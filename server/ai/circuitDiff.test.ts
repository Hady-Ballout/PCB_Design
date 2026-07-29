import { describe, expect, it } from 'vitest';
import { describeCircuitDiff, diffCircuits } from './circuitDiff.js';
import type { Circuit } from '../types.js';

const makeCircuit = (components: Array<Record<string, unknown>>): Circuit => ({
  title: 'Divider',
  type: 'voltage_divider',
  supplyVoltage: 5,
  nodes: ['VIN', 'OUT', '0'],
  components: components as unknown as Circuit['components'],
  notes: [],
});

const baseComponents = [
  { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VIN', 'OUT'], footprint: 'Resistor_THT:R_Axial' },
  { ref: 'R2', kind: 'resistor', value: '3.9k', nodes: ['OUT', '0'], footprint: 'Resistor_THT:R_Axial' },
];

describe('diffCircuits', () => {
  it('marks everything as a new build when there is no previous circuit', () => {
    const diff = diffCircuits(null, makeCircuit(baseComponents));

    expect(diff.isNewBuild).toBe(true);
    expect(diff.added).toHaveLength(2);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
  });

  it('buckets added, removed, and changed components by ref', () => {
    const previous = makeCircuit(baseComponents);
    const next = makeCircuit([
      { ref: 'R1', kind: 'resistor', value: '2.2k', nodes: ['VIN', 'OUT'], footprint: 'Resistor_THT:R_Axial' },
      { ref: 'C1', kind: 'capacitor', value: '100n', nodes: ['OUT', '0'], footprint: 'Capacitor_THT:C_Disc' },
    ]);

    const diff = diffCircuits(previous, next);

    expect(diff.isNewBuild).toBe(false);
    expect(diff.added.map((part) => part.ref)).toEqual(['C1']);
    expect(diff.removed.map((part) => part.ref)).toEqual(['R2']);
    expect(diff.changed).toEqual([
      expect.objectContaining({ ref: 'R1', fields: ['value'] }),
    ]);
  });

  it('detects kind and node changes as changed fields', () => {
    const previous = makeCircuit([baseComponents[0]]);
    const next = makeCircuit([
      { ref: 'R1', kind: 'thermistor', value: '1k', nodes: ['VIN', '0'], footprint: 'Resistor_THT:R_Axial' },
    ]);

    const diff = diffCircuits(previous, next);

    expect(diff.changed[0].fields).toEqual(['kind', 'nodes']);
  });

  it('ignores footprint-only deltas and value case/whitespace differences', () => {
    const previous = makeCircuit(baseComponents);
    const next = makeCircuit([
      { ref: 'R1', kind: 'resistor', value: ' 1K ', nodes: ['VIN', 'OUT'], footprint: '' },
      { ref: 'R2', kind: 'resistor', value: '3.9k', nodes: ['OUT', '0'], footprint: 'Other:Footprint' },
    ]);

    const diff = diffCircuits(previous, next);

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(diff.unchangedRefs).toEqual(['R1', 'R2']);
  });

  it('matches refs case-insensitively', () => {
    const previous = makeCircuit([{ ...baseComponents[0], ref: 'r1' }]);
    const next = makeCircuit([baseComponents[0]]);

    const diff = diffCircuits(previous, next);

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.unchangedRefs).toEqual(['R1']);
  });
});

describe('describeCircuitDiff', () => {
  it('describes a brand-new design', () => {
    const text = describeCircuitDiff(diffCircuits(null, makeCircuit(baseComponents)));

    expect(text).toContain('brand-new design');
    expect(text).not.toContain('Unchanged');
  });

  it('describes an unchanged design explicitly', () => {
    const circuit = makeCircuit(baseComponents);

    expect(describeCircuitDiff(diffCircuits(circuit, circuit))).toContain('unchanged from the previous turn');
  });

  it('narrates added, changed, and removed refs with the untouched remainder', () => {
    const previous = makeCircuit(baseComponents);
    const next = makeCircuit([
      { ref: 'R1', kind: 'resistor', value: '2.2k', nodes: ['VIN', 'OUT'], footprint: '' },
      { ref: 'R2', kind: 'resistor', value: '3.9k', nodes: ['OUT', '0'], footprint: '' },
      { ref: 'C1', kind: 'capacitor', value: '100n', nodes: ['OUT', '0'], footprint: '' },
    ]);

    const text = describeCircuitDiff(diffCircuits(previous, next));

    expect(text).toContain('Added: C1 (capacitor 100n, nodes OUT-0)');
    expect(text).toContain('Changed: R1 value 1k -> 2.2k');
    expect(text).toContain('Unchanged: 1 component (R2)');
  });

  it('caps long buckets with a remainder count and bounds total length', () => {
    const previous = makeCircuit([]);
    const many = Array.from({ length: 20 }, (_, index) => ({
      ref: `R${index + 1}`,
      kind: 'resistor',
      value: '1k',
      nodes: ['A', 'B'],
      footprint: '',
    }));
    const withPrevious = makeCircuit([{ ref: 'X1', kind: 'resistor', value: '1k', nodes: ['A', 'B'], footprint: '' }]);

    const text = describeCircuitDiff(diffCircuits(withPrevious, makeCircuit(many)));

    expect(text).toContain('and 8 more');
    expect(text.length).toBeLessThanOrEqual(2500);
  });
});
