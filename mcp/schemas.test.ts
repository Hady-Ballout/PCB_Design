import { describe, expect, it } from 'vitest';
import { circuitSchema } from './schemas.js';

const minimal = {
  title: 'RC low-pass',
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VIN', '0'] },
    { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VIN', 'VOUT'] },
    { ref: 'C1', kind: 'capacitor', value: '100nF', nodes: ['VOUT', '0'] },
  ],
};

describe('circuitSchema', () => {
  it('fills the fields core modules require but callers usually omit', () => {
    const circuit = circuitSchema.parse(minimal);

    expect(circuit.type).toBe('ai_generated');
    expect(circuit.supplyVoltage).toBe(5);
    expect(circuit.notes).toEqual([]);
    expect(circuit.components[0].footprint).toBe('');
  });

  it('derives the node list from the components when omitted', () => {
    const circuit = circuitSchema.parse(minimal);

    expect(circuit.nodes.sort()).toEqual(['0', 'VIN', 'VOUT']);
  });

  it('rejects a component kind outside the registry', () => {
    const result = circuitSchema.safeParse({
      ...minimal,
      components: [{ ref: 'U1', kind: 'flux_capacitor', value: '1.21GW', nodes: ['A', '0'] }],
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('flux_capacitor');
  });

  it('rejects a component with no nodes', () => {
    const result = circuitSchema.safeParse({
      ...minimal,
      components: [{ ref: 'R1', kind: 'resistor', value: '1k', nodes: [] }],
    });

    expect(result.success).toBe(false);
  });

  it('preserves an explicitly supplied supplyVoltage and notes', () => {
    const circuit = circuitSchema.parse({ ...minimal, supplyVoltage: 12, notes: ['bench supply'] });

    expect(circuit.supplyVoltage).toBe(12);
    expect(circuit.notes).toEqual(['bench supply']);
  });
});
