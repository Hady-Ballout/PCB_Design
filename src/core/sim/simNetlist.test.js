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

  it('emits the IR phototransistor as a slider-driven variable resistor', () => {
    const netlist = buildSimNetlist(circuitOf(withSupply([
      { ref: 'R2', kind: 'ir_phototransistor', value: '', nodes: ['VCC', 'OUT'] },
      { ref: 'R3', kind: 'resistor', value: '10k', nodes: ['OUT', '0'] },
    ])));
    expect(netlist.ok).toBe(true);
    expect(netlist.devices.find((device) => device.id === 'R2')).toMatchObject({
      type: 'vres', model: 'ir_phototransistor',
    });
    expect(netlist.controls).toContainEqual(expect.objectContaining({
      ref: 'R2', type: 'slider', name: 'ir', value: 0.1, label: 'IR light',
    }));
    expect(netlist.warnings.some((w) => w.code === 'kind_not_simulated')).toBe(false);
  });

  it('emits the IR emitter LED as a diode with the low-Vf DIR model', () => {
    const netlist = buildSimNetlist(circuitOf(withSupply([
      { ref: 'D1', kind: 'ir_led', value: '940nm', nodes: ['VCC', '0'] },
    ])));
    expect(netlist.ok).toBe(true);
    const junction = netlist.devices.find((device) => device.id === 'D1' && device.type === 'diode');
    expect(junction.model).toMatchObject({ is: 1e-18, n: 1.4 });
    // Series resistance externalized like every other diode kind.
    expect(netlist.devices.find((device) => device.id === 'D1__rs').ohms).toBe(6);
    expect(netlist.warnings.some((w) => w.code === 'kind_not_simulated')).toBe(false);
  });

  it('models the buck converter as an ideal source on its OUT (switch) pin', () => {
    const netlist = buildSimNetlist(circuitOf(withSupply([
      { ref: 'U1', kind: 'buck_converter', value: 'LM2596-5.0', nodes: ['VCC', 'SW', '0', 'VOUT', '0'] },
    ])));
    expect(netlist.ok).toBe(true);
    const source = netlist.devices.find((device) => device.id === 'U1' && device.type === 'vsource');
    expect(source.np).toBe(netlist.nodeIndex.get('SW'));
    expect(source.nm).toBe(GROUND);
    expect(source.vnom).toBe(5);
    expect(source.headroom).toBe(2);
    expect(source.inNode).toBe(netlist.nodeIndex.get('VCC'));
    expect(netlist.warnings.some((w) => w.code === 'buck_unpowered')).toBe(false);
  });

  it('warns and drops inNode when the buck converter has no input supply wired', () => {
    const netlist = buildSimNetlist(circuitOf([
      { ref: 'U1', kind: 'buck_converter', value: 'LM2596-5.0', nodes: ['NC_U1_1', 'SW', '0', 'NC_U1_4', 'NC_U1_5'] },
    ]));
    expect(netlist.ok).toBe(true);
    const source = netlist.devices.find((device) => device.id === 'U1' && device.type === 'vsource');
    expect(source.inNode).toBe(null);
    expect(source.vnom).toBe(5);
    expect(netlist.warnings.some((w) => w.code === 'buck_unpowered')).toBe(true);
  });

  it('flags MCU boards without dropping the rest; active kinds simulate', () => {
    const netlist = buildSimNetlist(circuitOf(withSupply([
      { ref: 'U1', kind: 'esp32', value: '', nodes: Array.from({ length: 12 }, (_, i) => `NC_U1_${i + 1}`) },
      { ref: 'Q1', kind: 'bjt_npn', value: '', nodes: ['A', 'B', 'C'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCC', '0'] },
    ])));
    expect(netlist.ok).toBe(true);
    expect(netlist.warnings.some((w) => w.code === 'mcu_not_simulated')).toBe(true);
    // BJTs came off the deferred list in M3 — Q1 is a real device now.
    expect(netlist.warnings.some((w) => w.code === 'kind_not_simulated')).toBe(false);
    expect(netlist.devices.find((device) => device.owner === 'Q1')).toMatchObject({ type: 'bjt', polarity: 1 });
    expect(netlist.devices.some((device) => device.owner === 'R1')).toBe(true);
  });

  it('gives Tier-2a sensors controls and one branch per connected output', () => {
    const netlist = buildSimNetlist(circuitOf(withSupply([
      { ref: 'T1', kind: 'temp_sensor', value: '', nodes: ['VCC', 'VT', '0'] },
      { ref: 'G1', kind: 'gas_sensor', value: '', nodes: ['VCC', '0', 'VDO', 'NC_G1_4'] },
      { ref: 'H1', kind: 'hall_sensor', value: '', nodes: ['VCC', '0', 'VH'] },
    ])));
    expect(netlist.ok).toBe(true);
    expect(netlist.devices.find((d) => d.id === 'T1_OUT')).toMatchObject({ type: 'sensor_source', law: 'tmp36' });
    // Gas: DO connected → branch; AO unconnected → no branch.
    expect(netlist.devices.some((d) => d.id === 'G1_DO')).toBe(true);
    expect(netlist.devices.some((d) => d.id === 'G1_AO')).toBe(false);
    expect(netlist.devices.find((d) => d.id === 'H1_OC')).toMatchObject({ type: 'vres', model: 'hall_switch' });
    expect(netlist.controls).toContainEqual(expect.objectContaining({ ref: 'T1', type: 'slider', name: 'tempC', value: 25 }));
    expect(netlist.controls).toContainEqual(expect.objectContaining({ ref: 'H1', type: 'toggle', name: 'magnet' }));
    // None of these warn as unsimulated modules.
    expect(netlist.warnings.some((w) => w.code === 'module_not_simulated')).toBe(false);
  });

  it('emits the ULN2003 as a four-channel event switch with input ties', () => {
    const netlist = buildSimNetlist(circuitOf(withSupply([
      // [IN1..IN4, VCC, GND, OUTA..OUTD] — only channel 1 wired.
      {
        ref: 'U2', kind: 'stepper_driver', value: '',
        nodes: ['VIN1', 'NC_U2_2', 'NC_U2_3', 'NC_U2_4', 'VCC', '0', 'VOUTA', 'NC_U2_8', 'NC_U2_9', 'NC_U2_10'],
      },
    ])));
    expect(netlist.ok).toBe(true);
    const record = netlist.devices.find((device) => device.id === 'U2');
    expect(record).toMatchObject({ type: 'stepper_driver', state: { on: [false, false, false, false] } });
    expect(record.in[0]).not.toBeNull();
    expect(record.in[1]).toBeNull();
    expect(record.out[0]).not.toBeNull();
    expect(record.out[1]).toBeNull();
    // Input tie only on the connected IN.
    expect(netlist.devices.some((device) => device.id === 'U2__tin1')).toBe(true);
    expect(netlist.devices.some((device) => device.id === 'U2__tin2')).toBe(false);
    expect(netlist.warnings.some((w) => w.code === 'module_not_simulated')).toBe(false);
  });

  it('emits stepper motor coils plus a stamp-less shaft tracker', () => {
    const netlist = buildSimNetlist(circuitOf(withSupply([
      // [A, B, C, D, COM] — coil D left unwired.
      { ref: 'M1', kind: 'stepper_motor', value: '', nodes: ['VA', 'VB', 'VC', 'NC_M1_4', 'VCC'] },
    ])));
    expect(netlist.ok).toBe(true);
    const coils = netlist.devices.filter((device) => device.owner === 'M1' && device.type === 'resistor');
    expect(coils.map((device) => device.id)).toEqual(['M1_A', 'M1_B', 'M1_C']);
    expect(coils[0].ohms).toBe(50);
    const tracker = netlist.devices.find((device) => device.id === 'M1_TRK');
    expect(tracker).toMatchObject({ type: 'stepper_motor', state: { patternIndex: null, halfSteps: 0 } });
    expect(tracker.coils[3]).toBeNull();
    expect(netlist.warnings.some((w) => w.code === 'module_not_simulated')).toBe(false);
  });

  it('emits the L298N with unwired enables defaulting to on', () => {
    const nodes = ['VS', '0', 'NC_U3_3', 'VIN1', 'VIN2', 'NC_U3_6', 'NC_U3_7', 'NC_U3_8', 'VO1', 'VO2', 'NC_U3_11', 'NC_U3_12'];
    const netlist = buildSimNetlist(circuitOf(withSupply([
      { ref: 'U3', kind: 'motor_driver', value: '', nodes },
    ])));
    expect(netlist.ok).toBe(true);
    const record = netlist.devices.find((device) => device.id === 'U3');
    expect(record).toMatchObject({ type: 'motor_driver' });
    expect(record.channels[0].enConnected).toBe(false);
    expect(record.channels[0].outA).not.toBeNull();
    expect(record.channels[1].inA).toBeNull();
    // Quiescent VS load present; no tie for the unwired ENA.
    expect(netlist.devices.some((device) => device.id === 'U3__q')).toBe(true);
    expect(netlist.devices.some((device) => device.id === 'U3__t3')).toBe(false);
    expect(netlist.devices.some((device) => device.id === 'U3__t4')).toBe(true);
    expect(netlist.warnings.some((w) => w.code === 'module_not_simulated')).toBe(false);
  });

  it('gives the joystick two axis sources, a stick switch, and controls', () => {
    const netlist = buildSimNetlist(circuitOf(withSupply([
      // [GND, VCC, VRX, VRY, SW] — VRY left unwired.
      { ref: 'J1', kind: 'joystick', value: '', nodes: ['0', 'VCC', 'VX', 'NC_J1_4', 'VSW'] },
    ])));
    expect(netlist.ok).toBe(true);
    expect(netlist.devices.find((d) => d.id === 'J1_VRX')).toMatchObject({ type: 'sensor_source', law: 'joystick_axis', stimulusName: 'x' });
    expect(netlist.devices.some((d) => d.id === 'J1_VRY')).toBe(false);
    expect(netlist.devices.find((d) => d.id === 'J1_SW')).toMatchObject({ type: 'vres', model: 'joystick_sw' });
    expect(netlist.controls).toContainEqual(expect.objectContaining({ ref: 'J1', type: 'slider', name: 'x', value: 0.5 }));
    expect(netlist.controls).toContainEqual(expect.objectContaining({ ref: 'J1', type: 'momentary', name: 'sw' }));
    expect(netlist.warnings.some((w) => w.code === 'module_not_simulated')).toBe(false);
  });

  it('attaches the IR receiver to a firmware Uno with remote-key controls', () => {
    const unoNodes = ['NC_U1_1', 'NC_U1_2', '0', ...Array.from({ length: 21 }, (_, i) => `NC_U1_${i + 4}`)];
    unoNodes[6] = 'VIR'; // D2
    const netlist = buildSimNetlist(circuitOf([
      { ref: 'U1', kind: 'arduino_uno', value: '', nodes: unoNodes },
      // [OUT, GND, VCC]
      { ref: 'IR1', kind: 'ir_receiver', value: '', nodes: ['VIR', '0', 'NC_IR1_3'] },
    ]), { mcuRef: 'U1' });
    expect(netlist.ok).toBe(true);
    const record = netlist.devices.find((device) => device.id === 'IR1');
    expect(record).toMatchObject({ type: 'avr_peripheral', pins: { OUT: 'D2' }, ownedPins: ['D2'] });
    // 9 remote keys + the display branch for the module-driven OUT.
    expect(netlist.controls.filter((c) => c.ref === 'IR1' && c.type === 'ir-key')).toHaveLength(9);
    expect(netlist.devices.some((device) => device.id === 'IR1_OUT')).toBe(true);
    expect(netlist.warnings.some((w) => w.code === 'module_not_simulated')).toBe(false);
  });

  it('keeps the IR receiver wiring-only without a firmware Uno', () => {
    const netlist = buildSimNetlist(circuitOf(withSupply([
      { ref: 'IR1', kind: 'ir_receiver', value: '', nodes: ['VIR', '0', 'VCC'] },
    ])));
    expect(netlist.warnings.some((w) => w.code === 'module_not_simulated')).toBe(true);
  });

  it('attaches the RC522 only on the hardware SPI pins (SDA as CS)', () => {
    const unoNodes = (assignments) => {
      const nodes = ['NC_U1_1', 'NC_U1_2', '0', ...Array.from({ length: 21 }, (_, i) => `NC_U1_${i + 4}`)];
      for (const [pin, net] of Object.entries(assignments)) {
        nodes[4 + Number(pin.slice(1))] = net;
      }
      return nodes;
    };
    // [3V3, RST, GND, IRQ, MISO, MOSI, SCK, SDA]
    const rfidNodes = ['NC_RF1_1', 'NC_RF1_2', '0', 'NC_RF1_4', 'VMISO', 'VMOSI', 'VSCK', 'VSDA'];
    const wired = buildSimNetlist(circuitOf([
      { ref: 'U1', kind: 'arduino_uno', value: '', nodes: unoNodes({ D10: 'VSDA', D11: 'VMOSI', D12: 'VMISO', D13: 'VSCK' }) },
      { ref: 'RF1', kind: 'rfid_reader', value: '', nodes: rfidNodes },
    ]), { mcuRef: 'U1' });
    expect(wired.devices.find((d) => d.id === 'RF1')).toMatchObject({
      type: 'avr_peripheral',
      pins: { SDA: 'D10', MOSI: 'D11', MISO: 'D12', SCK: 'D13' },
    });
    expect(wired.controls).toContainEqual(expect.objectContaining({ ref: 'RF1', type: 'button', name: 'tap' }));
    expect(wired.warnings.some((w) => w.code === 'module_not_simulated')).toBe(false);

    // MOSI landing anywhere but D11 breaks the hardware-SPI gate.
    const scrambled = buildSimNetlist(circuitOf([
      { ref: 'U1', kind: 'arduino_uno', value: '', nodes: unoNodes({ D10: 'VSDA', D9: 'VMOSI', D12: 'VMISO', D13: 'VSCK' }) },
      { ref: 'RF1', kind: 'rfid_reader', value: '', nodes: rfidNodes },
    ]), { mcuRef: 'U1' });
    expect(scrambled.warnings.some((w) => w.code === 'module_not_simulated')).toBe(true);
  });

  it('attaches the PMW3360 on the hardware SPI pins with trackpad controls', () => {
    const unoNodes = (assignments) => {
      const nodes = ['NC_U1_1', 'NC_U1_2', '0', ...Array.from({ length: 21 }, (_, i) => `NC_U1_${i + 4}`)];
      for (const [pin, net] of Object.entries(assignments)) {
        nodes[4 + Number(pin.slice(1))] = net;
      }
      return nodes;
    };
    // [RST, GND, MOT, NCS, SCK, MOSI, MISO, VCC]
    const mouseNodes = ['NC_M1_1', '0', 'VMOT', 'VNCS', 'VSCK', 'VMOSI', 'VMISO', 'NC_M1_8'];
    const wired = buildSimNetlist(circuitOf([
      { ref: 'U1', kind: 'arduino_uno', value: '', nodes: unoNodes({ D2: 'VMOT', D10: 'VNCS', D11: 'VMOSI', D12: 'VMISO', D13: 'VSCK' }) },
      { ref: 'M1', kind: 'mouse_sensor', value: '', nodes: mouseNodes },
    ]), { mcuRef: 'U1' });
    expect(wired.devices.find((d) => d.id === 'M1')).toMatchObject({
      type: 'avr_peripheral',
      pins: { NCS: 'D10', MOSI: 'D11', MISO: 'D12', SCK: 'D13', MOT: 'D2' },
      ownedPins: ['D2'],
    });
    expect(wired.controls).toContainEqual(expect.objectContaining({ ref: 'M1', type: 'stepper', name: 'dx' }));
    expect(wired.controls).toContainEqual(expect.objectContaining({ ref: 'M1', type: 'stepper', name: 'dy' }));
    expect(wired.warnings.some((w) => w.code === 'module_not_simulated')).toBe(false);

    // The optional MOT pin can stay unwired without blocking attachment.
    const noMot = buildSimNetlist(circuitOf([
      { ref: 'U1', kind: 'arduino_uno', value: '', nodes: unoNodes({ D10: 'VNCS', D11: 'VMOSI', D12: 'VMISO', D13: 'VSCK' }) },
      { ref: 'M1', kind: 'mouse_sensor', value: '', nodes: ['NC_M1_1', '0', 'NC_M1_3', 'VNCS', 'VSCK', 'VMOSI', 'VMISO', 'NC_M1_8'] },
    ]), { mcuRef: 'U1' });
    expect(noMot.devices.find((d) => d.id === 'M1')).toMatchObject({ type: 'avr_peripheral' });
    expect(noMot.warnings.some((w) => w.code === 'module_not_simulated')).toBe(false);

    // MOSI landing anywhere but D11 breaks the hardware-SPI gate.
    const scrambled = buildSimNetlist(circuitOf([
      { ref: 'U1', kind: 'arduino_uno', value: '', nodes: unoNodes({ D10: 'VNCS', D9: 'VMOSI', D12: 'VMISO', D13: 'VSCK' }) },
      { ref: 'M1', kind: 'mouse_sensor', value: '', nodes: mouseNodes },
    ]), { mcuRef: 'U1' });
    expect(scrambled.warnings.some((w) => w.code === 'module_not_simulated')).toBe(true);
  });

  it('maps the zener breakdown voltage from its value', () => {
    const netlist = buildSimNetlist(circuitOf(withSupply([
      { ref: 'D1', kind: 'zener', value: '9.1V', nodes: ['VCC', '0'] },
    ])));
    const junction = netlist.devices.find((device) => device.owner === 'D1' && device.type === 'diode');
    expect(junction.model.bv).toBe(9.1);
  });

  it('maps the TVS standoff voltage into a hard clamp model', () => {
    const netlist = buildSimNetlist(circuitOf(withSupply([
      { ref: 'D1', kind: 'tvs', value: '12V', nodes: ['0', 'VCC'] },
    ])));
    const junction = netlist.devices.find((device) => device.owner === 'D1' && device.type === 'diode');
    expect(junction.model.bv).toBe(12);
    expect(junction.model.rs).toBe(0.5);
    expect(netlist.warnings.some((w) => w.code === 'kind_not_simulated')).toBe(false);
  });

  it('models the charge controller as an ideal source on its OUT+ pin', () => {
    const netlist = buildSimNetlist(circuitOf(withSupply([
      { ref: 'V2', kind: 'charge_controller', value: 'TP4056', nodes: ['VCC', '0', 'BATP', '0', 'VLOAD', '0'] },
    ])));
    expect(netlist.ok).toBe(true);
    const source = netlist.devices.find((device) => device.id === 'V2' && device.type === 'vsource');
    expect(source.np).toBe(netlist.nodeIndex.get('VLOAD'));
    expect(source.nm).toBe(GROUND);
    expect(source.waveform.volts).toBe(4.2);
    // No dropout sensing on purpose: OUT follows the battery, not IN.
    expect(source.inNode).toBeUndefined();
  });
});
