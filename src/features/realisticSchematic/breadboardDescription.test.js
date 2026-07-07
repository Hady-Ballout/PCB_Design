import { describe, expect, it } from 'vitest';
import { circuitToBreadboard } from './breadboardModel.js';
import { describeBreadboard } from './breadboardDescription.js';

const dividerCircuit = {
  title: 'Voltage divider',
  supplyVoltage: 5,
  nodes: ['VCC', 'VOUT', '0'],
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
    { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCC', 'VOUT'] },
    { ref: 'R2', kind: 'resistor', value: '1k', nodes: ['VOUT', '0'] },
  ],
};

const opampCircuit = {
  title: 'Buffer',
  nodes: ['VIN', 'VOUT', 'VCC', '0'],
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '9V', nodes: ['VCC', '0'] },
    { ref: 'XU1', kind: 'opamp', value: 'LM358', nodes: ['VIN', 'VOUT', 'VOUT', 'VCC', '0'] },
    { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VIN', '0'] },
  ],
};

const describe_ = (circuit) => describeBreadboard(circuit, circuitToBreadboard(circuit));

describe('describeBreadboard', () => {
  it('reports title, supply, netlist, and nets', () => {
    const text = describe_(dividerCircuit);
    expect(text).toContain('Title: Voltage divider');
    expect(text).toContain('Supply voltage: 5 V');
    expect(text).toContain('R1  resistor 1k  nodes: VCC, VOUT');
    // VOUT is shared by R1.2 and R2.1.
    expect(text).toMatch(/VOUT.*: R1\.2, R2\.1/);
  });

  it('describes rails, batteries, parts, and jumpers with hole addresses', () => {
    const text = describe_(dividerCircuit);
    expect(text).toContain('TOP+ rail = VCC');
    expect(text).toContain('TOP- rail = 0 (GND)');
    expect(text).toMatch(/V1 5V: \+ -> VCC @ TOP\+ rail col\d+/);
    // Terminal-strip holes read as "<row letter><column>", e.g. a2.
    expect(text).toMatch(/pin1: VCC -> [a-j]\d+/);
  });

  it('passes the connectivity check for a well-formed build', () => {
    expect(describe_(dividerCircuit)).toContain('OK: every net is one connected node');
    expect(describe_(opampCircuit)).toContain('OK: every net is one connected node');
  });

  it('labels op-amp pins by function', () => {
    const text = describe_(opampCircuit);
    expect(text).toContain('(IN+)');
    expect(text).toContain('(OUT)');
    expect(text).toContain('(V-)');
  });

  it('flags a net split across two unconnected nodes', () => {
    // Two parts share net N but sit on different tie groups with no jumper
    // tying them together: the connectivity check must catch the break.
    const circuit = {
      title: 'Broken',
      components: [
        { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['A', 'N'] },
        { ref: 'R2', kind: 'resistor', value: '1k', nodes: ['N', 'B'] },
      ],
    };
    const broken = {
      board: { columns: 30, width: 500, height: 315 },
      rails: {},
      parts: [
        { ref: 'R1', kind: 'resistor', value: '1k', body: 'twoLead', strip: 'top', pinNets: ['A', 'N'], holes: [{ strip: 'top', column: 2, row: 0 }, { strip: 'top', column: 5, row: 0 }] },
        { ref: 'R2', kind: 'resistor', value: '1k', body: 'twoLead', strip: 'top', pinNets: ['N', 'B'], holes: [{ strip: 'top', column: 10, row: 0 }, { strip: 'top', column: 13, row: 0 }] },
      ],
      batteries: [],
      jumpers: [],
      netGroups: {},
      nets: [],
      warnings: [],
    };
    const text = describeBreadboard(circuit, broken);
    expect(text).toMatch(/SPLIT: net N/);
  });

  it('marks unconnected pins', () => {
    const circuit = {
      title: 'Dangling LED',
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
        { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['VCC', 'NC_DLED1_2'] },
      ],
    };
    const text = describeBreadboard(circuit, circuitToBreadboard(circuit));
    expect(text).toMatch(/not connected/);
  });
});
