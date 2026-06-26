import { normalizeAiCircuit, reconcileCircuitRevision } from './circuitResponse.js';
import { toSpice } from '../src/lib/pcbGenerator.js';

const readStringProperty = (text, name) => {
  const match = String(text || '').match(new RegExp(`"${name}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
  if (!match) return '';
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
};

const readNumberProperty = (text, name) => {
  const match = String(text || '').match(new RegExp(`"${name}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
  return match ? Number(match[1]) : 0;
};

export const extractCompleteComponents = (text) => {
  const source = String(text || '');
  const propertyIndex = source.search(/"components"\s*:/);
  if (propertyIndex === -1) return [];
  const arrayStart = source.indexOf('[', propertyIndex);
  if (arrayStart === -1) return [];

  const components = [];
  let objectStart = -1;
  let objectDepth = 0;
  let inString = false;
  let escaped = false;

  for (let index = arrayStart + 1; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === ']' && objectDepth === 0) break;
    if (char === '{') {
      if (objectDepth === 0) objectStart = index;
      objectDepth += 1;
    }
    if (char === '}' && objectDepth > 0) {
      objectDepth -= 1;
      if (objectDepth === 0 && objectStart !== -1) {
        try {
          components.push(JSON.parse(source.slice(objectStart, index + 1)));
        } catch {
          // Wait for more streamed JSON when an object is not complete yet.
        }
        objectStart = -1;
      }
    }
  }

  return components;
};

export const buildStreamingSpice = (text, prompt = '', existingCircuit = null) => {
  const title = readStringProperty(text, 'title') || 'AI generated circuit';
  const components = extractCompleteComponents(text);
  if (components.length === 0 && !existingCircuit?.components?.length) {
    return {
      componentCount: 0,
      title,
      spice: `* ${title}\n* AI is generating components...`,
    };
  }

  const partialCircuit = {
    title,
    type: readStringProperty(text, 'type') || 'ai_generated',
    supplyVoltage: readNumberProperty(text, 'supplyVoltage') || 5,
    components,
    notes: [],
  };
  const circuit = existingCircuit?.components?.length
    ? reconcileStreamingRevision(partialCircuit, existingCircuit, prompt)
    : normalizeAiCircuit(partialCircuit, prompt);

  return {
    componentCount: circuit.components.length,
    title: circuit.title,
    spice: toSpice(circuit),
  };
};

const reconcileStreamingRevision = (partialCircuit, existingCircuit, prompt) => {
  if (partialCircuit.components.length === 0) return normalizeAiCircuit(existingCircuit, prompt);

  const partialByRef = new Map(
    partialCircuit.components.map((component) => [String(component.ref || '').toUpperCase(), component]),
  );
  const mergedComponents = existingCircuit.components.map((component) =>
    partialByRef.get(String(component.ref).toUpperCase()) || component);
  const existingRefs = new Set(existingCircuit.components.map((component) => String(component.ref).toUpperCase()));
  mergedComponents.push(
    ...partialCircuit.components.filter((component) => !existingRefs.has(String(component.ref || '').toUpperCase())),
  );

  return reconcileCircuitRevision({
    ...partialCircuit,
    title: partialCircuit.title === 'AI generated circuit' ? existingCircuit.title : partialCircuit.title,
    type: partialCircuit.type === 'ai_generated' ? existingCircuit.type : partialCircuit.type,
    supplyVoltage: partialCircuit.supplyVoltage || existingCircuit.supplyVoltage,
    components: mergedComponents,
  }, prompt, existingCircuit);
};
