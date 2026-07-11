import { describe, expect, it } from 'vitest';
import { buildSimNetlist, GROUND } from './simNetlist.js';

const circuitOf = (components) => ({ title: 'fixture', components });

const withSupply = (components) => [
  { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
  ...components,
];

describe('buildSimNetlist', () => {
  it('indexes ground as -1 and other nets from 0', () => {
    const netlist = buildSimNetlist(circuitOf(withSupply([
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCC', '0'] },
    ])));
    expect(netlist.ok).toBe(true);
    expect(netlist.nodeIndex.has('0')).toBe(false);
    expect(netlist.nodeIndex.get('VCC')).toBe(0);
    const source = netlist.devices.find((device) => device.id === 'V1');
    expect(source.nm).toBe(GROUND);
  });

  it('expands a potentiometer into two wiper halves', () => {
    const netlist = buildSimNetlist(circuitOf(withSupply([
      { ref: 'RV1', kind: 'potentiometer', value: '10k', nodes: ['VCC', 'W', '0'] },
    ])));
    const halves = netlist.devices.filter((device) => device.owner === 'RV1');
    expect(halves.map((device) => device.id)).toEqual(['RV1_A', 'RV1_B']);
    expect(halves[0].params.total).toBe(10000);
    expect(netlist.controls).toContainEqual(expect.objectContaining({ ref: 'RV1', name: 'wiper', value: 0.5 }));
  });

  it('skips compound legs on unconnected pins, like toSpice', () => {
    const netlist = buildSimNetlist(circuitOf(withSupply([
      { ref: 'BR1', kind: 'bridge_rectifier', value: '', nodes: ['AC1', 'NC_BR1_2', 'VP', '0'] },
      { ref: 'D2', kind: 'rgb_led', value: '', nodes: ['VCC', 'NC_D2_2', 'NC_D2_3', '0'] },
      { ref: 'CS1', kind: 'current_sensor', value: '', nodes: ['NC_CS1_1', 'X', 'VCC', 'OUT', '0'] },
    ])));
    const bridgeLegs = netlist.devices.filter((device) => device.owner === 'BR1' && device.type === 'diode');
    expect(bridgeLegs.map((device) => device.id).sort()).toEqual(['BR1_A', 'BR1_C']);
    const rgbLegs = netlist.devices.filter((device) => device.owner === 'D2' && device.type === 'diode');
    expect(rgbLegs.map((device) => device.channel)).toEqual(['R']);
    expect(netlist.devices.some((device) => device.id === 'CS1_S')).toBe(false);
  });

  it('externalizes diode series resistance onto an internal node', () => {
    const netlist = buildSimNetlist(circuitOf(withSupply([
      { ref: 'D1', kind: 'led', value: 'red', nodes: ['VCC', '0'] },
    ])));
    const rs = netlist.devices.find((device) => device.id === 'D1__rs');
    const junction = netlist.devices.find((device) => device.id === 'D1' && device.type === 'diode');
    expect(rs.ohms).toBe(10);
    expect(junction.model.n).toBe(2);
    expect(netlist.nodeIndex.has('__int_D1')).toBe(true);
  });

  it('flags MCU boards and deferred kinds without dropping the rest', () => {
    const netlist = buildSimNetlist(circuitOf(withSupply([
      { ref: 'U1', kind: 'esp32', value: '', nodes: Array.from({ length: 12 }, (_, i) => `NC_U1_${i + 1}`) },
      { ref: 'Q1', kind: 'bjt_npn', value: '', nodes: ['A', 'B', 'C'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCC', '0'] },
    ])));
    expect(netlist.ok).toBe(true);
    expect(netlist.warnings.some((w) => w.code === 'mcu_not_simulated')).toBe(true);
    expect(netlist.warnings.some((w) => w.code === 'kind_not_simulated' && w.message.startsWith('Q1'))).toBe(true);
    expect(netlist.devices.some((device) => device.owner === 'R1')).toBe(true);
  });

  it('maps the zener breakdown voltage from its value', () => {
    const netlist = buildSimNetlist(circuitOf(withSupply([
      { ref: 'D1', kind: 'zener', value: '9.1V', nodes: ['VCC', '0'] },
    ])));
    const junction = netlist.devices.find((device) => device.owner === 'D1' && device.type === 'diode');
    expect(junction.model.bv).toBe(9.1);
  });
});
