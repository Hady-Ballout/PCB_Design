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

  return {
    title: String(aiCircuit.title || 'AI generated circuit'),
    type: String(aiCircuit.type || 'ai_generated'),
    supplyVoltage: Number(aiCircuit.supplyVoltage) || 5,
    nodes,
    components,
    notes: Array.isArray(aiCircuit.notes)
      ? aiCircuit.notes.map(String)
      : [`Generated from prompt: ${prompt}`],
  };
}

export function buildCircuitResponse(circuit, intent, source) {
  const diagram = buildCircuitDiagram(circuit);
  return {
    intent,
    circuit,
    validation: validateCircuit(circuit),
    diagram,
    diagramSvg: toDiagramSvg(diagram),
    spice: toSpice(circuit),
    kicadNetlist: toKiCadNetlist(circuit),
    simulation: simulateCircuit(circuit),
    source,
  };
}
