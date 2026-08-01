// Procedural PCB layout: component placement + two-layer Manhattan trace
// routing computed from the circuit alone (no KiCad install required).
// All dimensions are millimetres. Horizontal trace segments run on the top
// copper layer, vertical segments on the bottom layer, with a via at every
// bend — through-hole pads join both layers, so nets stay connected.
// Footprint geometry (pad positions/shapes/drills, body size) comes from
// real vendored KiCad footprints via pcbFootprints.js; this module only
// places whole footprints and routes between their pads.
import { bodyKindFor, footprintRecordFor } from './pcbFootprints.js';

export const BOARD_THICKNESS = 1.6;
export const TRACE_WIDTH = 0.8;
export const VIA_DIAMETER = 1.4;
// Fallback pad diameter for callers that don't read a pad's own `diameter`.
export const PAD_DIAMETER = 1.8;
const PLACEMENT_GAP = 5;
const EDGE_MARGIN = 4;

const round = (value) => Math.round(value * 100) / 100;

const isUnconnectedTerminal = (node, ref, pin) =>
  /^NC_/i.test(String(node)) || String(node) === `${ref}_${pin}`;

const placeComponents = (parts) => {
  const items = parts.map((part) => {
    const { libId, record, padOrder } = footprintRecordFor(part);
    const body = bodyKindFor(libId, part);
    // The courtyard already encloses the pads plus clearance, so it alone
    // sizes the placement cell.
    const width = record.courtyard.maxX - record.courtyard.minX;
    const height = record.courtyard.maxY - record.courtyard.minY;
    return {
      part,
      libId,
      record,
      padOrder,
      body,
      width,
      height,
      cellWidth: width + PLACEMENT_GAP,
      cellHeight: height + PLACEMENT_GAP,
    };
  });

  // Row packing toward a roughly 4:3 board.
  const totalArea = items.reduce((sum, item) => sum + item.cellWidth * item.cellHeight, 0);
  const targetWidth = Math.max(Math.sqrt(totalArea * (4 / 3)), Math.max(...items.map((item) => item.cellWidth)));

  const placed = [];
  let cursorX = EDGE_MARGIN;
  let cursorY = EDGE_MARGIN;
  let rowHeight = 0;
  for (const item of items) {
    if (cursorX > EDGE_MARGIN && cursorX + item.cellWidth > targetWidth + EDGE_MARGIN) {
      cursorX = EDGE_MARGIN;
      cursorY += rowHeight;
      rowHeight = 0;
    }
    placed.push({
      ...item,
      x: round(cursorX + item.cellWidth / 2),
      y: round(cursorY + item.cellHeight / 2),
    });
    cursorX += item.cellWidth;
    rowHeight = Math.max(rowHeight, item.cellHeight);
  }

  const width = Math.max(...placed.map((item) => item.x + item.cellWidth / 2)) + EDGE_MARGIN;
  const height = Math.max(...placed.map((item) => item.y + item.cellHeight / 2)) + EDGE_MARGIN;
  return { placed, width: round(width), height: round(height) };
};

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

export const buildPcbLayout = (circuit) => {
  const parts = (circuit?.components || []).filter((part) => part.kind !== 'ground');
  if (!parts.length) return null;

  const { placed, width, height } = placeComponents(parts);

  const components = placed.map((item) => {
    const padsByNumber = new Map(item.record.pads.map((pad) => [pad.number, pad]));
    return {
      ref: item.part.ref,
      kind: item.part.kind,
      value: item.part.value,
      body: item.body,
      rotation: 0,
      libId: item.libId,
      courtyard: item.record.courtyard,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      pads: (item.part.nodes || []).map((node, index) => {
        const padNumber = item.padOrder[index];
        const recordPad = padsByNumber.get(padNumber) || { x: 0, y: 0, shape: 'circle', size: { w: PAD_DIAMETER, h: PAD_DIAMETER }, drill: 0 };
        return {
          x: round(item.x + recordPad.x),
          y: round(item.y + recordPad.y),
          net: node,
          pinIndex: index + 1,
          connected: !isUnconnectedTerminal(node, item.part.ref, index + 1),
          padNumber,
          drill: recordPad.drill,
          diameter: Math.max(recordPad.size.w, recordPad.size.h),
          shape: recordPad.shape,
          size: recordPad.size,
        };
      }),
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
    board: { width, height, thickness: BOARD_THICKNESS },
    components,
    traces,
    vias,
    nets: [...netPads.keys()],
  };
};
