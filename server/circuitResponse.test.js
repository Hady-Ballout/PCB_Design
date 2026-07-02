import { describe, expect, it } from 'vitest';
import { buildCircuitResponse, normalizeAiCircuit, normalizeSchematicHints, reconcileCircuitRevision } from './circuitResponse.js';

const differenceAmplifier = {
  title: 'Difference Amplifier',
  type: 'amplifier',
  supplyVoltage: 5,
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
    { ref: 'V2', kind: 'voltage_source', value: '2.5V', nodes: ['VBIAS', '0'] },
    { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VINP', 'OPP'] },
    { ref: 'R2', kind: 'resistor', value: '10k', nodes: ['OPP', 'VBIAS'] },
    { ref: 'R3', kind: 'resistor', value: '10k', nodes: ['VINN', 'OPN'] },
    { ref: 'R4', kind: 'resistor', value: '10k', nodes: ['OPN', 'VBIAS'] },
    { ref: 'XU1', kind: 'opamp', value: 'LM358', nodes: ['OPP', 'OPN', 'VOUT', 'VCC', '0'] },
    { ref: 'RLOAD', kind: 'load', value: '10k', nodes: ['VOUT', '0'] },
  ],
  notes: [],
};

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

  it('normalizes schematic hints and ignores invalid refs or nets', () => {
    const normalized = normalizeAiCircuit({
      ...differenceAmplifier,
      schematic: {
        version: 1,
        topology: 'difference_amplifier',
        primaryRef: 'XU1',
        externalTerminals: [
          { net: 'VINP', label: 'V+', type: 'input', side: 'left' },
          { net: 'MISSING', label: 'BAD', type: 'input', side: 'left' },
        ],
        componentRoles: [
          { ref: 'XU1', role: 'primary', side: 'center' },
          { ref: 'NOPE', role: 'load', side: 'right' },
        ],
      },
    }, 'difference amplifier');

    expect(normalized.schematic).toMatchObject({
      version: 1,
      topology: 'difference_amplifier',
      primaryRef: 'XU1',
    });
    expect(normalized.schematic.externalTerminals.some((terminal) => terminal.net === 'MISSING')).toBe(false);
    expect(normalized.schematic.externalTerminals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ net: 'VINP', label: 'V+', type: 'input', side: 'left', explicit: true }),
        expect.objectContaining({ net: 'VINN', type: 'input', side: 'left', explicit: false }),
      ]),
    );
    expect(normalized.schematic.componentRoles.some((role) => role.ref === 'NOPE')).toBe(false);
  });

  it('derives schematic defaults for legacy circuit JSON', () => {
    const schematic = normalizeSchematicHints(differenceAmplifier);

    expect(schematic.primaryRef).toBe('XU1');
    expect(schematic.netRoles).toEqual(expect.arrayContaining([
      expect.objectContaining({ net: 'VOUT', role: 'output', side: 'right' }),
      expect.objectContaining({ net: '0', role: 'ground', side: 'bottom' }),
    ]));
    expect(schematic.externalTerminals).toEqual(expect.arrayContaining([
      expect.objectContaining({ net: 'VINP', type: 'input', side: 'left' }),
      expect.objectContaining({ net: 'VINN', type: 'input', side: 'left' }),
    ]));
  });

  it('returns a complete circuit response with physical schematic routing', () => {
    const response = buildCircuitResponse(
      differenceAmplifier,
      { rawPrompt: 'design a difference amplifier', type: 'amplifier' },
      'test',
    );

    expect(response.diagram.layoutMode).toBeUndefined();
    expect(response.diagram.netLabels).toHaveLength(0);
    expect(response.circuit.schematic.primaryRef).toBe('XU1');
    expect(response.diagram.ports.map((port) => port.net).sort()).toEqual(['VINN', 'VINP']);
    expect(response.diagram.wires.every((wire) => wire.points.length >= 2 && !wire.labelId)).toBe(true);
    expect(response.diagramSvg).toContain('<svg');
    expect(response.spice).toContain('XU1 OPP OPN VOUT VCC 0 LM358');
    expect(response.kicadNetlist).toContain('name="VBIAS"');
    expect(response.validation.ok).toBe(true);
  });
});
