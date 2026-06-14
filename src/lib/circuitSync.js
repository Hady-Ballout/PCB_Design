import {
  DiagramLayoutError,
  buildCircuitDiagram,
  layoutCircuitDiagram,
  repairDiagramLayout,
  simulateCircuit,
  toDiagramSvg,
  toKiCadNetlist,
  toSpice,
  validateCircuit,
} from './pcbGenerator.js';

const decodeXml = (value) =>
  String(value || '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code) => {
    if (code[0] === '#') {
      const radix = code[1].toLowerCase() === 'x' ? 16 : 10;
      const number = Number.parseInt(code.replace(/^#x?/i, ''), radix);
      return Number.isFinite(number) ? String.fromCodePoint(number) : entity;
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[code.toLowerCase()] || entity;
  });

const parseAttributes = (source) => {
  const attributes = {};
  const pattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(pattern)) {
    attributes[match[1]] = decodeXml(match[2] ?? match[3] ?? '');
  }
  return attributes;
};

const parseXml = (source) => {
  const input = String(source || '');
  const root = { name: '#document', attributes: {}, children: [], text: '' };
  const stack = [root];
  const tokenPattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/?[^>]+>|[^<]+/g;
  let cursor = 0;

  for (const match of input.matchAll(tokenPattern)) {
    if (match.index !== cursor) return { error: 'The KiCad netlist contains incomplete XML.' };
    cursor += match[0].length;
    const token = match[0];
    if (token.startsWith('<?') || token.startsWith('<!--')) continue;
    if (!token.startsWith('<')) {
      stack.at(-1).text += decodeXml(token);
      continue;
    }
    if (token.startsWith('</')) {
      const name = token.slice(2, -1).trim();
      if (stack.length === 1 || stack.at(-1).name !== name) {
        return { error: `Unexpected closing tag </${name}>.` };
      }
      stack.pop();
      continue;
    }

    const selfClosing = /\/\s*>$/.test(token);
    const body = token.slice(1, selfClosing ? token.lastIndexOf('/') : -1).trim();
    const name = body.match(/^[^\s/>]+/)?.[0];
    if (!name) return { error: 'The KiCad netlist contains an invalid XML tag.' };
    const node = { name, attributes: parseAttributes(body.slice(name.length)), children: [], text: '' };
    stack.at(-1).children.push(node);
    if (!selfClosing) stack.push(node);
  }

  if (cursor !== input.length || stack.length !== 1) {
    return { error: 'The KiCad netlist contains incomplete XML.' };
  }
  return { document: root };
};

const childrenNamed = (node, name) => node?.children?.filter((child) => child.name === name) || [];
const childNamed = (node, name) => childrenNamed(node, name)[0];
const childText = (node, name) => childNamed(node, name)?.text.trim() || '';

const kindFromRef = (ref) => {
  const normalized = String(ref || '').toUpperCase();
  if (normalized.startsWith('V')) return 'voltage_source';
  if (normalized.startsWith('R')) return 'resistor';
  if (normalized.startsWith('C')) return 'capacitor';
  if (normalized.startsWith('L')) return 'inductor';
  if (normalized.startsWith('D')) return 'diode';
  if (normalized.startsWith('Q')) return 'bjt_npn';
  if (normalized.startsWith('X') || normalized.startsWith('U')) return 'opamp';
  return 'generic';
};

const defaultPinCount = (kind) => {
  if (kind === 'opamp') return 5;
  if (kind === 'bjt_npn' || kind === 'bjt_pnp') return 3;
  return 2;
};

const spiceRefForComponent = (component) => {
  const base = String(component.ref || 'X').replace(/[^a-z0-9_]/gi, '_').toUpperCase();
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
    opamp: 'X',
  };
  const prefix = prefixByKind[component.kind] || 'X';
  return base.startsWith(prefix) ? base : `${prefix}_${base}`;
};

const voltageValue = (value) => (/v$/i.test(value) ? value : `${value}V`);

export const parseSpiceNetlist = (source, baseCircuit) => {
  const baseComponents = baseCircuit?.components || [];
  const baseBySpiceRef = new Map(baseComponents.map((component) => [spiceRefForComponent(component), component]));
  const components = [];
  const errors = [];
  let subcircuitDepth = 0;

  for (const [index, rawLine] of String(source || '').split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (/^\.subckt\b/i.test(line)) {
      subcircuitDepth += 1;
      continue;
    }
    if (/^\.ends\b/i.test(line)) {
      subcircuitDepth = Math.max(0, subcircuitDepth - 1);
      continue;
    }
    if (subcircuitDepth > 0) continue;
    if (!line || line.startsWith('*') || line.startsWith('.')) continue;
    if (line.startsWith('+')) {
      errors.push(`Line ${index + 1}: continuation lines are not supported by the canvas editor.`);
      continue;
    }

    const tokens = line.split(/\s+/);
    const spiceRef = tokens[0]?.toUpperCase();
    const prefix = spiceRef?.[0];
    const base = baseBySpiceRef.get(spiceRef);
    let record = null;

    if (prefix === 'R' || prefix === 'C' || prefix === 'L') {
      if (tokens.length < 4) {
        errors.push(`Line ${index + 1}: ${tokens[0]} needs two nodes and a value.`);
        continue;
      }
      const kind = prefix === 'R' ? (base?.kind === 'load' ? 'load' : 'resistor') : prefix === 'C' ? 'capacitor' : 'inductor';
      record = { kind, nodes: tokens.slice(1, 3), value: tokens.slice(3).join(' ') };
    } else if (prefix === 'V') {
      if (tokens.length < 4) {
        errors.push(`Line ${index + 1}: ${tokens[0]} needs two nodes and a source value.`);
        continue;
      }
      const expression = tokens.slice(3).join(' ');
      const dcMatch = expression.match(/^DC\s+(.+)$/i);
      record = dcMatch
        ? { kind: 'voltage_source', nodes: tokens.slice(1, 3), value: voltageValue(dcMatch[1]) }
        : { kind: 'signal_source', nodes: tokens.slice(1, 3), value: expression };
    } else if (prefix === 'D') {
      if (tokens.length < 4) {
        errors.push(`Line ${index + 1}: ${tokens[0]} needs two nodes and a diode model.`);
        continue;
      }
      const model = tokens[3];
      record = {
        kind: /DRED/i.test(model) || base?.kind === 'led' ? 'led' : 'diode',
        nodes: tokens.slice(1, 3),
        value: base?.value || model,
      };
    } else if (prefix === 'Q') {
      if (tokens.length < 5) {
        errors.push(`Line ${index + 1}: ${tokens[0]} needs collector, base, emitter, and model.`);
        continue;
      }
      record = { kind: base?.kind || 'bjt_npn', nodes: tokens.slice(1, 4), value: base?.value || tokens[4] };
    } else if (prefix === 'X') {
      if (tokens.length < 7) {
        errors.push(`Line ${index + 1}: ${tokens[0]} needs five op-amp nodes and a model.`);
        continue;
      }
      record = { kind: 'opamp', nodes: tokens.slice(1, 6), value: tokens.slice(6).join(' ') };
    } else {
      errors.push(`Line ${index + 1}: component ${tokens[0]} is not supported by the canvas editor.`);
      continue;
    }

    components.push({
      ...(base || {}),
      ref: base?.ref || tokens[0],
      footprint: base?.footprint || '',
      ...record,
    });
  }

  if (components.length === 0) errors.push('The SPICE netlist does not contain any supported components.');
  const duplicateRefs = components
    .map((component) => component.ref)
    .filter((ref, index, refs) => refs.indexOf(ref) !== index);
  if (duplicateRefs.length) errors.push(`Component ${duplicateRefs[0]} is declared more than once.`);
  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    errors: [],
    circuit: {
      ...(baseCircuit || {}),
      title: baseCircuit?.title || 'SPICE synchronized circuit',
      type: baseCircuit?.type || 'custom',
      supplyVoltage: baseCircuit?.supplyVoltage || 5,
      components,
      notes: baseCircuit?.notes || [],
    },
  };
};

const terminalKey = (ref, pin) => `${ref}:${pin}`;
const isUnconnectedTerminal = (node, ref, pin) =>
  /^NC_/i.test(String(node)) || String(node) === `${ref}_${pin}`;

class TerminalGroups {
  constructor(keys) {
    this.parent = new Map(keys.map((key) => [key, key]));
  }

  has(key) {
    return this.parent.has(key);
  }

  find(key) {
    const parent = this.parent.get(key);
    if (!parent || parent === key) return parent;
    const root = this.find(parent);
    this.parent.set(key, root);
    return root;
  }

  union(first, second) {
    const firstRoot = this.find(first);
    const secondRoot = this.find(second);
    if (firstRoot && secondRoot && firstRoot !== secondRoot) this.parent.set(secondRoot, firstRoot);
  }
}

const chooseNetName = (names) => {
  const unique = [...new Set(names.filter(Boolean).map(String))];
  if (unique.includes('0')) return '0';
  return unique[0] || '';
};

const diagramHasCompleteConnectivity = (diagram, circuit) => {
  const automaticWires = new Map(
    (diagram?.wires || [])
      .filter((wire) => !wire.manual)
      .map((wire) => [`${wire.ref}:${wire.pin}:${wire.node}`, wire]),
  );
  const netLabels = new Set((diagram?.netLabels || []).map((label) => label.id));

  return (circuit?.components || []).every((component) => component.nodes.every((node, index) => {
    const pin = index + 1;
    if (isUnconnectedTerminal(node, component.ref, pin)) return true;
    const wire = automaticWires.get(`${component.ref}:${pin}:${node}`);
    return Boolean(
      wire
      && wire.points?.length >= 2
      && wire.labelId
      && netLabels.has(wire.labelId),
    );
  }));
};

export const circuitElectricalSignature = (circuit) =>
  JSON.stringify(
    (circuit?.components || []).map((component) => ({
      ref: component.ref,
      kind: component.kind,
      value: component.value,
      footprint: component.footprint || '',
      nodes: component.nodes.map(String),
    })),
  );

export const circuitFromDiagram = (diagram, baseCircuit) => {
  const components = diagram?.components || [];
  const baseByRef = new Map((baseCircuit?.components || []).map((component) => [component.ref, component]));
  const keys = components.flatMap((component) =>
    component.pins.map((pin) => terminalKey(component.ref, pin.pinIndex)),
  );
  const groups = new TerminalGroups(keys);

  for (const wire of diagram?.wires || []) {
    if (!wire.manual) continue;
    const from = terminalKey(wire.from?.ref, wire.from?.pin);
    const to = terminalKey(wire.to?.ref, wire.to?.pin);
    if (groups.has(from) && groups.has(to)) groups.union(from, to);
  }

  const namedByRoot = new Map();
  for (const wire of diagram?.wires || []) {
    if (wire.manual) continue;
    if (isUnconnectedTerminal(wire.node, wire.ref, wire.pin)) continue;
    const key = terminalKey(wire.ref, wire.pin);
    const root = groups.find(key);
    if (!root || !wire.node) continue;
    namedByRoot.set(root, [...(namedByRoot.get(root) || []), String(wire.node)]);
  }

  const terminalsByRoot = new Map();
  for (const component of components) {
    for (const pin of component.pins) {
      const key = terminalKey(component.ref, pin.pinIndex);
      const root = groups.find(key);
      terminalsByRoot.set(root, [...(terminalsByRoot.get(root) || []), { component, pin }]);
    }
  }

  const netByRoot = new Map();
  for (const [root, terminals] of terminalsByRoot.entries()) {
    const named = chooseNetName(namedByRoot.get(root) || []);
    if (named) {
      netByRoot.set(root, named);
      continue;
    }
    const newComponentNames = terminals
      .filter(({ component }) => !baseByRef.has(component.ref))
      .map(({ component, pin }) =>
        isUnconnectedTerminal(pin.node, component.ref, pin.pinIndex) ? '' : pin.node,
      );
    const fallback = chooseNetName(newComponentNames);
    const first = terminals[0];
    netByRoot.set(
      root,
      fallback || `${terminals.length > 1 ? 'NET' : 'NC'}_${first.component.ref}_${first.pin.pinIndex}`,
    );
  }

  const synchronizedComponents = components.map((component) => {
    const base = baseByRef.get(component.ref);
    const sortedPins = [...component.pins].sort((a, b) => a.pinIndex - b.pinIndex);
    return {
      ...(base || {}),
      ref: component.ref,
      kind: component.kind || base?.kind || kindFromRef(component.ref),
      value: component.value || base?.value || '',
      footprint: component.footprint ?? base?.footprint ?? '',
      nodes: sortedPins.map((pin) => netByRoot.get(groups.find(terminalKey(component.ref, pin.pinIndex)))),
    };
  });

  return {
    ...(baseCircuit || {}),
    title: diagram?.title || baseCircuit?.title || 'Synchronized circuit',
    type: baseCircuit?.type || 'custom',
    supplyVoltage: baseCircuit?.supplyVoltage || 5,
    components: synchronizedComponents,
    notes: baseCircuit?.notes || [],
  };
};

export const parseKiCadNetlist = (source, baseCircuit) => {
  const parsed = parseXml(source);
  if (parsed.error) return { ok: false, errors: [parsed.error] };
  const exportNode = childNamed(parsed.document, 'export');
  const componentSection = childNamed(exportNode, 'components');
  const netSection = childNamed(exportNode, 'nets');
  if (!exportNode || !componentSection || !netSection) {
    return { ok: false, errors: ['The KiCad netlist must contain export, components, and nets sections.'] };
  }

  const errors = [];
  const baseByRef = new Map((baseCircuit?.components || []).map((component) => [component.ref, component]));
  const componentRecords = [];
  const seenRefs = new Set();
  for (const node of childrenNamed(componentSection, 'comp')) {
    const ref = node.attributes.ref?.trim();
    if (!ref) {
      errors.push('Every component must have a ref attribute.');
      continue;
    }
    if (seenRefs.has(ref)) errors.push(`Component ${ref} is declared more than once.`);
    seenRefs.add(ref);
    const fields = childNamed(node, 'fields');
    const kindField = childrenNamed(fields, 'field').find((field) => field.attributes.name === 'Kind');
    componentRecords.push({
      ref,
      value: childText(node, 'value'),
      footprint: childText(node, 'footprint'),
      kind: kindField?.text.trim() || baseByRef.get(ref)?.kind || kindFromRef(ref),
    });
  }
  if (componentRecords.length === 0) errors.push('The KiCad netlist does not contain any components.');

  const nodesByRef = new Map(componentRecords.map((component) => [component.ref, new Map()]));
  for (const net of childrenNamed(netSection, 'net')) {
    const name = net.attributes.name;
    if (name === undefined || name === '') {
      errors.push('Every net must have a name attribute.');
      continue;
    }
    for (const node of childrenNamed(net, 'node')) {
      const ref = node.attributes.ref;
      const pin = Number.parseInt(node.attributes.pin, 10);
      if (!nodesByRef.has(ref)) {
        errors.push(`Net ${name} references unknown component ${ref || '(missing ref)'}.`);
        continue;
      }
      if (!Number.isInteger(pin) || pin < 1) {
        errors.push(`Net ${name} contains an invalid pin for ${ref}.`);
        continue;
      }
      if (nodesByRef.get(ref).has(pin)) {
        errors.push(`${ref} pin ${pin} is assigned to more than one net.`);
        continue;
      }
      nodesByRef.get(ref).set(pin, String(name));
    }
  }

  if (errors.length) return { ok: false, errors };
  const components = componentRecords.map((record) => {
    const base = baseByRef.get(record.ref);
    const assignedPins = nodesByRef.get(record.ref);
    const pinCount = Math.max(
      defaultPinCount(record.kind),
      base?.nodes?.length || 0,
      ...assignedPins.keys(),
    );
    return {
      ...(base || {}),
      ...record,
      nodes: Array.from({ length: pinCount }, (_, index) => assignedPins.get(index + 1) || `NC_${record.ref}_${index + 1}`),
    };
  });

  return {
    ok: true,
    errors: [],
    circuit: {
      ...(baseCircuit || {}),
      title: baseCircuit?.title || 'KiCad synchronized circuit',
      type: baseCircuit?.type || 'custom',
      supplyVoltage: baseCircuit?.supplyVoltage || 5,
      components,
      notes: baseCircuit?.notes || [],
    },
  };
};

export const preserveDiagramLayout = (diagram, previousDiagram, circuit = null) => {
  if (!previousDiagram) return diagram;
  const previousComponents = new Map(previousDiagram.components.map((component) => [component.ref, component]));
  const previousNetLabels = new Map((previousDiagram.netLabels || []).map((label) => [label.id, label]));
  const previousWires = new Map((previousDiagram.wires || []).map((wire) => [
    wire.id || `${wire.ref || wire.from?.ref}-${wire.pin || wire.from?.pin}-${wire.node || wire.to?.ref}`,
    wire,
  ]));
  const components = diagram.components.map((component) => {
    const previous = previousComponents.get(component.ref);
    if (!previous) return component;
    const dx = previous.x - component.x;
    const dy = previous.y - component.y;
    return {
      ...component,
      x: previous.x,
      y: previous.y,
      pins: component.pins.map((pin) => ({ ...pin, x: pin.x + dx, y: pin.y + dy })),
    };
  });
  const netLabels = (diagram.netLabels || []).map((label) => {
    const previous = previousNetLabels.get(label.id);
    return previous
      ? {
          ...label,
          x: previous.x,
          y: previous.y,
          direction: previous.direction || label.direction,
          labelX: previous.labelX,
          labelY: previous.labelY,
        }
      : label;
  });
  const wires = diagram.wires.map((wire) => {
    const id = wire.id || `${wire.ref || wire.from?.ref}-${wire.pin || wire.from?.pin}-${wire.node || wire.to?.ref}`;
    const previous = previousWires.get(id);
    return previous ? {
      ...wire,
      id,
      routingMode: previous.routingMode || (previous.manual ? 'manual' : wire.routingMode),
      preferredWaypoints: previous.preferredWaypoints || [],
    } : wire;
  });
  const preserved = {
    ...diagram,
    width: Math.max(diagram.width, previousDiagram.width),
    height: Math.max(diagram.height, previousDiagram.height),
    components,
    netLabels,
    wires,
  };
  try {
    const repaired = repairDiagramLayout(preserved);
    if (!circuit || diagramHasCompleteConnectivity(repaired, circuit)) return repaired;
  } catch (error) {
    if (!(error instanceof DiagramLayoutError)) throw error;
  }

  // A topology edit can invalidate old label positions or routed waypoints. Keep
  // the surviving component placement and rebuild that routing state from scratch.
  try {
    const repaired = repairDiagramLayout({
      ...preserved,
      netLabels: [],
      wires: diagram.wires,
    });
    if (!circuit || diagramHasCompleteConnectivity(repaired, circuit)) return repaired;
  } catch (error) {
    if (!(error instanceof DiagramLayoutError)) throw error;
  }

  if (circuit) {
    try {
      const anchors = new Map(components.map((component) => [component.ref, component]));
      const repaired = layoutCircuitDiagram(circuit, { anchors });
      if (diagramHasCompleteConnectivity(repaired, circuit)) return repaired;
    } catch (error) {
      if (!(error instanceof DiagramLayoutError)) throw error;
    }
  }

  return circuit && !diagramHasCompleteConnectivity(diagram, circuit)
    ? layoutCircuitDiagram(circuit)
    : diagram;
};

export const synchronizeResult = (previousResult, circuit, previousDiagram, options = {}) => {
  const diagram = preserveDiagramLayout(buildCircuitDiagram(circuit), previousDiagram, circuit);
  const spice = options.spice ?? toSpice(circuit);
  const kicadNetlist = options.kicadNetlist ?? toKiCadNetlist(circuit);
  return {
    ...previousResult,
    circuit,
    validation: validateCircuit(circuit),
    simulation: simulateCircuit(circuit),
    diagram,
    diagramSvg: toDiagramSvg(diagram),
    spice,
    kicadNetlist,
  };
};
