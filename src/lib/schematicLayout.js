export const LAYOUT_VERSION = 4;
export const GRID_SIZE = 20;
export const COMPONENT_CLEARANCE = 24;
export const WIRE_CLEARANCE = 16;
const CANVAS_MARGIN = 60;
const MAX_ROUTE_STATES = 6000;
const MAX_EXPANSIONS = 8;
const PLACEMENT_CLEARANCE = COMPONENT_CLEARANCE + WIRE_CLEARANCE * 4;

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
};

const snap = (value, grid = GRID_SIZE) => Math.round(value / grid) * grid;
const pointKey = (point) => `${point.x},${point.y}`;
const isSourceKind = (kind) => kind === 'voltage_source' || kind === 'signal_source';
const isOutputNode = (node) => /(^|_)(v?out|out|load|filtered)(_|$)/i.test(String(node));
const isUnconnectedTerminal = (node, ref, pin) =>
  /^NC_/i.test(String(node)) || String(node) === `${ref}_${pin}`;
const labelIdForWire = (wire) => (wire.node === '0'
  ? `ground-label:${wire.ref}:${wire.pin}`
  : `net-label:${wire.ref}:${wire.pin}`);
const textWidth = (text, minimum = 54, maximum = 150) =>
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

const pinPoint = (component, pinIndex, node, netPosition) => {
  if (component.symbolType === 'bjt_npn' || component.symbolType === 'bjt_pnp') {
    if (pinIndex === 1) return { x: component.x + component.width / 2, y: component.y - component.height / 2 + 18 };
    if (pinIndex === 2) return { x: component.x - component.width / 2, y: component.y };
    if (pinIndex === 3) return { x: component.x + component.width / 2, y: component.y + component.height / 2 - 18 };
  }
  if (component.symbolType === 'opamp') {
    if (pinIndex === 1) return { x: component.x - component.width / 2, y: component.y + component.height * 0.22 };
    if (pinIndex === 2) return { x: component.x - component.width / 2, y: component.y - component.height * 0.22 };
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
  if (symbolType === 'opamp') return { width: 150, height: 110, symbolType };
  if (symbolType === 'bjt_npn' || symbolType === 'bjt_pnp') return { width: 118, height: 100, symbolType };
  if (symbolType === 'voltage_source' || symbolType === 'capacitor' || symbolType === 'diode' || symbolType === 'led') {
    return { width: 98, height: 112, symbolType };
  }
  return { width: 108, height: 58, symbolType };
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
      return occupied.every((box) => !rectsOverlap(labelBounds(label), box, 4)) ? label : null;
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
  for (const component of components) {
    const refLabel = placeLabel(component, component.ref, 'ref', [
      { x: component.x, y: component.y - component.height / 2 - 18 },
      { x: component.x - component.width / 2 - textWidth(component.ref) / 2 - 12, y: component.y },
      { x: component.x + component.width / 2 + textWidth(component.ref) / 2 + 12, y: component.y },
      { x: component.x, y: component.y + component.height / 2 + 20 },
    ]);
    labels.push(refLabel);
    occupied.push(labelBounds(refLabel, 4));

    const valueLabel = placeLabel(component, component.value, 'value', [
      { x: component.x, y: component.y + component.height / 2 + 20 },
      { x: component.x + component.width / 2 + textWidth(component.value) / 2 + 12, y: component.y },
      { x: component.x - component.width / 2 - textWidth(component.value) / 2 - 12, y: component.y },
      { x: component.x, y: component.y - component.height / 2 - 18 },
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

const segmentsConflict = (first, second, clearance = WIRE_CLEARANCE) =>
  segmentDistance(first, second) < clearance;

const routeObstacles = (diagram, wire) => {
  const endpointRefs = new Set([wire.ref, wire.from?.ref, wire.to?.ref, wire.targetRef].filter(Boolean));
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
    .filter((item) => wire.node === '0' || !wire.node || item.node !== wire.node)
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
        && occupiedSegments.every((occupied) => !segmentsConflict(segment, occupied)));
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
      if (occupiedSegments.some((occupied) => segmentsConflict(segment, occupied))) continue;
      const bendCost = current.direction && current.direction !== neighbor.direction ? 12 : 0;
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
  const component = diagram.components.find((item) => item.ref === wire.ref);
  const label = (diagram.netLabels || []).find((item) => item.id === wire.labelId);
  const legacyNet = diagram.nets.find((item) => item.name === wire.node);
  const pin = component?.pins.find((item) => item.pinIndex === wire.pin);
  return {
    start: pin ? { x: pin.x, y: pin.y } : wire.points?.[0] || { x: 0, y: 0 },
    end: label
      ? { x: label.x, y: label.y }
      : legacyNet ? { x: legacyNet.x, y: legacyNet.y } : wire.points?.at(-1) || { x: 0, y: 0 },
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
    .filter((item) => wire.node === '0' || !wire.node || item.node !== wire.node)
    .flatMap((item) => pathSegments(item.points || [])
    .map((segment) => ({ ...segment, wireId: item.id })));
  const candidate = candidates.find((points) => pathSegments(points).every((segment, index) => {
    if (index >= lead.length - 1 && hardBodies.some((rect) => segmentIntersectsRect(segment.from, segment.to, rect))) return false;
    if (obstacles.some((rect) => segmentIntersectsRect(segment.from, segment.to, rect))) return false;
    return occupied.every((other) => !segmentsConflict(segment, other));
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
  const width = Math.max(1100, CANVAS_MARGIN * 2 + rankColumns * 340) + (options.extraWidth || 0);
  const height = Math.max(720, 480 + rankBands * 300 + Math.ceil((circuit.components?.length || 0) / 8) * 110)
    + (options.extraHeight || 0);
  const netPositions = new Map(nonGroundNets.map((name, index) => [name, {
    x: snap(CANVAS_MARGIN + 100 + index * ((width - CANVAS_MARGIN * 2 - 200) / Math.max(1, nonGroundNets.length - 1))),
    y: 120,
  }]));
  const placed = [];
  const rankRows = new Map();
  for (const [index, part] of (circuit.components || []).entries()) {
    const rank = ranks.get(part.ref) || 0;
    const row = rankRows.get(rank) || 0;
    rankRows.set(rank, row + 1);
    const rankBand = Math.floor(rank / rankColumns);
    const rawColumn = rank % rankColumns;
    const visualColumn = rankBand % 2 === 0 ? rawColumn : rankColumns - rawColumn - 1;
    const size = componentSize(part.kind);
    const nodes = part.nodes.map(String);
    const nonGround = nodes.filter((node) => node !== '0');
    const hasGround = nodes.includes('0');
    const isTwoPin = nodes.length <= 2;
    let orientation = 'horizontal';
    let preferred = {
      x: CANVAS_MARGIN + 180 + visualColumn * 320 + (row % 3) * 220,
      y: 260 + rankBand * 300 + Math.floor(row / 3) * 190,
    };
    let componentWidth = size.width;
    let componentHeight = size.height;
    if (isTwoPin && hasGround && nonGround.length) {
      orientation = 'vertical';
      preferred = { x: preferred.x, y: preferred.y + 100 };
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
    const position = nearestFreePosition(component, placed, target, { width, height: height * 3, clearance: PLACEMENT_CLEARANCE })
      || { x: component.x, y: component.y + placed.length * 160 };
    placed.push(moveComponent(component, position.x, position.y));
  }
  const requiredHeight = Math.max(height, ...placed.map((component) => component.y + component.height / 2 + 150));
  const componentLabels = makeComponentLabels(placed);
  const nets = netNames.map((name) => {
    const connections = placed.flatMap((component) => component.pins
      .filter((pin) => pin.node === name)
      .map((pin) => ({ ref: component.ref, pin: pin.pinIndex, x: pin.x, y: pin.y })));
    return { name, connections };
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
    })));
  const draft = {
    title: circuit.title,
    layoutVersion: LAYOUT_VERSION,
    grid: { size: GRID_SIZE, componentClearance: COMPONENT_CLEARANCE, wireClearance: WIRE_CLEARANCE },
    width,
    height: requiredHeight,
    components: placed,
    nets,
    labels: componentLabels,
    netLabels: [],
    wires,
    junctions: [],
    bridges: [],
  };
  return draft;
};

const routeOrders = (diagram) => {
  const distance = (wire) => {
    const { start, end } = wireEndpoints(diagram, wire);
    return Math.abs(start.x - end.x) + Math.abs(start.y - end.y);
  };
  const groups = new Map();
  for (const wire of diagram.wires) {
    const key = `wire:${wire.id}`;
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
  return candidates.map((groups) => [...groups, ...tail]);
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

const routeNetGroup = (diagram, wires, routedWires) => {
  if (wires.length < 2) {
    const routed = routeOneWire(diagram, wires[0], routedWires);
    return routed ? [routed] : null;
  }
  const starts = new Map(wires.map((wire) => [wire.id, wireEndpoints(diagram, wire).start]));
  const pairs = wires.flatMap((first, firstIndex) => wires.slice(firstIndex + 1).map((second) => ({
    first,
    second,
    distance: Math.abs(starts.get(first.id).x - starts.get(second.id).x)
      + Math.abs(starts.get(first.id).y - starts.get(second.id).y),
  }))).sort((first, second) => first.distance - second.distance
    || first.first.id.localeCompare(second.first.id)
    || first.second.id.localeCompare(second.second.id));

  for (const pair of pairs) {
    const target = starts.get(pair.second.id);
    const trunk = routeOneWire(diagram, { ...pair.first, targetRef: pair.second.ref }, routedWires, target);
    if (!trunk) continue;
    const split = splitPathAtHalf(trunk.points);
    const first = { ...trunk, targetRef: undefined, points: split.first };
    const second = { ...pair.second, points: split.second };
    const remaining = wires.filter((wire) => wire !== pair.first && wire !== pair.second)
      .sort((left, right) => {
        const leftPoint = starts.get(left.id);
        const rightPoint = starts.get(right.id);
        const leftDistance = Math.abs(leftPoint.x - split.hub.x) + Math.abs(leftPoint.y - split.hub.y);
        const rightDistance = Math.abs(rightPoint.x - split.hub.x) + Math.abs(rightPoint.y - split.hub.y);
        return leftDistance - rightDistance || left.id.localeCompare(right.id);
      });
    for (const order of limitedPermutations(remaining)) {
      const routed = [first, second];
      let failed = false;
      for (const wire of order) {
        const next = routeOneWire(diagram, wire, [...routedWires, ...routed]);
        if (!next) {
          failed = true;
          break;
        }
        routed.push(next);
      }
      if (!failed) return routed;
    }
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

const routeWithExpansion = (diagram) => {
  let current = structuredClone(diagram);
  let lastViolations = [];
  let failedNode = null;
  current.layoutVersion = LAYOUT_VERSION;
  current.junctions = [];
  current.bridges = [];
  current.wires = (current.wires || []).map((wire) => ({
    ...wire,
    id: wire.id || `${wire.ref || wire.from?.ref}-${wire.pin || wire.from?.pin}-${wire.node || wire.to?.ref}`,
    labelId: wire.manual ? undefined : labelIdForWire(wire),
    stub: false,
    points: [],
  }));

  for (let attempt = 0; attempt <= MAX_EXPANSIONS; attempt += 1) {
    if (failedNode) {
      const offsets = [
        { x: 80, y: 0 },
        { x: -80, y: 0 },
        { x: 0, y: -80 },
        { x: 0, y: 80 },
        { x: 160, y: 0 },
        { x: -160, y: 0 },
        { x: 0, y: -160 },
        { x: 0, y: 160 },
      ];
      const offset = offsets[Math.min(attempt - 1, offsets.length - 1)];
      current.netLabels = (current.netLabels || []).map((label) => label.name === failedNode
        ? {
            ...label,
            x: label.x + offset.x,
            y: label.y + offset.y,
            labelX: label.labelX + offset.x,
            labelY: label.labelY + offset.y,
          }
        : label);
    }
    const preferredLabels = new Map((current.netLabels || []).map((label) => [label.id, label]));
    try {
      current.netLabels = placeNetLabels(current, preferredLabels);
    } catch (error) {
      const labelFailure = error instanceof DiagramLayoutError
        && error.violations.some((violation) => violation.type === 'net_label_placement_failed');
      if (!labelFailure || attempt === MAX_EXPANSIONS) throw error;
      current.width += 160;
      current.height += 120;
      continue;
    }
    for (const order of routeOrders(current)) {
      const routed = [];
      let failed = null;
      for (const group of order) {
        const isSignalNet = group.length > 1 && !group[0].manual && group[0].node !== '0';
        const single = isSignalNet ? null : routeOneWire(current, group[0], routed);
        const next = isSignalNet ? routeNetGroup(current, group, routed) : single && [single];
        if (!next) {
          failed = group[0];
          break;
        }
        routed.push(...next);
      }
      if (!failed) {
        const byId = new Map(routed.map((wire) => [wire.id, wire]));
        const candidate = {
          ...current,
          wires: current.wires.map((wire) => byId.get(wire.id)),
          junctions: junctionsForWires(routed),
          bridges: [],
        };
        const validation = validateDiagramLayout(candidate);
        if (validation.ok) return candidate;
        lastViolations = validation.violations;
      } else {
        lastViolations = [{ type: 'route_failed', wire: failed.id }];
        failedNode = failed.node && failed.node !== '0' ? failed.node : null;
      }
    }
    current.width += 160;
    current.height += 120;
  }

  throw new DiagramLayoutError(
    `Unable to create a collision-free schematic after ${MAX_EXPANSIONS + 1} routing attempts.`,
    lastViolations.length ? lastViolations : [{ type: 'route_failed' }],
  );
};

export const layoutCircuitDiagram = (circuit, options = {}) => routeWithExpansion(buildDraft(circuit, options));

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
          const sameNet = Boolean(wire.node) && wire.node !== '0' && wire.node === other.node;
          if (!sameNet && segmentsTouch(segment, otherSegment)) {
            violations.push({ type: 'wire_wire_intersection', wires: [wire.id, other.id] });
          } else if (!sameNet && segmentsConflict(segment, otherSegment)) {
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
  fastOrthogonalRoute as __debugFastOrthogonalRoute,
  placeNetLabels as __debugPlaceNetLabels,
  routeObstacles as __debugRouteObstacles,
  routeOneWire as __debugRouteOneWire,
  routeOrders as __debugRouteOrders,
  routeSection as __debugRouteSection,
};
