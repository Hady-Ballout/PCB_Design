// Netlist-aware component placement for the procedural PCB pipeline.
//
// Footprint geometry comes from the vendored KiCad library via
// footprintRecordFor(); this module only decides where each footprint lands
// and how it is rotated. Placement is a deterministic greedy insertion: seed
// the densest part at the origin, then repeatedly place whichever remaining
// part is most strongly connected to what is already down, scanning a 1.27 mm
// grid outward from its connections for the lowest-wirelength spot that keeps
// a clearance gap from every placed courtyard.
//
// Everything here is pure and deterministic: no RNG, no clock, and every
// iteration order has an explicit tiebreaker, so the same circuit always
// produces byte-identical placements.
//
// All dimensions are millimetres, y-down (same convention as pcbLayout.js).
import { footprintRecordFor } from './pcbFootprints.js';

/** Courtyard-to-courtyard clearance between neighbouring parts (mm). */
export const PLACEMENT_GAP = 2.0;
/** Clearance from the outermost courtyard to the board edge (mm). */
export const BOARD_MARGIN = 4;

/** Candidate centres sit on a 0.05" grid — the classic THT placement pitch. */
const GRID = 1.27;
const ROTATIONS = [0, 90, 180, 270];
/**
 * Spiral bound: keep widening rings until one yields a collision-free
 * candidate, scan exactly one more ring for a better score, then stop. If
 * nothing is valid at all (only reachable with pathological geometry), give up
 * after this many candidate centres and fall back to appending the part to the
 * right of everything placed so far.
 */
const MAX_SCAN_CENTERS = 2000;
/**
 * Nets touching more than this many pads are power/ground rails: they connect
 * nearly everything, so counting them would flatten the connectivity graph.
 * They are ignored when ranking parts, not when scoring candidate positions.
 */
const MAX_NET_PADS_FOR_RANKING = 4;

const EPSILON = 1e-9;

const round = (value) => Math.round(value * 100) / 100;
const snap = (value) => Math.round(value / GRID) * GRID;

/**
 * A node that is not really wired anywhere: an explicit NC_* marker or the
 * auto-generated per-pin stub `${ref}_${pin}`.
 */
export const isUnconnectedTerminal = (node, ref, pin) =>
  /^NC_/i.test(String(node)) || String(node) === `${ref}_${pin}`;

/** Rotates a footprint-local offset by a multiple of 90° (y-down). */
export const rotateOffset = (point, rotation) => {
  switch (((rotation % 360) + 360) % 360) {
    case 90: return { x: -point.y, y: point.x };
    case 180: return { x: -point.x, y: -point.y };
    case 270: return { x: point.y, y: -point.x };
    default: return { x: point.x, y: point.y };
  }
};

/** Axis-aligned bounds of a footprint-local box after rotation. */
const rotateBox = (box, rotation) => {
  const corners = [
    rotateOffset({ x: box.minX, y: box.minY }, rotation),
    rotateOffset({ x: box.maxX, y: box.minY }, rotation),
    rotateOffset({ x: box.maxX, y: box.maxY }, rotation),
    rotateOffset({ x: box.minX, y: box.maxY }, rotation),
  ];
  return {
    minX: Math.min(...corners.map((corner) => corner.x)),
    minY: Math.min(...corners.map((corner) => corner.y)),
    maxX: Math.max(...corners.map((corner) => corner.x)),
    maxY: Math.max(...corners.map((corner) => corner.y)),
  };
};

const translateBox = (box, x, y) => ({
  minX: box.minX + x, minY: box.minY + y, maxX: box.maxX + x, maxY: box.maxY + y,
});

const inflateBox = (box, amount) => ({
  minX: box.minX - amount, minY: box.minY - amount,
  maxX: box.maxX + amount, maxY: box.maxY + amount,
});

const boxesOverlap = (a, b) =>
  a.minX < b.maxX - EPSILON && b.minX < a.maxX - EPSILON
  && a.minY < b.maxY - EPSILON && b.minY < a.maxY - EPSILON;

const unionBox = (boxes) => ({
  minX: Math.min(...boxes.map((box) => box.minX)),
  minY: Math.min(...boxes.map((box) => box.minY)),
  maxX: Math.max(...boxes.map((box) => box.maxX)),
  maxY: Math.max(...boxes.map((box) => box.maxY)),
});

/** Absolute courtyard bounds of a placement, rotation included. */
export const placementBounds = (placement) =>
  translateBox(rotateBox(placement.footprint.courtyard, placement.rotation), placement.x, placement.y);

// Used when a padOrder entry names a pad the footprint record doesn't have.
// Size mirrors pcbLayout.js's PAD_DIAMETER (not imported — pcbLayout imports
// this module).
const FALLBACK_PAD = { x: 0, y: 0, shape: 'circle', size: { w: 1.8, h: 1.8 }, drill: 0, angle: 0 };

/**
 * Absolute pad positions for a placement, one entry per circuit node in node
 * order: `{ net, padNumber, index, pad (the footprint record pad), x, y }`.
 */
export const placementPads = (placement) => {
  const byNumber = new Map(placement.footprint.pads.map((pad) => [pad.number, pad]));
  return (placement.part?.nodes || []).map((node, index) => {
    const padNumber = placement.padOrder[index];
    const pad = byNumber.get(padNumber) || { ...FALLBACK_PAD, number: padNumber };
    const offset = rotateOffset(pad, placement.rotation);
    return {
      net: node,
      padNumber,
      index,
      pad,
      x: placement.x + offset.x,
      y: placement.y + offset.y,
    };
  });
};

/** Node indices that are actually wired to something outside the part. */
const connectedNodes = (part) =>
  (part?.nodes || [])
    .map((node, index) => ({ net: node, index }))
    .filter(({ net, index }) => !isUnconnectedTerminal(net, part.ref, index + 1));

/**
 * Connectivity graph over parts: `weights.get(a).get(b)` is the number of nets
 * shared by parts a and b, ignoring nets that touch more than
 * MAX_NET_PADS_FOR_RANKING pads.
 */
const buildConnectivity = (items) => {
  const netItems = new Map();
  for (const item of items) {
    for (const { net } of item.connected) {
      if (!netItems.has(net)) netItems.set(net, { pads: 0, items: new Set() });
      const entry = netItems.get(net);
      entry.pads += 1;
      entry.items.add(item.index);
    }
  }

  const weights = items.map(() => new Map());
  for (const entry of netItems.values()) {
    if (entry.pads > MAX_NET_PADS_FOR_RANKING) continue;
    const members = [...entry.items].sort((a, b) => a - b);
    for (let a = 0; a < members.length; a += 1) {
      for (let b = a + 1; b < members.length; b += 1) {
        const left = members[a];
        const right = members[b];
        weights[left].set(right, (weights[left].get(right) || 0) + 1);
        weights[right].set(left, (weights[right].get(left) || 0) + 1);
      }
    }
  }
  return weights;
};

/** Ring `ring` of a square spiral, in a fixed row-major order. */
const ringOffsets = (ring) => {
  if (ring === 0) return [{ dx: 0, dy: 0 }];
  const offsets = [];
  for (let dy = -ring; dy <= ring; dy += 1) {
    for (let dx = -ring; dx <= ring; dx += 1) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) === ring) offsets.push({ dx, dy });
    }
  }
  return offsets;
};

/**
 * Sum, over this part's wired pads, of the Manhattan distance to the closest
 * already-placed pad on the same net. Pads whose net isn't down yet cost
 * nothing, so a part is drawn toward its existing connections only.
 */
const candidateScore = (item, x, y, rotation, padsByNet) => {
  let score = 0;
  for (const { net, index } of item.connected) {
    const targets = padsByNet.get(net);
    if (!targets) continue;
    const pad = item.padByNode[index];
    const offset = rotateOffset(pad, rotation);
    const padX = x + offset.x;
    const padY = y + offset.y;
    let nearest = Infinity;
    for (const target of targets) {
      const distance = Math.abs(padX - target.x) + Math.abs(padY - target.y);
      if (distance < nearest) nearest = distance;
    }
    score += nearest;
  }
  return score;
};

/** Grid-snapped centre to spiral out from: the part's placed connections. */
const anchorFor = (item, placed, padsByNet) => {
  if (!placed.length) return { x: 0, y: 0 };
  const targets = [];
  for (const { net } of item.connected) {
    const netPads = padsByNet.get(net);
    if (netPads) targets.push(...netPads);
  }
  const points = targets.length ? targets : placed;
  const sum = points.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }), { x: 0, y: 0 });
  return { x: snap(sum.x / points.length), y: snap(sum.y / points.length) };
};

/** Lowest-scoring collision-free centre/rotation, or null if the scan gave up. */
const bestCandidate = (item, anchor, placedBoxes, padsByNet) => {
  let best = null;
  let firstValidRing = null;
  let centersScanned = 0;
  let spiralIndex = 0;

  for (let ring = 0; ; ring += 1) {
    if (firstValidRing !== null && ring > firstValidRing + 1) break;
    if (firstValidRing === null && centersScanned >= MAX_SCAN_CENTERS) break;
    for (const { dx, dy } of ringOffsets(ring)) {
      const x = anchor.x + dx * GRID;
      const y = anchor.y + dy * GRID;
      const index = spiralIndex;
      spiralIndex += 1;
      centersScanned += 1;
      for (const rotation of ROTATIONS) {
        const box = inflateBox(
          translateBox(item.courtyardByRotation[rotation], x, y),
          PLACEMENT_GAP / 2,
        );
        if (placedBoxes.some((placedBox) => boxesOverlap(box, placedBox))) continue;
        if (firstValidRing === null) firstValidRing = ring;
        const score = candidateScore(item, x, y, rotation, padsByNet);
        // Strict improvement only, so ties fall to the earlier spiral index and
        // then to the earlier rotation in ROTATIONS order.
        if (!best || score < best.score - EPSILON) best = { x, y, rotation, score, index };
      }
    }
  }
  return best;
};

/**
 * Places a circuit's parts on a board.
 *
 * @param {Array<{ ref?: string, kind?: string, nodes?: string[] }>} parts
 * @param {{ expandFactor?: number }} [options] `expandFactor > 1` spreads the
 *   finished placement apart about its centre by sqrt(expandFactor), giving a
 *   routing retry more room without changing rotations or relative order.
 * @returns {{ placements: Array<{ part: object, footprint: object, libId: string,
 *   padOrder: string[], x: number, y: number, rotation: number }>,
 *   board: { width: number, height: number } }}
 */
export const placeComponents = (parts, { expandFactor = 1 } = {}) => {
  const items = (parts || []).map((part, index) => {
    const { libId, record, padOrder } = footprintRecordFor(part);
    const byNumber = new Map(record.pads.map((pad) => [pad.number, pad]));
    return {
      part,
      index,
      libId,
      footprint: record,
      padOrder,
      ref: String(part?.ref ?? ''),
      padCount: padOrder.length,
      connected: connectedNodes(part),
      padByNode: (part?.nodes || []).map((_, node) => byNumber.get(padOrder[node]) || FALLBACK_PAD),
      courtyardByRotation: Object.fromEntries(
        ROTATIONS.map((rotation) => [rotation, rotateBox(record.courtyard, rotation)]),
      ),
    };
  });

  if (!items.length) {
    return { placements: [], board: { width: BOARD_MARGIN * 2, height: BOARD_MARGIN * 2 } };
  }

  const weights = buildConnectivity(items);

  // Seed: the part with the most pads (ties → lowest ref, then input order).
  const remaining = [...items];
  const byRef = (a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : a.index - b.index);
  remaining.sort((a, b) => (b.padCount - a.padCount) || byRef(a, b));

  const placements = [];
  const placedBoxes = [];
  const placedCenters = [];
  const padsByNet = new Map();

  const commit = (item, x, y, rotation) => {
    const placement = {
      part: item.part,
      footprint: item.footprint,
      libId: item.libId,
      padOrder: item.padOrder,
      x,
      y,
      rotation,
    };
    placements.push(placement);
    placedBoxes.push(inflateBox(translateBox(item.courtyardByRotation[rotation], x, y), PLACEMENT_GAP / 2));
    placedCenters.push({ x, y });
    for (const { net, index } of item.connected) {
      const offset = rotateOffset(item.padByNode[index], rotation);
      if (!padsByNet.has(net)) padsByNet.set(net, []);
      padsByNet.get(net).push({ x: x + offset.x, y: y + offset.y });
    }
  };

  const placedIndices = new Set();
  const seed = remaining.shift();
  commit(seed, 0, 0, 0);
  placedIndices.add(seed.index);

  while (remaining.length) {
    // Re-rank every round: connectivity to what's already placed, then pad
    // count, then ref.
    let next = null;
    let nextAt = -1;
    remaining.forEach((item, position) => {
      let connectivity = 0;
      for (const placedIndex of placedIndices) {
        connectivity += weights[item.index].get(placedIndex) || 0;
      }
      const better = !next
        || connectivity > next.connectivity
        || (connectivity === next.connectivity
          && (item.padCount > next.item.padCount
            || (item.padCount === next.item.padCount && byRef(item, next.item) < 0)));
      if (better) {
        next = { item, connectivity };
        nextAt = position;
      }
    });
    remaining.splice(nextAt, 1);
    const item = next.item;

    const candidate = bestCandidate(
      item,
      anchorFor(item, placedCenters, padsByNet),
      placedBoxes,
      padsByNet,
    );
    if (candidate) {
      commit(item, candidate.x, candidate.y, candidate.rotation);
    } else {
      // Give-up path: park the part clear of everything placed so far.
      const placedUnion = unionBox(placedBoxes);
      const box = item.courtyardByRotation[0];
      commit(
        item,
        placedUnion.maxX + PLACEMENT_GAP / 2 - box.minX,
        placedUnion.minY + PLACEMENT_GAP / 2 - box.minY,
        0,
      );
    }
    placedIndices.add(item.index);
  }

  return finishBoard(placements, expandFactor);
};

/** Applies expandFactor, then shifts the placement into the board margin. */
const finishBoard = (placements, expandFactor) => {
  const boundsOf = () => unionBox(placements.map(placementBounds));

  if (expandFactor > 1) {
    const spread = Math.sqrt(expandFactor);
    const bounds = boundsOf();
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    for (const placement of placements) {
      placement.x = centerX + (placement.x - centerX) * spread;
      placement.y = centerY + (placement.y - centerY) * spread;
    }
  }

  // Every centre is the same offset plus a whole number of 1.27 mm steps, so
  // without expandFactor they all round the same way and the gaps between
  // courtyards survive rounding exactly.
  const bounds = boundsOf();
  for (const placement of placements) {
    placement.x = round(placement.x + BOARD_MARGIN - bounds.minX);
    placement.y = round(placement.y + BOARD_MARGIN - bounds.minY);
  }

  const placedBounds = boundsOf();
  return {
    placements,
    board: {
      width: Math.ceil(placedBounds.maxX + BOARD_MARGIN),
      height: Math.ceil(placedBounds.maxY + BOARD_MARGIN),
    },
  };
};
