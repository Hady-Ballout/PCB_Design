import { describe, expect, it } from 'vitest';
import { reconcileCircuitRevision } from './circuitResponse.js';

describe('circuit revisions', () => {
  it('preserves existing component identity and footprint during a follow-up edit', () => {
    const existing = {
      title: 'Low Pass Filter',
      type: 'low_pass',
      supplyVoltage: 5,
      nodes: ['IN', 'OUT', '0'],
      components: [
        { ref: 'V1', kind: 'signal_source', value: 'SINE(0 1 100)', nodes: ['IN', '0'], footprint: 'Source:Existing' },
        { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['IN', 'OUT'], footprint: 'Resistor:Existing' },
      ],
      notes: [],
    };
    const aiRevision = {
      ...existing,
      components: [
        { ...existing.components[0], footprint: '' },
        { ...existing.components[1], footprint: '' },
        { ref: 'RLOAD', kind: 'load', value: '12k', nodes: ['OUT', '0'], footprint: 'Resistor:Load' },
      ],
    };

    const revised = reconcileCircuitRevision(aiRevision, 'Add a 12k load', existing);

    expect(revised.components).toHaveLength(3);
    expect(revised.components.find((part) => part.ref === 'R1').footprint).toBe('Resistor:Existing');
    expect(revised.components.find((part) => part.ref === 'RLOAD')).toMatchObject({ value: '12k', nodes: ['OUT', '0'] });
  });
});
