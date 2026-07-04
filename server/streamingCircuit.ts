import { normalizeAiCircuit, reconcileCircuitRevision } from './circuitResponse.js';
import { toSpice } from '../src/core/pcbGenerator.js';
import type { Circuit, Component, StreamingSpiceResult } from './types.js';

const readStringProperty = (text: string, name: string): string => {
  const match = String(text || '').match(new RegExp(`"${name}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
  if (!match) return '';
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
};

const readNumberProperty = (text: string, name: string): number => {
  const match = String(text || '').match(new RegExp(`"${name}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
  return match ? Number(match[1]) : 0;
};

export const extractCompleteComponents = (text: string): Partial<Component>[] => {
  const source = String(text || '');
  const propertyIndex = source.search(/"components"\s*:/);
  if (propertyIndex === -1) return [];
  const arrayStart = source.indexOf('[', propertyIndex);
  if (arrayStart === -1) return [];

  const components: Partial<Component>[] = [];
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

export const buildStreamingSpice = (
  text: string,
  prompt = '',
  existingCircuit: Circuit | null = null,
): StreamingSpiceResult => {
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
    notes: [] as string[],
  };
  const circuit = existingCircuit?.components?.length
    ? reconcileStreamingRevision(partialCircuit, existingCircuit, prompt)
    : normalizeAiCircuit(partialCircuit as Record<string, unknown>, prompt);

  return {
    componentCount: circuit.components.length,
    title: circuit.title,
    spice: toSpice(circuit),
  };
};

const reconcileStreamingRevision = (
  partialCircuit: { title: string; type: string; supplyVoltage: number; components: Partial<Component>[]; notes: string[] },
  existingCircuit: Circuit,
  prompt: string,
): Circuit => {
  if (partialCircuit.components.length === 0) return normalizeAiCircuit(existingCircuit as unknown as Record<string, unknown>, prompt);

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
  } as Record<string, unknown>, prompt, existingCircuit);
};
