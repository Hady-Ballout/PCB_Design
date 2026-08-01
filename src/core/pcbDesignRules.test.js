import { describe, expect, it } from 'vitest';
import { RULES, padCopperDistance, padCopperRadius } from './pcbDesignRules.js';
import { footprintRecordFor } from './pcbFootprints.js';
import { placementPads } from './pcbPlace.js';
import { buildPcbLayout } from './pcbLayout.js';

describe('RULES', () => {
  it('publishes the fabrication design rules the pipeline is built around', () => {
    expect(RULES).toMatchObject({
      gridPitch: 0.635,
      traceWidth: 0.8,
      clearance: 0.3,
      viaDiameter: 1.2,
      viaDrill: 0.6,
      edgeClearance: 0.5,
      boardMargin: 4,
      placementGap: 2.0,
      maskExpansion: 0.05,
      silkWidth: 0.15,
      boardThickness: 1.6,
    });
  });

  it('uses a routing grid that divides the 2.54 mm through-hole pitch', () => {
    const steps = 2.54 / RULES.gridPitch;
    expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
  });

  it('keeps a via drillable inside its own annular ring', () => {
    expect(RULES.viaDiameter).toBeGreaterThanOrEqual(RULES.viaDrill + 0.4);
  });
});

describe('padCopperDistance', () => {
  const rect3 = { x: 10, y: 10, shape: 'rect', size: { w: 3, h: 3 }, diameter: 3 };

  it('is negative inside a rect pad, zero on its edge and positive outside', () => {
    expect(padCopperDistance(rect3, 10, 10)).toBeCloseTo(-1.5, 9);
    expect(padCopperDistance(rect3, 11.5, 10)).toBeCloseTo(0, 9);
    expect(padCopperDistance(rect3, 11.9, 10)).toBeCloseTo(0.4, 9);
    // The corner is the one direction where exact and circumscribing agree.
    expect(padCopperDistance(rect3, 11.5, 11.5)).toBeCloseTo(0, 9);
  });

  it('refuses the points padCopperRadius wrongly claims for a rect pad', () => {
    // The circumscribing circle reaches hypot(3,3)/2 = 2.1213 mm, so a point
    // 2 mm out along the pad's x axis sits inside it — and 0.5 mm off copper.
    const x = 12;
    expect(Math.hypot(x - rect3.x, 0)).toBeLessThan(padCopperRadius(rect3));
    expect(padCopperDistance(rect3, x, 10)).toBeCloseTo(0.5, 9);
  });

  it('measures an oval pad as a stadium, not as its bounding box', () => {
    // 1.05 x 1.5 mm TO-92 pad: a 0.525 mm disc swept 0.45 mm vertically.
    const oval = { x: 0, y: 0, shape: 'oval', size: { w: 1.05, h: 1.5 } };
    expect(padCopperDistance(oval, 0.525, 0)).toBeCloseTo(0, 9);
    expect(padCopperDistance(oval, 0, 0.75)).toBeCloseTo(0, 9);
    // The bounding-box corner is well off the copper; a rect model would call
    // it an edge point.
    expect(padCopperDistance(oval, 0.525, 0.75)).toBeCloseTo(Math.hypot(0.525, 0.525) - 0.525, 9);
  });

  it('measures a circular pad from its diameter when it carries no size', () => {
    expect(padCopperDistance({ x: 0, y: 0, diameter: 1.6 }, 1, 0)).toBeCloseTo(0.2, 9);
  });

  it('reads a 90-degree-rotated TO-92 oval pad from its board-space size alone', () => {
    // The angle contract, proved end to end on a real rotated footprint.
    //
    // pcbPlace.rotatePadShape encodes a 90 degree placement TWICE: it swaps
    // size (1.05 x 1.5 -> 1.5 x 1.05, which is the correct board-space size on
    // its own) and it also sets angle to 90. pcbLayout does not copy `angle`
    // onto the layout pad, which is what makes the pipeline correct — so
    // padCopperDistance's contract is "size is board-space, angle is whatever
    // tilt remains inside that frame", and the pads it actually receives carry
    // no angle at all.
    const part = { ref: 'Q1', kind: 'bjt_npn', nodes: ['C', 'B', 'E'] };
    const { libId, record, padOrder } = footprintRecordFor(part);
    const placement = { part, footprint: record, libId, padOrder, x: 0, y: 0, rotation: 90 };
    const placed = placementPads(placement).find((entry) => entry.pad.shape === 'oval');

    expect(placed.pad.size).toEqual({ w: 1.5, h: 1.05 });
    expect(placed.pad.angle).toBe(90); // the double count, still in the placer

    // What pcbLayout hands on: shape + board-space size, no angle.
    const layoutPad = {
      x: placed.x, y: placed.y, shape: placed.pad.shape, size: placed.pad.size,
    };
    expect(layoutPad.angle).toBeUndefined();
    // Long axis is now horizontal: 0.75 mm of copper across x, 0.525 across y.
    expect(padCopperDistance(layoutPad, placed.x + 0.75, placed.y)).toBeCloseTo(0, 9);
    expect(padCopperDistance(layoutPad, placed.x, placed.y + 0.525)).toBeCloseTo(0, 9);

    // Honouring the placer's angle as well would rotate it back to vertical —
    // the exact failure the contract rules out.
    const doubleCounted = { ...layoutPad, angle: placed.pad.angle };
    expect(padCopperDistance(doubleCounted, placed.x + 0.75, placed.y)).toBeCloseTo(0.225, 9);
  });

  it('holds for every pad the vendored library ships, at every rotation', () => {
    // Nothing in the library carries an intrinsic tilt, so the swapped `size`
    // is the whole story for board-space geometry.
    for (const kind of ['resistor', 'capacitor', 'bjt_npn', 'opamp', 'voltage_source']) {
      const { record } = footprintRecordFor({ ref: 'X1', kind, nodes: ['A', 'B', 'C'] });
      for (const pad of record.pads) expect(pad.angle ?? 0).toBe(0);
    }
  });
});

describe('pad copper containment across the pipeline', () => {
  // A voltage source brings the 3 x 3 mm rect pad, the widest gap in the
  // library between a pad's true copper and its circumscribing circle
  // (0.62 mm at the pad's own edge).
  const layout = buildPcbLayout({
    components: [
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['IN', '0'] },
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['IN', 'OUT'] },
      { ref: 'C1', kind: 'capacitor', value: '100nF', nodes: ['OUT', '0'] },
    ],
  });

  const pads = layout.components.flatMap((component) => component.pads);

  it('has the rect pad this test is about', () => {
    expect(pads.some((pad) => pad.shape === 'rect' && pad.size.w === 3)).toBe(true);
  });

  it('lands every trace endpoint that reaches a pad on the pad, not beside it', () => {
    // The router picks a pad's terminal cell for maximum room, i.e. as far out
    // as the containment test allows. With the circumscribing circle as that
    // test, an endpoint could sit up to 0.62 mm off the copper of a 3 x 3 rect
    // pad while every downstream check, working from the same circle, called
    // the net connected.
    for (const trace of layout.traces) {
      for (const point of [trace.from, trace.to]) {
        for (const pad of pads) {
          if (!pad.connected || pad.net !== trace.net) continue;
          const insideCircle = Math.hypot(point.x - pad.x, point.y - pad.y) <= padCopperRadius(pad);
          if (!insideCircle) continue;
          expect(padCopperDistance(pad, point.x, point.y)).toBeLessThanOrEqual(1e-9);
        }
      }
    }
  });

  it('gives every wired pad of a routed net a trace endpoint on its own copper', () => {
    const multiPadNets = new Set(layout.nets.filter((net) =>
      pads.filter((pad) => pad.connected && pad.net === net).length > 1));

    for (const pad of pads) {
      if (!pad.connected || !multiPadNets.has(pad.net)) continue;
      const landed = layout.traces.some((trace) => trace.net === pad.net
        && [trace.from, trace.to].some((point) => padCopperDistance(pad, point.x, point.y) <= 1e-9));
      expect(landed).toBe(true);
    }
  });
});
