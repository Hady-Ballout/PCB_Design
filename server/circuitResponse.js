import {
  buildCircuitDiagram,
  simulateCircuit,
  toDiagramSvg,
  toKiCadNetlist,
  toSpice,
  validateCircuit,
} from '../src/lib/pcbGenerator.js';

const normalizeComponent = (component, index) => ({
  ref: String(component.ref || `X${index + 1}`).toUpperCase(),
  kind: String(component.kind || 'load'),
  value: String(component.value || 'UNKNOWN'),
  nodes: Array.isArray(component.nodes) && component.nodes.length ? component.nodes.map(String) : ['NODE', '0'],
  footprint: String(component.footprint || ''),
});

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const uniqueBy = (items, keyFor) => {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFor(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const normalizeSide = (value, fallback = '') => {
  const side = String(value || '').toLowerCase();
  return ['left', 'right', 'top', 'bottom', 'center'].includes(side) ? side : fallback;
};

const normalizeRole = (value, fallback = 'internal') =>
  String(value || fallback).toLowerCase().replace(/[^a-z0-9_]+/g, '_') || fallback;

const roleForNet = (net) => {
  const name = String(net || '');
  if (name === '0') return { role: 'ground', side: 'bottom' };
  if (/^(vcc|vdd|vbat|vbus|\+?5v|\+?12v)$/i.test(name)) return { role: 'supply', side: 'top' };
  if (/^(vee|vss|-5v|-12v)$/i.test(name)) return { role: 'supply', side: 'bottom' };
  if (/^(v?in|input|sig|signal)/i.test(name) || /^vin[a-z0-9_]*$/i.test(name)) return { role: 'input', side: 'left' };
  if (/(^|_)(v?out|output|filtered|load)(_|$)/i.test(name)) return { role: 'output', side: 'right' };
  if (/(bias|ref|mid)/i.test(name)) return { role: 'bias', side: 'left' };
  if (/(fb|feedback)/i.test(name)) return { role: 'feedback', side: 'top' };
  return { role: 'internal', side: '' };
};

const componentRoleFor = (component, schematic, netRoles) => {
  if (component.ref === schematic.primaryRef) return { role: 'primary', side: '', orientation: 'horizontal' };
  if (component.kind === 'opamp') return { role: 'primary', side: '', orientation: 'horizontal' };
  if (component.kind === 'load') return { role: 'load', side: 'right', orientation: 'vertical' };
  if (component.kind === 'voltage_source') return { role: 'source', side: 'left', orientation: 'vertical' };
  if (component.kind === 'signal_source') return { role: 'input_source', side: 'left', orientation: 'vertical' };
  const roles = component.nodes.map((node) => netRoles.get(String(node))?.role);
  if (roles.includes('output') && roles.includes('feedback')) return { role: 'feedback', side: '', orientation: 'horizontal' };
  if (roles.includes('output')) return { role: 'output_network', side: '', orientation: 'horizontal' };
  if (roles.includes('input')) return { role: 'input_network', side: '', orientation: 'horizontal' };
  if (roles.includes('bias')) return { role: 'bias_network', side: '', orientation: 'horizontal' };
  return { role: 'passive', side: '', orientation: '' };
};

export function normalizeSchematicHints(circuit) {
  const components = Array.isArray(circuit?.components) ? circuit.components : [];
  const componentRefs = new Set(components.map((component) => component.ref));
  const nodeNames = new Set(
    (Array.isArray(circuit?.nodes) && circuit.nodes.length
      ? circuit.nodes
      : components.flatMap((component) => component.nodes || []))
      .map(String),
  );
  const raw = isPlainObject(circuit?.schematic) ? circuit.schematic : {};
  const rawPrimary = String(raw.primaryRef || '').toUpperCase();
  const primaryRef = componentRefs.has(rawPrimary)
    ? rawPrimary
    : components.find((component) => component.kind === 'opamp')?.ref || '';
  const topology = normalizeRole(raw.topology || circuit?.type || 'custom', 'custom');

  const rawNetRoles = Array.isArray(raw.netRoles) ? raw.netRoles : [];
  const netRoles = new Map();
  for (const hint of rawNetRoles) {
    if (!isPlainObject(hint)) continue;
    const net = String(hint.net || '');
    if (!nodeNames.has(net)) continue;
    const derived = roleForNet(net);
    netRoles.set(net, {
      net,
      role: normalizeRole(hint.role, derived.role),
      side: normalizeSide(hint.side, derived.side),
    });
  }
  for (const net of nodeNames) {
    if (netRoles.has(net)) continue;
    const derived = roleForNet(net);
    netRoles.set(net, { net, ...derived });
  }

  const pinCounts = new Map();
  components.forEach((component) => {
    (component.nodes || []).forEach((node) => pinCounts.set(String(node), (pinCounts.get(String(node)) || 0) + 1));
  });

  const rawTerminals = Array.isArray(raw.externalTerminals) ? raw.externalTerminals : [];
  const externalTerminals = rawTerminals
    .filter(isPlainObject)
    .map((terminal) => {
      const net = String(terminal.net || '');
      if (!nodeNames.has(net) || net === '0') return null;
      const role = netRoles.get(net) || roleForNet(net);
      return {
        net,
        label: String(terminal.label || net),
        type: normalizeRole(terminal.type, role.role === 'internal' ? 'test' : role.role),
        side: normalizeSide(terminal.side, role.side || 'left'),
        explicit: true,
      };
    })
    .filter(Boolean);
  for (const [net, role] of netRoles.entries()) {
    if (net === '0') continue;
    const shouldExpose = ['input', 'output'].includes(role.role)
      || (pinCounts.get(net) === 1 && ['bias', 'internal'].includes(role.role) && /^(v?in|input|test|tp)/i.test(net));
    if (shouldExpose) {
      externalTerminals.push({
        net,
        label: net,
        type: role.role === 'internal' ? 'test' : role.role,
        side: normalizeSide(role.side, role.role === 'output' ? 'right' : 'left'),
        explicit: false,
      });
    }
  }

  const rawComponentRoles = Array.isArray(raw.componentRoles) ? raw.componentRoles : [];
  const componentRoles = rawComponentRoles
    .filter(isPlainObject)
    .map((hint) => {
      const ref = String(hint.ref || '').toUpperCase();
      if (!componentRefs.has(ref)) return null;
      const component = components.find((item) => item.ref === ref);
      const derived = componentRoleFor(component, { primaryRef }, netRoles);
      return {
        ref,
        role: normalizeRole(hint.role, derived.role),
        block: String(hint.block || derived.role || ''),
        side: normalizeSide(hint.side, derived.side),
        orientation: ['horizontal', 'vertical'].includes(String(hint.orientation || '').toLowerCase())
          ? String(hint.orientation).toLowerCase()
          : derived.orientation,
        order: Number.isFinite(Number(hint.order)) ? Number(hint.order) : component.order,
        pinRoles: isPlainObject(hint.pinRoles) ? hint.pinRoles : {},
      };
    })
    .filter(Boolean);
  for (const component of components) {
    if (componentRoles.some((hint) => hint.ref === component.ref)) continue;
    const derived = componentRoleFor(component, { primaryRef }, netRoles);
    componentRoles.push({
      ref: component.ref,
      role: derived.role,
      block: derived.role,
      side: derived.side,
      orientation: derived.orientation,
      order: component.order,
      pinRoles: {},
    });
  }

  const rawBlocks = Array.isArray(raw.blocks) ? raw.blocks : [];
  const blocks = rawBlocks
    .filter(isPlainObject)
    .map((block, index) => ({
      id: normalizeRole(block.id, `block_${index + 1}`),
      role: normalizeRole(block.role, 'functional'),
      refs: Array.isArray(block.refs) ? block.refs.map((ref) => String(ref).toUpperCase()).filter((ref) => componentRefs.has(ref)) : [],
      side: normalizeSide(block.side, ''),
      order: Number.isFinite(Number(block.order)) ? Number(block.order) : index,
    }))
    .filter((block) => block.refs.length);
  if (primaryRef && !blocks.some((block) => block.refs.includes(primaryRef))) {
    blocks.push({ id: 'primary', role: 'primary', refs: [primaryRef], side: 'center', order: 0 });
  }

  return {
    version: 1,
    topology,
    primaryRef,
    externalTerminals: uniqueBy(externalTerminals, (terminal) => terminal.net),
    netRoles: [...netRoles.values()],
    componentRoles: uniqueBy(componentRoles, (role) => role.ref),
    blocks,
  };
}

export function normalizeAiCircuit(aiCircuit, prompt) {
  if (!aiCircuit || typeof aiCircuit !== 'object') {
    throw new Error('AI circuit response was not an object.');
  }

  const components = Array.isArray(aiCircuit.components)
    ? aiCircuit.components.map(normalizeComponent)
    : [];
  if (components.length === 0) {
    throw new Error('AI circuit response did not include any components.');
  }

  const nodes = Array.isArray(aiCircuit.nodes) && aiCircuit.nodes.length
    ? aiCircuit.nodes.map(String)
    : [...new Set(components.flatMap((component) => component.nodes))];

  const normalized = {
    title: String(aiCircuit.title || 'AI generated circuit'),
    type: String(aiCircuit.type || 'ai_generated'),
    supplyVoltage: Number(aiCircuit.supplyVoltage) || 5,
    nodes,
    components,
    notes: Array.isArray(aiCircuit.notes)
      ? aiCircuit.notes.map(String)
      : [`Generated from prompt: ${prompt}`],
  };
  return {
    ...normalized,
    schematic: normalizeSchematicHints({ ...normalized, schematic: aiCircuit.schematic }),
  };
}

export function reconcileCircuitRevision(aiCircuit, prompt, existingCircuit = null) {
  const revised = normalizeAiCircuit(aiCircuit, prompt);
  if (!existingCircuit?.components?.length) return revised;

  const existingByRef = new Map(
    existingCircuit.components.map((component) => [String(component.ref).toUpperCase(), component]),
  );
  const components = revised.components.map((component) => {
    const existing = existingByRef.get(component.ref);
    if (!existing) return component;
    return {
      ...component,
      footprint: component.footprint || String(existing.footprint || ''),
    };
  });

  const merged = {
    ...revised,
    title: revised.title || String(existingCircuit.title || 'AI generated circuit'),
    type: revised.type || String(existingCircuit.type || 'ai_generated'),
    components,
  };
  return {
    ...merged,
    schematic: normalizeSchematicHints(merged),
  };
}

export function buildCircuitResponse(circuit, intent, source) {
  const enrichedCircuit = {
    ...circuit,
    schematic: normalizeSchematicHints(circuit),
  };
  const diagram = buildCircuitDiagram(enrichedCircuit);
  return {
    intent,
    circuit: enrichedCircuit,
    validation: validateCircuit(enrichedCircuit),
    diagram,
    diagramSvg: toDiagramSvg(diagram),
    spice: toSpice(enrichedCircuit),
    kicadNetlist: toKiCadNetlist(enrichedCircuit),
    simulation: simulateCircuit(enrichedCircuit),
    source,
  };
}
