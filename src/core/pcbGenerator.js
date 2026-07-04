import {
  COMPONENT_CLEARANCE,
  DiagramLayoutError,
  buildFallbackCircuitDiagram,
  diagramComponentsOverlap,
  findNearestLegalPlacement,
  layoutCircuitDiagram,
  repairDiagramLayout,
  rerouteAffectedNets,
  resolveComponentOverlaps,
  routeDiagramWire,
  validateDiagramLayout,
} from './schematicLayout.js';

export {
  COMPONENT_CLEARANCE,
  DiagramLayoutError,
  buildFallbackCircuitDiagram,
  diagramComponentsOverlap,
  findNearestLegalPlacement,
  layoutCircuitDiagram,
  repairDiagramLayout,
  rerouteAffectedNets,
  resolveComponentOverlaps,
  routeDiagramWire,
  validateDiagramLayout,
};

export const validateCircuit = (circuit) => {
  const errors = [];
  const warnings = [];
  const nodeUse = new Map();
  const externalTerminalNets = new Set(
    (circuit.schematic?.externalTerminals || [])
      .map((terminal) => String(terminal?.net || ''))
      .filter(Boolean),
  );
  const explicitTestPointNets = new Set(
    (circuit.schematic?.externalTerminals || [])
      .filter((terminal) => /test|tp/i.test(String(terminal?.type || '')))
      .map((terminal) => String(terminal.net || '')),
  );

  for (const part of circuit.components) {
    if (!part.value) errors.push(`${part.ref} is missing a value.`);
    if (!part.nodes.includes('0') && part.kind === 'voltage_source') {
      warnings.push(`${part.ref} does not reference ground.`);
    }
    if (part.kind === 'opamp' && part.nodes.length < 5) {
      warnings.push(`${part.ref} op amp should include + input, - input, output, V+, and V- nodes.`);
    }
    part.nodes.forEach((node) => nodeUse.set(node, (nodeUse.get(node) ?? 0) + 1));
  }

  if (!nodeUse.has('0')) errors.push('No ground node was generated.');
  for (const [node, count] of nodeUse.entries()) {
    if (node !== '0' && count < 2 && !externalTerminalNets.has(node) && !explicitTestPointNets.has(node)) {
      warnings.push(`${node} only connects to one pin and may be floating.`);
    }
  }

  if (!circuit.supplyVoltage || circuit.supplyVoltage <= 0) errors.push('Supply voltage must be positive.');
  if (circuit.supplyVoltage > 60) warnings.push('Supply voltage is high for beginner/maker breadboard circuits.');

  return { ok: errors.length === 0, errors, warnings };
};

const sanitizeSpiceRef = (ref) => String(ref || 'X').replace(/[^a-z0-9_]/gi, '_').toUpperCase();

const spiceRef = (part) => {
  const base = sanitizeSpiceRef(part.ref);
  const prefixByKind = {
    voltage_source: 'V',
    signal_source: 'V',
    resistor: 'R',
    load: 'R',
    capacitor: 'C',
    inductor: 'L',
    diode: 'D',
    led: 'D',
    bjt_npn: 'Q',
    bjt_pnp: 'Q',
    mosfet_n: 'M',
    mosfet_p: 'M',
    opamp: 'X',
    regulator: 'V',
  };
  const prefix = prefixByKind[part.kind] || 'X';
  return base.startsWith(prefix) ? base : `${prefix}_${base}`;
};

const cleanVoltageValue = (value) => String(value || '0').replace(/v$/i, '');

const regulatorVoltage = (value) => {
  const text = String(value || '').toLowerCase();
  if (text.includes('7805')) return '5';
  if (text.includes('7812')) return '12';
  if (text.includes('7905')) return '-5';
  return cleanVoltageValue(text).match(/\d+(?:\.\d+)?/)?.[0] || '5';
};

const regulatorOutputNode = (nodes = []) => {
  const namedOutput = nodes.find((node) => /^v?out/i.test(node));
  return namedOutput || nodes.at(-1) || 'VOUT';
};

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

const isOutputNode = (node) => /(^|_)(v?out|out|load|filtered)(_|$)/i.test(node);
const isSourceKind = (kind) => kind === 'voltage_source' || kind === 'signal_source';
const isUnconnectedNode = (node) => /^NC_/i.test(String(node));
const isUnconnectedTerminal = (node, ref, pin) =>
  isUnconnectedNode(node) || String(node) === `${ref}_${pin}`;

export const LM358_SUBCIRCUIT = `.subckt LM358 INP INN OUT VCC VEE
EGAIN NRAW 0 INP INN 100k
RPOLE NRAW NINT 1k
CPOLE NINT 0 15.9n
EOUT OUT 0 NINT 0 1
.ends LM358`;

export const addMissingSpiceModels = (spice, circuit) => {
  const source = String(spice || '');
  const needsLm358 = circuit?.components?.some((part) => part.kind === 'opamp')
    && !/^\s*\.subckt\s+LM358\b/im.test(source);
  if (!needsLm358) return source;

  const endPattern = /^\s*\.end\s*$/im;
  return endPattern.test(source)
    ? source.replace(endPattern, `${LM358_SUBCIRCUIT}\n.end`)
    : `${source.trimEnd()}\n${LM358_SUBCIRCUIT}`;
};

const orderNonGroundNets = (circuit) => {
  const connectedNodes = circuit.components.flatMap((part) =>
    part.nodes
      .map((node, index) => ({ node: String(node), pin: index + 1 }))
      .filter(({ node, pin }) => !isUnconnectedTerminal(node, part.ref, pin))
      .map(({ node }) => node),
  );
  const all = [...new Set(connectedNodes)].filter((node) => node !== '0');
  const sourceNodes = circuit.components
    .filter((part) => isSourceKind(part.kind))
    .flatMap((part) =>
      part.nodes.filter((node, index) => !isUnconnectedTerminal(node, part.ref, index + 1)),
    )
    .filter((node) => node !== '0');
  return [
    ...new Set([
      ...sourceNodes,
      ...all.filter((node) => !sourceNodes.includes(node) && !isOutputNode(node)),
      ...all.filter((node) => !sourceNodes.includes(node) && isOutputNode(node)),
    ]),
  ];
};

const textWidth = (text) => Math.max(58, Math.min(120, String(text).length * 8 + 24));

const pinPoint = (component, pinIndex, node, netPosition) => {
  if (component.symbolType === 'bjt_npn' || component.symbolType === 'bjt_pnp') {
    const collectorY = component.y - component.height / 2 + 18;
    const emitterY = component.y + component.height / 2 - 18;
    if (pinIndex === 1) return { x: component.x + component.width / 2, y: collectorY };
    if (pinIndex === 2) return { x: component.x - component.width / 2, y: component.y };
    if (pinIndex === 3) return { x: component.x + component.width / 2, y: emitterY };
  }

  if (component.symbolType === 'opamp') {
    const left = component.x - component.width / 2;
    const right = component.x + component.width / 2;
    const top = component.y - component.height / 2;
    const bottom = component.y + component.height / 2;
    if (pinIndex === 1) return { x: left, y: component.y + component.height * 0.22 };
    if (pinIndex === 2) return { x: left, y: component.y - component.height * 0.22 };
    if (pinIndex === 3) return { x: right, y: component.y };
    if (pinIndex === 4) return { x: component.x, y: top };
    if (pinIndex === 5) return { x: component.x, y: bottom };
  }

  if (component.pinCount <= 2) {
    if (component.orientation === 'vertical') {
      const isGround = node === '0';
      return {
        x: component.x,
        y: isGround ? component.y + component.height / 2 : component.y - component.height / 2,
      };
    }

    const netX = netPosition?.x ?? component.x;
    return {
      x: netX < component.x ? component.x - component.width / 2 : component.x + component.width / 2,
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

const buildCircuitDiagramLegacy = (circuit) => {
  const signalY = 120;
  const groundY = 390;
  const netOrder = orderNonGroundNets(circuit);
  const width = Math.max(760, 220 + Math.max(1, netOrder.length - 1) * 260);
  const netPositions = new Map(
    netOrder.map((name, index) => [
      name,
      {
        x: 140 + index * Math.max(190, Math.min(260, (width - 280) / Math.max(1, netOrder.length - 1))),
        y: signalY,
      },
    ]),
  );
  const shuntCounts = new Map();
  const genericCounts = new Map();

  const components = circuit.components.map((part, index) => {
    const nodes = part.nodes.map(String);
    const nonGroundNodes = nodes.filter((node) => node !== '0');
    const hasGround = nodes.includes('0');
    const isTwoPin = nodes.length <= 2;
    let orientation = 'horizontal';
    let x = 160 + (index % 3) * 210;
    let y = signalY + 120 + Math.floor(index / 3) * 118;
    let widthForPart = 108;
    let heightForPart = 58;

    if (isTwoPin && isSourceKind(part.kind) && hasGround && nonGroundNodes.length) {
      orientation = 'vertical';
      x = netPositions.get(nonGroundNodes[0])?.x ?? 140;
      y = (signalY + groundY) / 2;
      heightForPart = 112;
    } else if (isTwoPin && hasGround && nonGroundNodes.length) {
      orientation = 'vertical';
      const node = nonGroundNodes[0];
      const offset = shuntCounts.get(node) ?? 0;
      shuntCounts.set(node, offset + 1);
      x = (netPositions.get(node)?.x ?? 420) + offset * 118;
      y = (signalY + groundY) / 2;
      heightForPart = 112;
    } else if (isTwoPin && nonGroundNodes.length === 2) {
      const first = netPositions.get(nodes[0]) ?? { x: 180, y: signalY };
      const second = netPositions.get(nodes[1]) ?? { x: 480, y: signalY };
      x = (first.x + second.x) / 2;
      y = signalY;
      widthForPart = Math.max(108, Math.abs(second.x - first.x) - 70);
    } else {
      const anchor = nonGroundNodes[0] || nodes[0] || `N${index + 1}`;
      const offset = genericCounts.get(anchor) ?? 0;
      genericCounts.set(anchor, offset + 1);
      x = (netPositions.get(anchor)?.x ?? 280) + offset * 128;
      y = signalY + 155 + offset * 92;
      widthForPart = 128;
      heightForPart = 72;
    }

    const symbolType = symbolTypeByKind[part.kind] || 'generic';
    if (symbolType === 'bjt_npn' || symbolType === 'bjt_pnp') {
      widthForPart = 118;
      heightForPart = 100;
    }
    if (symbolType === 'opamp') {
      widthForPart = 150;
      heightForPart = 110;
    }

    const component = {
      ref: part.ref,
      kind: part.kind,
      value: part.value,
      nodes,
      symbolType,
      orientation,
      x,
      y,
      width: widthForPart,
      height: heightForPart,
      pinCount: Math.max(nodes.length, 2),
      order: index,
    };

    return {
      ...component,
      pins: nodes.map((node, pinIndex) => ({
        node,
        pinIndex: pinIndex + 1,
        ...pinPoint(component, pinIndex + 1, node, netPositions.get(node)),
      })),
    };
  });

  const spacedComponents = legacyResolveComponentOverlaps(components);
  const netNames = [...new Set(circuit.components.flatMap((part) =>
    part.nodes.filter((node, index) => !isUnconnectedTerminal(node, part.ref, index + 1)),
  ))];
  const height = Math.max(500, ...spacedComponents.map((component) => component.y + component.height / 2 + 80));
  const nets = netNames.map((name, index) => {
    const connections = spacedComponents.flatMap((component) =>
      component.pins
        .filter((pin) => pin.node === name)
        .map((pin) => ({ ref: component.ref, pin: pin.pinIndex, x: pin.x, y: pin.y })),
    );
    const averageX = connections.reduce((sum, item) => sum + item.x, 0) / Math.max(connections.length, 1);
    const isGround = name === '0';
    const position = isGround ? { x: Math.max(95, Math.min(width - 95, averageX)), y: groundY } : netPositions.get(name) ?? { x: averageX, y: signalY };
    const labelWidth = textWidth(name);
    const labelX = Math.max(10, Math.min(width - labelWidth - 10, position.x - labelWidth / 2));
    const labelY = isGround ? position.y + 24 : position.y - 42 - (index % 2) * 24;

    return { name, x: position.x, y: position.y, labelX, labelY, labelWidth, connections };
  });

  const netByName = new Map(nets.map((net) => [net.name, net]));
  const wires = spacedComponents.flatMap((component) =>
    component.pins.filter((pin) => !isUnconnectedTerminal(pin.node, component.ref, pin.pinIndex)).map((pin) => {
      const net = netByName.get(pin.node);
      return {
        ref: component.ref,
        pin: pin.pinIndex,
        node: pin.node,
        points: [
          { x: pin.x, y: pin.y },
          { x: pin.x, y: net.y },
          { x: net.x, y: net.y },
        ],
      };
    }),
  );

  return { title: circuit.title, width, height, components: spacedComponents, nets, wires };
};

const escapeXml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const svgPolyline = (points) => points.map((point) => `${point.x},${point.y}`).join(' ');

const bridgeSvg = (bridge) => {
  const radius = bridge.radius || 7;
  const path = bridge.orientation === 'vertical'
    ? `M ${bridge.x} ${bridge.y - radius} C ${bridge.x + radius} ${bridge.y - radius} ${bridge.x + radius} ${bridge.y + radius} ${bridge.x} ${bridge.y + radius}`
    : `M ${bridge.x - radius} ${bridge.y} C ${bridge.x - radius} ${bridge.y - radius} ${bridge.x + radius} ${bridge.y - radius} ${bridge.x + radius} ${bridge.y}`;
  const clear = bridge.orientation === 'vertical'
    ? `<line class="diagram-bridge-clear" x1="${bridge.x}" y1="${bridge.y - radius - 2}" x2="${bridge.x}" y2="${bridge.y + radius + 2}" />`
    : `<line class="diagram-bridge-clear" x1="${bridge.x - radius - 2}" y1="${bridge.y}" x2="${bridge.x + radius + 2}" y2="${bridge.y}" />`;
  return `<g class="diagram-bridge">${clear}<path class="diagram-bridge-arc" d="${path}" /></g>`;
};

const ROUTE_CLEARANCE = 16;
const LEGACY_COMPONENT_CLEARANCE = 24;

const moveDiagramComponent = (component, dx, dy) => ({
  ...component,
  x: component.x + dx,
  y: component.y + dy,
  pins: component.pins.map((pin) => ({ ...pin, x: pin.x + dx, y: pin.y + dy })),
});

const legacyDiagramComponentsOverlap = (first, second, clearance = LEGACY_COMPONENT_CLEARANCE) => {
  const horizontalGap = Math.abs(first.x - second.x) - (first.width + second.width) / 2;
  const verticalGap = Math.abs(first.y - second.y) - (first.height + second.height) / 2;
  return horizontalGap < clearance && verticalGap < clearance;
};

const legacyResolveComponentOverlaps = (components, clearance = LEGACY_COMPONENT_CLEARANCE) => {
  const placed = [];
  for (const original of components) {
    let component = original;
    let attempts = 0;
    while (attempts < 50) {
      const collision = placed.find((other) => legacyDiagramComponentsOverlap(component, other, clearance));
      if (!collision) break;
      const targetY = collision.y + (collision.height + component.height) / 2 + clearance;
      component = moveDiagramComponent(component, 0, targetY - component.y);
      attempts += 1;
    }
    placed.push(component);
  }
  return placed;
};

const componentBounds = (component, clearance = ROUTE_CLEARANCE) => ({
  left: component.x - component.width / 2 - clearance,
  right: component.x + component.width / 2 + clearance,
  top: component.y - component.height / 2 - clearance,
  bottom: component.y + component.height / 2 + clearance,
});

const segmentCrossesBounds = (from, to, bounds) => {
  if (from.x === to.x) {
    const minY = Math.min(from.y, to.y);
    const maxY = Math.max(from.y, to.y);
    return from.x > bounds.left && from.x < bounds.right && maxY > bounds.top && minY < bounds.bottom;
  }
  if (from.y === to.y) {
    const minX = Math.min(from.x, to.x);
    const maxX = Math.max(from.x, to.x);
    return from.y > bounds.top && from.y < bounds.bottom && maxX > bounds.left && minX < bounds.right;
  }
  return false;
};

const routeCollisionCount = (points, obstacles) => points.slice(1).reduce(
  (count, point, index) => count + obstacles.filter((bounds) =>
    segmentCrossesBounds(points[index], point, bounds)).length,
  0,
);

const compactRoute = (points) => points.filter((point, index) => {
  if (index === 0) return true;
  const previous = points[index - 1];
  return point.x !== previous.x || point.y !== previous.y;
});

const legacyRouteDiagramWire = (diagram, wire) => {
  if (wire.manual) return null;
  const component = diagram.components.find((item) => item.ref === wire.ref);
  const pin = component?.pins.find((item) => item.pinIndex === wire.pin);
  const net = diagram.nets.find((item) => item.name === wire.node);
  if (!component || !pin || !net) return wire.points;

  const offset = wire.offset || { x: 0, y: 0 };
  const start = { x: pin.x, y: pin.y };
  const end = { x: net.x, y: net.y };
  const bendX = pin.x + offset.x;
  const bendY = net.y + offset.y;
  const obstacles = diagram.components
    .filter((item) => item.ref !== component.ref)
    .map((item) => componentBounds(item));
  const candidates = [
    compactRoute([start, { x: bendX, y: bendY }, { x: end.x, y: bendY }, end]),
    compactRoute([start, { x: end.x, y: start.y + offset.y }, end]),
  ];
  const clearCandidate = candidates.find((points) => routeCollisionCount(points, obstacles) === 0);
  if (clearCandidate) return clearCandidate;

  const blockingBounds = obstacles.filter((bounds) => candidates.some((points) =>
    routeCollisionCount(points, [bounds]) > 0));
  const topLane = Math.min(start.y, end.y, ...blockingBounds.map((bounds) => bounds.top)) - ROUTE_CLEARANCE;
  const bottomLane = Math.max(start.y, end.y, ...blockingBounds.map((bounds) => bounds.bottom)) + ROUTE_CLEARANCE;
  const detours = [topLane, bottomLane].map((laneY) => compactRoute([
    start,
    { x: start.x, y: laneY },
    { x: end.x, y: laneY },
    end,
  ]));

  return detours.sort((first, second) =>
    routeCollisionCount(first, obstacles) - routeCollisionCount(second, obstacles))[0];
};

const diagramTerminalPoint = (diagram, terminal) => {
  const component = diagram.components.find((item) => item.ref === terminal.ref);
  const pin = component?.pins.find((item) => item.pinIndex === terminal.pin);
  return pin || { x: 0, y: 0 };
};

const diagramWirePoints = (diagram, wire) => {
  if (wire.points?.length) return wire.points;
  return routeDiagramWire(diagram, wire);
};

export const buildCircuitDiagram = (circuit) => layoutCircuitDiagram(circuit);

const renderGroundSvg = (x, y) =>
  `<g class="diagram-ground" aria-label="Ground"><circle class="diagram-node" cx="${x}" cy="${y}" r="4" /><line class="diagram-symbol" x1="${x}" y1="${y}" x2="${x}" y2="${y + 16}" /><line class="diagram-symbol" x1="${x - 18}" y1="${y + 16}" x2="${x + 18}" y2="${y + 16}" /><line class="diagram-symbol" x1="${x - 12}" y1="${y + 22}" x2="${x + 12}" y2="${y + 22}" /><line class="diagram-symbol" x1="${x - 6}" y1="${y + 28}" x2="${x + 6}" y2="${y + 28}" /></g>`;

const renderPortSvg = (port) => {
  const width = port.labelWidth || 58;
  const height = 24;
  const left = port.side === 'right' ? port.x + 10 : port.x - width - 10;
  const y = port.y - height / 2;
  const lineEnd = port.side === 'right' ? port.x + 10 : port.x - 10;
  return `<g class="diagram-port" aria-label="${escapeXml(port.label)} port"><circle class="diagram-node" cx="${port.x}" cy="${port.y}" r="4" /><line class="diagram-symbol" x1="${port.x}" y1="${port.y}" x2="${lineEnd}" y2="${port.y}" /><rect class="diagram-net" x="${left}" y="${y}" width="${width}" height="${height}" rx="4" /><text class="diagram-small" x="${left + width / 2}" y="${y + 16}" text-anchor="middle">${escapeXml(port.label)}</text></g>`;
};

const renderSymbolSvg = (component) => {
  const { x, y, width, height, symbolType, orientation } = component;
  const left = x - width / 2;
  const right = x + width / 2;
  const top = y - height / 2;
  const bottom = y + height / 2;
  if (symbolType === 'ground') {
    return `<line class="diagram-symbol" x1="${x}" y1="${top}" x2="${x}" y2="${y - 7}" /><line class="diagram-symbol" x1="${x - 22}" y1="${y - 7}" x2="${x + 22}" y2="${y - 7}" /><line class="diagram-symbol" x1="${x - 14}" y1="${y + 3}" x2="${x + 14}" y2="${y + 3}" /><line class="diagram-symbol" x1="${x - 7}" y1="${y + 13}" x2="${x + 7}" y2="${y + 13}" />`;
  }
  if (orientation === 'vertical') {
    if (symbolType === 'resistor') {
      return `<polyline class="diagram-symbol" points="${x},${top} ${x},${top + 18} ${x - 18},${top + 28} ${x + 18},${top + 44} ${x - 18},${top + 60} ${x + 18},${top + 76} ${x},${bottom - 18} ${x},${bottom}" />`;
    }
    if (symbolType === 'capacitor') {
      return `<line class="diagram-symbol" x1="${x}" y1="${top}" x2="${x}" y2="${y - 14}" /><line class="diagram-symbol" x1="${x - 24}" y1="${y - 14}" x2="${x + 24}" y2="${y - 14}" /><line class="diagram-symbol" x1="${x - 24}" y1="${y + 14}" x2="${x + 24}" y2="${y + 14}" /><line class="diagram-symbol" x1="${x}" y1="${y + 14}" x2="${x}" y2="${bottom}" />`;
    }
    if (symbolType === 'diode' || symbolType === 'led') {
      const ledMarks = symbolType === 'led' ? `<line class="diagram-symbol thin" x1="${x + 18}" y1="${y - 22}" x2="${x + 34}" y2="${y - 38}" /><line class="diagram-symbol thin" x1="${x + 30}" y1="${y - 16}" x2="${x + 46}" y2="${y - 32}" />` : '';
      return `<line class="diagram-symbol" x1="${x}" y1="${top}" x2="${x}" y2="${y - 20}" /><polygon class="diagram-fill" points="${x - 18},${y - 20} ${x + 18},${y - 20} ${x},${y + 12}" /><line class="diagram-symbol" x1="${x - 20}" y1="${y + 14}" x2="${x + 20}" y2="${y + 14}" /><line class="diagram-symbol" x1="${x}" y1="${y + 14}" x2="${x}" y2="${bottom}" />${ledMarks}`;
    }
    if (symbolType === 'voltage_source') {
      return `<line class="diagram-symbol" x1="${x}" y1="${top}" x2="${x}" y2="${y - 24}" /><circle class="diagram-symbol" cx="${x}" cy="${y}" r="24" /><line class="diagram-symbol" x1="${x}" y1="${y + 24}" x2="${x}" y2="${bottom}" /><text class="diagram-small" x="${x}" y="${y - 8}" text-anchor="middle">+</text><text class="diagram-small" x="${x}" y="${y + 16}" text-anchor="middle">-</text>`;
    }
  }
  if (symbolType === 'resistor') {
    const bodyWidth = Math.min(96, Math.max(70, width - 36));
    const bodyLeft = x - bodyWidth / 2;
    const bodyRight = x + bodyWidth / 2;
    const leadInset = bodyWidth / 6;
    return `<line class="diagram-symbol" x1="${left}" y1="${y}" x2="${bodyLeft}" y2="${y}" /><polyline class="diagram-symbol" points="${bodyLeft},${y} ${bodyLeft + leadInset},${top + 16} ${bodyLeft + leadInset * 2},${bottom - 16} ${bodyLeft + leadInset * 3},${top + 16} ${bodyLeft + leadInset * 4},${bottom - 16} ${bodyLeft + leadInset * 5},${y} ${bodyRight},${y}" /><line class="diagram-symbol" x1="${bodyRight}" y1="${y}" x2="${right}" y2="${y}" />`;
  }
  if (symbolType === 'capacitor') {
    return `<line class="diagram-symbol" x1="${left}" y1="${y}" x2="${x - 14}" y2="${y}" /><line class="diagram-symbol" x1="${x - 14}" y1="${top + 9}" x2="${x - 14}" y2="${bottom - 9}" /><line class="diagram-symbol" x1="${x + 14}" y1="${top + 9}" x2="${x + 14}" y2="${bottom - 9}" /><line class="diagram-symbol" x1="${x + 14}" y1="${y}" x2="${right}" y2="${y}" />`;
  }
  if (symbolType === 'inductor') {
    return `<path class="diagram-symbol" d="M ${left} ${y} H ${left + 14} C ${left + 18} ${top + 8}, ${left + 34} ${top + 8}, ${left + 38} ${y} C ${left + 42} ${top + 8}, ${left + 58} ${top + 8}, ${left + 62} ${y} C ${left + 66} ${top + 8}, ${left + 82} ${top + 8}, ${left + 86} ${y} H ${right}" />`;
  }
  if (symbolType === 'diode' || symbolType === 'led') {
    const ledMarks = symbolType === 'led' ? `<line class="diagram-symbol thin" x1="${x + 18}" y1="${top + 6}" x2="${x + 34}" y2="${top - 10}" /><line class="diagram-symbol thin" x1="${x + 30}" y1="${top + 12}" x2="${x + 46}" y2="${top - 4}" />` : '';
    return `<line class="diagram-symbol" x1="${left}" y1="${y}" x2="${x - 20}" y2="${y}" /><polygon class="diagram-fill" points="${x - 20},${top + 10} ${x - 20},${bottom - 10} ${x + 12},${y}" /><line class="diagram-symbol" x1="${x + 14}" y1="${top + 8}" x2="${x + 14}" y2="${bottom - 8}" /><line class="diagram-symbol" x1="${x + 14}" y1="${y}" x2="${right}" y2="${y}" />${ledMarks}`;
  }
  if (symbolType === 'voltage_source') {
    return `<line class="diagram-symbol" x1="${left}" y1="${y}" x2="${x - 24}" y2="${y}" /><circle class="diagram-symbol" cx="${x}" cy="${y}" r="24" /><line class="diagram-symbol" x1="${x + 24}" y1="${y}" x2="${right}" y2="${y}" /><text class="diagram-small" x="${x}" y="${y - 4}" text-anchor="middle">+</text><text class="diagram-small" x="${x}" y="${y + 16}" text-anchor="middle">-</text>`;
  }
  if (symbolType === 'bjt_npn' || symbolType === 'bjt_pnp') {
    const collector = component.pins.find((pin) => pin.pinIndex === 1) || { x: right, y: top + 18 };
    const base = component.pins.find((pin) => pin.pinIndex === 2) || { x: left, y };
    const emitter = component.pins.find((pin) => pin.pinIndex === 3) || { x: right, y: bottom - 18 };
    const radius = Math.min(width, height) / 2 - 12;
    const baseX = x - 16;
    const collectorJoin = { x: x + 10, y: y - 22 };
    const emitterJoin = { x: x + 10, y: y + 22 };
    const arrow = symbolType === 'bjt_npn'
      ? `${emitter.x - 21},${emitter.y - 8} ${emitter.x - 5},${emitter.y} ${emitter.x - 21},${emitter.y + 8}`
      : `${emitter.x - 5},${emitter.y - 8} ${emitter.x - 21},${emitter.y} ${emitter.x - 5},${emitter.y + 8}`;
    return `<circle class="diagram-symbol" cx="${x}" cy="${y}" r="${radius}" /><line class="diagram-symbol" x1="${base.x}" y1="${base.y}" x2="${baseX}" y2="${base.y}" /><line class="diagram-symbol" x1="${baseX}" y1="${y - 28}" x2="${baseX}" y2="${y + 28}" /><line class="diagram-symbol" x1="${baseX}" y1="${y - 18}" x2="${collectorJoin.x}" y2="${collectorJoin.y}" /><line class="diagram-symbol" x1="${collectorJoin.x}" y1="${collectorJoin.y}" x2="${collector.x}" y2="${collector.y}" /><line class="diagram-symbol" x1="${baseX}" y1="${y + 18}" x2="${emitterJoin.x}" y2="${emitterJoin.y}" /><line class="diagram-symbol" x1="${emitterJoin.x}" y1="${emitterJoin.y}" x2="${emitter.x}" y2="${emitter.y}" /><polygon points="${arrow}" fill="#94a3b5" /><text class="diagram-small" x="${collector.x - 10}" y="${collector.y - 8}" text-anchor="middle">C</text><text class="diagram-small" x="${base.x + 10}" y="${base.y - 8}" text-anchor="middle">B</text><text class="diagram-small" x="${emitter.x - 10}" y="${emitter.y + 18}" text-anchor="middle">E</text>`;
  }
  if (symbolType === 'opamp') {
    const nonInverting = component.pins.find((pin) => pin.pinIndex === 1) || { x: left, y: y + height * 0.22 };
    const inverting = component.pins.find((pin) => pin.pinIndex === 2) || { x: left, y: y - height * 0.22 };
    const output = component.pins.find((pin) => pin.pinIndex === 3) || { x: right, y };
    const positiveSupply = component.pins.find((pin) => pin.pinIndex === 4) || { x, y: top };
    const negativeSupply = component.pins.find((pin) => pin.pinIndex === 5) || { x, y: bottom };
    const bodyLeft = left + 28;
    const bodyRight = right - 18;
    const bodyTop = top + 12;
    const bodyBottom = bottom - 12;
    return `<line class="diagram-symbol" x1="${nonInverting.x}" y1="${nonInverting.y}" x2="${bodyLeft}" y2="${nonInverting.y}" /><line class="diagram-symbol" x1="${inverting.x}" y1="${inverting.y}" x2="${bodyLeft}" y2="${inverting.y}" /><polygon class="diagram-fill" points="${bodyLeft},${bodyTop} ${bodyLeft},${bodyBottom} ${bodyRight},${y}" /><line class="diagram-symbol" x1="${bodyRight}" y1="${y}" x2="${output.x}" y2="${output.y}" /><line class="diagram-symbol" x1="${positiveSupply.x}" y1="${positiveSupply.y}" x2="${positiveSupply.x}" y2="${bodyTop + 12}" /><line class="diagram-symbol" x1="${negativeSupply.x}" y1="${negativeSupply.y}" x2="${negativeSupply.x}" y2="${bodyBottom - 12}" /><text class="diagram-small" x="${bodyLeft + 18}" y="${nonInverting.y + 5}" text-anchor="middle">+</text><text class="diagram-small" x="${bodyLeft + 18}" y="${inverting.y + 5}" text-anchor="middle">-</text><text class="diagram-small" x="${positiveSupply.x + 18}" y="${positiveSupply.y + 14}" text-anchor="middle">V+</text><text class="diagram-small" x="${negativeSupply.x + 18}" y="${negativeSupply.y - 6}" text-anchor="middle">V-</text>`;
  }
  return `<rect class="diagram-symbol" x="${left}" y="${top}" width="${width}" height="${height}" rx="6" /><text class="diagram-small" x="${x}" y="${y + 5}" text-anchor="middle">${escapeXml(component.kind.replaceAll('_', ' '))}</text>`;
};

export const toDiagramSvg = (diagram) => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${diagram.width} ${diagram.height}" role="img">
  <title>${escapeXml(diagram.title)}</title>
  <style>
    .diagram-bg{fill:#161e26}.diagram-wire,.diagram-symbol{fill:none;stroke:#94a3b5;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.diagram-wire{stroke:#637080;stroke-width:1.5}.diagram-bridge-clear{stroke:#161e26;stroke-width:7;stroke-linecap:round}.diagram-bridge-arc{fill:none;stroke:#637080;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}.diagram-fill{fill:#161e26;stroke:#94a3b5;stroke-width:2}.diagram-node{fill:#d4943a}.diagram-net{fill:#232b36;stroke:#364050}.diagram-text{fill:#d4943a;font:700 14px Inter,Arial,sans-serif}.diagram-small{fill:#94a3b5;font:12px Inter,Arial,sans-serif}.diagram-value{fill:#3ab4a8}.thin{stroke-width:1.5}
  </style>
  <rect class="diagram-bg" width="${diagram.width}" height="${diagram.height}" rx="8" />
  ${diagram.wires.map((wire) => {
    const points = diagramWirePoints(diagram, wire);
    return `<polyline class="diagram-wire" points="${svgPolyline(points)}" />`;
  }).join('\n  ')}
  ${(diagram.bridges || []).map(bridgeSvg).join('\n  ')}
  ${(diagram.netLabels || []).map((label) => label.name === '0'
    ? renderGroundSvg(label.x, label.y)
    : `<g><rect class="diagram-net" x="${label.labelX}" y="${label.labelY}" width="${label.labelWidth}" height="26" rx="13" /><text class="diagram-small" x="${label.labelX + label.labelWidth / 2}" y="${label.labelY + 17}" text-anchor="middle">${escapeXml(label.name)}</text></g>`).join('\n  ')}
  ${[...new Map((diagram.wires || [])
    .filter((wire) => !wire.manual && wire.node === '0' && !(diagram.netLabels || []).some((label) => label.id === wire.labelId && label.name === '0'))
    .map((wire) => diagramWirePoints(diagram, wire).at(-1))
    .filter(Boolean)
    .map((point) => [`${point.x}:${point.y}`, point])).values()]
    .map((point) => renderGroundSvg(point.x, point.y)).join('\n  ')}
  ${(diagram.ports || []).map(renderPortSvg).join('\n  ')}
  ${(diagram.junctions || []).map((junction) => `<circle class="diagram-node" cx="${junction.x}" cy="${junction.y}" r="4" />`).join('\n  ')}
  ${diagram.components.map((component) => {
    const refLabel = diagram.labels?.find((label) => label.ref === component.ref && label.kind === 'ref');
    const valueLabel = diagram.labels?.find((label) => label.ref === component.ref && label.kind === 'value');
    const labels = component.symbolType === 'ground'
      ? ''
      : `<text class="diagram-text" x="${refLabel?.x || component.x}" y="${refLabel?.y || component.y - component.height / 2 - 12}" text-anchor="middle">${escapeXml(component.ref)}</text><text class="diagram-small" x="${valueLabel?.x || component.x}" y="${valueLabel?.y || component.y + component.height / 2 + 20}" text-anchor="middle">${escapeXml(component.value)}</text>`;
    // Engineers don't number the two pins of a resistor/cap/source/diode, so
    // only annotate pin numbers on multi-pin parts (op-amps, transistors) where
    // they actually disambiguate. Numbering every passive reads as machine output.
    const pinLabels = component.symbolType === 'ground' || (component.pins?.length ?? 0) <= 2
      ? ''
      : component.pins.map((pin) => `<text class="diagram-small" x="${pin.x}" y="${pin.y - 8}" text-anchor="middle">${pin.pinIndex}</text>`).join('');
    return `<g>${renderSymbolSvg(component)}${labels}${pinLabels}</g>`;
  }).join('\n  ')}
</svg>`;

export const toSpice = (circuit) => {
  const lines = [`* ${circuit.title}`, '* Generated by Prompt-to-PCB Generator'];
  for (const part of circuit.components) {
    const [a, b, c, d, e] = part.nodes;
    const ref = spiceRef(part);
    if (part.kind === 'voltage_source') lines.push(`${ref} ${a} ${b} DC ${cleanVoltageValue(part.value)}`);
    if (part.kind === 'signal_source') lines.push(`${ref} ${a} ${b} ${part.value}`);
    if (part.kind === 'resistor' || part.kind === 'load') lines.push(`${ref} ${a} ${b} ${part.value}`);
    if (part.kind === 'capacitor') lines.push(`${ref} ${a} ${b} ${part.value.replace(/f$/i, '')}`);
    if (part.kind === 'inductor') lines.push(`${ref} ${a} ${b} ${part.value.replace(/h$/i, '')}`);
    if (part.kind === 'diode') lines.push(`${ref} ${a} ${b} DGEN`);
    if (part.kind === 'led') lines.push(`${ref} ${a} ${b} DRED`);
    if (part.kind === 'bjt_npn') lines.push(`${ref} ${a} ${b} ${c} Q2N2222`);
    if (part.kind === 'opamp') lines.push(`${ref} ${a} ${b} ${c} ${d} ${e} LM358`);
    if (part.kind === 'regulator') lines.push(`${ref} ${regulatorOutputNode(part.nodes)} 0 DC ${regulatorVoltage(part.value)}`);
  }
  lines.push('.model DGEN D(IS=1e-14 RS=1 N=1)');
  lines.push('.model DRED D(IS=1e-20 N=2 RS=10 CJO=2p BV=5 IBV=10u)');
  lines.push('.model Q2N2222 NPN(IS=1e-14 BF=200 VAF=100)');
  if (circuit.components.some((part) => part.kind === 'opamp')) lines.push(LM358_SUBCIRCUIT);
  lines.push('.tran 0.1ms 20ms');
  lines.push('.op');
  lines.push('.end');
  return lines.join('\n');
};

export const toKiCadNetlist = (circuit) => {
  const nets = [...new Set(circuit.components.flatMap((part) => part.nodes))];
  const compXml = circuit.components
    .map(
      (part) => `    <comp ref="${escapeXml(part.ref)}">
      <value>${escapeXml(part.value)}</value>
      <footprint>${escapeXml(part.footprint || '')}</footprint>
      <fields>
        <field name="Kind">${escapeXml(part.kind)}</field>
      </fields>
    </comp>`,
    )
    .join('\n');
  const netXml = nets
    .map((net, index) => {
      const nodes = circuit.components
        .flatMap((part) =>
          part.nodes
            .map((node, pinIndex) => ({ node, pinIndex: pinIndex + 1, ref: part.ref }))
            .filter((pin) => pin.node === net),
        )
        .map((pin) => `      <node ref="${escapeXml(pin.ref)}" pin="${pin.pinIndex}" />`)
        .join('\n');
      return `    <net code="${index}" name="${escapeXml(net)}">
${nodes}
    </net>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<export version="D">
  <design>
    <source>prompt-to-pcb-generator</source>
    <date>${new Date().toISOString()}</date>
    <tool>Prompt-to-PCB Generator MVP</tool>
  </design>
  <components>
${compXml}
  </components>
  <nets>
${netXml}
  </nets>
</export>`;
};

export const simulateCircuit = (circuit) => {
  return {
    engine: 'AI-generated Ngspice-ready export',
    status: 'ready',
    metrics: [
      { label: 'Components', value: String(circuit.components.length) },
      { label: 'Nets', value: String(new Set(circuit.components.flatMap((part) => part.nodes)).size) },
      { label: 'Analysis', value: 'SPICE deck generated' },
    ],
    command: 'ngspice generated.cir',
  };
};
