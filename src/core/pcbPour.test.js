import { describe, expect, it } from 'vitest';
import { RULES, copperCorePoints, padCopperShape } from './pcbDesignRules.js';
import { runDrc } from './pcbDrc.js';
import { buildPcbLayout } from './pcbLayout.js';
import { buildGroundPour } from './pcbPour.js';

/* ------------------------------------------------------------------ */
/* An independent measuring stick                                      */
/*                                                                     */
/* Nothing below touches the pour's own grid mask: a polygon is judged  */
/* as the filled rectangle it claims to be, measured against the exact  */
/* copper model in pcbDesignRules.js. If the mask has an off-by-one the */
/* pour would still look self-consistent, but these numbers would not.  */
/* ------------------------------------------------------------------ */

const boundsOf = (polygon) => ({
  minX: Math.min(...polygon.map((point) => point.x)),
  maxX: Math.max(...polygon.map((point) => point.x)),
  minY: Math.min(...polygon.map((point) => point.y)),
  maxY: Math.max(...polygon.map((point) => point.y)),
});

const pointToSegment = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
};

const pointToRect = (px, py, rect) => Math.hypot(
  Math.max(rect.minX - px, 0, px - rect.maxX),
  Math.max(rect.minY - py, 0, py - rect.maxY),
);

const segmentsCross = (ax, ay, bx, by, cx, cy, dx, dy) => {
  const side = (x1, y1, x2, y2, x3, y3) => Math.sign((x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1));
  return side(ax, ay, bx, by, cx, cy) !== side(ax, ay, bx, by, dx, dy)
    && side(cx, cy, dx, dy, ax, ay) !== side(cx, cy, dx, dy, bx, by);
};

/** Exact distance between an axis-aligned rectangle and a segment (0 if they meet). */
const rectToSegment = (rect, ax, ay, bx, by) => {
  const inside = (x, y) => x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY;
  if (inside(ax, ay) || inside(bx, by)) return 0;
  const corners = [
    [rect.minX, rect.minY], [rect.maxX, rect.minY], [rect.maxX, rect.maxY], [rect.minX, rect.maxY],
  ];
  for (let index = 0; index < 4; index += 1) {
    const [cx, cy] = corners[index];
    const [dx, dy] = corners[(index + 1) % 4];
    if (segmentsCross(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  }
  // Two disjoint convex sets: the closest pair is a vertex of one against the
  // other, so four corner-to-segment and two endpoint-to-rect probes suffice.
  return Math.min(
    pointToRect(ax, ay, rect),
    pointToRect(bx, by, rect),
    ...corners.map(([cx, cy]) => pointToSegment(cx, cy, ax, ay, bx, by)),
  );
};

/** Distance from a rectangle to a convex core (1, 2 or 4 points). */
const rectToCore = (rect, points) => {
  if (points.length === 1) return rectToSegment(rect, points[0][0], points[0][1], points[0][0], points[0][1]);
  if (points.length === 2) {
    return rectToSegment(rect, points[0][0], points[0][1], points[1][0], points[1][1]);
  }
  return Math.min(...points.map((point, index) => {
    const next = points[(index + 1) % points.length];
    return rectToSegment(rect, point[0], point[1], next[0], next[1]);
  }));
};

/** Distance from a pour polygon to a pad's exact copper. */
const polygonToPad = (polygon, pad) => {
  const shape = padCopperShape(pad);
  return rectToCore(boundsOf(polygon), copperCorePoints(shape)) - shape.r;
};

const isGround = (net) => /^(gnd|ground|0)$/i.test(String(net));

/**
 * Smallest gap between any pour polygon and any copper that is NOT on the
 * pour's net, measured on both sides of the board (pads and vias are copper on
 * both layers, traces only on their own).
 */
const worstForeignGap = (layout) => {
  let worst = Infinity;
  for (const polygon of layout.pour.polygons) {
    const rect = boundsOf(polygon);
    for (const component of layout.components) {
      for (const pad of component.pads) {
        if (pad.connected !== false && pad.net === layout.pour.net) continue;
        worst = Math.min(worst, polygonToPad(polygon, pad));
      }
    }
    for (const via of layout.vias) {
      if (via.net === layout.pour.net) continue;
      worst = Math.min(worst, rectToSegment(rect, via.x, via.y, via.x, via.y) - via.diameter / 2);
    }
    for (const trace of layout.traces) {
      if (trace.net === layout.pour.net) continue;
      if (trace.layer !== 'bottom') continue;
      worst = Math.min(
        worst,
        rectToSegment(rect, trace.from.x, trace.from.y, trace.to.x, trace.to.y) - trace.width / 2,
      );
    }
  }
  return worst;
};

/** Smallest gap between any pour polygon and the board edge. */
const worstEdgeGap = (layout) => {
  let worst = Infinity;
  for (const polygon of layout.pour.polygons) {
    const rect = boundsOf(polygon);
    worst = Math.min(
      worst,
      rect.minX, rect.minY,
      layout.board.width - rect.maxX,
      layout.board.height - rect.maxY,
    );
  }
  return worst;
};

/* ------------------------------------------------------------------ */
/* Hand-built fixtures                                                 */
/* ------------------------------------------------------------------ */

const thtPad = (x, y, net, padNumber) => ({
  x, y, net, padNumber, pinIndex: Number(padNumber), connected: true,
  drill: 0.8, diameter: 1.6, shape: 'circle', size: { w: 1.6, h: 1.6 },
});

/** Two ground pads flanking a signal pad whose trace drops to the board's top. */
const groundedBoard = (overrides = {}) => ({
  board: { width: 24, height: 16, thickness: 1.6, outline: { x: 0, y: 0, width: 24, height: 16 } },
  components: [{
    ref: 'J1',
    kind: 'connector',
    rotation: 0,
    x: 12,
    y: 8,
    pads: [thtPad(6, 8, 'GND', '1'), thtPad(12, 8, 'SIG', '2'), thtPad(18, 8, 'GND', '3')],
  }],
  traces: [{ layer: 'bottom', net: 'SIG', from: { x: 12, y: 8 }, to: { x: 12, y: 2 }, width: 0.8 }],
  vias: [],
  nets: ['GND', 'SIG'],
  routing: { complete: true, failedNets: [] },
  ...overrides,
});

/** The same board, split in two by a signal trace no ground copper crosses. */
const fencedBoard = () => ({
  board: { width: 24, height: 16, thickness: 1.6, outline: { x: 0, y: 0, width: 24, height: 16 } },
  components: [{
    ref: 'J1',
    kind: 'connector',
    rotation: 0,
    x: 12,
    y: 4,
    pads: [thtPad(6, 4, 'GND', '1'), thtPad(18, 4, 'GND', '2')],
  }],
  // Spans the full width on the bottom layer, so the lower half of the board is
  // pourable but unreachable from any ground pad.
  traces: [{ layer: 'bottom', net: 'SIG', from: { x: 0, y: 10 }, to: { x: 24, y: 10 }, width: 0.8 }],
  vias: [],
  nets: ['GND', 'SIG'],
  routing: { complete: true, failedNets: [] },
});

const groundFreeBoard = () => ({
  board: { width: 24, height: 16, thickness: 1.6, outline: { x: 0, y: 0, width: 24, height: 16 } },
  components: [{
    ref: 'J1',
    kind: 'connector',
    rotation: 0,
    x: 12,
    y: 8,
    pads: [thtPad(6, 8, 'IN', '1'), thtPad(18, 8, 'OUT', '2')],
  }],
  traces: [],
  vias: [],
  nets: ['IN', 'OUT'],
  routing: { complete: true, failedNets: [] },
});

describe('buildGroundPour', () => {
  it('returns null when the board has no ground net', () => {
    expect(buildGroundPour(groundFreeBoard())).toBeNull();
    expect(buildGroundPour({ board: { width: 10, height: 10 }, components: [], traces: [], vias: [], nets: [] })).toBeNull();
    expect(buildGroundPour(null)).toBeNull();
  });

  it('pours the bottom layer on the ground net, direct-connected', () => {
    const pour = buildGroundPour(groundedBoard());

    expect(pour.net).toBe('GND');
    expect(pour.layer).toBe('bottom');
    expect(pour.connect).toBe('direct');
    expect(pour.polygons.length).toBeGreaterThan(0);
    for (const polygon of pour.polygons) expect(polygon.length).toBeGreaterThanOrEqual(4);
  });

  it('snaps every emitted coordinate to 3 decimals', () => {
    for (const polygon of buildGroundPour(groundedBoard()).polygons) {
      for (const point of polygon) {
        expect(point.x).toBe(Math.round(point.x * 1000) / 1000);
        expect(point.y).toBe(Math.round(point.y * 1000) / 1000);
      }
    }
  });

  it('keeps the clearance rule against every piece of foreign copper', () => {
    const layout = groundedBoard();
    layout.pour = buildGroundPour(layout);

    expect(worstForeignGap(layout)).toBeGreaterThanOrEqual(RULES.clearance);
  });

  it('keeps the edge clearance rule', () => {
    const layout = groundedBoard();
    layout.pour = buildGroundPour(layout);

    expect(worstEdgeGap(layout)).toBeGreaterThanOrEqual(RULES.edgeClearance);
  });

  it('lands copper on a ground pad, so the pour is actually a ground plane', () => {
    const layout = groundedBoard();
    const pour = buildGroundPour(layout);
    const groundPad = layout.components[0].pads.find((pad) => pad.net === 'GND');

    const touching = pour.polygons.filter((polygon) => polygonToPad(polygon, groundPad) <= 0);
    expect(touching.length).toBeGreaterThan(0);
  });

  it('drops copper that no ground pad can reach instead of leaving it floating', () => {
    const layout = fencedBoard();
    const pour = buildGroundPour(layout);

    expect(pour.polygons.length).toBeGreaterThan(0);
    // Every ground pad is above the fence, so nothing below it may be poured.
    for (const polygon of pour.polygons) {
      expect(boundsOf(polygon).maxY).toBeLessThan(10);
    }
  });

  it('is deterministic', () => {
    expect(buildGroundPour(groundedBoard())).toEqual(buildGroundPour(groundedBoard()));
    expect(JSON.stringify(buildGroundPour(groundedBoard())))
      .toBe(JSON.stringify(buildGroundPour(groundedBoard())));
  });
});

describe('buildPcbLayout with a ground pour', () => {
  const rcLowPass = {
    title: 'RC low-pass',
    components: [
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VIN', '0'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VIN', 'VOUT'] },
      { ref: 'C1', kind: 'capacitor', value: '100nF', nodes: ['VOUT', '0'] },
    ],
  };
  const layout = buildPcbLayout(rcLowPass);

  it('carries the pour on the layout it hands back', () => {
    expect(layout.pour).toBeTruthy();
    expect(layout.pour.net).toBe('0');
    expect(layout.pour.layer).toBe('bottom');
    expect(layout.pour.polygons.length).toBeGreaterThan(0);
  });

  it('clears every non-ground piece of copper on a board the router actually produced', () => {
    expect(worstForeignGap(layout)).toBeGreaterThanOrEqual(RULES.clearance);
    expect(worstEdgeGap(layout)).toBeGreaterThanOrEqual(RULES.edgeClearance);
  });

  it('leaves the independent DRC clean', () => {
    expect(runDrc(layout)).toEqual({ ok: true, violations: [] });
  });

  it('does not disturb routing, DRC or connectivity', () => {
    expect(layout.routing.complete).toBe(true);
    expect(layout.drc.ok).toBe(true);
    expect(layout.connectivity.ok).toBe(true);
  });

  it('is byte-for-byte deterministic with the pour included', () => {
    expect(JSON.stringify(buildPcbLayout(rcLowPass))).toBe(JSON.stringify(buildPcbLayout(rcLowPass)));
  });

  it('leaves `pour` null on a circuit with no ground net', () => {
    const groundFree = buildPcbLayout({
      title: 'Ground-free divider',
      components: [
        { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['A', 'B'] },
        { ref: 'R2', kind: 'resistor', value: '2k2', nodes: ['B', 'C'] },
      ],
    });

    expect(groundFree.nets.some(isGround)).toBe(false);
    expect(groundFree.pour).toBeNull();
  });
});

describe('runDrc on pour copper', () => {
  it('measures the pour independently and reports a polygon that crowds a foreign net', () => {
    const layout = groundedBoard();
    // A hand-placed polygon straddling the SIG trace at x = 12: the mask would
    // never produce it, which is the point — DRC has to catch what the mask did
    // not build.
    layout.pour = {
      net: 'GND',
      layer: 'bottom',
      connect: 'direct',
      polygons: [[
        { x: 11, y: 4 }, { x: 13, y: 4 }, { x: 13, y: 5 }, { x: 11, y: 5 },
      ]],
    };

    const { ok, violations } = runDrc(layout);
    expect(ok).toBe(false);
    const clearance = violations.filter((violation) => violation.type === 'clearance');
    expect(clearance.length).toBeGreaterThan(0);
    expect(clearance.some((violation) => /pour/.test(violation.refs.a) || /pour/.test(violation.refs.b))).toBe(true);
  });

  it('says nothing about a pour that keeps its distance', () => {
    const layout = groundedBoard();
    layout.pour = buildGroundPour(layout);

    expect(runDrc(layout).ok).toBe(true);
  });
});
