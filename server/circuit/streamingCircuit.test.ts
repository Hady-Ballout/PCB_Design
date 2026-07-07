import { describe, expect, it } from 'vitest';
import { buildStreamingSpice, extractCompleteComponents } from './streamingCircuit.js';
import type { Circuit } from '../types.js';

describe('streaming circuit helpers', () => {
  it('extracts only complete component objects from partial AI JSON', () => {
    const partial = '{"title":"RC Filter","components":['
      + '{"ref":"R1","kind":"resistor","value":"1k","nodes":["IN","OUT"],"footprint":"R"},'
      + '{"ref":"C1","kind":"capacitor","value":"100nF","nodes":["OUT"';

    expect(extractCompleteComponents(partial)).toEqual([
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['IN', 'OUT'], footprint: 'R' },
    ]);
  });

  it('builds a progressively expanding SPICE deck', () => {
    const first = '{"title":"RC Filter","type":"low_pass","supplyVoltage":5,"components":['
      + '{"ref":"V1","kind":"signal_source","value":"SINE(0 1 1k)","nodes":["IN","0"],"footprint":""}';
    const second = `${first},{"ref":"R1","kind":"resistor","value":"1k","nodes":["IN","OUT"],"footprint":""}`;

    expect(buildStreamingSpice(first).spice).toContain('V1 IN 0 SINE(0 1 1k)');
    expect(buildStreamingSpice(second)).toMatchObject({ componentCount: 2, title: 'RC Filter' });
    expect(buildStreamingSpice(second).spice).toContain('R1 IN OUT 1k');
  });

  it('builds a progressive SPICE deck from the AI response envelope', () => {
    const first = '{"circuit":{"title":"RC Filter","type":"low_pass","supplyVoltage":5,"components":['
      + '{"ref":"V1","kind":"signal_source","value":"SINE(0 1 1k)","nodes":["IN","0"],"footprint":""}';
    const second = `${first},{"ref":"R1","kind":"resistor","value":"1k","nodes":["IN","OUT"],"footprint":""}`;

    expect(buildStreamingSpice(first).spice).toContain('V1 IN 0 SINE(0 1 1k)');
    expect(buildStreamingSpice(second)).toMatchObject({ componentCount: 2, title: 'RC Filter' });
    expect(buildStreamingSpice(second).spice).toContain('R1 IN OUT 1k');
  });

  it('edits an existing streamed circuit instead of starting from an empty deck', () => {
    const existing: Circuit = {
      title: 'Existing filter',
      type: 'low_pass',
      supplyVoltage: 5,
      nodes: ['IN', 'OUT', '0'],
      components: [
        { ref: 'V1', kind: 'signal_source', value: 'SINE(0 1 100)', nodes: ['IN', '0'], footprint: '' },
        { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['IN', 'OUT'], footprint: '' },
      ],
      notes: [],
    };
    const partial = '{"title":"Existing filter","type":"low_pass","components":['
      + '{"ref":"RLOAD","kind":"load","value":"12k","nodes":["OUT","0"],"footprint":""}';

    const revision = buildStreamingSpice(partial, 'Add a load', existing);

    expect(revision.spice).toContain('V1 IN 0 SINE(0 1 100)');
    expect(revision.spice).toContain('R1 IN OUT 1k');
    expect(revision.spice).toContain('RLOAD OUT 0 12k');
  });
});
