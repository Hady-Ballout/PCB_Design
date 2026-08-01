// Procedural PCB layout: component placement + two-layer Manhattan trace
// routing computed from the circuit alone (no KiCad install required).
// All dimensions are millimetres. Horizontal trace segments run on the top
// copper layer, vertical segments on the bottom layer, with a via at every
// bend — through-hole pads join both layers, so nets stay connected.
// Footprint geometry (pad positions/shapes/drills, body size) comes from
// real vendored KiCad footprints via pcbFootprints.js, and placement from the
// netlist-aware placer in pcbPlace.js; this module turns those placements into
// the layout object and routes between their pads.
import { bodyKindFor } from './pcbFootprints.js';
import {
  isUnconnectedTerminal,
  placeComponents,
  placementBounds,
  placementPads,
} from './pcbPlace.js';

export const BOARD_THICKNESS = 1.6;
export const TRACE_WIDTH = 0.8;
export const VIA_DIAMETER = 1.4;
// Fallback pad diameter for callers that don't read a pad's own `diameter`.
export const PAD_DIAMETER = 1.8;

const round = (value) => Math.round(value * 100) / 100;

// Minimum spanning tree over a net's pads (Prim, Manhattan distance) so every
// pad is reached with short, non-redundant traces.
const spanningEdges = (pads) => {
  if (pads.length < 2) return [];
  const inTree = [pads[0]];
  const remaining = pads.slice(1);
  const edges = [];
  while (remaining.length) {
    let best = null;
    for (const candidate of remaining) {
      for (const anchor of inTree) {
        const cost = Math.abs(candidate.x - anchor.x) + Math.abs(candidate.y - anchor.y);
        if (!best || cost < best.cost) best = { candidate, anchor, cost };
      }
    }
    edges.push({ from: best.anchor, to: best.candidate });
    inTree.push(best.candidate);
    remaining.splice(remaining.indexOf(best.candidate), 1);
  }
  return edges;
};

/**
 * @param {object} circuit
 * @param {{ expandFactor?: number }} [options] forwarded to the placer; > 1
 *   spreads the parts apart to give routing more room.
 */
export const buildPcbLayout = (circuit, options = {}) => {
  const parts = (circuit?.components || []).filter((part) => part.kind !== 'ground');
  if (!parts.length) return null;

  const { placements, board } = placeComponents(parts, options);

  const components = placements.map((placement) => {
    const { part } = placement;
    // Extents of the placed (rotated) courtyard, so width/height stay the
    // on-board footprint size. `courtyard` itself remains footprint-local and
    // unrotated — pair it with `rotation` to rebuild the placed outline.
    const bounds = placementBounds(placement);
    return {
      ref: part.ref,
      kind: part.kind,
      value: part.value,
      body: bodyKindFor(placement.libId, part),
      rotation: placement.rotation,
      libId: placement.libId,
      courtyard: placement.footprint.courtyard,
      x: placement.x,
      y: placement.y,
      width: round(bounds.maxX - bounds.minX),
      height: round(bounds.maxY - bounds.minY),
      pads: placementPads(placement).map((placedPad) => ({
        x: round(placedPad.x),
        y: round(placedPad.y),
        net: placedPad.net,
        pinIndex: placedPad.index + 1,
        connected: !isUnconnectedTerminal(placedPad.net, part.ref, placedPad.index + 1),
        padNumber: placedPad.padNumber,
        drill: placedPad.pad.drill,
        diameter: Math.max(placedPad.pad.size.w, placedPad.pad.size.h),
        shape: placedPad.pad.shape,
        size: placedPad.pad.size,
      })),
    };
  });

  // Group connected pads by net.
  const netPads = new Map();
  for (const component of components) {
    for (const pad of component.pads) {
      if (!pad.connected) continue;
      if (!netPads.has(pad.net)) netPads.set(pad.net, []);
      netPads.get(pad.net).push(pad);
    }
  }

  // Route each net edge as an L: horizontal on top copper, vertical on bottom,
  // with a via at the bend. Alternating bend corners spreads parallel runs.
  const traces = [];
  const vias = [];
  let netIndex = 0;
  for (const [net, pads] of netPads.entries()) {
    const bendFirst = netIndex % 2 === 0;
    for (const edge of spanningEdges(pads)) {
      const { from, to } = edge;
      if (from.y === to.y) {
        traces.push({ layer: 'top', net, from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y }, width: TRACE_WIDTH });
        continue;
      }
      if (from.x === to.x) {
        traces.push({ layer: 'bottom', net, from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y }, width: TRACE_WIDTH });
        continue;
      }
      const corner = bendFirst ? { x: to.x, y: from.y } : { x: from.x, y: to.y };
      const horizontal = bendFirst
        ? { from: { x: from.x, y: from.y }, to: corner }
        : { from: corner, to: { x: to.x, y: to.y } };
      const vertical = bendFirst
        ? { from: corner, to: { x: to.x, y: to.y } }
        : { from: { x: from.x, y: from.y }, to: corner };
      traces.push({ layer: 'top', net, ...horizontal, width: TRACE_WIDTH });
      traces.push({ layer: 'bottom', net, ...vertical, width: TRACE_WIDTH });
      vias.push({ x: corner.x, y: corner.y, net });
    }
    netIndex += 1;
  }

  return {
    board: { width: board.width, height: board.height, thickness: BOARD_THICKNESS },
    components,
    traces,
    vias,
    nets: [...netPads.keys()],
  };
};
