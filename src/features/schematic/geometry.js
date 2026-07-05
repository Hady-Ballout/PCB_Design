// Pure schematic-diagram geometry helpers shared by the canvas editor.
import { GRID_SIZE, routeDiagramWire } from '../../core/schematicLayout.js';

const snapToGrid = (value) => Math.round(value / GRID_SIZE) * GRID_SIZE;

export const ADD_COMPONENT_TOOLS = [
  { type: 'resistor', label: 'Add resistor' },
  { type: 'capacitor', label: 'Add capacitor' },
  { type: 'source', label: 'Add voltage source' },
  { type: 'led', label: 'Add LED' },
  { type: 'bjt', label: 'Add BJT' },
  { type: 'opamp', label: 'Add op amp' },
  { type: 'ground', label: 'Add ground' },
];

export const diagramPath = (points) => points.map((point) => `${point.x},${point.y}`).join(' ');

export const cloneDiagram = (diagram) => (diagram ? structuredClone(diagram) : null);
export const wireId = (wire) => wire.id || `${wire.ref}-${wire.pin}-${wire.node}`;
export const isUnconnectedTerminal = (node, ref, pin) =>
  /^NC_/i.test(String(node)) || String(node) === `${ref}_${pin}`;

export const symbolDefaults = {
  resistor: { kind: 'resistor', symbolType: 'resistor', width: 130, height: 58, orientation: 'horizontal', value: '1k', prefix: 'R', nodes: 2 },
  capacitor: { kind: 'capacitor', symbolType: 'capacitor', width: 98, height: 112, orientation: 'vertical', value: '100nF', prefix: 'C', nodes: 2 },
  led: { kind: 'led', symbolType: 'led', width: 98, height: 112, orientation: 'vertical', value: 'red', prefix: 'DLED', nodes: 2 },
  source: { kind: 'voltage_source', symbolType: 'voltage_source', width: 98, height: 112, orientation: 'vertical', value: '5V', prefix: 'V', nodes: 2 },
  bjt: { kind: 'bjt_npn', symbolType: 'bjt_npn', width: 118, height: 100, orientation: 'horizontal', value: '2N2222', prefix: 'Q', nodes: 3 },
  opamp: { kind: 'opamp', symbolType: 'opamp', width: 150, height: 110, orientation: 'horizontal', value: 'LM358', prefix: 'XU', nodes: 5 },
  ground: { kind: 'ground', symbolType: 'ground', width: 72, height: 62, orientation: 'vertical', value: '0', prefix: 'GND', nodes: 1 },
};

export const svgPointer = (event, diagram) => {
  const svg = event.currentTarget.ownerSVGElement || event.currentTarget;
  // Use the SVG's real screen transform so viewBox scaling and the
  // preserveAspectRatio letterbox are both accounted for; a plain box-ratio
  // mapping drifts whenever the element aspect differs from the viewBox aspect.
  const ctm = svg.getScreenCTM?.();
  if (ctm && typeof DOMPoint !== 'undefined') {
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
    return { x: point.x, y: point.y };
  }
  const rect = svg.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * diagram.width,
    y: ((event.clientY - rect.top) / rect.height) * diagram.height,
  };
};

export const movedComponent = (component, dx, dy) => ({
  ...component,
  x: component.x + dx,
  y: component.y + dy,
  pins: component.pins.map((pin) => ({ ...pin, x: pin.x + dx, y: pin.y + dy })),
});

export const movedNet = (net, dx, dy) => ({
  ...net,
  x: net.x + dx,
  y: net.y + dy,
  labelX: net.labelX + dx,
  labelY: net.labelY + dy,
  ...(net.connections ? {
    connections: net.connections.map((connection) => ({ ...connection, x: connection.x + dx, y: connection.y + dy })),
  } : {}),
});

export const moveWireEndpoint = (wire, endpoint, dx, dy) => {
  if (!wire.points?.length) return wire;
  return {
    ...wire,
    points: wire.points.map((point, index) => {
      const isEndpoint = endpoint === 'start' ? index === 0 : index === wire.points.length - 1;
      return isEndpoint ? { x: point.x + dx, y: point.y + dy } : point;
    }),
  };
};

export const moveWirePath = (wire, diagram, dx, dy) => {
  const points = wire.points?.length ? wire.points : wirePoints(diagram, wire);
  if (points.length < 2) return wire;
  const midpoint = points.length === 2
    ? [{ x: (points[0].x + points[1].x) / 2 + dx, y: (points[0].y + points[1].y) / 2 + dy }]
    : points.slice(1, -1).map((point) => ({ x: point.x + dx, y: point.y + dy }));
  return {
    ...wire,
    routingMode: 'manual',
    preferredWaypoints: midpoint,
    points: [points[0], ...midpoint, points.at(-1)],
  };
};

export const componentPinPoint = (component, pinIndex) => {
  // Grid-aligned pin offsets, kept in sync with pinPoint in core/schematicLayout.js.
  if (component.symbolType === 'bjt_npn' || component.symbolType === 'bjt_pnp') {
    const reach = snapToGrid(component.height / 2 - 18);
    if (pinIndex === 1) return { x: component.x + component.width / 2, y: component.y - reach };
    if (pinIndex === 2) return { x: component.x - component.width / 2, y: component.y };
    if (pinIndex === 3) return { x: component.x + component.width / 2, y: component.y + reach };
  }

  if (component.symbolType === 'opamp') {
    const left = component.x - component.width / 2;
    const right = component.x + component.width / 2;
    const top = component.y - component.height / 2;
    const bottom = component.y + component.height / 2;
    const inputSpread = snapToGrid(component.height * 0.22);
    if (pinIndex === 1) return { x: left, y: component.y + inputSpread };
    if (pinIndex === 2) return { x: left, y: component.y - inputSpread };
    if (pinIndex === 3) return { x: right, y: component.y };
    if (pinIndex === 4) return { x: component.x, y: top };
    if (pinIndex === 5) return { x: component.x, y: bottom };
  }

  if (component.symbolType === 'ground') {
    return { x: component.x, y: component.y - component.height / 2 };
  }

  if (component.pinCount <= 2) {
    if (component.orientation === 'vertical') {
      return {
        x: component.x,
        y: pinIndex === 1 ? component.y - component.height / 2 : component.y + component.height / 2,
      };
    }
    return {
      x: pinIndex === 1 ? component.x - component.width / 2 : component.x + component.width / 2,
      y: component.y,
    };
  }

  const side = pinIndex % 2 === 1 ? -1 : 1;
  const row = Math.floor((pinIndex - 1) / 2);
  const rows = Math.ceil(component.pinCount / 2);
  return {
    x: component.x + side * (component.width / 2),
    y: component.y - ((rows - 1) * 14) / 2 + row * 28,
  };
};

export const makePins = (component, nodes) =>
  nodes.map((node, index) => ({
    node,
    pinIndex: index + 1,
    ...componentPinPoint(component, index + 1),
  }));

export const addedComponent = (diagram, type) => {
  const defaults = symbolDefaults[type];
  const existingRefs = new Set(diagram.components.map((component) => component.ref));
  let nextRefNumber = 1;
  while (existingRefs.has(`${defaults.prefix}${nextRefNumber}`)) nextRefNumber += 1;
  const column = diagram.components.length % 3;
  const row = Math.floor(diagram.components.length / 3);
  const nodes = defaults.kind === 'ground'
    ? ['0']
    : Array.from(
      { length: defaults.nodes },
      (_, index) => `NC_${defaults.prefix}${nextRefNumber}_${index + 1}`,
    );
  const component = {
    ref: `${defaults.prefix}${nextRefNumber}`,
    kind: defaults.kind,
    value: defaults.value,
    nodes,
    symbolType: defaults.symbolType,
    orientation: defaults.orientation,
    x: 150 + column * 210,
    y: 180 + row * 125,
    width: defaults.width,
    height: defaults.height,
    pinCount: defaults.nodes,
    order: diagram.components.length,
  };
  return { ...component, pins: makePins(component, nodes) };
};

export const terminalPoint = (diagram, terminal) => {
  const component = diagram.components.find((item) => item.ref === terminal.ref);
  const pin = component?.pins.find((item) => item.pinIndex === terminal.pin);
  return pin || { x: 0, y: 0 };
};

export const wirePoints = (diagram, wire) => {
  if (wire.points?.length) return wire.points;
  return routeDiagramWire(diagram, wire);
};
