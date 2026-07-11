import { describe, expect, it } from 'vitest';
import { COMPONENT_KINDS, DEFAULT_PIN_COUNT_BY_KIND } from '../componentKinds.js';
import { createSimulation } from './simEngine.js';

const circuitOf = (components, extra = {}) => ({
  title: 'fixture',
  type: 'test',
  supplyVoltage: 5,
  nodes: [...new Set(components.flatMap((part) => part.nodes))],
  components,
  notes: [],
  ...extra,
});

const volts = (engine, net) => engine.probe().netVoltages.get(net);

describe('createSimulation — DC solves', () => {
  it('solves a 1k/1k voltage divider to 2.500 V', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCC', 'VOUT'] },
      { ref: 'R2', kind: 'resistor', value: '1k', nodes: ['VOUT', '0'] },
    ]));
    expect(engine.ok).toBe(true);
    expect(engine.isDynamic).toBe(false);
    expect(engine.solveDC()).toBe(true);
    expect(volts(engine, 'VCC')).toBeCloseTo(5, 6);
    expect(volts(engine, 'VOUT')).toBeCloseTo(2.5, 6);
  });

  it('drives an LED + 220Ω from 5V at a realistic operating point', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '220', nodes: ['VCC', 'VLED'] },
      { ref: 'D1', kind: 'led', value: 'red', nodes: ['VLED', '0'] },
    ]));
    expect(engine.solveDC()).toBe(true);
    const observable = engine.observables().get('D1');
    expect(observable.amps).toBeGreaterThan(0.010);
    expect(observable.amps).toBeLessThan(0.015);
    const vLed = volts(engine, 'VLED');
    expect(vLed).toBeGreaterThan(1.8);
    expect(vLed).toBeLessThan(2.4);
    expect(observable.brightness).toBeGreaterThan(0.9);
  });

  it('clamps with a 5.1 V zener', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '12V', nodes: ['VIN', '0'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VIN', 'VCLAMP'] },
      // Cathode at the clamped node, anode to ground — reverse breakdown.
      { ref: 'D1', kind: 'zener', value: '5.1V', nodes: ['0', 'VCLAMP'] },
    ]));
    expect(engine.solveDC()).toBe(true);
    expect(volts(engine, 'VCLAMP')).toBeGreaterThan(4.8);
    expect(volts(engine, 'VCLAMP')).toBeLessThan(5.4);
  });

  it('dims an LED monotonically as the pot wiper sweeps', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '9V', nodes: ['VCC', '0'] },
      { ref: 'RV1', kind: 'potentiometer', value: '10k', nodes: ['VCC', 'VWIPER', 'NC_RV1_3'] },
      { ref: 'R1', kind: 'resistor', value: '220', nodes: ['VWIPER', 'VLED'] },
      { ref: 'D1', kind: 'led', value: 'red', nodes: ['VLED', '0'] },
    ]));
    const currents = [];
    for (const wiper of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      engine.setControl('RV1', 'wiper', wiper);
      expect(engine.solveDC()).toBe(true);
      currents.push(engine.observables().get('D1').amps);
    }
    for (let i = 1; i < currents.length; i += 1) {
      expect(currents[i]).toBeLessThan(currents[i - 1]);
    }
  });

  it('switches an LED with a pushbutton', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'SW1', kind: 'pushbutton', value: '', nodes: ['VCC', 'VBTN'] },
      { ref: 'R1', kind: 'resistor', value: '330', nodes: ['VBTN', 'VLED'] },
      { ref: 'D1', kind: 'led', value: 'red', nodes: ['VLED', '0'] },
    ]));
    expect(engine.solveDC()).toBe(true);
    expect(engine.observables().get('D1').amps).toBeLessThan(1e-4);
    engine.setControl('SW1', 'pressed', 1);
    expect(engine.solveDC()).toBe(true);
    expect(engine.observables().get('D1').amps).toBeGreaterThan(0.005);
  });

  it('routes through an SPDT switch and its toggle', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'SW1', kind: 'switch_spdt', value: '', nodes: ['VA', 'VCC', 'VB'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VA', '0'] },
      { ref: 'R2', kind: 'resistor', value: '1k', nodes: ['VB', '0'] },
    ]));
    expect(engine.solveDC()).toBe(true);
    expect(volts(engine, 'VA')).toBeGreaterThan(4.9);
    expect(volts(engine, 'VB')).toBeLessThan(0.1);
    engine.setControl('SW1', 'position', 'B');
    expect(engine.solveDC()).toBe(true);
    expect(volts(engine, 'VA')).toBeLessThan(0.1);
    expect(volts(engine, 'VB')).toBeGreaterThan(4.9);
  });

  it('brightens an LDR-driven divider as light increases', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'LDR1', kind: 'photoresistor', value: '10k', nodes: ['VCC', 'VSENSE'] },
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VSENSE', '0'] },
    ]));
    engine.setControl('LDR1', 'light', 0.1);
    engine.solveDC();
    const dark = volts(engine, 'VSENSE');
    engine.setControl('LDR1', 'light', 0.9);
    engine.solveDC();
    const bright = volts(engine, 'VSENSE');
    expect(dark).toBeLessThan(1);
    expect(bright).toBeGreaterThan(4);
  });

  it('models the regulator as an ideal source on its output', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '9V', nodes: ['VIN', '0'] },
      { ref: 'U1', kind: 'regulator', value: '7805', nodes: ['VIN', '0', 'VOUT'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VOUT', '0'] },
    ]));
    expect(engine.solveDC()).toBe(true);
    expect(volts(engine, 'VOUT')).toBeCloseTo(5, 4);
  });
});

describe('createSimulation — transient', () => {
  it('charges an RC to within 2% of the analytic curve at t = τ', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VCC', 'VCAP'] },
      { ref: 'C1', kind: 'capacitor', value: '100nF', nodes: ['VCAP', '0'] },
    ]));
    expect(engine.isDynamic).toBe(true);
    // τ = 1 ms; advance exactly to t = 1 ms with a generous budget.
    let remaining = 0.001 - engine.time;
    while (remaining > engine.h / 2) {
      engine.advance(Math.min(remaining, 0.0005), 50);
      remaining = 0.001 - engine.time;
    }
    const expected = 5 * (1 - Math.exp(-1));
    expect(volts(engine, 'VCAP')).toBeGreaterThan(expected * 0.98);
    expect(volts(engine, 'VCAP')).toBeLessThan(expected * 1.02);
  });

  it('rectifies a 100 Hz sine through a bridge', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'signal_source', value: 'SINE(0 5 100)', nodes: ['AC1', 'AC2'] },
      { ref: 'BR1', kind: 'bridge_rectifier', value: '', nodes: ['AC1', 'AC2', 'VPOS', '0'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VPOS', '0'] },
    ]));
    expect(engine.ok).toBe(true);
    let minOut = Infinity;
    let maxOut = -Infinity;
    // Sample one full 10 ms period.
    for (let i = 0; i < 100; i += 1) {
      engine.advance(0.0001, 50);
      const out = volts(engine, 'VPOS');
      minOut = Math.min(minOut, out);
      maxOut = Math.max(maxOut, out);
    }
    expect(minOut).toBeGreaterThan(-0.1);
    expect(maxOut).toBeGreaterThan(2.5);
    expect(maxOut).toBeLessThan(5);
  });
});

describe('createSimulation — pre-flight and robustness', () => {
  it('rejects a circuit with no ground', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', 'VRET'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCC', 'VRET'] },
    ]));
    expect(engine.ok).toBe(false);
    expect(engine.error.code).toBe('no_ground');
  });

  it('rejects a circuit with no source', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['A', '0'] },
    ]));
    expect(engine.ok).toBe(false);
    expect(engine.error.code).toBe('no_source');
  });

  it('rejects a shorted source', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['0', '0'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['A', '0'] },
    ]));
    expect(engine.ok).toBe(false);
    expect(engine.error.code).toBe('source_short');
  });

  it('warns but simulates around an MCU board', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'U1', kind: 'arduino_uno', value: '', nodes: ['VCC', '3V3', '0', ...Array.from({ length: 21 }, (_, i) => `NC_U1_${i + 4}`)] },
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCC', 'VOUT'] },
      { ref: 'R2', kind: 'resistor', value: '1k', nodes: ['VOUT', '0'] },
    ]));
    expect(engine.ok).toBe(true);
    expect(engine.warnings.some((w) => w.code === 'mcu_not_simulated')).toBe(true);
    expect(engine.solveDC()).toBe(true);
    expect(volts(engine, 'VOUT')).toBeCloseTo(2.5, 6);
  });

  it('never throws or produces NaN on a kitchen-sink circuit of every kind', () => {
    const components = Object.keys(COMPONENT_KINDS).map((kind, index) => {
      const pinCount = DEFAULT_PIN_COUNT_BY_KIND[kind] ?? 2;
      const ref = `P${index + 1}`;
      // Each part gets private nets except pin 2, which grounds it — keeps the
      // system connected without wiring ideal sources against each other.
      const nodes = Array.from({ length: pinCount }, (_, pin) => (pin === 1 ? '0' : `N_${ref}_${pin}`));
      return { ref, kind, value: '', nodes };
    });
    components.push({ ref: 'VMAIN', kind: 'voltage_source', value: '5V', nodes: ['RAIL', '0'] });
    components.push({ ref: 'RMAIN', kind: 'resistor', value: '1k', nodes: ['RAIL', '0'] });
    const engine = createSimulation(circuitOf(components));
    expect(engine.ok).toBe(true);
    expect(() => engine.solveDC()).not.toThrow();
    expect(engine.status().converged).toBe(true);
    expect(() => engine.advance(0.001, 50)).not.toThrow();
    const { netVoltages } = engine.probe();
    for (const [, value] of netVoltages) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(engine.warnings.some((w) => w.code === 'kind_not_simulated')).toBe(true);
  });
});
