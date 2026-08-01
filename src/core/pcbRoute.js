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
// Pads and vias are round obstacles that do not sit on the grid, and there the
// interior of a segment can dip closer than either endpoint. Circles therefore
// get the exact "sag" correction sqrt(R^2 + (pitch/2)^2) — the closest a unit
// grid edge with both ends at distance R can come to a point.
//
// The other subtlety is pad escape. A pad's terminal cell is always available
// to its own net even if foreign copper stamped over it, otherwise a pad could
// never be reached. To keep that exception safe, every foreign pad is stamped
// twice: once around its copper, and once as a `traceWidth + clearance` disk
// around *its* terminal cell, because a trace may leave that cell in any
// direction. A pad whose terminal cell cannot clear foreign pad copper at full
// trace width is reported as `no_escape` rather than routed into a short.
//
// Pad copper is modelled two different ways, on purpose:
//
// * as KEEP-OUT, a pad is its circumscribing circle (padCopperRadius:
//   hypot(w,h)/2 for rect pads, max(w,h)/2 otherwise). That never
//   under-reports copper, so anything the router routes around is genuinely
//   clear and pcbDrc.js — which measures the exact outline — can only ever
//   agree. The one place the conservatism bites is very tight footprints such
//   as TO-92_Inline (1.27 mm pitch), whose middle pad has no room for a 0.8 mm
//   escape at all; those come back as `no_escape` instead of a silent short.
// * as CONTAINMENT ("is this cell on the pad?"), a pad is its exact outline
//   (padCopperDistance). The circle is unusable here: it reaches past the
//   copper, so a terminal cell chosen inside it can sit off the pad entirely.
//
// Everything is deterministic: no RNG, no clock, and every heap comparison and
// iteration order carries an explicit total-order tiebreaker.
//
// All dimensions are millimetres, y-down.
import { RULES, padCopperDistance, padCopperRadius } from './pcbDesignRules.js';

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
  const traceHalf = rules.traceWidth / 2;
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
        // Keep-out radius (over-approximates the copper) for obstacle
        // stamping; `record` keeps the pad itself so the terminal cell can be
        // tested against the pad's exact outline.
        radius: padCopperRadius(pad),
        record: pad,
      });
    }
  }

  /* --- terminal cells --------------------------------------------- */

  // A pad's terminal is the cell inside its copper that keeps the most room to
  // foreign pad copper (ties: closest to the pad centre, then top-most, then
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
        let room = Infinity;
        for (const other of pads) {
          if (other.netKey === pad.netKey) continue;
          room = Math.min(room, Math.hypot(cellX(col) - other.x, cellY(row) - other.y) - other.radius);
        }
        candidates.push({ col, row, distance, room });
      }
    }
    candidates.sort((a, b) => (b.room - a.room) || (a.distance - b.distance) || (a.row - b.row) || (a.col - b.col));
    // `room` is measured to the escape cell's CENTRE, but the first hop out of
    // it runs along a grid edge whose interior can sag closer to a foreign
    // pad than either endpoint (see the sag correction above). The exact
    // worst case is pitch*3/8; hypot(clearance + traceHalf, pitch/2) is the
    // simpler safe bound (it's the sag distance for an edge whose endpoint is
    // already exactly `needed` away), so require room against that instead of
    // the bare centre-to-centre distance.
    const needed = Math.hypot(rules.clearance + traceHalf, halfCell);
    const pick = candidates.find((candidate) => {
      const owner = claimed.get(cellIndex(candidate.col, candidate.row));
      return owner === undefined || owner === pad.netKey;
    });
    if (!pick) {
      pad.escape = null;
      continue;
    }
    claimed.set(cellIndex(pick.col, pick.row), pad.netKey);
    pad.escape = { col: pick.col, row: pick.row, ok: pick.room >= needed - EPSILON };
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

  const edgeTemplateTrace = new Int32Array(nodeCount).fill(FREE);
  const edgeTemplateVia = new Int32Array(cellCount).fill(FREE);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = cellX(col);
      const y = cellY(row);
      const margin = Math.min(x, y, board.width - x, board.height - y);
      const cell = cellIndex(col, row);
      if (margin < rules.edgeClearance + traceHalf - EPSILON) {
        edgeTemplateTrace[cell] = EDGE_OWNER;
        edgeTemplateTrace[cell + cellCount] = EDGE_OWNER;
      }
      if (margin < rules.edgeClearance + viaRadius - EPSILON) edgeTemplateVia[cell] = EDGE_OWNER;
    }
  }

  const blockTrace = new Int32Array(nodeCount);
  const blockVia = new Int32Array(cellCount);

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

  const stampSegment = (segment, owner) => {
    const traceRadius = traceHalf + rules.clearance + traceHalf;
    const viaRadiusLimit = viaRadius + rules.clearance + traceHalf;
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

  /** Rebuilds both obstacle masks from the copper of every net but `netKey`. */
  const buildMasks = (netKey) => {
    blockTrace.set(edgeTemplateTrace);
    blockVia.set(edgeTemplateVia);

    for (const pad of pads) {
      if (pad.netKey === netKey) continue;
      const owner = ownerIdFor(pad.netKey);
      // Pad copper, with the exact sag correction for a round obstacle.
      const padTrace = Math.hypot(pad.radius + rules.clearance + traceHalf, halfCell);
      stampDisk(pad.x, pad.y, padTrace, pad.radius + rules.clearance + viaRadius, owner, BOTH_LAYERS);
      // The pad's own escape cell, which its net may always use.
      if (!pad.escape) continue;
      stampDisk(
        cellX(pad.escape.col), cellY(pad.escape.row),
        traceHalf + rules.clearance + traceHalf,
        viaRadius + rules.clearance + traceHalf,
        owner, BOTH_LAYERS,
      );
    }

    for (const item of copper) {
      if (item.netKey === netKey) continue;
      const owner = ownerIdFor(item.netKey);
      if (item.kind === 'via') {
        stampDisk(
          item.x, item.y,
          viaRadius + rules.clearance + traceHalf,
          viaRadius + rules.clearance + viaRadius,
          owner, BOTH_LAYERS,
        );
      } else if (item.kind === 'segment') {
        stampSegment(item, owner);
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

  const search = (sourceNodes, goalNodes) => {
    state.fill(0);
    isGoal.fill(0);
    isSource.fill(0);

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
          if (blockTrace[next] !== FREE && !isSource[next] && !isGoal[next]) continue;
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

    if (fromIsland === undefined || toIsland === undefined
      || !job.from.escape?.ok || !job.to.escape?.ok) {
      failedJobs.push({ job, reason: 'no_escape' });
      continue;
    }
    if (fromIsland === toIsland) continue;

    buildMasks(netKey);
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

    const found = search(sources, goals);
    if (found.ok) {
      commitPath(found.node, job, fromIsland);
      relabel(netKey, toIsland, fromIsland);
      continue;
    }

    const blockers = blockingNets(found.closed, netKey);
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
        // Only nets with copper on the board are worth ripping.
        if (!copper.some((item) => item.netKey === name && item.kind !== 'pad')) continue;
        counts.set(name, (counts.get(name) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => (b[1] - a[1]) || compareStrings(a[0], b[0]))
      .slice(0, 2)
      .map(([name]) => name);
  }

  /** Turns an A* result into maximal straight segments plus layer-change vias. */
  function commitPath(goalNode, job, island) {
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
        emitRun(netKey, path[runStart], path[index - 1], island);
        emitVia(netKey, path[index - 1], island);
        runStart = index;
        continue;
      }
      const last = index === path.length - 1;
      const bend = !last
        && (path[index + 1] % cellCount) !== (path[index] % cellCount)
        && !sameDirection(path[index - 1], path[index], path[index + 1]);
      if (last || bend) {
        emitRun(netKey, path[runStart], path[index], island);
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

  function emitRun(netKey, startNode, endNode, island) {
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
      width: rules.traceWidth,
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
