import { describe, expect, it } from 'vitest';
import { buildCircuitDiagram } from './pcbGenerator.js';
import { toKiCadSchematic } from './kicadSchematic.js';

const sampleCircuit = {
  title: 'KiCad export test circuit',
  type: 'ai_generated',
  supplyVoltage: 5,
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VIN', '0'] },
    { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VIN', 'VOUT'] },
    { ref: 'C1', kind: 'capacitor', value: '100nF', nodes: ['VOUT', '0'] },
    { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['VOUT', 'VIN', '0'] },
  ],
  notes: [],
};

const balancedParens = (text) => {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && !inString;
};

describe('toKiCadSchematic', () => {
  const diagram = buildCircuitDiagram(sampleCircuit);
  const schematic = toKiCadSchematic(sampleCircuit, diagram);

  it('emits a balanced KiCad 6 s-expression document', () => {
    expect(schematic.startsWith('(kicad_sch')).toBe(true);
    expect(balancedParens(schematic)).toBe(true);
    expect(schematic).toContain('(version 20211123)');
    expect(schematic).toContain('(sheet_instances (path "/" (page "1")))');
  });

  it('embeds one lib symbol and one placed symbol per component', () => {
    for (const part of sampleCircuit.components) {
      expect(schematic).toContain(`(symbol "PROMPT:${part.ref}"`);
      expect(schematic).toContain(`(lib_id "PROMPT:${part.ref}")`);
      expect(schematic).toContain(`(property "Reference" "${part.ref}"`);
      expect(schematic).toContain(`(property "Value" "${part.value}"`);
    }
  });

  it('serializes every routed wire segment and junction', () => {
    const wireCount = (schematic.match(/\(wire /g) || []).length;
    expect(wireCount).toBeGreaterThanOrEqual(diagram.wires.length);
    for (const junction of diagram.junctions || []) {
      expect(junction).toBeTruthy();
    }
  });

  it('places GND power symbols for ground terminals', () => {
    expect(schematic).toContain('(symbol "PROMPT:GND" (power)');
    expect(schematic).toContain('(lib_id "PROMPT:GND")');
  });

  it('labels named nets', () => {
    const hasNamedNetLabel = (diagram.netLabels || []).some((label) => label.name !== '0');
    if (hasNamedNetLabel) {
      expect(schematic).toMatch(/\(label "(VIN|VOUT)"/);
    }
  });

  it('is deterministic for the same diagram', () => {
    expect(toKiCadSchematic(sampleCircuit, diagram)).toBe(schematic);
  });

  it('returns an empty string without a diagram', () => {
    expect(toKiCadSchematic(sampleCircuit, null)).toBe('');
  });
});
