// Independent design rule + connectivity checker for a finished PCB layout.
//
// This module deliberately shares nothing with the router (pcbRoute.js) beyond
// the design rules themselves: it re-derives every piece of copper from the
// layout object and measures it with exact geometry, so a bug in the router's
// grid bookkeeping cannot hide behind a matching bug here. If runDrc says a
// board is clean, it is clean by measurement, not by construction.
//
// Copper model
// ------------
// Every piece of copper is a convex core inflated by a radius:
//
// * pad   — `padCopperShape(pad)` on BOTH layers (through-hole): a rect pad is
//           its rectangle (r = 0), an oval pad a stadium, a circular pad a
//           point inflated by d/2. This is EXACT.
// * via   — circle of `diameter / 2` on BOTH layers.
// * trace — capsule (segment inflated by `width / 2`) on its own layer.
// * pour  — one convex polygon per ground-pour rectangle (r = 0) on the pour's
//           layer. pcbPour.js emits the pour as disjoint axis-aligned
//           rectangles precisely so this stays exact: a filled convex polygon's
//           nearest point to anything outside it lies on its boundary, so
//           edge-to-edge measurement IS the copper gap, with no hole to hide a
//           short in. The pour's own construction already guarantees the
//           clearance; this is the independent second opinion that says so.
//
// Pads additionally carry `geom`, the circumscribing circle of
// `padCopperRadius(pad)`. That circle contains the pad but is bigger than it
// (0.62 mm bigger at a 3x3 rect pad's corner), which makes it a one-way
// instrument, and the two checks here use it accordingly:
//
// * CLEARANCE is a two-tier test. The circle runs first as a cheap reject:
//   because it never under-reports copper, "circle gap >= clearance" proves
//   the real gap is at least that too, and the pair is dismissed without more
//   work. Only a pair the circle *fails* is re-measured against the exact
//   outlines, and only the exact measurement can raise a violation — so the
//   over-approximation can never invent a clearance error for a rect pad, and
//   can never hide one either (it is always the pessimistic bound).
// * CONNECTIVITY ("does this trace end on the pad?") has no cheap tier at all.
//   An over-approximation there is a false PASS — it would weld a trace to a
//   pad it physically misses — so `checkConnectivity` measures exact copper,
//   always. Board-edge and annular-ring checks are exact for the same reason.
//
// Pads belonging to the *same* footprint are not checked against each other:
// their spacing is fixed by the vendored KiCad library (TO-92_Inline really
// does sit at 1.27 mm pitch), so it is the library's business, not the
// pipeline's. Everything else — pad/via/trace against pad/via/trace — is.
//
// All dimensions are millimetres, y-down.
import {
  PAD_ANNULAR_RING, RULES, VIA_ANNULAR_RING,
  copperCorePoints, padCopperRadius, padCopperShape,
} from './pcbDesignRules.js';

const TOP = 1;
const BOTTOM = 2;
const BOTH = TOP | BOTTOM;

/** Coincidence tolerance for connectivity (mm). */
const TOUCH_TOLERANCE = 1e-3;

/** Uniform bucket size for the broad-phase index (mm). */
const BUCKET = 4;

const round3 = (value) => Math.round(value * 1000) / 1000;

const layerMask = (layer) => (layer === 'bottom' ? BOTTOM : TOP);

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

/** Closest point to (px,py) on segment a→b, plus the distance to it. */
const closestOnSegment = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const cx = ax + dx * t;
  const cy = ay + dy * t;
  return { x: cx, y: cy, distance: Math.hypot(px - cx, py - cy) };
};

/** Closest pair of points between two segments, plus the distance. */
const closestBetweenSegments = (a, b) => {
  const cross = (a.bx - a.ax) * (b.by - b.ay) - (a.by - a.ay) * (b.bx - b.ax);
  if (cross !== 0) {
    const s = ((b.ax - a.ax) * (b.by - b.ay) - (b.ay - a.ay) * (b.bx - b.ax)) / cross;
    const t = ((b.ax - a.ax) * (a.by - a.ay) - (b.ay - a.ay) * (a.bx - a.ax)) / cross;
    if (s >= 0 && s <= 1 && t >= 0 && t <= 1) {
      const x = a.ax + (a.bx - a.ax) * s;
      const y = a.ay + (a.by - a.ay) * s;
      return { distance: 0, ax: x, ay: y, bx: x, by: y };
    }
  }
  const candidates = [
    { ...closestOnSegment(a.ax, a.ay, b.ax, b.ay, b.bx, b.by), from: { x: a.ax, y: a.ay } },
    { ...closestOnSegment(a.bx, a.by, b.ax, b.ay, b.bx, b.by), from: { x: a.bx, y: a.by } },
    { ...closestOnSegment(b.ax, b.ay, a.ax, a.ay, a.bx, a.by), from: { x: b.ax, y: b.ay }, swapped: true },
    { ...closestOnSegment(b.bx, b.by, a.ax, a.ay, a.bx, a.by), from: { x: b.bx, y: b.by }, swapped: true },
  ];
  let best = candidates[0];
  for (const candidate of candidates) if (candidate.distance < best.distance) best = candidate;
  return best.swapped
    ? { distance: best.distance, ax: best.x, ay: best.y, bx: best.from.x, by: best.from.y }
    : { distance: best.distance, ax: best.from.x, ay: best.from.y, bx: best.x, by: best.y };
};

/**
 * Gap between the copper of two items (negative = overlapping), with the two
 * nearest points so a violation can be located on the board.
 */
const copperGap = (a, b) => {
  if (a.geom.type === 'circle' && b.geom.type === 'circle') {
    const distance = Math.hypot(a.geom.x - b.geom.x, a.geom.y - b.geom.y);
    return { gap: distance - a.geom.r - b.geom.r, x: (a.geom.x + b.geom.x) / 2, y: (a.geom.y + b.geom.y) / 2 };
  }
  if (a.geom.type === 'circle' || b.geom.type === 'circle') {
    const circle = a.geom.type === 'circle' ? a.geom : b.geom;
    const segment = a.geom.type === 'circle' ? b.geom : a.geom;
    const near = closestOnSegment(circle.x, circle.y, segment.ax, segment.ay, segment.bx, segment.by);
    return { gap: near.distance - circle.r - segment.r, x: (circle.x + near.x) / 2, y: (circle.y + near.y) / 2 };
  }
  const near = closestBetweenSegments(a.geom, b.geom);
  return {
    gap: near.distance - a.geom.r - b.geom.r,
    x: (near.ax + near.bx) / 2,
    y: (near.ay + near.by) / 2,
  };
};

/* --- exact copper: convex core inflated by a radius ----------------- */

/** The (at most four) edges of a convex core, degenerate cores included. */
const coreEdges = (points) => {
  if (points.length === 1) {
    return [{ ax: points[0][0], ay: points[0][1], bx: points[0][0], by: points[0][1] }];
  }
  if (points.length === 2) {
    return [{ ax: points[0][0], ay: points[0][1], bx: points[1][0], by: points[1][1] }];
  }
  return points.map((point, index) => {
    const next = points[(index + 1) % points.length];
    return { ax: point[0], ay: point[1], bx: next[0], by: next[1] };
  });
};

/** True when `point` lies inside the convex polygon `points` (consistent winding). */
const insideConvex = (points, point) => {
  if (points.length < 3) return false;
  let sign = 0;
  for (const edge of coreEdges(points)) {
    const cross = (edge.bx - edge.ax) * (point[1] - edge.ay) - (edge.by - edge.ay) * (point[0] - edge.ax);
    if (cross === 0) continue;
    const next = cross > 0 ? 1 : -1;
    if (sign === 0) sign = next;
    else if (sign !== next) return false;
  }
  return true;
};

/**
 * Exact gap between two cores' inflated copper (negative = overlapping), with
 * the two nearest points. Both cores are convex, so the closest approach is
 * always attained on a boundary edge pair unless one contains the other.
 */
const exactGap = (a, b) => {
  if (insideConvex(a.core, b.core[0]) || insideConvex(b.core, a.core[0])) {
    const x = (a.core[0][0] + b.core[0][0]) / 2;
    const y = (a.core[0][1] + b.core[0][1]) / 2;
    return { gap: -(a.inflate + b.inflate), x, y };
  }
  let best = null;
  for (const left of coreEdges(a.core)) {
    for (const right of coreEdges(b.core)) {
      const near = closestBetweenSegments(left, right);
      if (!best || near.distance < best.distance) best = near;
    }
  }
  return {
    gap: best.distance - a.inflate - b.inflate,
    x: (best.ax + best.bx) / 2,
    y: (best.ay + best.by) / 2,
  };
};

/**
 * Gap between two items, measured exactly. Traces and vias are already exact
 * in `geom`, so a pair of them short-circuits to the cheap closed forms.
 */
const measuredGap = (a, b) => ((a.exact && b.exact) ? copperGap(a, b) : exactGap(a, b));

/** Axis-aligned bounds of an item's exact copper. */
const itemBounds = (item) => {
  const bounds = {
    minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity,
  };
  for (const [x, y] of item.core) {
    bounds.minX = Math.min(bounds.minX, x - item.inflate);
    bounds.minY = Math.min(bounds.minY, y - item.inflate);
    bounds.maxX = Math.max(bounds.maxX, x + item.inflate);
    bounds.maxY = Math.max(bounds.maxY, y + item.inflate);
  }
  return bounds;
};

/* ------------------------------------------------------------------ */
/* Copper extraction                                                   */
/* ------------------------------------------------------------------ */

/**
 * Every piece of copper on the board, in a stable order: pads (component
 * order, pad order), then vias, then traces, then ground-pour polygons.
 *
 * Pads that are not wired to anything still exist physically, so they take
 * part in clearance checks under a private net key (they can never be
 * "connected" to a real net by accident).
 *
 * @returns {Array<object>} copper items
 */
export const copperItems = (layout) => {
  const items = [];
  const push = (item) => {
    items.push({ index: items.length, ...item });
  };

  for (const component of layout?.components || []) {
    for (const pad of component.pads || []) {
      const shape = padCopperShape(pad);
      push({
        kind: 'pad',
        net: pad.net,
        netKey: pad.connected === false ? `#nc:${component.ref}:${pad.padNumber}` : pad.net,
        routable: pad.connected !== false,
        owner: component.ref,
        label: `pad ${component.ref}.${pad.padNumber ?? pad.pinIndex ?? '?'}`,
        drill: pad.drill,
        annularRing: PAD_ANNULAR_RING,
        // A surface-mount pad is copper on one side only, so it neither
        // clears against nor shorts to copper on the other layer.
        layers: pad.type === 'smd' ? layerMask(pad.layer) : BOTH,
        // Over-approximating keep-out circle, used only as the clearance
        // check's cheap reject (see the header).
        geom: { type: 'circle', x: pad.x, y: pad.y, r: padCopperRadius(pad) },
        core: copperCorePoints(shape),
        inflate: shape.r,
        // Half the narrowest width of the copper through the pad centre — the
        // inscribed circle, which is what an annular ring is measured on.
        inscribed: Math.min(shape.hw, shape.hh) + shape.r,
        exact: shape.hw === 0 && shape.hh === 0,
      });
    }
  }

  for (const via of layout?.vias || []) {
    const diameter = via.diameter ?? RULES.viaDiameter;
    push({
      kind: 'via',
      net: via.net,
      netKey: via.net,
      routable: true,
      owner: null,
      label: `via @${round3(via.x)},${round3(via.y)}`,
      drill: via.drill ?? RULES.viaDrill,
      annularRing: VIA_ANNULAR_RING,
      layers: BOTH,
      geom: { type: 'circle', x: via.x, y: via.y, r: diameter / 2 },
      core: [[via.x, via.y]],
      inflate: diameter / 2,
      inscribed: diameter / 2,
      exact: true,
    });
  }

  for (const trace of layout?.traces || []) {
    const width = trace.width ?? RULES.traceWidth;
    const half = width / 2;
    push({
      kind: 'trace',
      width,
      net: trace.net,
      netKey: trace.net,
      routable: true,
      owner: null,
      label: `trace ${trace.layer} ${round3(trace.from.x)},${round3(trace.from.y)}→${round3(trace.to.x)},${round3(trace.to.y)}`,
      drill: 0,
      annularRing: 0,
      layers: layerMask(trace.layer),
      geom: {
        type: 'segment',
        ax: trace.from.x, ay: trace.from.y, bx: trace.to.x, by: trace.to.y,
        r: half,
      },
      core: [[trace.from.x, trace.from.y], [trace.to.x, trace.to.y]],
      inflate: half,
      inscribed: half,
      exact: true,
    });
  }

  const pour = layout?.pour;
  for (const polygon of pour?.polygons || []) {
    const xs = polygon.map((point) => point.x);
    const ys = polygon.map((point) => point.y);
    const x = (Math.min(...xs) + Math.max(...xs)) / 2;
    const y = (Math.min(...ys) + Math.max(...ys)) / 2;
    push({
      kind: 'pour',
      net: pour.net,
      netKey: pour.net,
      // The pour is a consequence of the net's copper, not a member of it: the
      // flood fill only keeps cells that already sit on a ground pad or via, so
      // letting it join the connectivity union-find could only ever paper over
      // a net that routing had actually left split.
      routable: false,
      owner: null,
      label: `pour ${pour.layer} @${round3(x)},${round3(y)}`,
      drill: 0,
      annularRing: 0,
      layers: layerMask(pour.layer),
      // Circumscribing circle: over-approximates, so it is safe as the
      // clearance check's cheap reject and never decides a violation.
      geom: { type: 'circle', x, y, r: Math.max(...polygon.map((point) => Math.hypot(point.x - x, point.y - y))) },
      core: polygon.map((point) => [point.x, point.y]),
      inflate: 0,
      inscribed: 0,
      exact: false,
    });
  }

  return items;
};

/**
 * Broad phase: bucket every item by the cells its inflated bounds cover, then
 * hand back the candidate pairs (i < j, each pair once) in index order.
 */
const candidatePairs = (items, margin) => {
  const buckets = new Map();
  for (const item of items) {
    const bounds = itemBounds(item);
    const minCol = Math.floor((bounds.minX - margin) / BUCKET);
    const maxCol = Math.floor((bounds.maxX + margin) / BUCKET);
    const minRow = Math.floor((bounds.minY - margin) / BUCKET);
    const maxRow = Math.floor((bounds.maxY + margin) / BUCKET);
    for (let col = minCol; col <= maxCol; col += 1) {
      for (let row = minRow; row <= maxRow; row += 1) {
        const key = `${col}:${row}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(item.index);
      }
    }
  }

  const seen = new Set();
  const pairs = [];
  for (const bucket of buckets.values()) {
    for (let a = 0; a < bucket.length; a += 1) {
      for (let b = a + 1; b < bucket.length; b += 1) {
        const low = Math.min(bucket[a], bucket[b]);
        const high = Math.max(bucket[a], bucket[b]);
        const key = low * items.length + high;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push([low, high]);
      }
    }
  }
  // Bucket iteration order already follows insertion order, but sorting makes
  // the output independent of it.
  pairs.sort((left, right) => (left[0] - right[0]) || (left[1] - right[1]));
  return pairs;
};

/* ------------------------------------------------------------------ */
/* Design rule check                                                   */
/* ------------------------------------------------------------------ */

/**
 * Measures a finished layout against the fabrication rules.
 *
 * @param {object} layout
 * @param {import('./pcbDesignRules.js').DesignRules} [rules]
 * @returns {{ ok: boolean, violations: Array<{ type: 'clearance'|'edge'|'annular'|'trace_width',
 *   netA: string, netB: string|null, x: number, y: number, distance: number,
 *   required: number, refs: { a: string, b: string|null } }> }}
 */
export const runDrc = (layout, rules = RULES) => {
  const items = copperItems(layout);
  const violations = [];

  // Copper-to-copper, different nets, sharing a layer.
  for (const [left, right] of candidatePairs(items, rules.clearance)) {
    const a = items[left];
    const b = items[right];
    if (a.netKey === b.netKey) continue;
    if (!(a.layers & b.layers)) continue;
    if (a.kind === 'pad' && b.kind === 'pad' && a.owner === b.owner) continue;
    // Tier 1: the over-approximating circles. They contain the real copper, so
    // a pass here is a pass for the real copper too — dismiss without more work.
    if (copperGap(a, b).gap >= rules.clearance) continue;
    // Tier 2: the exact outlines. Only this measurement may raise a violation,
    // so a rect pad is never flagged for copper its circumscribing circle
    // owns but the pad itself does not.
    const { gap, x, y } = measuredGap(a, b);
    if (gap >= rules.clearance) continue;
    violations.push({
      type: 'clearance',
      netA: a.net,
      netB: b.net,
      x: round3(x),
      y: round3(y),
      distance: round3(gap),
      required: rules.clearance,
      refs: { a: a.label, b: b.label },
    });
  }

  // Copper to board edge.
  const board = layout?.board;
  if (board) {
    for (const item of items) {
      const bounds = itemBounds(item);
      const gaps = [
        { gap: bounds.minX, x: bounds.minX, y: (bounds.minY + bounds.maxY) / 2 },
        { gap: bounds.minY, x: (bounds.minX + bounds.maxX) / 2, y: bounds.minY },
        { gap: board.width - bounds.maxX, x: bounds.maxX, y: (bounds.minY + bounds.maxY) / 2 },
        { gap: board.height - bounds.maxY, x: (bounds.minX + bounds.maxX) / 2, y: bounds.maxY },
      ];
      let worst = gaps[0];
      for (const candidate of gaps) if (candidate.gap < worst.gap) worst = candidate;
      if (worst.gap >= rules.edgeClearance) continue;
      violations.push({
        type: 'edge',
        netA: item.net,
        netB: null,
        x: round3(worst.x),
        y: round3(worst.y),
        distance: round3(worst.gap),
        required: rules.edgeClearance,
        refs: { a: item.label, b: null },
      });
    }
  }

  // Etchable trace width. The router is allowed to neck a job down to squeeze
  // out of a tight footprint, so something independent has to hold the floor —
  // otherwise a neck could walk below what a fab can etch and every other rule
  // here would still report the board clean.
  //
  // `?? RULES.minTraceWidth` because a caller may pass a partial rules object:
  // an undefined floor would make every comparison below NaN, i.e. silently
  // pass, which is the one failure mode this check exists to prevent.
  const minTraceWidth = rules.minTraceWidth ?? RULES.minTraceWidth;
  for (const item of items) {
    if (item.kind !== 'trace') continue;
    if (item.width >= minTraceWidth - 1e-9) continue;
    violations.push({
      type: 'trace_width',
      netA: item.net,
      netB: null,
      x: round3((item.geom.ax + item.geom.bx) / 2),
      y: round3((item.geom.ay + item.geom.by) / 2),
      distance: round3(item.width),
      required: minTraceWidth,
      refs: { a: item.label, b: null },
    });
  }

  // Annular rings around drilled holes, measured on the pad's INSCRIBED width.
  //
  // A ring is thinnest where the copper is narrowest, so a non-square pad has
  // to be judged on its short axis: the circumscribing diameter this check used
  // to read let a 1.05 x 1.5 mm oval claim the 1.5 mm figure while the drill
  // actually breaks out through the 1.05 mm one. `PAD_ANNULAR_RING` is quoted
  // per side, hence the factor of two.
  for (const item of items) {
    if (!item.drill || item.geom.type !== 'circle') continue;
    const required = item.drill + 2 * item.annularRing;
    const diameter = item.inscribed * 2;
    if (diameter >= required - 1e-9) continue;
    violations.push({
      type: 'annular',
      netA: item.net,
      netB: null,
      x: round3(item.geom.x),
      y: round3(item.geom.y),
      distance: round3(diameter),
      required: round3(required),
      refs: { a: item.label, b: null },
    });
  }

  violations.sort((a, b) =>
    (a.type < b.type ? -1 : a.type > b.type ? 1 : 0)
    || (a.netA < b.netA ? -1 : a.netA > b.netA ? 1 : 0)
    || (String(a.netB) < String(b.netB) ? -1 : String(a.netB) > String(b.netB) ? 1 : 0)
    || (a.x - b.x) || (a.y - b.y));

  return { ok: violations.length === 0, violations };
};

/* ------------------------------------------------------------------ */
/* Connectivity                                                        */
/* ------------------------------------------------------------------ */

/**
 * Union-find over each net's copper: two items join when their EXACT copper
 * physically touches (gap <= 1e-3) on a shared layer. Every routed net must
 * come out as a single island.
 *
 * @returns {{ ok: boolean, incompleteNets: Array<{ net: string, islands: number }> }}
 */
export const checkConnectivity = (layout) => {
  const items = copperItems(layout)
    .filter((item) => item.routable)
    .map((item, index) => ({ ...item, index }));

  const parent = items.map((_, index) => index);
  const find = (node) => {
    let root = node;
    while (parent[root] !== root) root = parent[root];
    let walk = node;
    while (parent[walk] !== walk) {
      const next = parent[walk];
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
  };

  for (const [left, right] of candidatePairs(items, TOUCH_TOLERANCE)) {
    const a = items[left];
    const b = items[right];
    if (a.netKey !== b.netKey) continue;
    if (!(a.layers & b.layers)) continue;
    // Exact copper only: the circumscribing circle would union a trace that
    // ends beside a rect pad rather than on it, reporting a net as complete
    // when the board would come back open.
    if (measuredGap(a, b).gap <= TOUCH_TOLERANCE) union(left, right);
  }

  const islandsByNet = new Map();
  items.forEach((item, position) => {
    if (!islandsByNet.has(item.netKey)) islandsByNet.set(item.netKey, { net: item.net, roots: new Set() });
    islandsByNet.get(item.netKey).roots.add(find(position));
  });

  const incompleteNets = [...islandsByNet.values()]
    .filter((entry) => entry.roots.size > 1)
    .map((entry) => ({ net: entry.net, islands: entry.roots.size }))
    .sort((a, b) => (a.net < b.net ? -1 : a.net > b.net ? 1 : 0));

  return { ok: incompleteNets.length === 0, incompleteNets };
};
