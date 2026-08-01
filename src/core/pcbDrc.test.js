import { describe, expect, it } from 'vitest';
import { checkConnectivity, runDrc } from './pcbDrc.js';
import { RULES } from './pcbDesignRules.js';

/** Minimal hand-built layout: no placer, no router, just copper. */
const layoutOf = ({ components = [], traces = [], vias = [], board } = {}) => ({
  board: { width: 40, height: 40, thickness: RULES.boardThickness, ...board },
  components,
  traces,
  vias,
  nets: [...new Set([
    ...components.flatMap((component) => component.pads.map((pad) => pad.net)),
    ...traces.map((trace) => trace.net),
  ])],
});

const pad = (x, y, net, extra = {}) => ({
  x, y, net, connected: true, diameter: 1.6, drill: 0.8, pinIndex: 1, padNumber: '1', ...extra,
});

const part = (ref, pads) => ({ ref, kind: 'resistor', value: '1k', x: 0, y: 0, width: 2, height: 2, pads });

const trace = (net, from, to, layer = 'top') => ({
  layer, net, from, to, width: RULES.traceWidth,
});

describe('runDrc', () => {
  it('accepts a layout whose different-net copper is far apart', () => {
    const result = runDrc(layoutOf({
      components: [part('R1', [pad(10, 10, 'A')]), part('R2', [pad(20, 20, 'B')])],
    }));

    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('flags two different-net pads left with only a 0.2 mm gap', () => {
    // Copper edges 0.2 mm apart: 1.8 mm centres minus two 0.8 mm radii.
    const result = runDrc(layoutOf({
      components: [part('R1', [pad(10, 10, 'A')]), part('R2', [pad(11.8, 10, 'B')])],
    }));

    expect(result.ok).toBe(false);
    const violation = result.violations.find((item) => item.type === 'clearance');
    expect(violation.distance).toBeCloseTo(0.2, 6);
    expect(violation.required).toBe(RULES.clearance);
    expect([violation.netA, violation.netB].sort()).toEqual(['A', 'B']);
  });

  it('ignores pad spacing inside one footprint, which the library fixes', () => {
    // TO-92_Inline really does put its pads 1.27 mm apart; that is the
    // vendor's geometry, not something the pipeline can route around.
    const result = runDrc(layoutOf({
      components: [part('Q1', [pad(10, 10, 'A'), pad(11.27, 10, 'B')])],
    }));

    expect(result.violations).toEqual([]);
  });

  it('never complains about copper that shares a net', () => {
    const result = runDrc(layoutOf({
      components: [part('R1', [pad(10, 10, 'A')]), part('R2', [pad(10.4, 10, 'A')])],
      traces: [trace('A', { x: 10, y: 10 }, { x: 10.4, y: 10 })],
    }));

    expect(result.violations).toEqual([]);
  });

  it('separates the two copper layers', () => {
    const crossing = { components: [], traces: [], vias: [] };
    crossing.traces = [
      trace('A', { x: 5, y: 10 }, { x: 30, y: 10 }, 'top'),
      trace('B', { x: 20, y: 5 }, { x: 20, y: 30 }, 'bottom'),
    ];

    expect(runDrc(layoutOf(crossing)).violations).toEqual([]);
    crossing.traces[1].layer = 'top';
    expect(runDrc(layoutOf(crossing)).ok).toBe(false);
  });

  it('treats through-hole pads and vias as copper on both layers', () => {
    const bottomOnly = layoutOf({
      components: [part('R1', [pad(10, 10, 'A')])],
      traces: [trace('B', { x: 5, y: 11 }, { x: 20, y: 11 }, 'bottom')],
    });

    // 1 mm between the pad centre and the trace axis: 1 - 0.8 - 0.4 < 0.
    expect(runDrc(bottomOnly).ok).toBe(false);
    expect(runDrc(bottomOnly).violations[0].type).toBe('clearance');
  });

  it('flags copper that crowds the board edge', () => {
    const result = runDrc(layoutOf({
      components: [part('R1', [pad(1, 10, 'A')])],
    }));

    const violation = result.violations.find((item) => item.type === 'edge');
    expect(violation.distance).toBeCloseTo(0.2, 6);
    expect(violation.required).toBe(RULES.edgeClearance);
  });

  it('flags a pad whose annular ring is too thin', () => {
    const result = runDrc(layoutOf({
      components: [part('R1', [pad(10, 10, 'A', { diameter: 1.2, drill: 0.8 })])],
    }));

    expect(result.violations.map((item) => item.type)).toContain('annular');
  });

  it('flags a via whose annular ring is too thin', () => {
    const result = runDrc(layoutOf({
      vias: [{ x: 10, y: 10, net: 'A', diameter: 1.2, drill: 0.9 }],
    }));

    const violation = result.violations.find((item) => item.type === 'annular');
    expect(violation.required).toBeCloseTo(1.3, 6);
  });

  it('reports violations in a stable order', () => {
    const layout = layoutOf({
      components: [
        part('R1', [pad(10, 10, 'A'), pad(20, 20, 'C')]),
        part('R2', [pad(11.8, 10, 'B'), pad(21.8, 20, 'D')]),
      ],
    });

    expect(JSON.stringify(runDrc(layout))).toBe(JSON.stringify(runDrc(layout)));
    expect(runDrc(layout).violations).toHaveLength(2);
  });

  it('catches a rect pad whose diagonal corner reaches a foreign trace (inscribed-circle under-model)', () => {
    // A 3x3 mm rect pad's true copper reaches Math.hypot(3, 3) / 2 ≈ 2.1213 mm
    // from its centre at the diagonal corner, not max(3, 3) / 2 = 1.5 mm (the
    // inscribed circle). `diameter: 3` mirrors what pcbLayout.js actually
    // stamps on a pad (diameter = max(size.w, size.h)), so this also exercises
    // that padCopperRadius must check `size` before `diameter`.
    //
    // Net B's trace runs perpendicular to the pad's 45 degree diagonal, with
    // its closest approach exactly on that diagonal, 2.5 mm from the pad
    // centre:
    //   - true corner-to-trace gap  = 2.5 - 2.1213 - 0.4 (trace half-width)
    //                               ≈ -0.021 mm  -> overlapping copper, VIOLATION
    //   - inscribed-circle gap      = 2.5 - 1.5   - 0.4
    //                               = 0.6 mm      -> clear, no violation (WRONG)
    const rectPad = pad(10, 10, 'A', { shape: 'rect', size: { w: 3, h: 3 }, diameter: 3 });
    const diagonalTrace = trace('B', { x: 12.474874, y: 11.06066 }, { x: 11.06066, y: 12.474874 });

    const result = runDrc(layoutOf({
      components: [part('R1', [rectPad])],
      traces: [diagonalTrace],
    }));

    const violation = result.violations.find((item) => item.type === 'clearance');
    expect(violation).toBeDefined();
    expect(violation.distance).toBeCloseTo(-0.0213, 3);
    expect([violation.netA, violation.netB].sort()).toEqual(['A', 'B']);
    expect(result.ok).toBe(false);
  });

  it('does not invent a clearance error a rect pad only has in its bounding circle', () => {
    // The other side of the coin. Net B's trace runs down the pad's flank,
    // where the true copper stops at x = 11.5 but the circumscribing circle
    // keeps going to 12.1213:
    //   - true edge-to-trace gap   = 12.21 - 11.5    - 0.4 = 0.31 mm -> LEGAL
    //   - circumscribing-circle gap = 2.21 - 2.1213  - 0.4 = -0.31 mm -> would
    //     be reported, and would be wrong
    // Only the exact measurement may raise a violation, so this stays clean.
    const rectPad = pad(10, 10, 'A', { shape: 'rect', size: { w: 3, h: 3 }, diameter: 3 });
    const flankingTrace = trace('B', { x: 12.21, y: 5 }, { x: 12.21, y: 15 });

    const result = runDrc(layoutOf({
      components: [part('R1', [rectPad])],
      traces: [flankingTrace],
    }));

    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('still flags the same flanking trace once it crosses the true rect edge', () => {
    // 0.29 mm clear instead of 0.31 — one hundredth of a millimetre inside the
    // rule — so the exact measurement is doing real work, not just passing
    // everything.
    const rectPad = pad(10, 10, 'A', { shape: 'rect', size: { w: 3, h: 3 }, diameter: 3 });
    const result = runDrc(layoutOf({
      components: [part('R1', [rectPad])],
      traces: [trace('B', { x: 12.19, y: 5 }, { x: 12.19, y: 15 })],
    }));

    const violation = result.violations.find((item) => item.type === 'clearance');
    expect(violation).toBeDefined();
    expect(violation.distance).toBeCloseTo(0.29, 6);
  });

  it('measures an oval pad as a stadium rather than its bounding box', () => {
    // A 1.05 x 1.5 mm TO-92 pad is a 0.525 mm disc swept 0.45 mm vertically,
    // so off to the side its copper stops well inside the max(w,h)/2 = 0.75 mm
    // circle. Net B's trace corners in at (11.1, 10.85):
    //   - true stadium-to-trace gap = 1.2652 - 0.525 - 0.4 = 0.34 mm -> LEGAL
    //   - max(w,h)/2 circle gap     = 1.3902 - 0.75  - 0.4 = 0.24 mm -> would
    //     be reported, and would be wrong
    const ovalPad = pad(10, 10, 'A', { shape: 'oval', size: { w: 1.05, h: 1.5 }, diameter: 1.5 });
    const corner = trace('B', { x: 11.1, y: 10.85 }, { x: 14, y: 10.85 });

    const result = runDrc(layoutOf({
      components: [part('R1', [ovalPad])],
      traces: [corner],
    }));

    expect(result.violations.filter((item) => item.type === 'clearance')).toEqual([]);
  });
});

describe('checkConnectivity', () => {
  it('accepts a net whose pads are joined by a trace', () => {
    const result = checkConnectivity(layoutOf({
      components: [part('R1', [pad(10, 10, 'A')]), part('R2', [pad(20, 10, 'A')])],
      traces: [trace('A', { x: 10, y: 10 }, { x: 20, y: 10 })],
    }));

    expect(result).toEqual({ ok: true, incompleteNets: [] });
  });

  it('reports a net whose pads were never wired together', () => {
    const result = checkConnectivity(layoutOf({
      components: [part('R1', [pad(10, 10, 'A')]), part('R2', [pad(20, 10, 'A')])],
    }));

    expect(result.ok).toBe(false);
    expect(result.incompleteNets).toEqual([{ net: 'A', islands: 2 }]);
  });

  it('reports a net whose trace stops short of the far pad', () => {
    const result = checkConnectivity(layoutOf({
      components: [part('R1', [pad(10, 10, 'A')]), part('R2', [pad(20, 10, 'A')])],
      traces: [trace('A', { x: 10, y: 10 }, { x: 15, y: 10 })],
    }));

    expect(result.incompleteNets).toEqual([{ net: 'A', islands: 2 }]);
  });

  it('walks a net through a via between the two layers', () => {
    const result = checkConnectivity(layoutOf({
      components: [part('R1', [pad(10, 10, 'A')]), part('R2', [pad(20, 20, 'A')])],
      traces: [
        trace('A', { x: 10, y: 10 }, { x: 20, y: 10 }, 'top'),
        trace('A', { x: 20, y: 10 }, { x: 20, y: 20 }, 'bottom'),
      ],
      vias: [{ x: 20, y: 10, net: 'A', diameter: RULES.viaDiameter, drill: RULES.viaDrill }],
    }));

    expect(result.ok).toBe(true);
  });

  it('accepts a T-junction where a trace lands mid-way along another', () => {
    const result = checkConnectivity(layoutOf({
      components: [
        part('R1', [pad(10, 10, 'A')]),
        part('R2', [pad(20, 10, 'A')]),
        part('R3', [pad(15, 20, 'A')]),
      ],
      traces: [
        trace('A', { x: 10, y: 10 }, { x: 20, y: 10 }),
        trace('A', { x: 15, y: 10 }, { x: 15, y: 20 }),
      ],
    }));

    expect(result.ok).toBe(true);
  });

  it('ignores pads that are not wired to anything', () => {
    const result = checkConnectivity(layoutOf({
      components: [part('R1', [pad(10, 10, 'R1_1', { connected: false })])],
    }));

    expect(result).toEqual({ ok: true, incompleteNets: [] });
  });

  it('splits a net whose trace stops beside a rect pad instead of on it', () => {
    // The false PASS this whole exercise is about. A 1.7 x 1.7 mm rect pad's
    // copper stops at x = 10.85; its circumscribing circle keeps going to
    // 11.2021. Net A's trace starts at x = 11.15 — 0.3 mm off the copper, yet
    // still INSIDE that circle — and runs away with a 0.1 mm half-width:
    //   - true gap                  = 0.3 - 0.1 = 0.2 mm of air. OPEN board.
    //   - circumscribing-circle gap = 1.15 - 1.2021 - 0.1 = -0.15 mm, i.e.
    //     "overlapping", so the circle model welds them and calls the net done.
    const rectPad = pad(10, 10, 'A', { shape: 'rect', size: { w: 1.7, h: 1.7 }, diameter: 1.7 });
    const stub = { ...trace('A', { x: 11.15, y: 10 }, { x: 16, y: 10 }), width: 0.2 };
    const layout = layoutOf({
      components: [part('R1', [rectPad]), part('R2', [pad(16, 10, 'A')])],
      traces: [stub],
    });

    // The endpoint really is inside the circle the old model used...
    expect(stub.from.x - rectPad.x).toBeLessThan(Math.hypot(1.7, 1.7) / 2);
    // ...and really is off the copper.
    expect(stub.from.x - rectPad.x).toBeGreaterThan(1.7 / 2);

    expect(checkConnectivity(layout).incompleteNets).toEqual([{ net: 'A', islands: 2 }]);
  });

  it('joins the same net once the trace reaches the rect pad copper', () => {
    const rectPad = pad(10, 10, 'A', { shape: 'rect', size: { w: 1.7, h: 1.7 }, diameter: 1.7 });
    const layout = layoutOf({
      components: [part('R1', [rectPad]), part('R2', [pad(16, 10, 'A')])],
      traces: [{ ...trace('A', { x: 10.85, y: 10 }, { x: 16, y: 10 }), width: 0.2 }],
    });

    expect(checkConnectivity(layout).ok).toBe(true);
  });

  it('ignores single-pad nets, which need no copper at all', () => {
    const result = checkConnectivity(layoutOf({
      components: [part('R1', [pad(10, 10, 'A')])],
    }));

    expect(result.ok).toBe(true);
  });
});
