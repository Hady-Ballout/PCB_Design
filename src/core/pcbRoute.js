// Clearance-aware two-layer maze router.
//
// Copper is laid on a `RULES.gridPitch` grid (2.54/4, so through-hole pads sit
// a whole number of steps apart) with an A* search per two-terminal job. Nets
// are decomposed into jobs by a Manhattan MST over their pads; a job's goal is
// every cell already electrically on the net, so later joins land as
// T-junctions instead of doubling back to a pad.
//
// Why a grid router can be trusted to be DRC-clean
// ------------------------------------------------
// Every routed segment runs between adjacent cell centres, so all copper the
// router creates is grid-aligned. For two grid-aligned segments the minimum
// distance is always attained at cell centres (the perpendicular foot of a
// grid node onto a unit grid edge is itself a grid node), so testing cell
// centres against other traces is *exact*, not approximate.
//
// Pads do not sit on the grid, and there the interior of a segment can dip
// closer than either endpoint, so cell-centre testing needs a "sag" correction.
//
// The sag lemma, for an arbitrary obstacle set K (this is the generalisation
// that lets pads be stamped as stadiums and rectangles rather than discs):
//
//   let A, B be the ends of a grid edge, |AB| = p, with dist(A,K), dist(B,K)
//   >= D.  Let M be the point of AB closest to K and P in K its nearest point,
//   so dist(M,K) = |MP|.  Since P is IN K, |AP| >= dist(A,K) >= D and likewise
//   |BP| >= D.  Drop the perpendicular from P to line AB, foot F, height h.
//   If F is outside AB then min |x - P| over AB is |AP| or |BP| >= D.  If F is
//   inside then min(|AF|,|FB|) <= p/2, and D^2 <= h^2 + min(|AF|,|FB|)^2
//   <= h^2 + (p/2)^2, so h >= sqrt(D^2 - (p/2)^2).  Either way
//
//       dist(M,K) = |MP| >= min over AB of |x - P| >= sqrt(D^2 - (p/2)^2).
//
// Nothing in that argument needs K to be a disc, or even convex. Inverting it:
// to guarantee `need` of clearance along the whole edge, stamp every cell whose
// distance to K is below sqrt(need^2 + (p/2)^2).
//
// Applying it to a pad, K is the pad's CORE (padCoreDistance) — a rectangle for
// a rect pad, the segment between the foci for an oval, a point for a circle —
// and the copper is that core inflated by `r`. So a cell is blocked when
//
//       padCoreDistance(pad, cell) < hypot(r + clearance + traceHalf, pitch/2).
//
// Keeping `r` INSIDE the hypot is the whole point of modelling the shape:
// hypot(r + C, p/2) < r + hypot(C, p/2), and for a TO-92 pad (r = 0.525) that
// difference is 0.05 mm — the entire escape corridor out of its middle pin.
// Modelling the same pad as its circumscribing disc (r = max(w,h)/2 = 0.75)
// costs another 0.225 mm on top.
//
// Vias, and the escape-cell disks below, sit ON grid nodes, and the closest
// point of a grid edge to a grid node is itself a grid node — so those need no
// sag correction at all and `stampDisk` tests cell centres directly.
//
// The other subtlety is pad escape. A pad's terminal cell is always available
// to its own net even if foreign copper stamped over it, otherwise a pad could
// never be reached. To keep that exception safe, every foreign pad is stamped
// twice: once around its copper, and once as a `traceWidth + clearance` disk
// around *its* terminal cell, because a trace may leave that cell in any
// direction and at any width up to the full one.
//
// Neck-down
// ---------
// A pad's terminal cell records `limit`, the widest trace half-width that can
// both sit on it and leave it (the sag bound above, inverted against every
// foreign pad). A job is tried at `RULES.traceWidth` and steps down
// `RULES.traceWidthLadder` only when a rung's escape or search fails; the mask
// is rebuilt for the width actually being laid, which is where the benefit
// comes from — a narrower trace inflates every obstacle less. Other nets' laid
// copper always contributes its OWN real width to that mask, so a neck is never
// bought at a neighbour's expense. Width is picked per job, so one two-terminal
// connection is one uniform width, and every emitted trace carries it. A pad
// that cannot escape at the narrowest rung is reported `no_escape` rather than
// routed into a short.
//
// Pad copper is shape-exact everywhere it matters — as KEEP-OUT through
// `padCoreDistance` + the sag bound above, and as CONTAINMENT ("is this cell on
// the pad?") through `padCopperDistance`. `padCopperRadius`'s circumscribing
// circle survives only as a cheap bounding radius for candidate-cell scans, and
// is never the thing that decides whether copper may be laid.
//
// Everything is deterministic: no RNG, no clock, and every heap comparison and
// iteration order carries an explicit total-order tiebreaker.
//
// All dimensions are millimetres, y-down.
import {
  RULES, padCopperDistance, padCopperRadius, padCopperShape, padCoreDistance,
} from './pcbDesignRules.js';

/**
 * Net names a ground pour would claim. Exported because the copper pour needs
 * exactly the same notion of "ground" that the router uses when it pushes
 * these nets to the back of the routing order.
 */
export const GROUND_NET_RE = /^(gnd|ground|0)$/i;

const RIGHT = 0;
const LEFT = 1;
const DOWN = 2;
const UP = 3;
const VIA = 4;
const NO_DIRECTION = 5;

const LAYER_NAMES = ['top', 'bottom'];

/** Cost knobs, in grid steps. */
const VIA_COST = 8;
const BEND_COST = 0.5;
const OFF_PREFERENCE_COST = 0.5;

/** Board edge marker in the obstacle masks (never rippable). */
const EDGE_OWNER = -2;
const FREE = -1;

/** Total rip-up-and-retry events allowed for one board. */
const MAX_RIP_UPS = 2;

const EPSILON = 1e-9;

const round3 = (value) => Math.round(value * 1000) / 1000;

const compareStrings = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ------------------------------------------------------------------ */
/* Minimum spanning tree                                               */
/* ------------------------------------------------------------------ */

/**
 * Minimum spanning tree over a net's pads (Prim, Manhattan distance), so every
 * pad is reached with short, non-redundant copper. Returns index pairs into
 * `pads`, in the order Prim added them.
 *
 * @param {Array<{ x: number, y: number }>} pads
 * @returns {Array<{ from: number, to: number, length: number }>}
 */
export const spanningEdges = (pads) => {
  if (pads.length < 2) return [];
  const inTree = [0];
  const remaining = pads.map((_, index) => index).slice(1);
  const edges = [];
  while (remaining.length) {
    let best = null;
    for (const candidate of remaining) {
      for (const anchor of inTree) {
        const length = Math.abs(pads[candidate].x - pads[anchor].x)
          + Math.abs(pads[candidate].y - pads[anchor].y);
        if (!best || length < best.length - EPSILON) best = { from: anchor, to: candidate, length };
      }
    }
    edges.push(best);
    inTree.push(best.to);
    remaining.splice(remaining.indexOf(best.to), 1);
  }
  return edges;
};

/* ------------------------------------------------------------------ */
/* Grid                                                                */
/* ------------------------------------------------------------------ */

const distanceToSegment = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
};

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

/**
 * Routes every multi-pad net on a placed board.
 *
 * @param {{ components: Array<object>, board: { width: number, height: number } }} input
 *   `components` is the layout components array, with absolute pad positions.
 * @param {import('./pcbDesignRules.js').DesignRules} [rules]
 * @returns {{ traces: Array<{ layer: string, net: string, from: { x: number, y: number },
 *   to: { x: number, y: number }, width: number }>,
 *   vias: Array<{ x: number, y: number, net: string, diameter: number, drill: number }>,
 *   failedNets: Array<{ net: string, from: { x: number, y: number },
 *     to: { x: number, y: number }, reason: string }> }}
 */
export const routeBoard = ({ components = [], board }, rules = RULES) => {
  const pitch = rules.gridPitch;
  // The widest any trace on this board may be. It is what a job is tried at
  // first, and — because a foreign pad's escape trace has not been laid yet and
  // could still come out at full width — what foreign escape cells are
  // protected against regardless of how narrow the current job is.
  const fullHalf = rules.traceWidth / 2;
  const widthLadder = (rules.traceWidthLadder?.length ? rules.traceWidthLadder : [rules.traceWidth]);
  const viaRadius = rules.viaDiameter / 2;
  const halfCell = pitch / 2;

  const cols = Math.floor(board.width / pitch + EPSILON) + 1;
  const rows = Math.floor(board.height / pitch + EPSILON) + 1;
  const cellCount = cols * rows;
  const nodeCount = cellCount * 2;

  const cellX = (col) => col * pitch;
  const cellY = (row) => row * pitch;
  const cellIndex = (col, row) => row * cols + col;

  /* --- copper inventory ------------------------------------------- */

  // Pads keep the layout's net name for reporting, but unwired terminals get
  // a private key so they can never be mistaken for a routable net.
  const pads = [];
  for (const component of components) {
    for (const pad of component.pads || []) {
      const wired = pad.connected !== false;
      pads.push({
        index: pads.length,
        ref: component.ref,
        net: pad.net,
        netKey: wired ? pad.net : `#nc:${component.ref}:${pad.padNumber ?? pads.length}`,
        wired,
        x: pad.x,
        y: pad.y,
        // `shape` is the exact copper (convex core + inflation radius) and is
        // what stamps obstacles and measures escape room; `radius` is the
        // circumscribing circle, kept only to size candidate-cell scans.
        shape: padCopperShape(pad),
        radius: padCopperRadius(pad),
        record: pad,
      });
    }
  }

  /* --- terminal cells --------------------------------------------- */

  // A pad's terminal is the cell inside its copper that can escape at the
  // widest trace (ties: closest to the pad centre, then top-most, then
  // left-most). Picking the roomiest cell is what lets a DIP pin escape
  // between its neighbours instead of dead-ending.
  //
  // "Inside its copper" has to be measured against the pad's EXACT outline
  // (padCopperDistance), not the circumscribing circle padCopperRadius
  // reports. The circle is the right model for keep-out — it never
  // under-reports copper — but as a containment test it over-reaches: a 3x3 mm
  // rect pad's circle stretches 0.62 mm past the pad edge at the diagonal, and
  // because the sort below prefers the cell with the MOST room it actively
  // seeks out the outermost candidate. A terminal cell off the copper is a
  // trace that physically misses the pad while every downstream check, working
  // from the same circle, still calls the net connected.
  const claimed = new Map();
  for (const pad of pads) {
    if (!pad.wired) continue;
    const candidates = [];
    const span = Math.ceil(Math.max(pad.radius, halfCell) / pitch) + 1;
    const centreCol = Math.round(pad.x / pitch);
    const centreRow = Math.round(pad.y / pitch);
    for (let row = centreRow - span; row <= centreRow + span; row += 1) {
      for (let col = centreCol - span; col <= centreCol + span; col += 1) {
        if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
        if (padCopperDistance(pad.record, cellX(col), cellY(row)) > EPSILON) continue;
        const distance = Math.hypot(cellX(col) - pad.x, cellY(row) - pad.y);
        // How wide a trace this cell could carry: invert the sag bound per
        // foreign pad. A grid edge leaving the cell keeps
        // sqrt(coreDistance^2 - (pitch/2)^2) of core distance along its whole
        // length, of which r + clearance is spoken for, and the rest is the
        // trace's half-width. Taking the minimum over foreign pads makes
        // `limit` the widest half-width the cell can escape at — which is both
        // the ranking key and, once the width ladder exists, the acceptance
        // test at each rung.
        let limit = Infinity;
        for (const other of pads) {
          if (other.netKey === pad.netKey) continue;
          const core = padCoreDistance(other.shape, cellX(col), cellY(row));
          const along = Math.sqrt(Math.max(0, core * core - halfCell * halfCell));
          limit = Math.min(limit, along - other.shape.r - rules.clearance);
        }
        candidates.push({ col, row, distance, limit });
      }
    }
    candidates.sort((a, b) => (b.limit - a.limit) || (a.distance - b.distance)
      || (a.row - b.row) || (a.col - b.col));
    const pick = candidates.find((candidate) => {
      const owner = claimed.get(cellIndex(candidate.col, candidate.row));
      return owner === undefined || owner === pad.netKey;
    });
    if (!pick) {
      pad.escape = null;
      continue;
    }
    claimed.set(cellIndex(pick.col, pick.row), pad.netKey);
    pad.escape = { col: pick.col, row: pick.row, limit: pick.limit };
  }

  /* --- nets -------------------------------------------------------- */

  const netPads = new Map();
  for (const pad of pads) {
    if (!pad.wired) continue;
    if (!netPads.has(pad.netKey)) netPads.set(pad.netKey, []);
    netPads.get(pad.netKey).push(pad);
  }

  const nets = [];
  for (const [name, members] of netPads) {
    if (members.length < 2) continue;
    const edges = spanningEdges(members);
    nets.push({
      name,
      pads: members,
      edges,
      length: edges.reduce((total, edge) => total + edge.length, 0),
      ground: GROUND_NET_RE.test(name),
    });
  }
  // Short nets first (they have the least freedom), ground-like rails last so
  // the signal nets get the clean channels.
  nets.sort((a, b) => (Number(a.ground) - Number(b.ground))
    || (a.length - b.length)
    || compareStrings(a.name, b.name));
  nets.forEach((net, order) => { net.order = order; });

  const netByName = new Map(nets.map((net) => [net.name, net]));

  // Obstacle owners are indexed by net order; unwired pads and nets that need
  // no routing share the "not rippable" slot list below.
  const ownerIds = new Map();
  const ownerIdFor = (netKey) => {
    if (!ownerIds.has(netKey)) ownerIds.set(netKey, ownerIds.size);
    return ownerIds.get(netKey);
  };
  const ownerNames = [];
  for (const pad of pads) {
    if (ownerIds.has(pad.netKey)) continue;
    ownerNames[ownerIdFor(pad.netKey)] = pad.netKey;
  }

  /* --- copper store ------------------------------------------------ */

  // Every routed item records the exact cells it covers, so "already on this
  // net" is an exact cell-set question rather than a geometric guess.
  let copperSerial = 0;
  const copper = [];
  for (const pad of pads) {
    if (!pad.wired || !pad.escape) continue;
    const cell = cellIndex(pad.escape.col, pad.escape.row);
    copper.push({
      serial: copperSerial += 1,
      kind: 'pad',
      netKey: pad.netKey,
      pad,
      island: pad.index,
      cells: [cell, cell + cellCount],
    });
  }

  const islandOf = (pad) => copper.find((item) => item.kind === 'pad' && item.pad === pad)?.island;

  /* --- masks ------------------------------------------------------- */

  // Board-edge keep-out. Along a grid edge the distance to the outline is
  // linear in the one coordinate that varies, so it is minimised at an endpoint
  // and cell-centre testing is exact — no sag term. The trace template depends
  // on the width being laid, so there is one per ladder rung.
  const edgeTemplates = new Map();
  const edgeTemplateTraceFor = (half) => {
    let template = edgeTemplates.get(half);
    if (template) return template;
    template = new Int32Array(nodeCount).fill(FREE);
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const margin = Math.min(cellX(col), cellY(row),
          board.width - cellX(col), board.height - cellY(row));
        if (margin >= rules.edgeClearance + half - EPSILON) continue;
        const cell = cellIndex(col, row);
        template[cell] = EDGE_OWNER;
        template[cell + cellCount] = EDGE_OWNER;
      }
    }
    edgeTemplates.set(half, template);
    return template;
  };
  const edgeTemplateVia = new Int32Array(cellCount).fill(FREE);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const margin = Math.min(cellX(col), cellY(row),
        board.width - cellX(col), board.height - cellY(row));
      if (margin < rules.edgeClearance + viaRadius - EPSILON) edgeTemplateVia[cellIndex(col, row)] = EDGE_OWNER;
    }
  }

  const blockTrace = new Int32Array(nodeCount);
  const blockVia = new Int32Array(cellCount);

  /**
   * Pad keep-out, measured against the pad's exact core (see the sag lemma in
   * the header). `traceNeed` carries the sag correction because a pad is not on
   * the grid; `viaNeed` does not, because a via is a disc centred on a grid
   * node and the nearest point of a grid edge to a grid node is a grid node.
   */
  const stampPad = (shape, owner, half) => {
    const traceNeed = Math.hypot(shape.r + rules.clearance + half, halfCell);
    const viaNeed = shape.r + rules.clearance + viaRadius;
    const reach = Math.max(traceNeed, viaNeed);
    const minCol = Math.max(0, Math.ceil((shape.x - shape.hw - shape.hh - reach) / pitch));
    const maxCol = Math.min(cols - 1, Math.floor((shape.x + shape.hw + shape.hh + reach) / pitch));
    const minRow = Math.max(0, Math.ceil((shape.y - shape.hw - shape.hh - reach) / pitch));
    const maxRow = Math.min(rows - 1, Math.floor((shape.y + shape.hw + shape.hh + reach) / pitch));
    for (let row = minRow; row <= maxRow; row += 1) {
      for (let col = minCol; col <= maxCol; col += 1) {
        const distance = padCoreDistance(shape, cellX(col), cellY(row));
        const cell = cellIndex(col, row);
        if (distance < traceNeed - EPSILON) {
          for (const layer of BOTH_LAYERS) {
            const node = cell + layer * cellCount;
            if (blockTrace[node] === FREE) blockTrace[node] = owner;
          }
        }
        if (distance < viaNeed - EPSILON && blockVia[cell] === FREE) blockVia[cell] = owner;
      }
    }
  };

  const stampDisk = (cx, cy, traceRadius, viaRadiusLimit, owner, layers) => {
    const radius = Math.max(traceRadius, viaRadiusLimit);
    const minCol = Math.max(0, Math.ceil((cx - radius) / pitch));
    const maxCol = Math.min(cols - 1, Math.floor((cx + radius) / pitch));
    const minRow = Math.max(0, Math.ceil((cy - radius) / pitch));
    const maxRow = Math.min(rows - 1, Math.floor((cy + radius) / pitch));
    for (let row = minRow; row <= maxRow; row += 1) {
      for (let col = minCol; col <= maxCol; col += 1) {
        const distance = Math.hypot(cellX(col) - cx, cellY(row) - cy);
        const cell = cellIndex(col, row);
        if (distance < traceRadius - EPSILON) {
          for (const layer of layers) {
            const node = cell + layer * cellCount;
            if (blockTrace[node] === FREE) blockTrace[node] = owner;
          }
        }
        if (distance < viaRadiusLimit - EPSILON && blockVia[cell] === FREE) blockVia[cell] = owner;
      }
    }
  };

  // `segment.half` is the laid trace's OWN half-width; `half` is the width the
  // current job is being laid at. A neck buys the current job a smaller mask,
  // never a discount on copper that is already on the board.
  const stampSegment = (segment, owner, half) => {
    const traceRadius = segment.half + rules.clearance + half;
    const viaRadiusLimit = viaRadius + rules.clearance + segment.half;
    const radius = Math.max(traceRadius, viaRadiusLimit);
    const minCol = Math.max(0, Math.ceil((Math.min(segment.ax, segment.bx) - radius) / pitch));
    const maxCol = Math.min(cols - 1, Math.floor((Math.max(segment.ax, segment.bx) + radius) / pitch));
    const minRow = Math.max(0, Math.ceil((Math.min(segment.ay, segment.by) - radius) / pitch));
    const maxRow = Math.min(rows - 1, Math.floor((Math.max(segment.ay, segment.by) + radius) / pitch));
    for (let row = minRow; row <= maxRow; row += 1) {
      for (let col = minCol; col <= maxCol; col += 1) {
        const distance = distanceToSegment(cellX(col), cellY(row), segment.ax, segment.ay, segment.bx, segment.by);
        const cell = cellIndex(col, row);
        if (distance < traceRadius - EPSILON) {
          const node = cell + segment.layer * cellCount;
          if (blockTrace[node] === FREE) blockTrace[node] = owner;
        }
        if (distance < viaRadiusLimit - EPSILON && blockVia[cell] === FREE) blockVia[cell] = owner;
      }
    }
  };

  const BOTH_LAYERS = [0, 1];

  /**
   * Rebuilds both obstacle masks from the copper of every net but `netKey`, for
   * a job about to be laid at half-width `half`.
   */
  const buildMasks = (netKey, half) => {
    blockTrace.set(edgeTemplateTraceFor(half));
    blockVia.set(edgeTemplateVia);

    for (const pad of pads) {
      if (pad.netKey === netKey) continue;
      const owner = ownerIdFor(pad.netKey);
      stampPad(pad.shape, owner, half);
      // The pad's own escape cell, which its net may always use — and may still
      // leave at FULL width in any direction, so this disk is sized on
      // `fullHalf` rather than on whatever the current job necked down to.
      if (!pad.escape) continue;
      stampDisk(
        cellX(pad.escape.col), cellY(pad.escape.row),
        half + rules.clearance + fullHalf,
        viaRadius + rules.clearance + fullHalf,
        owner, BOTH_LAYERS,
      );
    }

    for (const item of copper) {
      if (item.netKey === netKey) continue;
      const owner = ownerIdFor(item.netKey);
      if (item.kind === 'via') {
        stampDisk(
          item.x, item.y,
          viaRadius + rules.clearance + half,
          viaRadius + rules.clearance + viaRadius,
          owner, BOTH_LAYERS,
        );
      } else if (item.kind === 'segment') {
        stampSegment(item, owner, half);
      }
    }
  };

  /* --- A* ---------------------------------------------------------- */

  const gScore = new Float64Array(nodeCount);
  const fScore = new Float64Array(nodeCount);
  const heuristic = new Int32Array(cellCount);
  const cameFrom = new Int32Array(nodeCount);
  const cameDirection = new Int8Array(nodeCount);
  const state = new Uint8Array(nodeCount); // 0 unseen, 1 open, 2 closed
  const isGoal = new Uint8Array(nodeCount);
  const isSource = new Uint8Array(nodeCount);
  const isTerminal = new Uint8Array(nodeCount);
  const heap = [];

  const rowOf = (node) => Math.floor((node % cellCount) / cols);
  const colOf = (node) => (node % cellCount) % cols;

  const precedes = (a, b) => {
    if (fScore[a] !== fScore[b]) return fScore[a] < fScore[b];
    const ha = heuristic[a % cellCount];
    const hb = heuristic[b % cellCount];
    if (ha !== hb) return ha < hb;
    const ra = rowOf(a);
    const rb = rowOf(b);
    if (ra !== rb) return ra < rb;
    const ca = colOf(a);
    const cb = colOf(b);
    if (ca !== cb) return ca < cb;
    return a < b;
  };

  const search = (sourceNodes, goalNodes, terminalNodes) => {
    state.fill(0);
    isGoal.fill(0);
    isSource.fill(0);
    isTerminal.fill(0);
    for (const node of terminalNodes) isTerminal[node] = 1;

    // Exact L1 distance in cells to the nearest goal cell (two-pass chamfer),
    // an admissible heuristic because no step costs less than 1 per cell.
    heuristic.fill(0x3fffffff);
    for (const node of goalNodes) {
      isGoal[node] = 1;
      heuristic[node % cellCount] = 0;
    }
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const cell = cellIndex(col, row);
        if (col > 0) heuristic[cell] = Math.min(heuristic[cell], heuristic[cell - 1] + 1);
        if (row > 0) heuristic[cell] = Math.min(heuristic[cell], heuristic[cell - cols] + 1);
      }
    }
    for (let row = rows - 1; row >= 0; row -= 1) {
      for (let col = cols - 1; col >= 0; col -= 1) {
        const cell = cellIndex(col, row);
        if (col < cols - 1) heuristic[cell] = Math.min(heuristic[cell], heuristic[cell + 1] + 1);
        if (row < rows - 1) heuristic[cell] = Math.min(heuristic[cell], heuristic[cell + cols] + 1);
      }
    }

    let heapSize = 0;
    heap.length = 0;
    const push = (node) => {
      let child = heapSize;
      heap[heapSize] = node;
      heapSize += 1;
      while (child > 0) {
        const parent = (child - 1) >> 1;
        if (!precedes(heap[child], heap[parent])) break;
        const swap = heap[parent];
        heap[parent] = heap[child];
        heap[child] = swap;
        child = parent;
      }
    };
    const pop = () => {
      const top = heap[0];
      heapSize -= 1;
      heap[0] = heap[heapSize];
      let parent = 0;
      for (;;) {
        const left = parent * 2 + 1;
        const right = left + 1;
        let best = parent;
        if (left < heapSize && precedes(heap[left], heap[best])) best = left;
        if (right < heapSize && precedes(heap[right], heap[best])) best = right;
        if (best === parent) break;
        const swap = heap[best];
        heap[best] = heap[parent];
        heap[parent] = swap;
        parent = best;
      }
      return top;
    };

    for (const node of sourceNodes) {
      isSource[node] = 1;
      gScore[node] = 0;
      fScore[node] = heuristic[node % cellCount];
      cameFrom[node] = -1;
      cameDirection[node] = NO_DIRECTION;
      state[node] = 1;
    }
    // Push in a fixed order so equal-priority sources always pop the same way.
    for (const node of [...sourceNodes].sort((a, b) => a - b)) push(node);

    const closed = [];
    while (heapSize > 0) {
      const current = pop();
      if (state[current] === 2) continue;
      state[current] = 2;
      closed.push(current);
      if (isGoal[current] && !isSource[current]) return { ok: true, node: current, closed };

      const cell = current % cellCount;
      const layer = current < cellCount ? 0 : 1;
      const col = cell % cols;
      const row = (cell - col) / cols;
      const previous = cameDirection[current];

      for (const direction of [RIGHT, LEFT, DOWN, UP, VIA]) {
        let next;
        let cost;
        if (direction === VIA) {
          // A via needs its own, larger disk clear on both layers; unlike a
          // trace cell it is never force-allowed onto a pad's escape cell.
          const other = layer === 0 ? cell + cellCount : cell;
          if (blockVia[cell] !== FREE) continue;
          if (blockTrace[other] !== FREE) continue;
          if (blockTrace[cell + layer * cellCount] !== FREE) continue;
          next = other;
          cost = VIA_COST;
        } else {
          const nextCol = col + (direction === RIGHT ? 1 : direction === LEFT ? -1 : 0);
          const nextRow = row + (direction === DOWN ? 1 : direction === UP ? -1 : 0);
          if (nextCol < 0 || nextRow < 0 || nextCol >= cols || nextRow >= rows) continue;
          next = cellIndex(nextCol, nextRow) + layer * cellCount;
          // The one force-allowed exception is a pad's TERMINAL cell, and only
          // against foreign copper: it is the pad's only way onto the grid, and
          // `escape.limit` has already proved that a trace of this width can
          // both sit there and leave it. It is not extended to the net's other
          // copper cells (a job at full width joining a necked run must clear
          // the mask at ITS width) and never to the board edge, which no
          // exception can make safe.
          if (blockTrace[next] !== FREE
            && (blockTrace[next] === EDGE_OWNER || !isTerminal[next])) continue;
          const vertical = direction === DOWN || direction === UP;
          const disfavoured = layer === 0 ? vertical : !vertical;
          cost = 1 + (disfavoured ? OFF_PREFERENCE_COST : 0)
            + (previous !== NO_DIRECTION && previous !== VIA && previous !== direction ? BEND_COST : 0);
        }
        if (state[next] === 2) continue;
        const tentative = gScore[current] + cost;
        if (state[next] === 1 && tentative >= gScore[next] - EPSILON) continue;
        gScore[next] = tentative;
        fScore[next] = tentative + heuristic[next % cellCount];
        cameFrom[next] = current;
        cameDirection[next] = direction;
        state[next] = 1;
        push(next);
      }
    }
    return { ok: false, closed };
  };

  /* --- routing loop ------------------------------------------------ */

  const traces = [];
  const vias = [];
  const failedNets = [];

  const jobs = [];
  for (const net of nets) {
    const ordered = [...net.edges].sort((a, b) => (a.length - b.length)
      || (net.pads[a.from].x - net.pads[b.from].x)
      || (net.pads[a.from].y - net.pads[b.from].y)
      || (net.pads[a.to].x - net.pads[b.to].x)
      || (net.pads[a.to].y - net.pads[b.to].y));
    for (const edge of ordered) {
      jobs.push({ id: jobs.length, net, from: net.pads[edge.from], to: net.pads[edge.to] });
    }
  }

  const relabel = (netKey, fromIsland, toIsland) => {
    for (const item of copper) {
      if (item.netKey === netKey && item.island === fromIsland) item.island = toIsland;
    }
  };

  const ripUp = (netKey) => {
    for (let index = copper.length - 1; index >= 0; index -= 1) {
      const item = copper[index];
      if (item.netKey !== netKey) continue;
      if (item.kind === 'pad') item.island = item.pad.index;
      else copper.splice(index, 1);
    }
  };

  const queue = jobs.slice();
  let ripUpsLeft = MAX_RIP_UPS;
  const failedJobs = [];

  while (queue.length) {
    const job = queue.shift();
    const netKey = job.net.name;
    const fromIsland = islandOf(job.from);
    const toIsland = islandOf(job.to);

    if (fromIsland === undefined || toIsland === undefined) {
      failedJobs.push({ job, reason: 'no_escape' });
      continue;
    }
    if (fromIsland === toIsland) continue;

    const sources = [];
    const goals = [];
    for (const item of copper) {
      if (item.netKey !== netKey) continue;
      if (item.island === fromIsland) sources.push(...item.cells);
      else if (item.island === toIsland) goals.push(...item.cells);
    }

    // Two pads close enough to share a terminal cell already share copper, so
    // there is nothing to route between them.
    const sourceCells = new Set(sources);
    if (goals.some((node) => sourceCells.has(node))) {
      relabel(netKey, toIsland, fromIsland);
      continue;
    }

    const terminals = [];
    for (const item of copper) {
      if (item.netKey !== netKey || item.kind !== 'pad') continue;
      if (item.island === fromIsland || item.island === toIsland) terminals.push(...item.cells);
    }

    // The neck-down ladder. Full width first, and a narrower rung only once the
    // wide one has genuinely failed — the narrower trace's payoff is a smaller
    // obstacle mask (stampPad/stampSegment are both parameterised on `half`),
    // which is exactly what opens a pad the wide trace could not leave. Width
    // is chosen per JOB, so a two-terminal connection is one uniform width.
    let laid = false;
    let closed = null;
    for (const width of widthLadder) {
      const half = width / 2;
      if (!(job.from.escape?.limit >= half - EPSILON)
        || !(job.to.escape?.limit >= half - EPSILON)) continue;
      buildMasks(netKey, half);
      const found = search(sources, goals, terminals);
      if (found.ok) {
        commitPath(found.node, job, fromIsland, width);
        relabel(netKey, toIsland, fromIsland);
        laid = true;
        break;
      }
      closed = found.closed;
    }
    if (laid) continue;
    // No rung even got as far as a search: both ends are walled in by their own
    // neighbours' copper, which no amount of retrying will change.
    if (!closed) {
      failedJobs.push({ job, reason: 'no_escape' });
      continue;
    }

    const blockers = blockingNets(closed, netKey);
    if (ripUpsLeft > 0 && blockers.length) {
      ripUpsLeft -= 1;
      for (const blocker of blockers) {
        ripUp(blocker);
        for (const other of jobs) if (other.net.name === blocker) queue.push(other);
      }
      queue.push(job);
      continue;
    }
    failedJobs.push({ job, reason: 'unroutable' });
  }

  /**
   * Nets whose copper walls in the search frontier: the two that own the most
   * blocked cells next to the closed set.
   */
  function blockingNets(closed, netKey) {
    const counts = new Map();
    // Only nets with copper on the board are worth ripping; compute that once
    // rather than re-scanning `copper` for every blocked cell in the frontier.
    const rippable = new Set();
    for (const item of copper) if (item.kind !== 'pad') rippable.add(item.netKey);
    for (const node of closed) {
      const cell = node % cellCount;
      const layer = node < cellCount ? 0 : 1;
      const col = cell % cols;
      const row = (cell - col) / cols;
      const neighbours = [
        col + 1 < cols ? cellIndex(col + 1, row) : -1,
        col - 1 >= 0 ? cellIndex(col - 1, row) : -1,
        row + 1 < rows ? cellIndex(col, row + 1) : -1,
        row - 1 >= 0 ? cellIndex(col, row - 1) : -1,
      ];
      for (const neighbour of neighbours) {
        if (neighbour < 0) continue;
        const owner = blockTrace[neighbour + layer * cellCount];
        if (owner < 0) continue;
        const name = ownerNames[owner];
        if (name === netKey || !netByName.has(name)) continue;
        if (!rippable.has(name)) continue;
        counts.set(name, (counts.get(name) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => (b[1] - a[1]) || compareStrings(a[0], b[0]))
      .slice(0, 2)
      .map(([name]) => name);
  }

  /** Turns an A* result into maximal straight segments plus layer-change vias. */
  function commitPath(goalNode, job, island, width) {
    const path = [];
    for (let node = goalNode; node !== -1; node = cameFrom[node]) path.push(node);
    path.reverse();
    if (path.length < 2) return;

    const netKey = job.net.name;
    let runStart = 0;
    for (let index = 1; index < path.length; index += 1) {
      // A layer change repeats the cell on the other layer: close the run on
      // the old layer, drop a via, and start again from the new layer.
      if ((path[index] % cellCount) === (path[index - 1] % cellCount)) {
        emitRun(netKey, path[runStart], path[index - 1], island, width);
        emitVia(netKey, path[index - 1], island);
        runStart = index;
        continue;
      }
      const last = index === path.length - 1;
      const bend = !last
        && (path[index + 1] % cellCount) !== (path[index] % cellCount)
        && !sameDirection(path[index - 1], path[index], path[index + 1]);
      if (last || bend) {
        emitRun(netKey, path[runStart], path[index], island, width);
        runStart = index;
      }
    }
  }

  function sameDirection(a, b, c) {
    const cellA = a % cellCount;
    const cellB = b % cellCount;
    const cellC = c % cellCount;
    return (cellB - cellA) === (cellC - cellB);
  }

  function emitRun(netKey, startNode, endNode, island, width) {
    if (startNode === endNode || (startNode % cellCount) === (endNode % cellCount)) return;
    const layer = startNode < cellCount ? 0 : 1;
    const startCell = startNode % cellCount;
    const endCell = endNode % cellCount;
    const startCol = startCell % cols;
    const startRow = (startCell - startCol) / cols;
    const endCol = endCell % cols;
    const endRow = (endCell - endCol) / cols;
    const cells = [];
    const stepCol = Math.sign(endCol - startCol);
    const stepRow = Math.sign(endRow - startRow);
    for (let col = startCol, row = startRow; ; col += stepCol, row += stepRow) {
      cells.push(cellIndex(col, row) + layer * cellCount);
      if (col === endCol && row === endRow) break;
    }
    copper.push({
      serial: copperSerial += 1,
      kind: 'segment',
      netKey,
      island,
      layer,
      width,
      half: width / 2,
      ax: cellX(startCol), ay: cellY(startRow),
      bx: cellX(endCol), by: cellY(endRow),
      cells,
    });
  }

  function emitVia(netKey, node, island) {
    const cell = node % cellCount;
    const col = cell % cols;
    const row = (cell - col) / cols;
    if (copper.some((item) => item.kind === 'via' && item.netKey === netKey
      && item.cells[0] === cell)) return;
    copper.push({
      serial: copperSerial += 1,
      kind: 'via',
      netKey,
      island,
      x: cellX(col), y: cellY(row),
      cells: [cell, cell + cellCount],
    });
  }

  /* --- output ------------------------------------------------------ */

  const displayNet = new Map(pads.map((pad) => [pad.netKey, pad.net]));

  const segments = copper.filter((item) => item.kind === 'segment')
    .sort((a, b) => a.serial - b.serial);
  for (const merged of mergeCollinear(segments, copper)) {
    traces.push({
      layer: LAYER_NAMES[merged.layer],
      net: displayNet.get(merged.netKey) ?? merged.netKey,
      from: { x: round3(merged.ax), y: round3(merged.ay) },
      to: { x: round3(merged.bx), y: round3(merged.by) },
      width: merged.width,
    });
  }

  for (const item of copper) {
    if (item.kind !== 'via') continue;
    vias.push({
      x: round3(item.x),
      y: round3(item.y),
      net: displayNet.get(item.netKey) ?? item.netKey,
      diameter: rules.viaDiameter,
      drill: rules.viaDrill,
    });
  }
  vias.sort((a, b) => compareStrings(a.net, b.net) || (a.y - b.y) || (a.x - b.x));

  // A job can be re-queued by someone else's rip-up and fail twice; report it
  // once, keeping the first reason recorded for it.
  const reportedJobs = new Set();
  for (const { job, reason } of failedJobs) {
    if (reportedJobs.has(job.id)) continue;
    reportedJobs.add(job.id);
    failedNets.push({
      net: job.net.pads[0].net,
      from: { x: round3(job.from.x), y: round3(job.from.y) },
      to: { x: round3(job.to.x), y: round3(job.to.y) },
      reason,
    });
  }
  failedNets.sort((a, b) => compareStrings(a.net, b.net)
    || (a.from.x - b.from.x) || (a.from.y - b.from.y)
    || (a.to.x - b.to.x) || (a.to.y - b.to.y));

  return { traces, vias, failedNets };
};

/**
 * Joins two collinear same-layer same-net segments that meet end-to-end, as
 * long as the shared point carries no via and no third segment (which would
 * make it a T-junction worth keeping visible).
 */
const mergeCollinear = (segments, copper) => {
  const merged = segments.map((segment) => ({ ...segment }));
  const endpointUses = new Map();
  const key = (x, y, layer, netKey) => `${round3(x)}:${round3(y)}:${layer}:${netKey}`;
  for (const segment of merged) {
    for (const point of [[segment.ax, segment.ay], [segment.bx, segment.by]]) {
      const id = key(point[0], point[1], segment.layer, segment.netKey);
      endpointUses.set(id, (endpointUses.get(id) || 0) + 1);
    }
  }
  const viaAt = new Set(copper.filter((item) => item.kind === 'via')
    .flatMap((item) => [0, 1].map((layer) => key(item.x, item.y, layer, item.netKey))));

  const horizontal = (segment) => Math.abs(segment.ay - segment.by) < EPSILON;
  const result = [];
  for (const segment of merged) {
    const previous = result[result.length - 1];
    const joinable = previous
      && previous.netKey === segment.netKey
      && previous.layer === segment.layer
      && previous.width === segment.width
      && horizontal(previous) === horizontal(segment)
      && Math.abs(previous.bx - segment.ax) < EPSILON
      && Math.abs(previous.by - segment.ay) < EPSILON
      && endpointUses.get(key(segment.ax, segment.ay, segment.layer, segment.netKey)) === 2
      && !viaAt.has(key(segment.ax, segment.ay, segment.layer, segment.netKey))
      && Math.sign(previous.bx - previous.ax) === Math.sign(segment.bx - segment.ax)
      && Math.sign(previous.by - previous.ay) === Math.sign(segment.by - segment.ay);
    if (joinable) {
      previous.bx = segment.bx;
      previous.by = segment.by;
      continue;
    }
    result.push(segment);
  }
  return result.filter((segment) => Math.abs(segment.ax - segment.bx) > EPSILON
    || Math.abs(segment.ay - segment.by) > EPSILON);
};
