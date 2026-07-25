// Procedural PCB layout: component placement + two-layer Manhattan trace
// routing computed from the circuit alone (no KiCad install required).
// All dimensions are millimetres. Horizontal trace segments run on the top
// copper layer, vertical segments on the bottom layer, with a via at every
// bend — through-hole pads join both layers, so nets stay connected.
export const BOARD_THICKNESS = 1.6;
export const TRACE_WIDTH = 0.8;
export const VIA_DIAMETER = 1.4;
export const PAD_DIAMETER = 1.8;
const PLACEMENT_GAP = 5;
const EDGE_MARGIN = 4;

// Footprint catalogue: body size plus through-hole pad offsets from the
// component centre. Pad order matches the circuit model's node order.
const twoPadRow = (span) => [{ x: -span / 2, y: 0 }, { x: span / 2, y: 0 }];
const inlineRow = (count, pitch) =>
  Array.from({ length: count }, (_, i) => ({ x: (i - (count - 1) / 2) * pitch, y: 0 }));
const dualRow = (count, pitch, rowSpan) =>
  Array.from({ length: count }, (_, i) => {
    const perRow = Math.ceil(count / 2);
    const row = i < perRow ? 1 : -1;
    const along = i < perRow ? i : count - 1 - i;
    return { x: (along - (perRow - 1) / 2) * pitch, y: (row * rowSpan) / 2 };
  });

const FOOTPRINTS = {
  resistor: { width: 9, height: 3.2, pads: twoPadRow(11.5), body: 'axial' },
  load: { width: 9, height: 3.2, pads: twoPadRow(11.5), body: 'axial' },
  inductor: { width: 9, height: 4, pads: twoPadRow(11.5), body: 'axial' },
  diode: { width: 7, height: 3, pads: twoPadRow(9.5), body: 'axial' },
  led: { width: 5.5, height: 5.5, pads: twoPadRow(2.54), body: 'led' },
  capacitor: { width: 6, height: 6, pads: twoPadRow(5.08), body: 'radial' },
  voltage_source: { width: 10, height: 7.5, pads: twoPadRow(5.08), body: 'terminal' },
  signal_source: { width: 10, height: 7.5, pads: twoPadRow(5.08), body: 'terminal' },
  bjt_npn: { width: 6, height: 5.5, pads: inlineRow(3, 2.54), body: 'to92' },
  bjt_pnp: { width: 6, height: 5.5, pads: inlineRow(3, 2.54), body: 'to92' },
  mosfet_n: { width: 6, height: 5.5, pads: inlineRow(3, 2.54), body: 'to92' },
  mosfet_p: { width: 6, height: 5.5, pads: inlineRow(3, 2.54), body: 'to92' },
  regulator: { width: 10.2, height: 6.5, pads: inlineRow(3, 2.54), body: 'to220' },
  opamp: { width: 10.2, height: 8, pads: dualRow(8, 2.54, 7.62), body: 'dip' },
  arduino_uno: { width: 46, height: 34, pads: dualRow(12, 2.54, 30), body: 'module' },
  raspberry_pi: { width: 50, height: 36, pads: dualRow(10, 2.54, 32), body: 'module' },
  esp32: { width: 44, height: 26, pads: dualRow(12, 2.54, 22), body: 'module' },
};
const GENERIC_FOOTPRINT = { width: 10, height: 8, pads: twoPadRow(7.62), body: 'generic' };

export const footprintFor = (part) => {
  const base = FOOTPRINTS[part.kind] || GENERIC_FOOTPRINT;
  const nodeCount = part.nodes?.length ?? base.pads.length;
  if (nodeCount === base.pads.length) return base;
  // Node count differs from the catalogue entry: fall back to a stretched
  // dual-row package so every node still gets a pad.
  const width = Math.max(base.width, Math.ceil(nodeCount / 2) * 2.54 + 4);
  return { width, height: Math.max(base.height, 8), pads: dualRow(nodeCount, 2.54, Math.max(base.height, 8) - 1.5), body: base.body };
};

const round = (value) => Math.round(value * 100) / 100;

const isUnconnectedTerminal = (node, ref, pin) =>
  /^NC_/i.test(String(node)) || String(node) === `${ref}_${pin}`;

const placeComponents = (parts) => {
  const items = parts.map((part) => {
    const footprint = footprintFor(part);
    // Cells reserve room for the pad row too, not just the body.
    const padExtentX = Math.max(...footprint.pads.map((pad) => Math.abs(pad.x)), 0) * 2 + PAD_DIAMETER;
    const padExtentY = Math.max(...footprint.pads.map((pad) => Math.abs(pad.y)), 0) * 2 + PAD_DIAMETER;
    return {
      part,
      footprint,
      cellWidth: Math.max(footprint.width, padExtentX) + PLACEMENT_GAP,
      cellHeight: Math.max(footprint.height, padExtentY) + PLACEMENT_GAP,
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

  const components = placed.map((item) => ({
    ref: item.part.ref,
    kind: item.part.kind,
    value: item.part.value,
    body: item.footprint.body,
    x: item.x,
    y: item.y,
    width: item.footprint.width,
    height: item.footprint.height,
    pads: (item.part.nodes || []).map((node, index) => {
      const offset = item.footprint.pads[index] || { x: 0, y: 0 };
      return {
        x: round(item.x + offset.x),
        y: round(item.y + offset.y),
        net: node,
        pinIndex: index + 1,
        connected: !isUnconnectedTerminal(node, item.part.ref, index + 1),
      };
    }),
  }));

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
