// Bottom-copper ground pour for a finished pcbLayout.js board.
//
// A pour is the last thing that happens to the copper: placement, routing and
// the design-rule check are all finished, and the pour fills whatever bottom-
// layer space is left over with ground. It never moves a trace, never changes a
// routing result, and — by construction — never creates a clearance violation.
// pcbDrc.js re-measures it afterwards anyway, because "by construction" is
// exactly the claim this pipeline refuses to take on trust.
//
// THE MASK. The board is sampled on a lattice of square cells `gridPitch / 2`
// on a side (half the router's pitch, so the pour resolves detail the router
// cannot). A cell is POURABLE when its centre clears every piece of foreign
// copper by `clearance + cellReach` and the board edge by
// `edgeClearance + cellReach`, where `cellReach` is half a cell's DIAGONAL —
// the furthest any point of the cell can be from the centre that was actually
// measured. That margin is what turns a statement about sample points into a
// statement about the filled copper: if the centre clears by `C + cellReach`,
// every square micron of the cell clears by at least `C`. Foreign copper is
// measured exactly — `padCopperDistance` for pads (shape-exact), true segment
// distance for traces, centre distance for vias — and each item contributes its
// OWN half-width, so a 0.25 mm necked trace does not reserve 0.8 mm of room.
// Ground copper does not block: the pour is supposed to grow onto it, which is
// what makes the connection.
//
// NO FLOATING COPPER. A pourable cell is only kept if it is 4-connected to a
// cell that physically sits on ground-net pad or via copper. Islands the pour
// cannot reach are dropped whole — a disconnected copper puddle is an antenna,
// a fab DFM warning, and (in KiCad's own filler) an island to be removed.
//
// RECTANGLES, NOT OUTLINES. The kept mask is emitted as a set of disjoint
// axis-aligned rectangles (maximal horizontal runs, merged vertically when
// consecutive rows agree), not as traced outlines. The reason is the emitters:
// a Gerber G36 region and a KiCad `filled_polygon` both UNION — neither has an
// even-odd rule — and the kept mask is full of holes, one around every foreign
// pad and trace. An outline trace would therefore flood copper straight back
// over the keep-outs the mask just carved. A rectangle decomposition is the
// hole-free representation of exactly the same copper, and every rectangle is
// convex, which is also what lets pcbDrc measure it exactly.
//
// DIRECT CONNECT. Pads on the pour's net are simply swallowed by it — no
// thermal relief spokes. Solid connections keep the plane's impedance honest;
// the cost is that hand-soldering a ground pin needs more heat, which the
// fabrication README says out loud.
//
// Deterministic: fixed row-major iteration, no RNG, no clock.
//
// All dimensions are millimetres, y-down.
import { RULES, padCopperDistance, padCopperRadius } from './pcbDesignRules.js';
import { GROUND_NET_RE } from './pcbRoute.js';

const round3 = (value) => Math.round(value * 1000) / 1000;

/** Distance from a point to a segment. */
const distanceToSegment = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
};

/**
 * The net this board's pour would claim: the ground-like net (same matcher the
 * router uses to push these rails to the back of the queue) carrying the most
 * pads, ties broken by name so the answer never depends on component order.
 * Any OTHER ground-like net stays foreign copper — two nets named `GND` and `0`
 * are electrically distinct in this model, and merging them under a pour would
 * be inventing a connection the circuit never asked for.
 *
 * @param {object} layout
 * @returns {string|null}
 */
export const pourNetOf = (layout) => {
  const padsPerNet = new Map();
  for (const component of layout?.components || []) {
    for (const pad of component.pads || []) {
      if (pad.connected === false) continue;
      if (!GROUND_NET_RE.test(String(pad.net))) continue;
      padsPerNet.set(pad.net, (padsPerNet.get(pad.net) ?? 0) + 1);
    }
  }
  let best = null;
  for (const [net, count] of padsPerNet) {
    if (!best || count > best.count || (count === best.count && net < best.net)) best = { net, count };
  }
  return best ? best.net : null;
};

/**
 * Builds the bottom-layer ground pour for a routed board.
 *
 * @param {object} layout a pcbLayout.js layout (board, components, traces, vias)
 * @param {import('./pcbDesignRules.js').DesignRules} [rules]
 * @returns {null | { net: string, layer: 'bottom', connect: 'direct',
 *   polygons: Array<Array<{ x: number, y: number }>> }} null when there is no
 *   ground net, or when nothing on the board can be poured.
 */
export const buildGroundPour = (layout, rules = RULES) => {
  const board = layout?.board;
  if (!board) return null;
  const net = pourNetOf(layout);
  if (!net) return null;

  const step = rules.gridPitch / 2;
  // Half a cell's diagonal: the sample-to-fill margin argued in the header.
  const cellReach = (step * Math.SQRT2) / 2;
  const cols = Math.floor(board.width / step);
  const rows = Math.floor(board.height / step);
  if (cols <= 0 || rows <= 0) return null;

  const centreX = (col) => (col + 0.5) * step;
  const centreY = (row) => (row + 0.5) * step;
  const at = (col, row) => row * cols + col;

  /* --- the mask ---------------------------------------------------- */

  const keepOut = rules.clearance + cellReach;
  const edgeKeepOut = rules.edgeClearance + cellReach;

  const pourable = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row += 1) {
    const y = centreY(row);
    const insideY = y >= edgeKeepOut && board.height - y >= edgeKeepOut;
    for (let col = 0; col < cols; col += 1) {
      const x = centreX(col);
      pourable[at(col, row)] = insideY && x >= edgeKeepOut && board.width - x >= edgeKeepOut ? 1 : 0;
    }
  }

  /** Blocks every cell in a bounding box whose centre fails `tooClose`. */
  const block = (minX, minY, maxX, maxY, tooClose) => {
    const fromCol = Math.max(0, Math.ceil(minX / step - 0.5));
    const toCol = Math.min(cols - 1, Math.floor(maxX / step - 0.5));
    const fromRow = Math.max(0, Math.ceil(minY / step - 0.5));
    const toRow = Math.min(rows - 1, Math.floor(maxY / step - 0.5));
    for (let row = fromRow; row <= toRow; row += 1) {
      const y = centreY(row);
      for (let col = fromCol; col <= toCol; col += 1) {
        const index = at(col, row);
        if (!pourable[index]) continue;
        if (tooClose(centreX(col), y)) pourable[index] = 0;
      }
    }
  };

  const groundPads = [];
  for (const component of layout.components || []) {
    for (const pad of component.pads || []) {
      // An unwired terminal is real copper on no net at all, so it is foreign
      // to the pour even when its net name reads like ground.
      if (pad.connected !== false && pad.net === net) {
        groundPads.push(pad);
        continue;
      }
      const reach = padCopperRadius(pad) + keepOut;
      block(pad.x - reach, pad.y - reach, pad.x + reach, pad.y + reach,
        (x, y) => padCopperDistance(pad, x, y) < keepOut);
    }
  }

  const groundVias = [];
  for (const via of layout.vias || []) {
    const radius = (via.diameter ?? rules.viaDiameter) / 2;
    if (via.net === net) {
      groundVias.push({ x: via.x, y: via.y, radius });
      continue;
    }
    const reach = radius + keepOut;
    block(via.x - reach, via.y - reach, via.x + reach, via.y + reach,
      (x, y) => Math.hypot(x - via.x, y - via.y) - radius < keepOut);
  }

  for (const trace of layout.traces || []) {
    // Pads and vias are copper on both layers; a trace is only on its own.
    if (trace.layer !== 'bottom') continue;
    if (trace.net === net) continue;
    const half = (trace.width ?? rules.traceWidth) / 2;
    const reach = half + keepOut;
    const { from, to } = trace;
    block(
      Math.min(from.x, to.x) - reach, Math.min(from.y, to.y) - reach,
      Math.max(from.x, to.x) + reach, Math.max(from.y, to.y) + reach,
      (x, y) => distanceToSegment(x, y, from.x, from.y, to.x, to.y) - half < keepOut,
    );
  }

  /* --- flood fill from the ground copper ---------------------------- */

  const reached = new Uint8Array(cols * rows);
  const queue = [];
  const seed = (index) => {
    if (!pourable[index] || reached[index]) return;
    reached[index] = 1;
    queue.push(index);
  };
  /** Every cell whose centre physically lands on a piece of ground copper. */
  const seedAround = (x, y, radius, onCopper) => {
    const fromCol = Math.max(0, Math.ceil((x - radius) / step - 0.5));
    const toCol = Math.min(cols - 1, Math.floor((x + radius) / step - 0.5));
    const fromRow = Math.max(0, Math.ceil((y - radius) / step - 0.5));
    const toRow = Math.min(rows - 1, Math.floor((y + radius) / step - 0.5));
    for (let row = fromRow; row <= toRow; row += 1) {
      for (let col = fromCol; col <= toCol; col += 1) {
        if (onCopper(centreX(col), centreY(row))) seed(at(col, row));
      }
    }
  };

  for (const pad of groundPads) {
    const radius = padCopperRadius(pad);
    seedAround(pad.x, pad.y, radius, (x, y) => padCopperDistance(pad, x, y) <= 0);
  }
  for (const via of groundVias) {
    seedAround(via.x, via.y, via.radius, (x, y) => Math.hypot(x - via.x, y - via.y) <= via.radius);
  }

  for (let head = 0; head < queue.length; head += 1) {
    const index = queue[head];
    const col = index % cols;
    const row = (index - col) / cols;
    if (col > 0) seed(index - 1);
    if (col < cols - 1) seed(index + 1);
    if (row > 0) seed(index - cols);
    if (row < rows - 1) seed(index + cols);
  }

  /* --- rectangles --------------------------------------------------- */

  const polygons = [];
  const emit = (fromCol, toCol, fromRow, toRow) => {
    const x0 = round3(fromCol * step);
    const x1 = round3((toCol + 1) * step);
    const y0 = round3(fromRow * step);
    const y1 = round3((toRow + 1) * step);
    polygons.push([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]);
  };

  // A run is keyed by its column span, so a run that repeats identically on the
  // next row simply extends the open rectangle instead of starting a new one.
  let open = new Map();
  for (let row = 0; row < rows; row += 1) {
    const next = new Map();
    let start = -1;
    for (let col = 0; col <= cols; col += 1) {
      const on = col < cols && reached[at(col, row)] === 1;
      if (on && start < 0) start = col;
      if (!on && start >= 0) {
        const key = `${start}:${col - 1}`;
        next.set(key, { fromCol: start, toCol: col - 1, fromRow: open.get(key)?.fromRow ?? row });
        start = -1;
      }
    }
    for (const [key, rectangle] of open) {
      if (!next.has(key)) emit(rectangle.fromCol, rectangle.toCol, rectangle.fromRow, row - 1);
    }
    open = next;
  }
  for (const rectangle of open.values()) {
    emit(rectangle.fromCol, rectangle.toCol, rectangle.fromRow, rows - 1);
  }

  if (!polygons.length) return null;
  // Canonical row-major order, independent of how the run bookkeeping above
  // happened to close its rectangles.
  polygons.sort((a, b) => (a[0].y - b[0].y) || (a[0].x - b[0].x));

  return { net, layer: 'bottom', connect: 'direct', polygons };
};
