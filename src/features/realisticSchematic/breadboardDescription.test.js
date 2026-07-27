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
    expect(describe_(dividerCircuit)).toContain('OK: wiring matches the netlist');
    expect(describe_(opampCircuit)).toContain('OK: wiring matches the netlist');
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

describe('microcontroller boards', () => {
  it('describes an MCU build and reports its connectivity as OK', () => {
    const circuit = {
      title: 'Uno blink',
      components: [
        {
          ref: 'U1',
          kind: 'arduino_uno',
          value: 'Uno R3',
          nodes: ['VCC5', 'NC_U1_2', '0', 'NC_U1_4', 'NC_U1_5', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8', 'NC_U1_9', 'NC_U1_10', 'NC_U1_11', 'NC_U1_12', 'NC_U1_13', 'NC_U1_14', 'NC_U1_15', 'NC_U1_16', 'NC_U1_17', 'LED', 'NC_U1_19', 'NC_U1_20', 'NC_U1_21', 'NC_U1_22', 'NC_U1_23', 'NC_U1_24'],
        },
        { ref: 'RLED', kind: 'resistor', value: '330', nodes: ['LED', 'LEDK'] },
        { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['LEDK', '0'] },
        { ref: 'R2', kind: 'resistor', value: '330', nodes: ['VCC5', '0'] },
      ],
    };
    const text = describeBreadboard(circuit, circuitToBreadboard(circuit));
    expect(text).toContain('U1  arduino_uno Uno R3  [off-board module — flying leads]');
    expect(text).toMatch(/pin18 \(D13\): LED/);
    expect(text).toMatch(/pin2 \(3V3\): not connected -> unplaced/);
    expect(text).toContain('OK: wiring matches the netlist (this checks connectivity only — see DESIGN RULE FINDINGS and WARNINGS for everything else).');
  });

  it('labels off-board modules instead of claiming a strip', () => {
    const circuit = {
      title: 'uno', type: 'test', supplyVoltage: 5,
      nodes: ['VCC', 'MID', '0'],
      components: [
        {
          ref: 'U1', kind: 'arduino_uno', value: 'arduino_uno', footprint: '',
          nodes: Array.from({ length: 24 }, (_, i) => (i === 0 ? 'VCC' : i === 2 ? '0' : `NC_U1_${i + 1}`)),
        },
        { ref: 'R1', kind: 'resistor', value: '330', nodes: ['VCC', 'MID'], footprint: '' },
        { ref: 'D1', kind: 'led', value: 'red', nodes: ['MID', '0'], footprint: '' },
      ],
    };
    const text = describe_(circuit);
    const u1Line = text.split('\n').find((line) => /^ {2}U1 {2}arduino_uno/.test(line));
    expect(u1Line).toMatch(/\[off-board module — flying leads\]/);
    expect(u1Line).not.toMatch(/on (top|bottom) strip/);
  });
});

describe('design rule findings section', () => {
  it('prints topology violations with severity tags', () => {
    // led with no series resistor: source -> LED -> ground
    const circuit = {
      title: 'bare led', type: 'test', supplyVoltage: 5,
      nodes: ['VCC', '0'],
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'], footprint: '' },
        { ref: 'D1', kind: 'led', value: 'red', nodes: ['VCC', '0'], footprint: '' },
      ],
    };
    const text = describeBreadboard(circuit, circuitToBreadboard(circuit));
    expect(text).toContain('== DESIGN RULE FINDINGS ==');
    expect(text).toContain('[error] led_no_series_resistor');
    expect(text).not.toMatch(/== DESIGN RULE FINDINGS ==\n\(none\)/);
  });

  it('prints (none) when no rules fire', () => {
    const circuit = {
      title: 'clean', type: 'test', supplyVoltage: 5,
      nodes: ['VCC', 'MID', '0'],
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'], footprint: '' },
        { ref: 'R1', kind: 'resistor', value: '330', nodes: ['VCC', 'MID'], footprint: '' },
        { ref: 'D1', kind: 'led', value: 'red', nodes: ['MID', '0'], footprint: '' },
      ],
    };
    const text = describeBreadboard(circuit, circuitToBreadboard(circuit));
    expect(text).toMatch(/== DESIGN RULE FINDINGS ==\n\(none\)/);
  });
});
