export const LAYOUT_VERSION = 5;
export const GRID_SIZE = 20;
export const COMPONENT_CLEARANCE = 24;
export const WIRE_CLEARANCE = 16;
const CANVAS_MARGIN = 60;
const MAX_ROUTE_STATES = 6000;
const MAX_EXPANSIONS = 8;
const PLACEMENT_CLEARANCE = COMPONENT_CLEARANCE + WIRE_CLEARANCE * 4;
// Placement grid for the signal-flow columns. Same-rank parts share a column
// (COLUMN_STRIDE apart horizontally) and stack ROW_STRIDE apart vertically.
// Tidy placement: parts in a rank share the rank's lane and fan into a tight,
// aligned 2-column block. Ranks with one part stay a single clean column. This
// is what makes most schematics read as deliberate signal-flow columns.
const TIDY_GRID = {
  columnStart: 160,
  rowStart: 220,
  columnStride: 380,
  rankBandStride: 360,
  rowStride: 190,
  subColumns: 1,
  subColumnStride: 190,
};
// Fallback "spread" placement (the original wide 3-column-per-rank fan-out).
// Denser feedback circuits (e.g. an op-amp whose input parts rank to its right)
// can't route as tidy rank-separated columns, so when the tidy pass fails we
// retry with this looser grid, which interleaves adjacent ranks enough to route.
const SPREAD_GRID = {
  columnStart: 180,
  rowStart: 260,
  columnStride: 320,
  rankBandStride: 300,
  rowStride: 190,
  subColumns: 3,
  subColumnStride: 220,
};

export class DiagramLayoutError extends Error {
  constructor(message, violations = []) {
    super(message);
    this.name = 'DiagramLayoutError';
    this.code = 'diagram_layout_failed';
    this.violations = violations;
  }
}

const symbolTypeByKind = {
  voltage_source: 'voltage_source',
  signal_source: 'voltage_source',
  resistor: 'resistor',
  load: 'resistor',
  capacitor: 'capacitor',
  inductor: 'inductor',
  diode: 'diode',
  led: 'led',
  bjt_npn: 'bjt_npn',
  bjt_pnp: 'bjt_pnp',
  mosfet_n: 'generic',
  mosfet_p: 'generic',
  opamp: 'opamp',
  regulator: 'generic',
  arduino_uno: 'generic',
  raspberry_pi: 'generic',
  esp32: 'generic',
};

const snap = (value, grid = GRID_SIZE) => Math.round(value / grid) * grid;

// --- Placeholder slot grid -------------------------------------------------
// The canvas is a grid of fixed-size slots, one component per slot. The grid —
// not the content — drives the canvas size (slotCanvasSize), so slots stay put
// even if the router grows the canvas to fit wires. All dimensions are grid
// multiples so slot centers land on the schematic grid. These pure helpers live
// in core so both the layout engine and the feature renderer share one source of
// truth (the feature layer decorates each rect with pins on top).
export const SCHEMATIC_SLOT_LAYOUT = { cols: 4, slotWidth: 160, slotHeight: 120, gap: 60, margin: 60 };

// Rows grow to hold every component; keep at least two rows so an empty grid
// still reads as a grid. Columns are fixed by the layout.
export const slotGridFor = (count, layout = SCHEMATIC_SLOT_LAYOUT) => ({
  rows: Math.max(2, Math.ceil(Math.max(count, 1) / layout.cols)),
  cols: layout.cols,
});

export const slotCanvasSize = (rows, cols, layout = SCHEMATIC_SLOT_LAYOUT) => {
  const { slotWidth, slotHeight, gap, margin } = layout;
  return {
    width: snap(2 * margin + cols * slotWidth + (cols - 1) * gap),
    height: snap(2 * margin + rows * slotHeight + (rows - 1) * gap),
  };
};

// Bare slot rectangles (no pins). The feature layer adds pin geometry.
export const slotRects = (rows, cols, layout = SCHEMATIC_SLOT_LAYOUT) => {
  const { slotWidth, slotHeight, gap, margin } = layout;
  const slots = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      slots.push({
        id: `slot-${row}-${col}`,
        index: row * cols + col + 1,
        row,
        col,
        x: snap(margin + col * (slotWidth + gap)),
        y: snap(margin + row * (slotHeight + gap)),
        width: slotWidth,
        height: slotHeight,
      });
    }
  }
  return slots;
};

export const slotCenter = (slot) => ({
  x: snap(slot.x + slot.width / 2),
  y: snap(slot.y + slot.height / 2),
});

// Assign refs (already in signal-flow order) to slots column-major, so earlier
// ranks sit in the left column and flow rightward. Returns Map<ref, slot>.
export const assignSlots = (refsInOrder, slots) => {
  const rows = slots.reduce((max, slot) => Math.max(max, slot.row + 1), 0);
  const byRowCol = new Map(slots.map((slot) => [`${slot.row}:${slot.col}`, slot]));
  const assignment = new Map();
  refsInOrder.forEach((ref, index) => {
    const slot = byRowCol.get(`${index % rows}:${Math.floor(index / rows)}`) || slots[index];
    if (slot) assignment.set(ref, slot);
  });
  return assignment;
};

const slotIsOccupied = (slot, components) => {
  const center = slotCenter(slot);
  return components.some(
    (component) =>
      Math.abs(component.x - center.x) < slot.width / 2 && Math.abs(component.y - center.y) < slot.height / 2,
  );
};

export const nextFreeSlot = (slots, components) =>
  slots.find((slot) => !slotIsOccupied(slot, components)) || null;

export const nearestSlot = (slots, x, y) => {
  let best = null;
  let bestDistance = Infinity;
  for (const slot of slots) {
    const center = slotCenter(slot);
    const distance = (center.x - x) ** 2 + (center.y - y) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = slot;
    }
  }
  return best;
};
// ---------------------------------------------------------------------------

const pointKey = (point) => `${point.x},${point.y}`;
const isSourceKind = (kind) => kind === 'voltage_source' || kind === 'signal_source';
const isOutputNode = (node) => /(^|_)(v?out|out|load|filtered)(_|$)/i.test(String(node));
const isUnconnectedTerminal = (node, ref, pin) =>
  /^NC_/i.test(String(node)) || String(node) === `${ref}_${pin}`;
const labelIdForWire = (wire) => (wire.node === '0'
  ? `ground-label:${wire.ref}:${wire.pin}`
  : `net-label:${wire.ref}:${wire.pin}`);
const textWidth = (text, minimum = 30, maximum = 150) =>
  Math.max(minimum, Math.min(maximum, String(text || '').length * 8 + 20));

export const rectsOverlap = (first, second, clearance = 0) => !(
  first.right + clearance <= second.left
  || second.right + clearance <= first.left
  || first.bottom + clearance <= second.top
  || second.bottom + clearance <= first.top
);

export const componentBounds = (component, clearance = 0) => ({
  left: component.x - component.width / 2 - clearance,
  right: component.x + component.width / 2 + clearance,
  top: component.y - component.height / 2 - clearance,
  bottom: component.y + component.height / 2 + clearance,
});

const labelBounds = (label, clearance = 0) => ({
  left: label.x - label.width / 2 - clearance,
  right: label.x + label.width / 2 + clearance,
  top: label.y - label.height / 2 - clearance,
  bottom: label.y + label.height / 2 + clearance,
});

const netLabelBounds = (label, clearance = 0) => {
  if (label.name === '0') {
    return {
      left: label.x - 18 - clearance,
      right: label.x + 18 + clearance,
      top: label.y - clearance,
      bottom: label.y + 28 + clearance,
    };
  }
  return {
    left: label.labelX - clearance,
    right: label.labelX + label.labelWidth + clearance,
    top: label.labelY - clearance,
    bottom: label.labelY + 26 + clearance,
  };
};

export const diagramComponentsOverlap = (first, second, clearance = COMPONENT_CLEARANCE) =>
  rectsOverlap(componentBounds(first), componentBounds(second), clearance);

const moveComponent = (component, x, y) => {
  const dx = x - component.x;
  const dy = y - component.y;
  return {
    ...component,
    x,
    y,
    pins: (component.pins || []).map((pin) => ({ ...pin, x: pin.x + dx, y: pin.y + dy })),
  };
};

// Multi-pin side pins sit a grid multiple away from the (snapped) component
// center so horizontal wires meet them without a tiny off-grid jog at the pin.
const pinPoint = (component, pinIndex, node, netPosition) => {
  if (component.symbolType === 'bjt_npn' || component.symbolType === 'bjt_pnp') {
    const reach = snap(component.height / 2 - 18);
    if (pinIndex === 1) return { x: component.x + component.width / 2, y: component.y - reach };
    if (pinIndex === 2) return { x: component.x - component.width / 2, y: component.y };
    if (pinIndex === 3) return { x: component.x + component.width / 2, y: component.y + reach };
  }
  if (component.symbolType === 'opamp') {
    const inputSpread = snap(component.height * 0.22);
    if (pinIndex === 1) return { x: component.x - component.width / 2, y: component.y + inputSpread };
    if (pinIndex === 2) return { x: component.x - component.width / 2, y: component.y - inputSpread };
    if (pinIndex === 3) return { x: component.x + component.width / 2, y: component.y };
    if (pinIndex === 4) return { x: component.x, y: component.y - component.height / 2 };
    if (pinIndex === 5) return { x: component.x, y: component.y + component.height / 2 };
  }
  if (component.pinCount <= 2) {
    if (component.orientation === 'vertical') {
      return { x: component.x, y: node === '0' ? component.y + component.height / 2 : component.y - component.height / 2 };
    }
    return {
      x: netPosition
        ? ((netPosition.x < component.x ? -1 : 1) * component.width) / 2 + component.x
        : component.x + (pinIndex === 1 ? -1 : 1) * component.width / 2,
      y: component.y,
    };
  }
  const side = pinIndex % 2 === 1 ? -1 : 1;
  const row = Math.floor((pinIndex - 1) / 2);
  const rows = Math.ceil(component.pinCount / 2);
  return {
    x: component.x + side * component.width / 2,
    y: component.y - ((rows - 1) * 14) / 2 + row * 28,
  };
};

const componentSize = (kind) => {
  const symbolType = symbolTypeByKind[kind] || 'generic';
  // Boards carry 10-12 pins in the generic side-alternating layout, so they
  // need a much taller body than the other 'generic' kinds (mosfet, regulator).
  if (kind === 'arduino_uno' || kind === 'raspberry_pi' || kind === 'esp32') return { width: 150, height: 200, symbolType };
  if (symbolType === 'opamp') return { width: 150, height: 110, symbolType };
  if (symbolType === 'bjt_npn' || symbolType === 'bjt_pnp') return { width: 118, height: 100, symbolType };
  if (symbolType === 'voltage_source' || symbolType === 'capacitor' || symbolType === 'diode' || symbolType === 'led') {
    return { width: 98, height: 112, symbolType };
  }
  return { width: 108, height: 58, symbolType };
};

const roleMapByRef = (schematic = {}) => new Map(
  (schematic.componentRoles || []).map((role) => [String(role.ref || '').toUpperCase(), role]),
);

const roleMapByNet = (schematic = {}) => new Map(
  (schematic.netRoles || []).map((role) => [String(role.net || ''), role]),
);

const terminalSide = (terminal, netRole) => {
  const side = String(terminal.side || netRole?.side || '').toLowerCase();
  return ['left', 'right', 'top', 'bottom'].includes(side) ? side : 'left';
};

const portTerminalPoint = (terminal, index, counts, size, netRole) => {
  const side = terminalSide(terminal, netRole);
  const count = counts.get(side) || 1;
  const order = index.get(side) || 0;
  index.set(side, order + 1);
  const spacing = side === 'left' || side === 'right'
    ? (size.height - CANVAS_MARGIN * 3) / Math.max(1, count + 1)
    : (size.width - CANVAS_MARGIN * 3) / Math.max(1, count + 1);
  if (side === 'right') return { x: size.width - CANVAS_MARGIN - 50, y: snap(CANVAS_MARGIN + spacing * (order + 1)) };
  if (side === 'top') return { x: snap(CANVAS_MARGIN + spacing * (order + 1)), y: CANVAS_MARGIN + 40 };
  if (side === 'bottom') return { x: snap(CANVAS_MARGIN + spacing * (order + 1)), y: size.height - CANVAS_MARGIN - 50 };
  return { x: CANVAS_MARGIN + 50, y: snap(CANVAS_MARGIN + spacing * (order + 1)) };
};

const buildConnectivity = (circuit) => {
  const netToComponents = new Map();
  for (const component of circuit.components || []) {
    component.nodes.forEach((node, index) => {
      if (isUnconnectedTerminal(node, component.ref, index + 1)) return;
      if (!netToComponents.has(String(node))) netToComponents.set(String(node), []);
      netToComponents.get(String(node)).push(component.ref);
    });
  }
  return netToComponents;
};

const rankComponents = (circuit) => {
  const components = circuit.components || [];
  const byRef = new Map(components.map((component) => [component.ref, component]));
  const netToComponents = buildConnectivity(circuit);
  const ranks = new Map();
  const queue = [];
  components.filter((component) => isSourceKind(component.kind)).forEach((component) => {
    ranks.set(component.ref, 0);
    queue.push(component.ref);
  });
  if (queue.length === 0 && components[0]) {
    ranks.set(components[0].ref, 0);
    queue.push(components[0].ref);
  }
  while (queue.length) {
    const ref = queue.shift();
    const component = byRef.get(ref);
    const rank = ranks.get(ref) || 0;
    for (const node of component?.nodes || []) {
      if (node === '0') continue;
      for (const neighbor of netToComponents.get(String(node)) || []) {
        if (!ranks.has(neighbor)) {
          ranks.set(neighbor, rank + 1);
          queue.push(neighbor);
        }
      }
    }
  }
  components.forEach((component, index) => {
    if (!ranks.has(component.ref)) ranks.set(component.ref, Math.floor(index / 4));
  });
  return ranks;
};

const nearestFreePosition = (component, placed, preferred, bounds) => {
  const origin = { x: preferred.x, y: preferred.y };
  const legal = (position) => {
    const candidate = moveComponent(component, position.x, position.y);
    const box = componentBounds(candidate);
    return box.left >= CANVAS_MARGIN && box.top >= CANVAS_MARGIN
      && box.right <= bounds.width - CANVAS_MARGIN && box.bottom <= bounds.height - CANVAS_MARGIN
      && placed.every((other) => !diagramComponentsOverlap(
        candidate,
        other,
        bounds.clearance ?? PLACEMENT_CLEARANCE,
      ));
  };
  if (legal(origin)) return origin;
  for (let radius = 1; radius <= 40; radius += 1) {
    const candidates = [];
    for (let dx = -radius; dx <= radius; dx += 1) {
      candidates.push({ x: snap(origin.x + dx * GRID_SIZE), y: snap(origin.y - radius * GRID_SIZE) });
      candidates.push({ x: snap(origin.x + dx * GRID_SIZE), y: snap(origin.y + radius * GRID_SIZE) });
    }
    for (let dy = -radius + 1; dy < radius; dy += 1) {
      candidates.push({ x: snap(origin.x - radius * GRID_SIZE), y: snap(origin.y + dy * GRID_SIZE) });
      candidates.push({ x: snap(origin.x + radius * GRID_SIZE), y: snap(origin.y + dy * GRID_SIZE) });
    }
    const found = candidates.find(legal);
    if (found) return found;
  }
  return null;
};

export const resolveComponentOverlaps = (components, clearance = COMPONENT_CLEARANCE, size = {}) => {
  const bounds = { width: size.width || 1800, height: size.height || 1400, clearance: Math.max(clearance, PLACEMENT_CLEARANCE) };
  const placed = [];
  for (const component of components) {
    const position = nearestFreePosition(component, placed, component, bounds)
      || { x: component.x, y: Math.max(component.y, ...placed.map((item) => item.y + item.height + clearance), 120) };
    placed.push(moveComponent(component, position.x, position.y));
  }
  return placed;
};

const pinEscapeBounds = (component, pin) => {
  const bounds = componentBounds(component);
  const reach = WIRE_CLEARANCE + GRID_SIZE;
  const halfWidth = WIRE_CLEARANCE;
  const sides = [
    { side: 'left', distance: Math.abs(pin.x - bounds.left) },
    { side: 'right', distance: Math.abs(pin.x - bounds.right) },
    { side: 'top', distance: Math.abs(pin.y - bounds.top) },
    { side: 'bottom', distance: Math.abs(pin.y - bounds.bottom) },
  ].sort((first, second) => first.distance - second.distance);
  if (sides[0].side === 'left') {
    return { left: pin.x - reach, right: pin.x, top: pin.y - halfWidth, bottom: pin.y + halfWidth };
  }
  if (sides[0].side === 'right') {
    return { left: pin.x, right: pin.x + reach, top: pin.y - halfWidth, bottom: pin.y + halfWidth };
  }
  if (sides[0].side === 'top') {
    return { left: pin.x - halfWidth, right: pin.x + halfWidth, top: pin.y - reach, bottom: pin.y };
  }
  return { left: pin.x - halfWidth, right: pin.x + halfWidth, top: pin.y, bottom: pin.y + reach };
};

const makeComponentLabels = (components) => {
  const labels = [];
  const occupied = [
    ...components.map((component) => componentBounds(component, 6)),
    ...components.flatMap((component) => (component.pins || []).map((pin) => pinEscapeBounds(component, pin))),
  ];
  const placeLabel = (component, text, kind, candidates) => {
    const width = textWidth(text);
    const legal = (candidate) => {
      const label = { ref: component.ref, kind, text, ...candidate, width, height: 18 };
      const bounds = labelBounds(label);
      if (bounds.left < 0 || bounds.top < 0) return null;
      return occupied.every((box) => !rectsOverlap(bounds, box, 4)) ? label : null;
    };
    for (const candidate of candidates) {
      const label = legal(candidate);
      if (label) return label;
    }
    for (let radius = 1; radius <= 12; radius += 1) {
      const distance = Math.max(component.width, component.height) / 2 + 20 + radius * GRID_SIZE;
      const search = [
        { x: component.x, y: component.y - distance },
        { x: component.x + distance, y: component.y },
        { x: component.x, y: component.y + distance },
        { x: component.x - distance, y: component.y },
        { x: component.x - distance, y: component.y - distance },
        { x: component.x + distance, y: component.y - distance },
        { x: component.x + distance, y: component.y + distance },
        { x: component.x - distance, y: component.y + distance },
      ];
      for (const candidate of search) {
        const label = legal(candidate);
        if (label) return label;
      }
    }
    return { ref: component.ref, kind, text, ...candidates[0], width, height: 18 };
  };
  // Preferred spots hug the body: 26px clears the body box (6px pad + 4px
  // check clearance + half the 18px label height). Horizontal parts escape
  // their pins sideways, so side labels need 40px to clear the 36px escape
  // reach; vertical parts escape up/down and can keep side labels tight. If
  // none of these fit, the ring search exiles the label — and text floating
  // away from its part is a machine-layout tell.
  for (const component of components) {
    const sideGap = component.orientation === 'vertical' ? 10 : 40;
    const refLabel = placeLabel(component, component.ref, 'ref', [
      { x: component.x, y: component.y - component.height / 2 - 26 },
      { x: component.x - component.width / 2 - textWidth(component.ref) / 2 - sideGap, y: component.y },
      { x: component.x + component.width / 2 + textWidth(component.ref) / 2 + sideGap, y: component.y },
      { x: component.x, y: component.y + component.height / 2 + 26 },
    ]);
    labels.push(refLabel);
    occupied.push(labelBounds(refLabel, 4));

    const valueLabel = placeLabel(component, component.value, 'value', [
      { x: component.x, y: component.y + component.height / 2 + 26 },
      { x: component.x + component.width / 2 + textWidth(component.value) / 2 + sideGap, y: component.y },
      { x: component.x - component.width / 2 - textWidth(component.value) / 2 - sideGap, y: component.y },
      { x: component.x, y: component.y - component.height / 2 - 26 },
    ]);
    labels.push(valueLabel);
    occupied.push(labelBounds(valueLabel, 4));
  }
  return labels;
};

const segmentBounds = (from, to, clearance = 0) => ({
  left: Math.min(from.x, to.x) - clearance,
  right: Math.max(from.x, to.x) + clearance,
  top: Math.min(from.y, to.y) - clearance,
  bottom: Math.max(from.y, to.y) + clearance,
});

const segmentIntersectsRect = (from, to, rect) => {
  if (from.x === to.x) return from.x > rect.left && from.x < rect.right
    && Math.max(from.y, to.y) > rect.top && Math.min(from.y, to.y) < rect.bottom;
  if (from.y === to.y) return from.y > rect.top && from.y < rect.bottom
    && Math.max(from.x, to.x) > rect.left && Math.min(from.x, to.x) < rect.right;
  return rectsOverlap(segmentBounds(from, to), rect);
};

const pathSegments = (points) => points.slice(1).map((point, index) => ({ from: points[index], to: point }));

const segmentOrientation = (segment) => (
  segment.from.x === segment.to.x ? 'vertical' : segment.from.y === segment.to.y ? 'horizontal' : 'diagonal'
);

const collinearOverlap = (first, second) => {
  if (first.from.x === first.to.x && second.from.x === second.to.x && first.from.x === second.from.x) {
    return Math.min(Math.max(first.from.y, first.to.y), Math.max(second.from.y, second.to.y))
      > Math.max(Math.min(first.from.y, first.to.y), Math.min(second.from.y, second.to.y));
  }
  if (first.from.y === first.to.y && second.from.y === second.to.y && first.from.y === second.from.y) {
    return Math.min(Math.max(first.from.x, first.to.x), Math.max(second.from.x, second.to.x))
      > Math.max(Math.min(first.from.x, first.to.x), Math.min(second.from.x, second.to.x));
  }
  return false;
};

const pointToSegmentDistance = (point, segment) => {
  if (segment.from.x === segment.to.x) {
    const minY = Math.min(segment.from.y, segment.to.y);
    const maxY = Math.max(segment.from.y, segment.to.y);
    const dy = point.y < minY ? minY - point.y : point.y > maxY ? point.y - maxY : 0;
    return Math.hypot(point.x - segment.from.x, dy);
  }
  const minX = Math.min(segment.from.x, segment.to.x);
  const maxX = Math.max(segment.from.x, segment.to.x);
  const dx = point.x < minX ? minX - point.x : point.x > maxX ? point.x - maxX : 0;
  return Math.hypot(dx, point.y - segment.from.y);
};

const segmentsTouch = (first, second) => {
  if (collinearOverlap(first, second)) return true;
  const firstVertical = first.from.x === first.to.x;
  const secondVertical = second.from.x === second.to.x;
  if (firstVertical === secondVertical) {
    const firstPoint = first.from;
    const secondPoint = second.from;
    if (firstVertical && firstPoint.x !== secondPoint.x) return false;
    if (!firstVertical && firstPoint.y !== secondPoint.y) return false;
    const firstRange = firstVertical
      ? [Math.min(first.from.y, first.to.y), Math.max(first.from.y, first.to.y)]
      : [Math.min(first.from.x, first.to.x), Math.max(first.from.x, first.to.x)];
    const secondRange = secondVertical
      ? [Math.min(second.from.y, second.to.y), Math.max(second.from.y, second.to.y)]
      : [Math.min(second.from.x, second.to.x), Math.max(second.from.x, second.to.x)];
    return Math.max(firstRange[0], secondRange[0]) <= Math.min(firstRange[1], secondRange[1]);
  }
  const vertical = firstVertical ? first : second;
  const horizontal = firstVertical ? second : first;
  return vertical.from.x >= Math.min(horizontal.from.x, horizontal.to.x)
    && vertical.from.x <= Math.max(horizontal.from.x, horizontal.to.x)
    && horizontal.from.y >= Math.min(vertical.from.y, vertical.to.y)
    && horizontal.from.y <= Math.max(vertical.from.y, vertical.to.y);
};

const segmentDistance = (first, second) => {
  if (segmentsTouch(first, second)) return 0;
  return Math.min(
    pointToSegmentDistance(first.from, second),
    pointToSegmentDistance(first.to, second),
    pointToSegmentDistance(second.from, first),
    pointToSegmentDistance(second.to, first),
  );
};

const bridgeableCrossing = (first, second) => {
  const firstOrientation = segmentOrientation(first);
  const secondOrientation = segmentOrientation(second);
  if (firstOrientation === 'diagonal' || secondOrientation === 'diagonal' || firstOrientation === secondOrientation) return null;
  const vertical = firstOrientation === 'vertical' ? first : second;
  const horizontal = firstOrientation === 'horizontal' ? first : second;
  const point = { x: vertical.from.x, y: horizontal.from.y };
  const insideVertical = point.y >= Math.min(vertical.from.y, vertical.to.y)
    && point.y <= Math.max(vertical.from.y, vertical.to.y);
  const insideHorizontal = point.x >= Math.min(horizontal.from.x, horizontal.to.x)
    && point.x <= Math.max(horizontal.from.x, horizontal.to.x);
  if (!insideVertical || !insideHorizontal) return null;
  return point;
};

const bridgeForCrossing = (wire, segment, point) => ({
  wireId: wire.id,
  x: point.x,
  y: point.y,
  orientation: segmentOrientation(segment),
  radius: 7,
});

const bridgeMatches = (bridge, wire, point) =>
  bridge.wireId === wire.id && bridge.x === point.x && bridge.y === point.y;

const endpointRefsForWire = (wire) => new Set([wire.ref, wire.from?.ref, wire.to?.ref].filter(Boolean));

const wiresShareEndpointRef = (first, second) => {
  const firstRefs = endpointRefsForWire(first);
  return [...endpointRefsForWire(second)].some((ref) => firstRefs.has(ref));
};

const connectedRefsForNode = (diagram, node) => new Set(
  (diagram.components || [])
    .filter((component) => (component.pins || []).some((pin) => pin.node === node))
    .map((component) => component.ref),
);

const routeObstacles = (diagram, wire) => {
  const endpointRefs = new Set([wire.ref, wire.from?.ref, wire.to?.ref, wire.targetRef].filter(Boolean));
  if (wire.node) {
    for (const ref of connectedRefsForNode(diagram, wire.node)) endpointRefs.add(ref);
  }
  return [
    ...diagram.components
      .filter((component) => !endpointRefs.has(component.ref))
      .map((component) => componentBounds(component, WIRE_CLEARANCE)),
    ...(diagram.netLabels || [])
      .filter((label) => label.id !== wire.labelId)
      .map((label) => netLabelBounds(label, WIRE_CLEARANCE)),
  ];
};

const compactOrthogonalPath = (points) => points.filter((point, index, list) => {
  if (index === 0 || index === list.length - 1) return true;
  const before = list[index - 1];
  const after = list[index + 1];
  return !((before.x === point.x && point.x === after.x) || (before.y === point.y && point.y === after.y));
});

const reconstructPath = (states, key) => {
  const points = [];
  let current = key;
  while (current) {
    const state = states.get(current);
    points.push({ x: state.x, y: state.y });
    current = state.parent;
  }
  points.reverse();
  return points.filter((point, index) => {
    if (index === 0 || index === points.length - 1) return true;
    const before = points[index - 1];
    const after = points[index + 1];
    return !(before.x === point.x && point.x === after.x) && !(before.y === point.y && point.y === after.y);
  });
};

const heapPush = (heap, item) => {
  heap.push(item);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (heap[parent].score <= item.score) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = item;
};

const heapPop = (heap) => {
  if (heap.length === 1) return heap.pop();
  const first = heap[0];
  const last = heap.pop();
  let index = 0;
  while (index * 2 + 1 < heap.length) {
    let child = index * 2 + 1;
    const right = child + 1;
    if (right < heap.length && heap[right].score < heap[child].score) child = right;
    if (heap[child].score >= last.score) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = last;
  return first;
};

const endpointGridPoint = (diagram, point, grid) => {
  const owner = diagram.components.find((component) => (component.pins || [])
    .some((pin) => pin.x === point.x && pin.y === point.y));
  if (!owner) return { x: snap(point.x, grid), y: snap(point.y, grid) };
  const bounds = componentBounds(owner);
  const distances = [
    { side: 'left', value: Math.abs(point.x - bounds.left) },
    { side: 'right', value: Math.abs(point.x - bounds.right) },
    { side: 'top', value: Math.abs(point.y - bounds.top) },
    { side: 'bottom', value: Math.abs(point.y - bounds.bottom) },
  ].sort((first, second) => first.value - second.value);
  if (distances[0].side === 'left') {
    return { x: Math.floor((bounds.left - WIRE_CLEARANCE) / grid) * grid, y: snap(point.y, grid) };
  }
  if (distances[0].side === 'right') {
    return { x: Math.ceil((bounds.right + WIRE_CLEARANCE) / grid) * grid, y: snap(point.y, grid) };
  }
  if (distances[0].side === 'top') {
    return { x: snap(point.x, grid), y: Math.floor((bounds.top - WIRE_CLEARANCE) / grid) * grid };
  }
  return { x: snap(point.x, grid), y: Math.ceil((bounds.bottom + WIRE_CLEARANCE) / grid) * grid };
};

const routeSection = (start, end, diagram, wire, routedWires) => {
  const grid = diagram.grid?.size || GRID_SIZE;
  const startGrid = endpointGridPoint(diagram, start, grid);
  const endGrid = endpointGridPoint(diagram, end, grid);
  const obstacles = routeObstacles(diagram, wire);
  const hardBodies = diagram.components.map((component) => componentBounds(component));
  const occupiedSegments = routedWires
    .filter((item) => !wire.node || item.node !== wire.node)
    .flatMap((item) => pathSegments(item.points || [])
    .map((segment) => ({ ...segment, wireId: item.id })));
  const open = [{ ...startGrid, direction: '', cost: 0, score: Math.abs(startGrid.x - endGrid.x) + Math.abs(startGrid.y - endGrid.y) }];
  const best = new Map();
  const states = new Map();
  let visited = 0;
  while (open.length && visited < MAX_ROUTE_STATES) {
    const current = heapPop(open);
    const key = `${current.x},${current.y},${current.direction}`;
    if (best.has(key) && best.get(key) < current.cost) continue;
    states.set(key, current);
    if (current.x === endGrid.x && current.y === endGrid.y) {
      const gridPath = reconstructPath(states, key);
      const points = [
        start,
        { x: startGrid.x, y: start.y },
        ...gridPath,
        { x: endGrid.x, y: end.y },
        end,
      ].filter((point, index, list) => index === 0 || pointKey(point) !== pointKey(list[index - 1]));
      const compacted = compactOrthogonalPath(points);
      const legal = pathSegments(compacted).every((segment) =>
        !hardBodies.some((rect) => segmentIntersectsRect(segment.from, segment.to, rect))
        && !obstacles.some((rect) => segmentIntersectsRect(segment.from, segment.to, rect))
        && occupiedSegments.every((occupied) => !collinearOverlap(segment, occupied)));
      if (legal) return compacted;
    }
    visited += 1;
    const neighbors = [
      { x: current.x + grid, y: current.y, direction: 'h' },
      { x: current.x - grid, y: current.y, direction: 'h' },
      { x: current.x, y: current.y + grid, direction: 'v' },
      { x: current.x, y: current.y - grid, direction: 'v' },
    ];
    for (const neighbor of neighbors) {
      if (neighbor.x < CANVAS_MARGIN || neighbor.y < CANVAS_MARGIN
        || neighbor.x > diagram.width - CANVAS_MARGIN || neighbor.y > diagram.height - CANVAS_MARGIN) continue;
      const segment = { from: current, to: neighbor };
      if (hardBodies.some((rect) => segmentIntersectsRect(segment.from, segment.to, rect))) continue;
      if (obstacles.some((rect) => segmentIntersectsRect(segment.from, segment.to, rect))) continue;
      if (occupiedSegments.some((occupied) => collinearOverlap(segment, occupied))) continue;
      // Corners cost more than a grid step so the router trades a longer run
      // for a straighter one — zig-zags are the clearest machine-drawn tell.
      const bendCost = current.direction && current.direction !== neighbor.direction ? 30 : 0;
      const cost = current.cost + grid + bendCost;
      const neighborKey = `${neighbor.x},${neighbor.y},${neighbor.direction}`;
      if (best.has(neighborKey) && best.get(neighborKey) <= cost) continue;
      best.set(neighborKey, cost);
      states.set(neighborKey, { ...neighbor, cost, parent: key });
      heapPush(open, {
        ...neighbor,
        cost,
        parent: key,
        score: cost + Math.abs(neighbor.x - endGrid.x) + Math.abs(neighbor.y - endGrid.y),
      });
    }
  }
  return null;
};

const terminalPoint = (diagram, terminal) => {
  const component = diagram.components.find((item) => item.ref === terminal.ref);
  const pin = component?.pins.find((item) => item.pinIndex === terminal.pin);
  return pin ? { x: pin.x, y: pin.y } : { x: 0, y: 0 };
};

const wireEndpoints = (diagram, wire) => {
  if (wire.manual) return {
    start: terminalPoint(diagram, wire.from),
    end: terminalPoint(diagram, wire.to),
  };
  if (wire.portId) {
    const port = (diagram.ports || []).find((item) => item.id === wire.portId);
    const legacyNet = diagram.nets.find((item) => item.name === wire.node);
    return {
      start: port ? { x: port.x, y: port.y } : wire.points?.[0] || { x: 0, y: 0 },
      end: Number.isFinite(legacyNet?.x) && Number.isFinite(legacyNet?.y)
        ? { x: legacyNet.x, y: legacyNet.y }
        : wire.points?.at(-1) || (port ? { x: port.x, y: port.y } : { x: 0, y: 0 }),
    };
  }
  const component = diagram.components.find((item) => item.ref === wire.ref);
  const label = (diagram.netLabels || []).find((item) => item.id === wire.labelId);
  const legacyNet = diagram.nets.find((item) => item.name === wire.node);
  const pin = component?.pins.find((item) => item.pinIndex === wire.pin);
  const legacyEnd = Number.isFinite(legacyNet?.x) && Number.isFinite(legacyNet?.y)
    ? { x: legacyNet.x, y: legacyNet.y }
    : null;
  return {
    start: pin ? { x: pin.x, y: pin.y } : wire.points?.[0] || { x: 0, y: 0 },
    end: label
      ? { x: label.x, y: label.y }
      : legacyEnd || wire.points?.at(-1) || (pin ? { x: pin.x, y: pin.y } : { x: 0, y: 0 }),
  };
};

const fastOrthogonalRoute = (diagram, wire, routedWires, start, end) => {
  if (wire.preferredWaypoints?.length || wire.routingMode === 'manual' || wire.manual) return null;
  const grid = diagram.grid?.size || GRID_SIZE;
  const egress = endpointGridPoint(diagram, start, grid);
  const lead = [start, { x: egress.x, y: start.y }, egress]
    .filter((point, index, list) => index === 0 || pointKey(point) !== pointKey(list[index - 1]));
  const candidates = [
    [...lead, { x: egress.x, y: end.y }, end],
    [...lead, { x: end.x, y: egress.y }, end],
  ].map((points) => points.filter((point, index, list) =>
    index === 0 || pointKey(point) !== pointKey(list[index - 1])));
  const obstacles = routeObstacles(diagram, wire);
  const hardBodies = diagram.components.map((component) => componentBounds(component));
  const occupied = routedWires
    .filter((item) => !wire.node || item.node !== wire.node)
    .flatMap((item) => pathSegments(item.points || [])
    .map((segment) => ({ ...segment, wireId: item.id })));
  const candidate = candidates.find((points) => pathSegments(points).every((segment, index) => {
    if (index >= lead.length - 1 && hardBodies.some((rect) => segmentIntersectsRect(segment.from, segment.to, rect))) return false;
    if (obstacles.some((rect) => segmentIntersectsRect(segment.from, segment.to, rect))) return false;
    return occupied.every((other) => !collinearOverlap(segment, other));
  }));
  return candidate ? compactOrthogonalPath(candidate) : null;
};

const routeOneWire = (diagram, wire, routedWires, target = null) => {
  const endpoints = wireEndpoints(diagram, wire);
  const start = endpoints.start;
  const componentPins = new Set(diagram.components.flatMap((component) =>
    (component.pins || []).map((pin) => pointKey(pin))));
  const sameNetWires = !wire.labelId && wire.node && wire.node !== '0'
    ? routedWires.filter((item) => item.node === wire.node)
    : [];
  const sameNetPoints = sameNetWires.flatMap((item) => [
    ...(item.points || []),
    ...pathSegments(item.points || []).map((segment) => segment.from.x === segment.to.x
      ? {
          x: segment.from.x,
          y: Math.max(Math.min(start.y, Math.max(segment.from.y, segment.to.y)), Math.min(segment.from.y, segment.to.y)),
        }
      : {
          x: Math.max(Math.min(start.x, Math.max(segment.from.x, segment.to.x)), Math.min(segment.from.x, segment.to.x)),
          y: segment.from.y,
        }),
  ]).filter((point) => !componentPins.has(pointKey(point)));
  const targets = [...new Map(
    [...sameNetPoints, target || endpoints.end]
      .sort((first, second) =>
        Math.abs(first.x - start.x) + Math.abs(first.y - start.y)
        - Math.abs(second.x - start.x) - Math.abs(second.y - start.y))
      .map((point) => [pointKey(point), point]),
  ).values()].slice(0, 12);

  for (const end of targets) {
    const fastRoute = fastOrthogonalRoute(diagram, wire, routedWires, start, end);
    if (fastRoute) {
      return {
        ...wire,
        id: wire.id || `${wire.ref || wire.from?.ref}-${wire.pin || wire.from?.pin}-${wire.node || wire.to?.ref}`,
        routingMode: wire.routingMode || 'auto',
        points: fastRoute,
      };
    }
    const preferences = (wire.preferredWaypoints || (wire.offset ? [{
      x: (start.x + end.x) / 2 + wire.offset.x,
      y: (start.y + end.y) / 2 + wire.offset.y,
    }] : [])).map((point) => ({
      x: snap(Math.max(CANVAS_MARGIN, Math.min(diagram.width - CANVAS_MARGIN, point.x))),
      y: snap(Math.max(CANVAS_MARGIN, Math.min(diagram.height - CANVAS_MARGIN, point.y))),
    }));
    const stops = [start, ...preferences, end];
    const points = [];
    let failed = false;
    for (let index = 0; index < stops.length - 1; index += 1) {
      const section = routeSection(stops[index], stops[index + 1], diagram, wire, routedWires);
      if (!section) {
        failed = true;
        break;
      }
      points.push(...section.slice(points.length ? 1 : 0));
    }
    if (!failed) {
      return {
        ...wire,
        id: wire.id || `${wire.ref || wire.from?.ref}-${wire.pin || wire.from?.pin}-${wire.node || wire.to?.ref}`,
        routingMode: wire.manual ? 'manual' : wire.routingMode || 'auto',
        points,
      };
    }
  }
  return null;
};

const wirePriority = (wire, diagram) => {
  const net = diagram.nets.find((item) => item.name === wire.node);
  if (wire.node === '0' || /^(vcc|vdd|vee|vss)$/i.test(String(wire.node))) return 0;
  if ((net?.connections?.length || 0) > 3) return 1;
  if (isOutputNode(wire.node)) return 2;
  return 3;
};

const pinSide = (component, pin) => {
  const bounds = componentBounds(component);
  return [
    { direction: 'left', distance: Math.abs(pin.x - bounds.left) },
    { direction: 'right', distance: Math.abs(pin.x - bounds.right) },
    { direction: 'up', distance: Math.abs(pin.y - bounds.top) },
    { direction: 'down', distance: Math.abs(pin.y - bounds.bottom) },
  ].sort((first, second) => first.distance - second.distance)[0].direction;
};

// A wire reads as hand-routed when it leaves one part and enters the next in a
// single straight run. For a part about to be placed, find the row an
// already-placed connected pin escapes on: side pins connect straight across at
// their own row, top/bottom pins connect on the first grid row past the body.
// Only grid rows qualify — aligning to an off-grid row would trade one visible
// bend for an uglier off-grid jog.
const alignmentRow = (placed, nodes) => {
  for (const node of nodes) {
    for (const other of placed) {
      for (const pin of other.pins || []) {
        if (pin.node !== node) continue;
        const side = pinSide(other, pin);
        if (side === 'left' || side === 'right') {
          if (pin.y === snap(pin.y)) return pin.y;
          continue;
        }
        const bounds = componentBounds(other);
        return side === 'up'
          ? Math.floor((bounds.top - WIRE_CLEARANCE) / GRID_SIZE) * GRID_SIZE
          : Math.ceil((bounds.bottom + WIRE_CLEARANCE) / GRID_SIZE) * GRID_SIZE;
      }
    }
  }
  return null;
};

const connectionLabel = (id, name, anchor, direction, terminal = {}) => {
  const labelWidth = name === '0' ? 0 : textWidth(name);
  let labelX = anchor.x - labelWidth / 2;
  let labelY = anchor.y - 13;
  if (direction === 'right') labelX = anchor.x;
  if (direction === 'left') labelX = anchor.x - labelWidth;
  if (direction === 'up') labelY = anchor.y - 26;
  if (direction === 'down') labelY = anchor.y;
  return {
    id,
    name,
    ...terminal,
    x: anchor.x,
    y: anchor.y,
    direction,
    labelX,
    labelY,
    labelWidth,
  };
};

const placeNetLabels = (diagram, preferredLabels = new Map()) => {
  const labels = [];
  const withinCanvas = (label) => {
    const bounds = netLabelBounds(label);
    return bounds.left >= CANVAS_MARGIN && bounds.top >= CANVAS_MARGIN
      && bounds.right <= diagram.width - CANVAS_MARGIN
      && bounds.bottom <= diagram.height - CANVAS_MARGIN;
  };
  const legal = (label) => {
    if (!withinCanvas(label)) return false;
    const visualBounds = netLabelBounds(label);
    if (diagram.components.some((other) => rectsOverlap(
      visualBounds,
      componentBounds(other),
      WIRE_CLEARANCE,
    ))) return false;
    if ((diagram.labels || []).some((other) => rectsOverlap(
      visualBounds,
      labelBounds(other),
      WIRE_CLEARANCE,
    ))) return false;
    if (labels.some((other) => rectsOverlap(
      visualBounds,
      netLabelBounds(other),
      WIRE_CLEARANCE,
    ))) return false;
    if (diagram.components.some((component) => (component.pins || []).some((pin) =>
      !(label.ref === component.ref && label.pin === pin.pinIndex)
      && rectsOverlap(visualBounds, pinEscapeBounds(component, pin), WIRE_CLEARANCE)))) return false;
    return !diagram.components.some((component) => rectsOverlap(
      { left: label.x - 1, right: label.x + 1, top: label.y - 1, bottom: label.y + 1 },
      componentBounds(component, WIRE_CLEARANCE),
    ));
  };

  const groundWires = diagram.wires.filter((wire) => !wire.manual && wire.node === '0');
  for (const wire of groundWires) {
    const component = diagram.components.find((item) => item.ref === wire.ref);
    const pin = component?.pins.find((item) => item.pinIndex === wire.pin);
    if (!component || !pin) continue;
    const preferred = preferredLabels.get(wire.labelId);
    let placed = preferred
      ? connectionLabel(wire.labelId, wire.node, preferred, preferred.direction || 'down', { ref: wire.ref, pin: wire.pin })
      : null;
    if (!placed || !legal(placed)) {
      placed = null;
      const outward = pinSide(component, pin);
      const directions = ['down', outward, 'left', 'right', 'up'];
      const uniqueDirections = [...new Set(directions)];
      for (let radius = 2; radius <= 36 && !placed; radius += 1) {
        const distance = radius * GRID_SIZE;
        for (const direction of uniqueDirections) {
          for (const tangent of [0, -1, 1, -2, 2, -3, 3]) {
            const delta = {
              left: { x: -distance, y: tangent * GRID_SIZE },
              right: { x: distance, y: tangent * GRID_SIZE },
              up: { x: tangent * GRID_SIZE, y: -distance },
              down: { x: tangent * GRID_SIZE, y: distance },
            }[direction];
            const candidate = connectionLabel(wire.labelId, wire.node, {
              x: snap(pin.x + delta.x),
              y: snap(pin.y + delta.y),
            }, direction, { ref: wire.ref, pin: wire.pin });
            if (legal(candidate)) {
              placed = candidate;
              break;
            }
          }
          if (placed) break;
        }
      }
    }
    if (!placed) {
      throw new DiagramLayoutError(`No legal label position is available for ${wire.ref} pin ${wire.pin}.`, [
        { type: 'net_label_placement_failed', wire: wire.id },
      ]);
    }
    labels.push(placed);
  }

  const signalWires = diagram.wires.filter((wire) => !wire.manual && wire.node !== '0');
  for (const wire of signalWires) {
    const component = diagram.components.find((item) => item.ref === wire.ref);
    const pin = component?.pins.find((item) => item.pinIndex === wire.pin);
    if (!component || !pin) continue;
    const preferred = preferredLabels.get(wire.labelId);
    let placed = preferred
      ? connectionLabel(wire.labelId, wire.node, preferred, preferred.direction || pinSide(component, pin), {
          ref: wire.ref,
          pin: wire.pin,
        })
      : null;
    if (!placed || !legal(placed)) {
      placed = null;
      const outward = pinSide(component, pin);
      const directions = [...new Set([outward, 'up', 'right', 'left', 'down'])];
      for (let radius = 2; radius <= 36 && !placed; radius += 1) {
        const distance = radius * GRID_SIZE;
        for (const direction of directions) {
          for (const tangent of [0, -1, 1, -2, 2, -3, 3]) {
            const delta = {
              left: { x: -distance, y: tangent * GRID_SIZE },
              right: { x: distance, y: tangent * GRID_SIZE },
              up: { x: tangent * GRID_SIZE, y: -distance },
              down: { x: tangent * GRID_SIZE, y: distance },
            }[direction];
            const candidate = connectionLabel(wire.labelId, wire.node, {
              x: snap(pin.x + delta.x),
              y: snap(pin.y + delta.y),
            }, direction, { ref: wire.ref, pin: wire.pin });
            if (legal(candidate)) {
              placed = candidate;
              break;
            }
          }
          if (placed) break;
        }
      }
    }
    if (!placed) {
      throw new DiagramLayoutError(`No legal label position is available for ${wire.ref} pin ${wire.pin}.`, [
        { type: 'net_label_placement_failed', wire: wire.id, node: wire.node },
      ]);
    }
    labels.push(placed);
  }
  return labels;
};

const buildDraft = (circuit, options = {}) => {
  const schematic = circuit.schematic || {};
  const componentRoles = roleMapByRef(schematic);
  const netRoles = roleMapByNet(schematic);
  const ranks = rankComponents(circuit);
  const netNames = [...new Set((circuit.components || []).flatMap((component) =>
    component.nodes.filter((node, index) => !isUnconnectedTerminal(node, component.ref, index + 1))))];
  const nonGroundNets = netNames.filter((name) => name !== '0').sort((first, second) => {
    const firstOutput = isOutputNode(first) ? 1 : 0;
    const secondOutput = isOutputNode(second) ? 1 : 0;
    return firstOutput - secondOutput || first.localeCompare(second);
  });
  const maxRank = Math.max(0, ...ranks.values());
  const rankColumns = Math.min(8, maxRank + 1);
  const rankBands = Math.ceil((maxRank + 1) / rankColumns);
  // Slot mode: place one component per fixed slot and size the canvas to the
  // grid (see slotCanvasSize) instead of to the free signal-flow spread.
  const slotMode = Boolean(options.slots);
  const slotGrid = slotMode ? slotGridFor((circuit.components || []).length) : null;
  const slots = slotMode ? slotRects(slotGrid.rows, slotGrid.cols) : null;
  const slotAssignment = slotMode
    ? assignSlots(
        [...(circuit.components || [])]
          .map((part, index) => ({ ref: part.ref, rank: ranks.get(part.ref) || 0, index }))
          .sort((first, second) => first.rank - second.rank || first.index - second.index)
          .map((entry) => entry.ref),
        slots,
      )
    : null;
  const slotSize = slotMode ? slotCanvasSize(slotGrid.rows, slotGrid.cols) : null;
  const width = slotMode
    ? slotSize.width + (options.extraWidth || 0)
    : Math.max(1100, CANVAS_MARGIN * 2 + rankColumns * 340) + (options.extraWidth || 0);
  const height = slotMode
    ? slotSize.height + (options.extraHeight || 0)
    : Math.max(720, 480 + rankBands * 300 + Math.ceil((circuit.components?.length || 0) / 8) * 110)
      + (options.extraHeight || 0);
  const netPositions = new Map(nonGroundNets.map((name, index) => [name, {
    x: snap(CANVAS_MARGIN + 100 + index * ((width - CANVAS_MARGIN * 2 - 200) / Math.max(1, nonGroundNets.length - 1))),
    y: CANVAS_MARGIN + 40 + (index % 4) * 50,
  }]));
  const placed = [];
  const rankRows = new Map();
  const sideRows = new Map();
  for (const [index, part] of (circuit.components || []).entries()) {
    const rank = ranks.get(part.ref) || 0;
    const row = rankRows.get(rank) || 0;
    rankRows.set(rank, row + 1);
    const role = componentRoles.get(String(part.ref || '').toUpperCase());
    const roleSide = String(role?.side || '').toLowerCase();
    const roleRow = sideRows.get(roleSide) || 0;
    if (roleSide) sideRows.set(roleSide, roleRow + 1);
    const rankBand = Math.floor(rank / rankColumns);
    const rawColumn = rank % rankColumns;
    const visualColumn = rankBand % 2 === 0 ? rawColumn : rankColumns - rawColumn - 1;
    const size = componentSize(part.kind);
    const nodes = part.nodes.map(String);
    const nonGround = nodes.filter((node) => node !== '0');
    const hasGround = nodes.includes('0');
    const isTwoPin = nodes.length <= 2;
    let orientation = 'horizontal';
    // Human schematics read as clean signal-flow columns. Parts in the same rank
    // sit in the rank's vertical lane, stacked evenly. Ranks with several parts
    // fan into a tight, aligned 2-column block (not the old 3-wide, wide-stride
    // scatter) so the router keeps 2-D breathing room while the result still
    // reads as orderly pairs rather than random placement. Ranks with one part
    // stay a single clean column.
    const grid = options.spread ? SPREAD_GRID : TIDY_GRID;
    const subColumn = row % grid.subColumns;
    const subRow = Math.floor(row / grid.subColumns);
    let preferred = {
      x: CANVAS_MARGIN + grid.columnStart + visualColumn * grid.columnStride + subColumn * grid.subColumnStride,
      y: grid.rowStart + rankBand * grid.rankBandStride + subRow * grid.rowStride,
    };
    let componentWidth = size.width;
    let componentHeight = size.height;
    if (isTwoPin && hasGround && nonGround.length) {
      orientation = 'vertical';
      preferred = { x: preferred.x, y: preferred.y + 100 };
      if (componentHeight < componentWidth) {
        // Stand the body upright too: the vertical zigzag glyph assumes a tall
        // body, and a rotated part keeping its landscape box draws a scribble
        // with the wire running through it.
        componentWidth = size.height;
        componentHeight = size.width;
      }
    } else if (isTwoPin && nonGround.length) {
      // Series passives line up with the pin that feeds them so the joining
      // wire runs straight — the strongest single cue of a hand-drawn sheet.
      // Stay within the part's own rank band: long chains wrap into serpentine
      // bands, and dragging a part back to the previous band's row would pile
      // the whole chain onto one endless line.
      const row = alignmentRow(placed, nonGround);
      if (row !== null && Math.abs(row - preferred.y) < grid.rankBandStride * 0.75) {
        preferred = { x: preferred.x, y: row };
      }
    } else if (size.symbolType === 'opamp') {
      // Center the op amp so whichever input is already driven sits level
      // with its driving pin.
      const spread = snap(size.height * 0.22);
      const invertingRow = nodes[1] && nodes[1] !== '0' ? alignmentRow(placed, [nodes[1]]) : null;
      const nonInvertingRow = invertingRow === null && nodes[0] && nodes[0] !== '0'
        ? alignmentRow(placed, [nodes[0]])
        : null;
      const centered = invertingRow !== null
        ? invertingRow + spread
        : nonInvertingRow !== null ? nonInvertingRow - spread : null;
      if (centered !== null && Math.abs(centered - preferred.y) < grid.rankBandStride * 0.75) {
        preferred = { x: preferred.x, y: centered };
      }
    } else if (size.symbolType === 'bjt_npn' || size.symbolType === 'bjt_pnp') {
      const baseRow = nodes[1] && nodes[1] !== '0' ? alignmentRow(placed, [nodes[1]]) : null;
      if (baseRow !== null && Math.abs(baseRow - preferred.y) < grid.rankBandStride * 0.75) {
        preferred = { x: preferred.x, y: baseRow };
      }
    }
    if (role?.orientation === 'horizontal' || role?.orientation === 'vertical') {
      orientation = role.orientation;
    }
    if (['left', 'center', 'right', 'top', 'bottom'].includes(roleSide)) {
      const columns = {
        left: CANVAS_MARGIN + 260,
        center: Math.max(CANVAS_MARGIN + 420, width / 2),
        right: width - CANVAS_MARGIN - 260,
        top: Math.max(CANVAS_MARGIN + 420, width / 2),
        bottom: Math.max(CANVAS_MARGIN + 420, width / 2),
      };
      const rows = {
        left: 220 + roleRow * 150,
        center: 300 + roleRow * 170,
        right: 220 + roleRow * 150,
        top: 160 + roleRow * 120,
        bottom: height - 180 - roleRow * 120,
      };
      preferred = {
        x: columns[roleSide],
        y: rows[roleSide],
      };
    }
    // Slot mode pins the component to its assigned slot center; the orientation
    // heuristics above still apply (they only affect body/pin geometry).
    if (slotMode) {
      const slot = slotAssignment.get(part.ref) || slots[index] || slots[slots.length - 1];
      if (slot) preferred = slotCenter(slot);
    }
    const component = {
      ref: part.ref,
      kind: part.kind,
      value: part.value,
      nodes,
      symbolType: size.symbolType,
      orientation,
      x: snap(preferred.x),
      y: snap(preferred.y),
      width: componentWidth,
      height: componentHeight,
      pinCount: Math.max(nodes.length, 2),
      order: index,
    };
    component.pins = nodes.map((node, pinIndex) => ({
      node,
      pinIndex: pinIndex + 1,
      ...pinPoint(component, pinIndex + 1, node),
    }));
    const anchor = options.anchors?.get(part.ref);
    const target = anchor || component;
    // In slot mode (without an explicit anchor) the component sits exactly at
    // its slot center — never nudged out of the slot to dodge a collision.
    const position = slotMode && !anchor
      ? { x: component.x, y: component.y }
      : nearestFreePosition(component, placed, target, { width, height: height * 3, clearance: PLACEMENT_CLEARANCE })
        || { x: component.x, y: component.y + placed.length * 160 };
    placed.push(moveComponent(component, position.x, position.y));
  }
  // Slot mode keeps the canvas locked to the grid; the free layout grows to fit
  // the lowest placed part.
  const requiredHeight = slotMode
    ? height
    : Math.max(height, ...placed.map((component) => component.y + component.height / 2 + 150));
  const componentLabels = makeComponentLabels(placed);
  const netPinCounts = new Map();
  placed.forEach((component) => {
    component.pins.forEach((pin) => netPinCounts.set(pin.node, (netPinCounts.get(pin.node) || 0) + 1));
  });
  const terminalCounts = new Map();
  const activeTerminals = (schematic.externalTerminals || [])
    .filter((terminal) => terminal.explicit || (netPinCounts.get(String(terminal.net || '')) || 0) <= 1);
  for (const terminal of activeTerminals) {
    const netRole = netRoles.get(String(terminal.net || ''));
    const side = terminalSide(terminal, netRole);
    terminalCounts.set(side, (terminalCounts.get(side) || 0) + 1);
  }
  const terminalIndexes = new Map();
  // Slot mode fixes component positions, so an edge-anchored port can end up far
  // from its net's pin with occupied slots in between (unroutable). Instead drop
  // the port as a short stub just outside the pin it connects to.
  const slotPortPoint = (net, side) => {
    const pin = placed.flatMap((component) => component.pins).find((item) => item.node === net);
    if (!pin) return null;
    const STUB = GRID_SIZE * 2;
    if (side === 'left') return { x: snap(pin.x - STUB), y: snap(pin.y) };
    if (side === 'right') return { x: snap(pin.x + STUB), y: snap(pin.y) };
    if (side === 'top') return { x: snap(pin.x), y: snap(pin.y - STUB) };
    return { x: snap(pin.x), y: snap(pin.y + STUB) };
  };
  const ports = activeTerminals
    .filter((terminal) => netNames.includes(String(terminal.net || '')))
    .map((terminal, index) => {
      const net = String(terminal.net);
      const netRole = netRoles.get(net);
      const side = terminalSide(terminal, netRole);
      const point = (slotMode && slotPortPoint(net, side))
        || portTerminalPoint(terminal, terminalIndexes, terminalCounts, { width, height: requiredHeight }, netRole);
      const label = String(terminal.label || net);
      const labelWidth = textWidth(label, 48, 110);
      return {
        id: `port:${net}:${index}`,
        net,
        label,
        type: String(terminal.type || netRole?.role || 'terminal'),
        side,
        x: point.x,
        y: point.y,
        labelWidth,
      };
    });
  const nets = netNames.map((name) => {
    const connections = placed.flatMap((component) => component.pins
      .filter((pin) => pin.node === name)
      .map((pin) => ({ ref: component.ref, pin: pin.pinIndex, x: pin.x, y: pin.y })));
    // Anchor the ground rail just below the lowest grounded pin, not at the
    // canvas bottom. A local rail keeps ground drops short and clustered under
    // the parts they belong to (how an engineer draws it) instead of routing
    // every ground wire the full height of the sheet into a void.
    const position = name === '0'
      ? {
          x: snap(connections.reduce((sum, item) => sum + item.x, 0) / Math.max(1, connections.length)),
          y: snap(Math.max(120, ...connections.map((item) => item.y)) + 90),
        }
      : netPositions.get(name);
    return {
      name,
      ...(position ? { x: position.x, y: position.y } : {}),
      connections,
    };
  });
  const wires = placed.flatMap((component) => component.pins
    .filter((pin) => !isUnconnectedTerminal(pin.node, component.ref, pin.pinIndex))
    .map((pin) => ({
      id: `${component.ref}-${pin.pinIndex}-${pin.node}`,
      ref: component.ref,
      pin: pin.pinIndex,
      node: pin.node,
      labelId: labelIdForWire({ ref: component.ref, pin: pin.pinIndex, node: pin.node }),
      routingMode: 'auto',
      preferredWaypoints: [],
      points: [],
    }))).concat(ports.map((port) => ({
      id: `port-wire:${port.id}`,
      portId: port.id,
      node: port.net,
      routingMode: 'auto',
      preferredWaypoints: [],
      points: [],
    })));
  const draft = {
    title: circuit.title,
    layoutVersion: LAYOUT_VERSION,
    grid: { size: GRID_SIZE, componentClearance: COMPONENT_CLEARANCE, wireClearance: WIRE_CLEARANCE },
    width,
    height: requiredHeight,
    components: placed,
    nets,
    ports,
    labels: componentLabels,
    netLabels: [],
    wires,
    junctions: [],
    bridges: [],
    ...(slotMode ? { slotLayout: slotGrid } : {}),
  };
  return draft;
};

export const buildFallbackCircuitDiagram = (circuit, options = {}) => {
  const draft = buildDraft(circuit, options);
  const stubLength = GRID_SIZE * 2;
  const netLabels = [];
  const wires = draft.wires.map((wire) => {
    if (wire.portId) {
      const port = draft.ports.find((item) => item.id === wire.portId);
      if (!port) return null;
      const anchor = {
        left: { x: port.x + stubLength, y: port.y },
        right: { x: port.x - stubLength, y: port.y },
        top: { x: port.x, y: port.y + stubLength },
        bottom: { x: port.x, y: port.y - stubLength },
      }[port.side] || { x: port.x + stubLength, y: port.y };
      return {
        ...wire,
        routingMode: 'fallback',
        points: [
          { x: port.x, y: port.y },
          anchor,
        ],
      };
    }
    const component = draft.components.find((item) => item.ref === wire.ref);
    const pin = component?.pins.find((item) => item.pinIndex === wire.pin);
    if (!component || !pin) return null;
    const direction = pinSide(component, pin);
    const labelWidth = wire.node === '0' ? 36 : textWidth(wire.node);
    const anchor = {
      left: {
        x: Math.max(CANVAS_MARGIN + labelWidth, pin.x - stubLength),
        y: pin.y,
      },
      right: {
        x: pin.x + stubLength,
        y: pin.y,
      },
      up: {
        x: pin.x,
        y: Math.max(CANVAS_MARGIN + 26, pin.y - stubLength),
      },
      down: {
        x: pin.x,
        y: pin.y + stubLength,
      },
    }[direction];
    const label = connectionLabel(
      wire.labelId,
      wire.node,
      anchor,
      direction,
      { ref: wire.ref, pin: wire.pin },
    );
    netLabels.push(label);
    return {
      ...wire,
      routingMode: 'fallback',
      points: [
        { x: pin.x, y: pin.y },
        { x: anchor.x, y: anchor.y },
      ],
    };
  }).filter(Boolean);
  const bounds = [
    ...draft.components.map((component) => componentBounds(component)),
    ...draft.labels.map((label) => labelBounds(label)),
    ...netLabels.map((label) => netLabelBounds(label)),
    ...wires.flatMap((wire) => wire.points || []).map((point) => ({
      left: point.x,
      right: point.x,
      top: point.y,
      bottom: point.y,
    })),
  ];
  const minLeft = Math.min(0, ...bounds.map((box) => box.left));
  const minTop = Math.min(0, ...bounds.map((box) => box.top));
  const shiftX = minLeft < 0 ? snap(Math.abs(minLeft) + CANVAS_MARGIN) : 0;
  const shiftY = minTop < 0 ? snap(Math.abs(minTop) + CANVAS_MARGIN) : 0;
  const movePoint = (point) => ({ x: point.x + shiftX, y: point.y + shiftY });
  const components = draft.components.map((component) =>
    shiftX || shiftY ? moveComponent(component, component.x + shiftX, component.y + shiftY) : component);
  const labels = draft.labels.map((label) => ({
    ...label,
    x: label.x + shiftX,
    y: label.y + shiftY,
  }));
  const shiftedNetLabels = netLabels.map((label) => ({
    ...label,
    x: label.x + shiftX,
    y: label.y + shiftY,
    labelX: label.labelX + shiftX,
    labelY: label.labelY + shiftY,
  }));
  const shiftedWires = wires.map((wire) => ({
    ...wire,
    points: (wire.points || []).map(movePoint),
  }));
  const shiftedPorts = draft.ports.map((port) => ({
    ...port,
    x: port.x + shiftX,
    y: port.y + shiftY,
  }));
  const shiftedNets = draft.nets.map((net) => ({
    ...net,
    ...(Number.isFinite(net.x) && Number.isFinite(net.y) ? movePoint(net) : {}),
    connections: (net.connections || []).map((connection) => ({
      ...connection,
      x: connection.x + shiftX,
      y: connection.y + shiftY,
    })),
  }));
  const shiftedBounds = [
    ...components.map((component) => componentBounds(component)),
    ...labels.map((label) => labelBounds(label)),
    ...shiftedNetLabels.map((label) => netLabelBounds(label)),
  ];
  return {
    ...draft,
    layoutMode: 'fallback',
    layoutWarning: 'Schematic opened with labeled nets because automatic wire routing could not fully resolve this layout.',
    components,
    labels,
    nets: shiftedNets,
    ports: shiftedPorts,
    netLabels: shiftedNetLabels,
    wires: shiftedWires,
    junctions: [],
    bridges: [],
    width: Math.max(draft.width + shiftX, ...shiftedBounds.map((box) => box.right + CANVAS_MARGIN)),
    height: Math.max(draft.height + shiftY, ...shiftedBounds.map((box) => box.bottom + CANVAS_MARGIN)),
  };
};

const routeOrders = (diagram) => {
  const distance = (wire) => {
    const { start, end } = wireEndpoints(diagram, wire);
    return Math.abs(start.x - end.x) + Math.abs(start.y - end.y);
  };
  const groups = new Map();
  for (const wire of diagram.wires) {
    const key = wire.manual ? `wire:${wire.id}` : `net:${wire.node}`;
    groups.set(key, [...(groups.get(key) || []), wire]);
  }
  const grouped = [...groups.values()].map((wires) => [...wires].sort((first, second) =>
    distance(first) - distance(second) || String(first.id).localeCompare(String(second.id))));
  const signalGroups = grouped.filter((wires) => !wires[0].manual && wires[0].node !== '0');
  const manualGroups = grouped.filter((wires) => wires[0].manual);
  const groundGroups = grouped.filter((wires) => !wires[0].manual && wires[0].node === '0');
  const byPriority = [...signalGroups].sort((first, second) =>
    wirePriority(first[0], diagram) - wirePriority(second[0], diagram)
    || String(first[0].node || first[0].id).localeCompare(String(second[0].node || second[0].id)));
  const bySize = [...signalGroups].sort((first, second) =>
    second.length - first.length
    || wirePriority(first[0], diagram) - wirePriority(second[0], diagram));
  const byHubDensity = [...signalGroups].sort((first, second) => {
    const density = (group) => {
      const net = diagram.nets.find((item) => item.name === group[0].node);
      if (!Number.isFinite(net?.x) || !Number.isFinite(net?.y)) return 0;
      const area = {
        left: net.x - 140,
        right: net.x + 140,
        top: net.y - 140,
        bottom: net.y + 140,
      };
      return diagram.components.filter((component) =>
        rectsOverlap(area, componentBounds(component, WIRE_CLEARANCE))).length;
    };
    return density(first) - density(second)
      || second.length - first.length
      || wirePriority(first[0], diagram) - wirePriority(second[0], diagram);
  });
  const tail = [...manualGroups, ...groundGroups];
  const permutations = (items) => {
    if (items.length < 2) return [items];
    if (items.length > 5) {
      return items.map((_, index) => [...items.slice(index), ...items.slice(0, index)]);
    }
    return items.flatMap((item, index) => permutations([
      ...items.slice(0, index),
      ...items.slice(index + 1),
    ]).map((rest) => [item, ...rest]));
  };
  const candidates = signalGroups.length <= 5
    ? permutations(byPriority)
    : [byPriority, [...byPriority].reverse(), bySize, [...bySize].reverse()];
  const seen = new Set();
  return [
    ...candidates,
    bySize,
    [...bySize].reverse(),
    byHubDensity,
    [...byHubDensity].reverse(),
  ].filter((groups) => {
    const key = groups.map((group) => group[0]?.node || group[0]?.id).join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((groups) => [...groups, ...tail]);
};

const splitPathAtHalf = (points) => {
  const segments = pathSegments(points);
  const total = segments.reduce((sum, segment) =>
    sum + Math.abs(segment.to.x - segment.from.x) + Math.abs(segment.to.y - segment.from.y), 0);
  let remaining = total / 2;
  let splitIndex = 0;
  let hub = points[0];
  for (const [index, segment] of segments.entries()) {
    const length = Math.abs(segment.to.x - segment.from.x) + Math.abs(segment.to.y - segment.from.y);
    if (remaining <= length) {
      hub = segment.from.x === segment.to.x
        ? { x: segment.from.x, y: snap(segment.from.y + Math.sign(segment.to.y - segment.from.y) * remaining) }
        : { x: snap(segment.from.x + Math.sign(segment.to.x - segment.from.x) * remaining), y: segment.from.y };
      splitIndex = index;
      break;
    }
    remaining -= length;
  }
  const first = compactOrthogonalPath([...points.slice(0, splitIndex + 1), hub]
    .filter((point, index, list) => index === 0 || pointKey(point) !== pointKey(list[index - 1])));
  const second = compactOrthogonalPath([hub, ...points.slice(splitIndex + 1)].reverse()
    .filter((point, index, list) => index === 0 || pointKey(point) !== pointKey(list[index - 1])));
  return { first, second, hub };
};

const limitedPermutations = (items) => {
  if (items.length < 2) return [items];
  if (items.length > 5) return [items, [...items].reverse()];
  return items.flatMap((item, index) => limitedPermutations([
    ...items.slice(0, index),
    ...items.slice(index + 1),
  ]).map((rest) => [item, ...rest]));
};

const netHubPoint = (diagram, wires) => {
  const net = diagram.nets.find((item) => item.name === wires[0]?.node);
  const starts = wires.map((wire) => wireEndpoints(diagram, wire).start);
  const average = {
    x: snap(starts.reduce((sum, point) => sum + point.x, 0) / Math.max(1, starts.length)),
    y: snap(starts.reduce((sum, point) => sum + point.y, 0) / Math.max(1, starts.length)),
  };
  const legal = (point) => {
    if (point.x < CANVAS_MARGIN || point.y < CANVAS_MARGIN
      || point.x > diagram.width - CANVAS_MARGIN || point.y > diagram.height - CANVAS_MARGIN) return false;
    const bounds = { left: point.x - 1, right: point.x + 1, top: point.y - 1, bottom: point.y + 1 };
    return diagram.components.every((component) => !rectsOverlap(bounds, componentBounds(component, WIRE_CLEARANCE)));
  };
  if (Number.isFinite(net?.x) && Number.isFinite(net?.y)) {
    const preferred = { x: net.x, y: net.y };
    if (legal(preferred)) return preferred;
  }
  if (legal(average)) return average;
  for (let radius = 1; radius <= 36; radius += 1) {
    const candidates = [];
    for (let dx = -radius; dx <= radius; dx += 1) {
      candidates.push({ x: snap(average.x + dx * GRID_SIZE), y: snap(average.y - radius * GRID_SIZE) });
      candidates.push({ x: snap(average.x + dx * GRID_SIZE), y: snap(average.y + radius * GRID_SIZE) });
    }
    for (let dy = -radius + 1; dy < radius; dy += 1) {
      candidates.push({ x: snap(average.x - radius * GRID_SIZE), y: snap(average.y + dy * GRID_SIZE) });
      candidates.push({ x: snap(average.x + radius * GRID_SIZE), y: snap(average.y + dy * GRID_SIZE) });
    }
    const found = candidates.find(legal);
    if (found) return found;
  }
  return average;
};

const routeNetGroup = (diagram, wires, routedWires) => {
  if (wires.length < 2) {
    const endpoints = wireEndpoints(diagram, wires[0]);
    const component = diagram.components.find((item) => item.ref === wires[0].ref);
    const pin = component?.pins.find((item) => item.pinIndex === wires[0].pin);
    const direction = component && pin ? pinSide(component, pin) : 'right';
    const delta = {
      left: { x: -GRID_SIZE * 2, y: 0 },
      right: { x: GRID_SIZE * 2, y: 0 },
      up: { x: 0, y: -GRID_SIZE * 2 },
      down: { x: 0, y: GRID_SIZE * 2 },
    }[direction];
    const maxX = Math.max(GRID_SIZE, diagram.width - GRID_SIZE);
    const maxY = Math.max(GRID_SIZE, diagram.height - GRID_SIZE);
    const target = {
      x: snap(Math.max(GRID_SIZE, Math.min(maxX, endpoints.start.x + delta.x))),
      y: snap(Math.max(GRID_SIZE, Math.min(maxY, endpoints.start.y + delta.y))),
    };
    const routed = routeOneWire(diagram, wires[0], [], target);
    return routed ? [routed] : null;
  }
  if (wires.length === 2) {
    const [firstWire, secondWire] = wires;
    const target = wireEndpoints(diagram, secondWire).start;
    const trunk = routeOneWire(diagram, { ...firstWire, targetRef: secondWire.ref }, routedWires, target);
    if (!trunk) return null;
    const split = splitPathAtHalf(trunk.points);
    return [
      { ...trunk, targetRef: undefined, points: split.first },
      { ...secondWire, points: split.second },
    ];
  }
  const hub = netHubPoint(diagram, wires);
  const ordered = [...wires].sort((first, second) => {
    const firstStart = wireEndpoints(diagram, first).start;
    const secondStart = wireEndpoints(diagram, second).start;
    const firstDistance = Math.abs(firstStart.x - hub.x) + Math.abs(firstStart.y - hub.y);
    const secondDistance = Math.abs(secondStart.x - hub.x) + Math.abs(secondStart.y - hub.y);
    return firstDistance - secondDistance || first.id.localeCompare(second.id);
  });
  const orders = [
    ordered,
    [...ordered].reverse(),
    ...limitedPermutations(ordered).slice(0, 24),
  ];
  const seen = new Set();
  for (const order of orders) {
    const key = order.map((wire) => wire.id).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const routed = [];
    let failed = false;
    for (const wire of order) {
      const next = routeOneWire(diagram, wire, [...routedWires, ...routed], hub);
      if (!next) {
        failed = true;
        break;
      }
      routed.push(next);
    }
    if (!failed) return routed;
  }
  return null;
};

const pointOnSegment = (point, segment) => {
  if (segment.from.x === segment.to.x) {
    return point.x === segment.from.x
      && point.y >= Math.min(segment.from.y, segment.to.y)
      && point.y <= Math.max(segment.from.y, segment.to.y);
  }
  return point.y === segment.from.y
    && point.x >= Math.min(segment.from.x, segment.to.x)
    && point.x <= Math.max(segment.from.x, segment.to.x);
};

const junctionsForWires = (wires) => {
  const junctions = [];
  const byNode = new Map();
  for (const wire of wires.filter((item) => item.node && item.node !== '0')) {
    byNode.set(wire.node, [...(byNode.get(wire.node) || []), wire]);
  }
  for (const [node, nodeWires] of byNode.entries()) {
    if (nodeWires.length < 3) continue;
    const candidates = new Map(nodeWires.flatMap((wire) => (wire.points || []).map((point) => [pointKey(point), point])));
    for (const point of candidates.values()) {
      const directions = new Set();
      for (const wire of nodeWires) {
        for (const segment of pathSegments(wire.points || [])) {
          if (!pointOnSegment(point, segment)) continue;
          if (segment.from.x < point.x || segment.to.x < point.x) directions.add('left');
          if (segment.from.x > point.x || segment.to.x > point.x) directions.add('right');
          if (segment.from.y < point.y || segment.to.y < point.y) directions.add('up');
          if (segment.from.y > point.y || segment.to.y > point.y) directions.add('down');
        }
      }
      if (directions.size >= 3) junctions.push({ id: `junction:${node}:${point.x}:${point.y}`, node, ...point });
    }
  }
  return junctions;
};

const bridgesForWires = (wires) => {
  const bridges = [];
  for (const [index, wire] of wires.entries()) {
    for (const other of wires.slice(0, index)) {
      if (wire.node && wire.node === other.node) continue;
      for (const segment of pathSegments(wire.points || [])) {
        for (const otherSegment of pathSegments(other.points || [])) {
          const point = bridgeableCrossing(segment, otherSegment);
          if (!point) continue;
          bridges.push(bridgeForCrossing(wire, segment, point));
        }
      }
    }
  }
  return bridges;
};

// After routing succeeds the canvas is usually far larger than the drawn
// circuit (placement/expansion budget leaves the content floating in a void).
// Trim width/height down to a tight box around the actual geometry plus a
// margin so the schematic fills its frame the way a hand-drawn sheet does.
// Resize-only: no coordinate is moved, so a validated layout stays valid.
const MIN_CANVAS_WIDTH = 700;
const MIN_CANVAS_HEIGHT = 500;
const GROUND_GLYPH_DROP = 34;
const cropDiagramToContent = (diagram) => {
  let maxX = 0;
  let maxY = 0;
  const extend = (x, y) => {
    if (Number.isFinite(x) && x > maxX) maxX = x;
    if (Number.isFinite(y) && y > maxY) maxY = y;
  };
  for (const component of diagram.components || []) {
    const bounds = componentBounds(component);
    extend(bounds.right, bounds.bottom);
  }
  for (const label of diagram.labels || []) {
    const bounds = labelBounds(label);
    extend(bounds.right, bounds.bottom);
  }
  for (const label of diagram.netLabels || []) {
    const bounds = netLabelBounds(label);
    extend(bounds.right, bounds.bottom);
  }
  for (const port of diagram.ports || []) extend(port.x + (port.labelWidth || 60), port.y + 30);
  for (const junction of diagram.junctions || []) extend(junction.x, junction.y);
  for (const wire of diagram.wires || []) {
    for (const point of wire.points || []) extend(point.x, point.y + GROUND_GLYPH_DROP);
  }
  // In slot mode the canvas must never shrink below the slot grid, so empty
  // trailing slots stay visible.
  const slotFloor = diagram.slotLayout
    ? slotCanvasSize(diagram.slotLayout.rows, diagram.slotLayout.cols)
    : { width: MIN_CANVAS_WIDTH, height: MIN_CANVAS_HEIGHT };
  const width = Math.max(slotFloor.width, snap(maxX + CANVAS_MARGIN));
  const height = Math.max(slotFloor.height, snap(maxY + CANVAS_MARGIN));
  return {
    ...diagram,
    width: Math.max(slotFloor.width, Math.min(diagram.width, width)),
    height: Math.max(slotFloor.height, Math.min(diagram.height, height)),
  };
};

const routeWithExpansion = (diagram, { maxExpansions = MAX_EXPANSIONS } = {}) => {
  let current = structuredClone(diagram);
  let lastViolations = [];
  current.layoutVersion = LAYOUT_VERSION;
  current.junctions = [];
  current.bridges = [];
  current.wires = (current.wires || []).map((wire) => ({
    ...wire,
    id: wire.id || `${wire.ref || wire.from?.ref}-${wire.pin || wire.from?.pin}-${wire.node || wire.to?.ref}`,
    labelId: undefined,
    stub: false,
    points: [],
  }));

  for (let attempt = 0; attempt <= maxExpansions; attempt += 1) {
    current.netLabels = [];
    for (const order of routeOrders(current)) {
      const routed = [];
      let failed = null;
      for (const group of order) {
        const isAutoNetGroup = !group[0].manual;
        const single = isAutoNetGroup ? null : routeOneWire(current, group[0], routed);
        const next = isAutoNetGroup ? routeNetGroup(current, group, routed) : single && [single];
        if (!next) {
          failed = group[0];
          break;
        }
        routed.push(...next);
      }
      if (!failed) {
        const byId = new Map(routed.map((wire) => [wire.id, wire]));
        const bridges = bridgesForWires(routed);
        const candidate = {
          ...current,
          wires: current.wires.map((wire) => byId.get(wire.id)),
          junctions: junctionsForWires(routed),
          bridges,
        };
        const validation = validateDiagramLayout(candidate);
        if (validation.ok) return cropDiagramToContent(candidate);
        lastViolations = validation.violations;
      } else {
        lastViolations = [{ type: 'route_failed', wire: failed.id }];
      }
    }
    current.width += 160;
    current.height += 120;
  }

  throw new DiagramLayoutError(
    `Unable to create a collision-free schematic after ${maxExpansions + 1} routing attempts.`,
    lastViolations.length ? lastViolations : [{ type: 'route_failed' }],
  );
};

// Tidy single-column placement is the preferred, most human-looking layout, but
// it can't route every topology (feedback loops, op-amp inputs fed from the
// right). We give the tidy pass only a small expansion budget so it bails
// quickly, then retry with the looser spread grid — which interleaves ranks
// enough to route the dense cases the engine always used to handle — at the
// full budget before ever falling back to labeled-net stubs.
const TIDY_EXPANSION_BUDGET = 0;
export const layoutCircuitDiagram = (circuit, options = {}) => {
  if (options.spread) return routeWithExpansion(buildDraft(circuit, options));
  try {
    return routeWithExpansion(buildDraft(circuit, options), { maxExpansions: TIDY_EXPANSION_BUDGET });
  } catch (error) {
    if (!(error instanceof DiagramLayoutError)) throw error;
    return routeWithExpansion(buildDraft(circuit, { ...options, spread: true }));
  }
};

export const routeDiagramWire = (diagram, wire) => {
  if (wire.points?.length) return wire.points;
  if (!diagram.layoutVersion) {
    const { start, end } = wireEndpoints(diagram, wire);
    const direct = compactOrthogonalPath([start, { x: end.x, y: start.y }, end]);
    const obstacles = diagram.components
      .filter((component) => component.ref !== wire.ref)
      .map((component) => componentBounds(component, WIRE_CLEARANCE));
    if (pathSegments(direct).every((segment) =>
      obstacles.every((rect) => !segmentIntersectsRect(segment.from, segment.to, rect)))) return direct;
  }
  return routeOneWire(diagram, wire, (diagram.wires || []).filter((item) => item !== wire && item.points?.length))?.points || [];
};

const refreshDiagramGeometry = (diagram) => {
  const copy = structuredClone(diagram);
  copy.labels = makeComponentLabels(copy.components);
  copy.nets = (copy.nets || []).map((net) => ({
    ...net,
    connections: copy.components.flatMap((component) => component.pins
      .filter((pin) => pin.node === net.name)
      .map((pin) => ({ ref: component.ref, pin: pin.pinIndex, x: pin.x, y: pin.y }))),
  }));
  return copy;
};

export const rerouteAffectedNets = (diagram) => {
  const refreshed = refreshDiagramGeometry(diagram);
  return routeWithExpansion(refreshed);
};

export const findNearestLegalPlacement = (diagram, componentRef, target) => {
  const component = diagram.components.find((item) => item.ref === componentRef);
  if (!component) return null;
  const others = diagram.components.filter((item) => item.ref !== componentRef);
  let width = diagram.width;
  let height = diagram.height;
  for (let attempt = 0; attempt <= MAX_EXPANSIONS; attempt += 1) {
    const position = nearestFreePosition(component, others, target, { width, height, clearance: COMPONENT_CLEARANCE });
    if (position) return { ...position, width, height };
    width += 160;
    height += 120;
  }
  return null;
};

export const validateDiagramLayout = (diagram) => {
  const violations = [];
  for (let index = 0; index < diagram.components.length; index += 1) {
    const component = diagram.components[index];
    const bounds = componentBounds(component);
    if (bounds.left < 0 || bounds.top < 0 || bounds.right > diagram.width || bounds.bottom > diagram.height) {
      violations.push({ type: 'out_of_bounds', ref: component.ref });
    }
    for (const other of diagram.components.slice(index + 1)) {
      if (rectsOverlap(bounds, componentBounds(other))) {
        violations.push({ type: 'body_collision', refs: [component.ref, other.ref] });
      } else if (diagramComponentsOverlap(component, other)) {
        violations.push({ type: 'insufficient_clearance', refs: [component.ref, other.ref] });
      }
    }
  }
  const labels = diagram.labels || [];
  labels.forEach((label, index) => {
    const bounds = labelBounds(label);
    if (bounds.left < 0 || bounds.top < 0 || bounds.right > diagram.width || bounds.bottom > diagram.height) {
      violations.push({ type: 'out_of_bounds', object: 'label', ref: label.ref });
    }
    if (diagram.components.some((component) => label.ref !== component.ref && rectsOverlap(bounds, componentBounds(component), 4))) {
      violations.push({ type: 'label_component_overlap', label: label.ref });
    }
    if (labels.slice(index + 1).some((other) => rectsOverlap(bounds, labelBounds(other), 4))) {
      violations.push({ type: 'label_overlap', label: label.ref });
    }
  });
  const netLabels = diagram.netLabels || [];
  netLabels.forEach((label, index) => {
    const bounds = netLabelBounds(label);
    if (bounds.left < 0 || bounds.top < 0 || bounds.right > diagram.width || bounds.bottom > diagram.height) {
      violations.push({ type: 'out_of_bounds', object: 'net_label', ref: label.id });
    }
    if (diagram.components.some((component) => rectsOverlap(bounds, componentBounds(component)))) {
      violations.push({ type: 'net_label_component_overlap', label: label.id });
    }
    if (labels.some((componentLabel) => rectsOverlap(bounds, labelBounds(componentLabel)))) {
      violations.push({ type: 'net_label_text_overlap', label: label.id });
    }
    if (netLabels.slice(index + 1).some((other) => rectsOverlap(bounds, netLabelBounds(other), WIRE_CLEARANCE))) {
      violations.push({ type: 'net_label_overlap', label: label.id });
    }
  });
  diagram.wires.forEach((wire, index) => {
    if ((wire.points || []).some((point) => point.x < 0 || point.y < 0 || point.x > diagram.width || point.y > diagram.height)) {
      violations.push({ type: 'out_of_bounds', object: 'wire', ref: wire.id });
    }
    for (const segment of pathSegments(wire.points || [])) {
      const endpointRefs = new Set([wire.ref, wire.from?.ref, wire.to?.ref].filter(Boolean));
      if (wire.node) {
        for (const ref of connectedRefsForNode(diagram, wire.node)) endpointRefs.add(ref);
      }
      if (diagram.components.some((component) =>
        segmentIntersectsRect(segment.from, segment.to, componentBounds(component)))) {
        violations.push({ type: 'wire_component_overlap', wire: wire.id });
      } else if (diagram.components.some((component) => !endpointRefs.has(component.ref)
        && segmentIntersectsRect(segment.from, segment.to, componentBounds(component, WIRE_CLEARANCE)))) {
        violations.push({ type: 'wire_component_clearance', wire: wire.id });
      }
      for (const label of netLabels) {
        if (label.id !== wire.labelId && segmentIntersectsRect(segment.from, segment.to, netLabelBounds(label))) {
          violations.push({ type: 'wire_label_overlap', wire: wire.id, label: label.id });
        }
      }
      for (const other of diagram.wires.slice(0, index)) {
        for (const otherSegment of pathSegments(other.points || [])) {
          const sameNet = Boolean(wire.node) && wire.node === other.node;
          const crossing = !sameNet ? bridgeableCrossing(segment, otherSegment) : null;
          const bridged = crossing && (diagram.bridges || []).some((bridge) =>
            bridgeMatches(bridge, wire, crossing) || bridgeMatches(bridge, other, crossing));
          if (!sameNet && segmentsTouch(segment, otherSegment) && !bridged) {
            violations.push({ type: 'wire_wire_intersection', wires: [wire.id, other.id] });
          } else if (!sameNet
            && !wiresShareEndpointRef(wire, other)
            && segmentDistance(segment, otherSegment) < WIRE_CLEARANCE - 1
            && !bridged) {
            violations.push({ type: 'wire_wire_clearance', wires: [wire.id, other.id] });
          }
        }
      }
    }
  });
  return { ok: violations.length === 0, violations };
};

export const repairDiagramLayout = (diagram, options = {}) => {
  if (!diagram) return diagram;
  const copy = structuredClone(diagram);
  const anchors = new Map(copy.components.map((component) => [component.ref, component]));
  if (options.circuit) return layoutCircuitDiagram(options.circuit, { anchors });
  copy.layoutVersion = LAYOUT_VERSION;
  copy.grid = copy.grid || { size: GRID_SIZE, componentClearance: COMPONENT_CLEARANCE, wireClearance: WIRE_CLEARANCE };
  copy.components = resolveComponentOverlaps(copy.components, COMPONENT_CLEARANCE, copy);
  copy.labels = makeComponentLabels(copy.components);
  copy.nets = (copy.nets || []).map((net) => ({
    name: net.name,
    ...(Number.isFinite(net.x) && Number.isFinite(net.y) ? { x: net.x, y: net.y } : {}),
    connections: copy.components.flatMap((component) => component.pins
      .filter((pin) => pin.node === net.name)
      .map((pin) => ({ ref: component.ref, pin: pin.pinIndex, x: pin.x, y: pin.y }))),
  }));
  copy.wires = (copy.wires || []).map((wire) => {
    const endpoints = wireEndpoints(copy, wire);
    const preferredWaypoints = wire.preferredWaypoints || (wire.offset ? [{
      x: (endpoints.start.x + endpoints.end.x) / 2 + wire.offset.x,
      y: (endpoints.start.y + endpoints.end.y) / 2 + wire.offset.y,
    }] : []);
    return {
      ...wire,
      id: wire.id || `${wire.ref || wire.from?.ref}-${wire.pin || wire.from?.pin}-${wire.node || wire.to?.ref}`,
      labelId: wire.manual ? undefined : labelIdForWire(wire),
      routingMode: wire.manual ? 'manual' : wire.routingMode || 'auto',
      preferredWaypoints,
      points: [],
    };
  });
  copy.height = Math.max(copy.height || 500, ...copy.components.map((component) => component.y + component.height / 2 + 100));
  copy.junctions = [];
  copy.bridges = [];
  return routeWithExpansion(copy);
};

export {
  buildDraft as __debugBuildDraft,
  bridgesForWires as __debugBridgesForWires,
  fastOrthogonalRoute as __debugFastOrthogonalRoute,
  placeNetLabels as __debugPlaceNetLabels,
  routeObstacles as __debugRouteObstacles,
  routeNetGroup as __debugRouteNetGroup,
  routeOneWire as __debugRouteOneWire,
  routeOrders as __debugRouteOrders,
  routeSection as __debugRouteSection,
};
