import { describe, expect, it } from 'vitest';
import { COMPONENT_KINDS, DEFAULT_PIN_COUNT_BY_KIND } from '../componentKinds.js';
import { TEST_PROGRAM_D13_BLINK, TEST_PROGRAM_D13_HIGH, TEST_PROGRAM_RX_ENABLE, TEST_PROGRAM_SERVO_1750, TEST_PROGRAM_TRIG_PULSE, buildShiftOutProgram, buildSpiProgram, buildStepperProgram, buildWs2812Program } from './avrRunner.js';
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

  it('lights an IR emitter LED behind a series resistor', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '220', nodes: ['VCC', 'VA'] },
      { ref: 'D1', kind: 'ir_led', value: '940nm', nodes: ['VA', '0'] },
    ]));
    expect(engine.solveDC()).toBe(true);
    const entry = engine.observables().get('D1');
    // ~16 mA through 220 Ω at Vf ≈ 1.3 V → full brightness.
    expect(entry.amps).toBeGreaterThan(0.01);
    expect(entry.brightness).toBeGreaterThan(0.5);
  });

  it('swings an IR phototransistor divider with the IR slider', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'Q1', kind: 'ir_phototransistor', value: '', nodes: ['VCC', 'VSENSE'] },
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VSENSE', '0'] },
    ]));
    expect(engine.solveDC()).toBe(true);
    const dark = volts(engine, 'VSENSE');
    engine.setControl('Q1', 'ir', 1);
    engine.solveDC();
    const lit = volts(engine, 'VSENSE');
    expect(dark).toBeLessThan(0.5);
    expect(lit).toBeGreaterThan(4);
    expect(engine.observables().get('Q1').ohms).toBeCloseTo(500, 0);
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

describe('createSimulation — active devices (M3)', () => {
  it('saturates a BJT switch driving an LED', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'RB', kind: 'resistor', value: '10k', nodes: ['VCC', 'VB'] },
      { ref: 'R1', kind: 'resistor', value: '330', nodes: ['VCC', 'VLED'] },
      { ref: 'D1', kind: 'led', value: 'red', nodes: ['VLED', 'VC'] },
      { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['VC', 'VB', '0'] },
    ]));
    expect(engine.solveDC()).toBe(true);
    expect(engine.observables().get('D1').amps).toBeGreaterThan(0.005);
    // Saturated collector sits well below a volt.
    expect(volts(engine, 'VC')).toBeLessThan(0.4);
  });

  it('cuts the BJT off when the base is floating', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '330', nodes: ['VCC', 'VLED'] },
      { ref: 'D1', kind: 'led', value: 'red', nodes: ['VLED', 'VC'] },
      { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['VC', 'NC_Q1_2', '0'] },
    ]));
    expect(engine.solveDC()).toBe(true);
    expect(Math.abs(engine.observables().get('D1').amps)).toBeLessThan(1e-6);
  });

  it('models the weak level-1 NMOS exactly like the ngspice deck', () => {
    // KP=20µ VTO=2: 5 V gate saturates at (KP/2)·(VGS−VTO)² = 90 µA.
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCC', 'VD'] },
      { ref: 'M1', kind: 'mosfet_n', value: '', nodes: ['VD', 'VCC', '0'] },
    ]));
    expect(engine.solveDC()).toBe(true);
    const id = engine.observables().get('M1').amps;
    expect(id).toBeGreaterThan(90e-6 * 0.85);
    expect(id).toBeLessThan(90e-6 * 1.15);
  });

  it('cuts the NMOS off with the gate grounded', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCC', 'VD'] },
      { ref: 'M1', kind: 'mosfet_n', value: '', nodes: ['VD', '0', '0'] },
    ]));
    expect(engine.solveDC()).toBe(true);
    expect(Math.abs(engine.observables().get('M1').amps)).toBeLessThan(1e-6);
  });

  it('follows the input in an opamp voltage follower', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '9V', nodes: ['VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VCC', 'VIN'] },
      { ref: 'R2', kind: 'resistor', value: '10k', nodes: ['VIN', '0'] },
      // [IN+, IN-, OUT, V+, V-]; OUT fed back to IN-.
      { ref: 'U1', kind: 'opamp', value: 'LM358', nodes: ['VIN', 'VOUT', 'VOUT', 'VCC', '0'] },
      { ref: 'RL', kind: 'resistor', value: '10k', nodes: ['VOUT', '0'] },
    ]));
    expect(engine.solveDC()).toBe(true);
    expect(volts(engine, 'VOUT')).toBeGreaterThan(4.5 - 0.01);
    expect(volts(engine, 'VOUT')).toBeLessThan(4.5 + 0.01);
  });

  it('sets the inverting-amp gain from the feedback network', () => {
    // Non-inverting input biased at 2.5 V; source 1.5 V through R1 10k, R2
    // 20k feedback: VOUT = 2.5 − 2·(1.5 − 2.5) = 4.5 V.
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '9V', nodes: ['VCC', '0'] },
      { ref: 'V2', kind: 'voltage_source', value: '2.5V', nodes: ['VBIAS', '0'] },
      { ref: 'V3', kind: 'voltage_source', value: '1.5V', nodes: ['VSIG', '0'] },
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VSIG', 'VINN'] },
      { ref: 'R2', kind: 'resistor', value: '20k', nodes: ['VINN', 'VOUT'] },
      { ref: 'U1', kind: 'opamp', value: 'LM358', nodes: ['VBIAS', 'VINN', 'VOUT', 'VCC', '0'] },
    ]));
    expect(engine.solveDC()).toBe(true);
    expect(volts(engine, 'VOUT')).toBeGreaterThan(4.5 * 0.98);
    expect(volts(engine, 'VOUT')).toBeLessThan(4.5 * 1.02);
  });

  it('flips the open-collector comparator with hysteresis', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'VREF', kind: 'voltage_source', value: '2.5V', nodes: ['VR', '0'] },
      { ref: 'RP', kind: 'resistor', value: '10k', nodes: ['VCC', 'VOUT'] },
      { ref: 'RS', kind: 'potentiometer', value: '10k', nodes: ['VCC', 'VIN', '0'] },
      { ref: 'U1', kind: 'comparator', value: 'LM393', nodes: ['VIN', 'VR', 'VOUT', 'VCC', '0'] },
    ]));
    // Wiper high → IN+ > 2.5 V → output released → pulled up.
    engine.setControl('RS', 'wiper', 0.3); // upper=3k lower=7k → VIN = 3.5 V
    expect(engine.solveDC()).toBe(true);
    expect(volts(engine, 'VOUT')).toBeGreaterThan(4.9);
    // Wiper low → IN+ < 2.5 V → output pulled low.
    engine.setControl('RS', 'wiper', 0.7); // VIN = 1.5 V
    expect(engine.solveDC()).toBe(true);
    expect(volts(engine, 'VOUT')).toBeLessThan(0.1);
  });

  it('oscillates a 555 astable at the RC formula period', () => {
    // RA=RB=10k, C=100nF → T = 0.693·(RA+2RB)·C = 2.079 ms.
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'RA', kind: 'resistor', value: '10k', nodes: ['VCC', 'VD'] },
      { ref: 'RB', kind: 'resistor', value: '10k', nodes: ['VD', 'VT'] },
      { ref: 'C1', kind: 'capacitor', value: '100nF', nodes: ['VT', '0'] },
      {
        ref: 'U1', kind: 'timer_555', value: 'NE555',
        // [GND, TRIG, OUT, RESET, CTRL, THRES, DISCH, VCC]
        nodes: ['0', 'VT', 'VOUT', 'VCC', 'NC_U1_5', 'VT', 'VD', 'VCC'],
      },
      { ref: 'RL', kind: 'resistor', value: '10k', nodes: ['VOUT', '0'] },
    ]));
    expect(engine.ok).toBe(true);
    expect(engine.isDynamic).toBe(true);
    const edges = [];
    let lastOut = 0;
    for (let i = 0; i < 120; i += 1) {
      engine.advance(0.0001, 50);
      const out = volts(engine, 'VOUT');
      if (lastOut < 2.5 && out >= 2.5) edges.push(engine.time);
      lastOut = out;
    }
    expect(edges.length).toBeGreaterThanOrEqual(4);
    const periods = edges.slice(-3).map((edge, index, arr) => (index ? edge - arr[index - 1] : null)).filter(Boolean);
    const mean = periods.reduce((sum, value) => sum + value, 0) / periods.length;
    expect(mean).toBeGreaterThan(0.002079 * 0.95);
    expect(mean).toBeLessThan(0.002079 * 1.05);
  });

  it('couples the optocoupler on and off', () => {
    const on = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '330', nodes: ['VCC', 'VA'] },
      // [A, K, E, C]
      { ref: 'U1', kind: 'optocoupler', value: 'PC817', nodes: ['VA', '0', '0', 'VOUT'] },
      { ref: 'RP', kind: 'resistor', value: '10k', nodes: ['VCC', 'VOUT'] },
    ]));
    expect(on.solveDC()).toBe(true);
    expect(volts(on, 'VOUT')).toBeLessThan(0.2);

    const off = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'U1', kind: 'optocoupler', value: 'PC817', nodes: ['NC_U1_1', '0', '0', 'VOUT'] },
      { ref: 'RP', kind: 'resistor', value: '10k', nodes: ['VCC', 'VOUT'] },
    ]));
    expect(off.solveDC()).toBe(true);
    expect(volts(off, 'VOUT')).toBeGreaterThan(4.8);
  });

  it('drops out the regulator when the input sags', () => {
    const healthy = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '9V', nodes: ['VIN', '0'] },
      { ref: 'U1', kind: 'regulator', value: '7805', nodes: ['VIN', '0', 'VOUT'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VOUT', '0'] },
    ]));
    expect(healthy.solveDC()).toBe(true);
    expect(volts(healthy, 'VOUT')).toBeCloseTo(5, 2);

    const sagging = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '4V', nodes: ['VIN', '0'] },
      { ref: 'U1', kind: 'regulator', value: '7805', nodes: ['VIN', '0', 'VOUT'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VOUT', '0'] },
    ]));
    expect(sagging.solveDC()).toBe(true);
    expect(volts(sagging, 'VOUT')).toBeGreaterThan(2.4);
    expect(volts(sagging, 'VOUT')).toBeLessThan(2.6);
  });

  it('models the buck converter as an ideal source on the switch node, carried to VOUT by the inductor', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '12V', nodes: ['VIN', '0'] },
      { ref: 'U1', kind: 'buck_converter', value: 'LM2596-5.0', nodes: ['VIN', 'SW', '0', 'VOUT', '0'] },
      { ref: 'L1', kind: 'inductor', value: '100uH', nodes: ['SW', 'VOUT'] },
      { ref: 'D1', kind: 'schottky', value: '', nodes: ['0', 'SW'] },
      { ref: 'C1', kind: 'capacitor', value: '220uF', nodes: ['VOUT', '0'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VOUT', '0'] },
    ]));
    expect(engine.solveDC()).toBe(true);
    expect(volts(engine, 'VOUT')).toBeGreaterThan(5 - 1e-2);
    expect(volts(engine, 'VOUT')).toBeLessThan(5 + 1e-2);
    // The catch schottky stays reverse-biased — negligible current.
    const diode = engine.observables().get('D1');
    expect(Math.abs(diode.amps)).toBeLessThan(1e-6);
  });

  it('sags the buck converter output below Vin − 2V headroom', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5.5V', nodes: ['VIN', '0'] },
      { ref: 'U1', kind: 'buck_converter', value: 'LM2596-5.0', nodes: ['VIN', 'SW', '0', 'VOUT', '0'] },
      { ref: 'L1', kind: 'inductor', value: '100uH', nodes: ['SW', 'VOUT'] },
      { ref: 'D1', kind: 'schottky', value: '', nodes: ['0', 'SW'] },
      { ref: 'C1', kind: 'capacitor', value: '220uF', nodes: ['VOUT', '0'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VOUT', '0'] },
    ]));
    expect(engine.solveDC()).toBe(true);
    expect(volts(engine, 'VOUT')).toBeGreaterThan(3.4);
    expect(volts(engine, 'VOUT')).toBeLessThan(3.6);
  });

  it('reports the buzzer frequency from a 555 tone', () => {
    // RA=RB=10k, C=10nF → f = 1.44/((RA+2RB)C) ≈ 4.8 kHz; buzzer across OUT.
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'RA', kind: 'resistor', value: '10k', nodes: ['VCC', 'VD'] },
      { ref: 'RB', kind: 'resistor', value: '10k', nodes: ['VD', 'VT'] },
      { ref: 'C1', kind: 'capacitor', value: '10nF', nodes: ['VT', '0'] },
      {
        ref: 'U1', kind: 'timer_555', value: 'NE555',
        nodes: ['0', 'VT', 'VOUT', 'VCC', 'NC_U1_5', 'VT', 'VD', 'VCC'],
      },
      { ref: 'BZ1', kind: 'buzzer', value: '1k', nodes: ['VOUT', '0'] },
    ]));
    for (let i = 0; i < 40; i += 1) engine.advance(0.0001, 50);
    const { freqHz } = engine.observables().get('BZ1');
    expect(freqHz).toBeGreaterThan(4800 * 0.85);
    expect(freqHz).toBeLessThan(4800 * 1.15);
  });
});

describe('createSimulation — polish devices (M4)', () => {
  it('blows the fuse on DC overcurrent and stays intact below the rating', () => {
    const overloaded = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'F1', kind: 'fuse', value: '1A', nodes: ['VCC', 'VF'] },
      { ref: 'R1', kind: 'resistor', value: '1', nodes: ['VF', '0'] },
    ]));
    expect(overloaded.solveDC()).toBe(true);
    expect(overloaded.observables().get('F1').blown).toBe(true);
    expect(Math.abs(overloaded.observables().get('R1').amps)).toBeLessThan(1e-3);

    const healthy = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'F1', kind: 'fuse', value: '1A', nodes: ['VCC', 'VF'] },
      { ref: 'R1', kind: 'resistor', value: '10', nodes: ['VF', '0'] },
    ]));
    expect(healthy.solveDC()).toBe(true);
    expect(healthy.observables().get('F1').blown).toBe(false);
    expect(healthy.observables().get('R1').amps).toBeGreaterThan(0.45);
  });

  it('blows the fuse only after sustained transient overcurrent (~10 ms)', () => {
    // The capacitor makes the circuit dynamic so time actually advances.
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'F1', kind: 'fuse', value: '1A', nodes: ['VCC', 'VF'] },
      { ref: 'R1', kind: 'resistor', value: '1', nodes: ['VF', '0'] },
      { ref: 'C1', kind: 'capacitor', value: '100nF', nodes: ['VF', '0'] },
    ]));
    expect(engine.isDynamic).toBe(true);
    // ~5 ms: over threshold but under the 10 ms window.
    for (let i = 0; i < 5; i += 1) engine.advance(0.001, 50);
    expect(engine.observables().get('F1').blown).toBe(false);
    // ~15 ms total: window exceeded.
    for (let i = 0; i < 10; i += 1) engine.advance(0.001, 50);
    expect(engine.observables().get('F1').blown).toBe(true);
  });

  it('switches the relay contacts and loads the supply coil', () => {
    const build = (driveVolts) => createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'V2', kind: 'voltage_source', value: `${driveVolts}V`, nodes: ['VIN', '0'] },
      // [VCC, GND, IN, COM, NO, NC]
      { ref: 'K1', kind: 'relay_module', value: '', nodes: ['VCC', '0', 'VIN', 'VCC', 'VNO', 'VNC'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VNO', '0'] },
      { ref: 'R2', kind: 'resistor', value: '1k', nodes: ['VNC', '0'] },
    ]));
    const energized = build(5);
    expect(energized.solveDC()).toBe(true);
    expect(volts(energized, 'VNO')).toBeGreaterThan(4.9);
    expect(volts(energized, 'VNC')).toBeLessThan(0.1);
    expect(energized.observables().get('K1').energized).toBe(true);
    // Coil + contact load on the 5 V supply: > 50 mA delivered.
    expect(energized.observables().get('V1').amps).toBeGreaterThan(0.05);

    const idle = build(0);
    expect(idle.solveDC()).toBe(true);
    expect(volts(idle, 'VNO')).toBeLessThan(0.1);
    expect(volts(idle, 'VNC')).toBeGreaterThan(4.9);
    expect(idle.observables().get('K1').energized).toBe(false);
  });

  it('pulls a ULN2003 output low only while its input reads high', () => {
    const build = (driveVolts) => createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'V2', kind: 'voltage_source', value: `${driveVolts}V`, nodes: ['VIN', '0'] },
      // [IN1..IN4, VCC, GND, OUTA..OUTD]: channel 1 switches a 50 Ω coil load.
      {
        ref: 'U2', kind: 'stepper_driver', value: '',
        nodes: ['VIN', 'NC_U2_2', 'NC_U2_3', 'NC_U2_4', 'VCC', '0', 'VOUTA', 'NC_U2_8', 'NC_U2_9', 'NC_U2_10'],
      },
      { ref: 'R1', kind: 'resistor', value: '50', nodes: ['VCC', 'VOUTA'] },
    ]));
    const driven = build(5);
    expect(driven.solveDC()).toBe(true);
    // 5 V across 50 Ω + 10 Ω sat: OUTA sits near the saturation voltage.
    expect(volts(driven, 'VOUTA')).toBeLessThan(1.1);
    const idle = build(0);
    expect(idle.solveDC()).toBe(true);
    expect(volts(idle, 'VOUTA')).toBeGreaterThan(4.9);
  });

  it('switches the L298N outputs by IN polarity and coasts when disabled', () => {
    // [VS, GND, ENA, IN1, IN2, ENB, IN3, IN4, OUT1..OUT4]
    const build = (inHigh, enaNet = 'NC_U3_3') => createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '12V', nodes: ['VS', '0'] },
      { ref: 'V2', kind: 'voltage_source', value: '5V', nodes: ['VDRIVE', '0'] },
      {
        ref: 'U3', kind: 'motor_driver', value: '',
        nodes: ['VS', '0', enaNet, inHigh === 'A' ? 'VDRIVE' : '0', inHigh === 'B' ? 'VDRIVE' : '0',
          'NC_U3_6', 'NC_U3_7', 'NC_U3_8', 'VO1', 'VO2', 'NC_U3_11', 'NC_U3_12'],
      },
      { ref: 'M1', kind: 'dc_motor', value: '', nodes: ['VO1', 'VO2'] },
    ]));

    const forward = build('A');
    expect(forward.solveDC()).toBe(true);
    // 12 V through 2+2 Ω bridge into the 10 Ω winding: ~8.6 V across it.
    expect(volts(forward, 'VO1') - volts(forward, 'VO2')).toBeGreaterThan(8);
    expect(forward.observables().get('M1').speed01).toBeGreaterThan(0.9);

    const reverse = build('B');
    expect(reverse.solveDC()).toBe(true);
    expect(volts(reverse, 'VO2') - volts(reverse, 'VO1')).toBeGreaterThan(8);

    // ENA wired to ground: both outputs float — the motor coasts.
    const coast = build('A', '0');
    expect(coast.solveDC()).toBe(true);
    expect(Math.abs(volts(coast, 'VO1') - volts(coast, 'VO2'))).toBeLessThan(0.1);
    expect(coast.observables().get('M1').speed01).toBeLessThan(0.05);
  });

  it('centers the joystick axes at half supply and follows the stimulus', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      // [GND, VCC, VRX, VRY, SW]
      { ref: 'J1', kind: 'joystick', value: '', nodes: ['0', 'VCC', 'VX', 'VY', 'VSW'] },
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VX', '0'] },
      { ref: 'R2', kind: 'resistor', value: '10k', nodes: ['VY', '0'] },
      // Pull-up on the stick switch (INPUT_PULLUP stand-in).
      { ref: 'R3', kind: 'resistor', value: '10k', nodes: ['VCC', 'VSW'] },
    ]));
    expect(engine.solveDC()).toBe(true);
    expect(volts(engine, 'VX')).toBeCloseTo(2.5, 1);
    expect(volts(engine, 'VY')).toBeCloseTo(2.5, 1);
    expect(volts(engine, 'VSW')).toBeGreaterThan(4.9);

    engine.setControl('J1', 'x', 0.25);
    engine.setControl('J1', 'sw', 1);
    expect(engine.solveDC()).toBe(true);
    expect(volts(engine, 'VX')).toBeCloseTo(1.25, 1);
    expect(volts(engine, 'VY')).toBeCloseTo(2.5, 1);
    expect(volts(engine, 'VSW')).toBeLessThan(0.1);
  });

  it('drops the joystick axes to 0 V when the module is unpowered', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'RL', kind: 'resistor', value: '1k', nodes: ['VCC', '0'] },
      // VCC pin unwired → axis sources stay at 0 V.
      { ref: 'J1', kind: 'joystick', value: '', nodes: ['0', 'NC_J1_2', 'VX', 'NC_J1_4', 'NC_J1_5'] },
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VX', '0'] },
    ]));
    expect(engine.solveDC()).toBe(true);
    expect(Math.abs(volts(engine, 'VX'))).toBeLessThan(0.05);
  });

  it('drives the current-sensor OUT at 2.5 V + 185 mV/A', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      // [IP+, IP-, VCC, OUT, GND]: shunt in series with a 1 Ω load → ~5 A.
      { ref: 'CS1', kind: 'current_sensor', value: '', nodes: ['VCC', 'VLOAD', 'VCC', 'VOUT', '0'] },
      { ref: 'R1', kind: 'resistor', value: '1', nodes: ['VLOAD', '0'] },
      { ref: 'RO', kind: 'resistor', value: '10k', nodes: ['VOUT', '0'] },
    ]));
    expect(engine.solveDC()).toBe(true);
    expect(volts(engine, 'VOUT')).toBeGreaterThan(3.38);
    expect(volts(engine, 'VOUT')).toBeLessThan(3.48);
    expect(engine.observables().get('CS1').outVolts).toBeCloseTo(volts(engine, 'VOUT'), 2);
  });

  it('sags the solar panel under load through its 5 Ω internal resistance', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'PV1', kind: 'solar_panel', value: '6V', nodes: ['VPV', '0'] },
      { ref: 'R1', kind: 'resistor', value: '55', nodes: ['VPV', '0'] },
    ]));
    expect(engine.solveDC()).toBe(true);
    expect(volts(engine, 'VPV')).toBeGreaterThan(5.5 * 0.99);
    expect(volts(engine, 'VPV')).toBeLessThan(5.5 * 1.01);
  });
});

describe('createSimulation — Arduino Uno firmware bridge', () => {
  // Uno fixedPins: [5V, 3V3, GND, VIN, D0..D13, A0..A5]. D13 is index 17.
  const unoNodes = (overrides = {}) => {
    const nodes = ['VCC5', 'NC_U1_2', '0', ...Array.from({ length: 21 }, (_, i) => `NC_U1_${i + 4}`)];
    for (const [pin, net] of Object.entries(overrides)) {
      const index = pin === '5V' ? 0 : pin === 'GND' ? 2
        : pin.startsWith('D') ? 4 + Number(pin.slice(1))
          : 18 + Number(pin.slice(1));
      nodes[index] = net;
    }
    return nodes;
  };

  it('drives an LED from D13 with real firmware execution', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'U1', kind: 'arduino_uno', value: '', nodes: unoNodes({ D13: 'VPIN' }) },
      { ref: 'R1', kind: 'resistor', value: '330', nodes: ['VPIN', 'VLED'] },
      { ref: 'D1', kind: 'led', value: 'red', nodes: ['VLED', '0'] },
    ]), { mcu: { program: TEST_PROGRAM_D13_HIGH } });
    expect(engine.ok).toBe(true);
    expect(engine.isDynamic).toBe(true); // firmware forces transient
    expect(engine.warnings.some((w) => w.code === 'mcu_no_firmware')).toBe(false);
    engine.advance(0.002, 50);
    expect(engine.observables().get('D1').amps).toBeGreaterThan(0.005);
    // The Uno's internal 5 V supply powers its 5V pin net.
    expect(volts(engine, 'VCC5')).toBeGreaterThan(4.9);
  });

  it('sees toggling pin levels from the fast-toggle program', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'U1', kind: 'arduino_uno', value: '', nodes: unoNodes({ D13: 'VPIN' }) },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VPIN', '0'] },
    ]), { mcu: { program: TEST_PROGRAM_D13_BLINK } });
    const seen = new Set();
    for (let i = 0; i < 50; i += 1) {
      engine.advance(0.0001, 50);
      seen.add(volts(engine, 'VPIN') > 2.5);
    }
    expect(seen).toEqual(new Set([true, false]));
  });

  it('feeds circuit voltages into digital inputs and the ADC', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'U1', kind: 'arduino_uno', value: '', nodes: unoNodes({ D8: 'VHI', A0: 'VMID' }) },
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VHI', '0'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VHI', 'VMID'] },
      { ref: 'R2', kind: 'resistor', value: '1k', nodes: ['VMID', '0'] },
    ]), { mcu: { program: TEST_PROGRAM_D13_HIGH } });
    engine.advance(0.001, 50);
    // D8 (PB0) input reads high; PINB is data address 0x23.
    expect(engine.mcuRunner.cpu.data[0x23] & 1).toBe(1);
    // A0 ADC channel carries the divider midpoint.
    expect(engine.mcuRunner.adc.channelValues[0]).toBeCloseTo(2.5, 1);
  });

  it('collects Serial output into the ring buffer', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'U1', kind: 'arduino_uno', value: '', nodes: unoNodes({ D13: 'VPIN' }) },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VPIN', '0'] },
    ]), { mcu: { program: TEST_PROGRAM_D13_HIGH } });
    engine.advance(0.001, 50);
    expect(typeof engine.serialText()).toBe('string'); // empty for this program, but wired
  });

  it('averages PWM-like toggling into a mid brightness (persistence of vision)', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'U1', kind: 'arduino_uno', value: '', nodes: unoNodes({ D13: 'VPIN' }) },
      { ref: 'R1', kind: 'resistor', value: '330', nodes: ['VPIN', 'VLED'] },
      { ref: 'D1', kind: 'led', value: 'red', nodes: ['VLED', '0'] },
    ]), { mcu: { program: TEST_PROGRAM_D13_BLINK } });
    // The toggle program flips every few cycles — far faster than 30 ms.
    for (let i = 0; i < 40; i += 1) engine.advance(0.002, 50);
    const { brightness, amps } = engine.observables().get('D1');
    expect(brightness).toBeGreaterThan(0.1);
    expect(brightness).toBeLessThan(1);
    // Instantaneous amps is either full-on or off — the split is intentional.
    expect(Math.abs(amps)).toBeDefined();
  });
});

describe('createSimulation — protocol peripherals (Tier 2b)', () => {
  const unoNodesForPins = (overrides) => {
    const nodes = ['NC_U1_1', 'NC_U1_2', '0', ...Array.from({ length: 21 }, (_, i) => `NC_U1_${i + 4}`)];
    for (const [pin, net] of Object.entries(overrides)) {
      const index = pin.startsWith('D') ? 4 + Number(pin.slice(1)) : 18 + Number(pin.slice(1));
      nodes[index] = net;
    }
    return nodes;
  };

  it('decodes servo PWM from real firmware into a horn angle', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'U1', kind: 'arduino_uno', value: '', nodes: unoNodesForPins({ D9: 'VSIG' }) },
      // [VCC, GND, SIG]
      { ref: 'M1', kind: 'servo', value: 'SG90', nodes: ['NC_M1_1', '0', 'VSIG'] },
    ]), { mcu: { program: TEST_PROGRAM_SERVO_1750 } });
    expect(engine.ok).toBe(true);
    expect(engine.warnings.some((w) => w.code === 'module_not_simulated')).toBe(false);
    // Two full 20 ms PWM periods.
    for (let i = 0; i < 45; i += 1) engine.advance(0.001, 50);
    const { angle } = engine.observables().get('M1');
    expect(angle).toBeGreaterThan(133);
    expect(angle).toBeLessThan(137);
  });

  it('accumulates stepper shaft angle from a ULN2003 driven by firmware', () => {
    const FULL_STEP = [0b0011, 0b0110, 0b1100, 0b1001];
    const build = (masks) => createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'U1', kind: 'arduino_uno', value: '', nodes: unoNodesForPins({ D2: 'VIN1', D3: 'VIN2', D4: 'VIN3', D5: 'VIN4' }) },
      // [IN1..IN4, VCC, GND, OUTA..OUTD]
      {
        ref: 'U2', kind: 'stepper_driver', value: '',
        nodes: ['VIN1', 'VIN2', 'VIN3', 'VIN4', 'VCC', '0', 'VA', 'VB', 'VC', 'VD'],
      },
      // [A, B, C, D, COM]
      { ref: 'M1', kind: 'stepper_motor', value: '', nodes: ['VA', 'VB', 'VC', 'VD', 'VCC'] },
      // ~3 ms per full step (12000 SBIW iterations ≈ 48k cycles).
    ]), { mcu: { program: buildStepperProgram(masks, 12000) } });

    const forward = build(FULL_STEP);
    expect(forward.ok).toBe(true);
    expect(forward.warnings.some((w) => w.code === 'module_not_simulated')).toBe(false);
    for (let i = 0; i < 60; i += 1) forward.advance(0.001, 50);
    const spun = forward.observables().get('M1');
    // ~20 full steps in 60 ms → ~40 half steps; generous window for timing.
    expect(spun.halfSteps).toBeGreaterThan(20);
    expect(spun.halfSteps).toBeLessThan(48);
    expect(spun.angle).toBeGreaterThan(0);

    const reverse = build([...FULL_STEP].reverse());
    for (let i = 0; i < 60; i += 1) reverse.advance(0.001, 50);
    expect(reverse.observables().get('M1').halfSteps).toBeLessThan(-20);
  });

  it('answers TRIG with an ECHO visible on the display branch', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'U1', kind: 'arduino_uno', value: '', nodes: unoNodesForPins({ D7: 'VTRIG', D8: 'VECHO' }) },
      // [VCC, TRIG, ECHO, GND]
      { ref: 'U2', kind: 'ultrasonic_sensor', value: '', nodes: ['NC_U2_1', 'VTRIG', 'VECHO', '0'] },
    ]), { mcu: { program: TEST_PROGRAM_TRIG_PULSE } });
    expect(engine.ok).toBe(true);
    // Echo at 50 cm default: high from ~250 µs to ~3.15 ms after the pulse.
    let sawHigh = false;
    for (let i = 0; i < 40; i += 1) {
      engine.advance(0.0001, 50);
      if (volts(engine, 'VECHO') > 4) sawHigh = true;
    }
    expect(sawHigh).toBe(true);
    // After the echo window the net returns low.
    for (let i = 0; i < 20; i += 1) engine.advance(0.001, 50);
    expect(volts(engine, 'VECHO')).toBeLessThan(1);
  });

  it('drives an LED through a shift register from real firmware', () => {
    // 595 fixedPins: [QB..QH, GND, QH2, SRCLR, SRCLK, RCLK, OE, SER, QA, VCC].
    // Shift 0x01 → QA (last-shifted bit 0) high; QA is index 14.
    const srNodes = Array.from({ length: 16 }, (_, i) => `NC_SR1_${i + 1}`);
    srNodes[7] = '0'; // GND
    srNodes[13] = 'VSER';
    srNodes[10] = 'VSRCLK';
    srNodes[11] = 'VRCLK';
    srNodes[14] = 'VQA';
    const engine = createSimulation(circuitOf([
      { ref: 'U1', kind: 'arduino_uno', value: '', nodes: unoNodesForPins({ D2: 'VSER', D3: 'VSRCLK', D4: 'VRCLK' }) },
      { ref: 'SR1', kind: 'shift_register', value: '74HC595', nodes: srNodes },
      { ref: 'R1', kind: 'resistor', value: '330', nodes: ['VQA', 'VLED'] },
      { ref: 'D1', kind: 'led', value: 'red', nodes: ['VLED', '0'] },
    ]), { mcu: { program: buildShiftOutProgram(0x01) } });
    expect(engine.ok).toBe(true);
    expect(engine.warnings.some((w) => w.code === 'module_not_simulated')).toBe(false);
    engine.advance(0.002, 50);
    expect(engine.observables().get('D1').amps).toBeGreaterThan(0.005);
    expect(engine.observables().get('SR1').latch).toBe(0x01);
  });

  it('rejects I2C displays not wired to the hardware TWI pins', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'U1', kind: 'arduino_uno', value: '', nodes: unoNodesForPins({ D2: 'VSDA', D3: 'VSCL' }) },
      // OLED on plain digital pins — software I2C, not simulated.
      { ref: 'O1', kind: 'oled_display', value: '', nodes: ['NC_O1_1', '0', 'VSCL', 'VSDA'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VSDA', '0'] },
    ]), { mcu: { program: TEST_PROGRAM_D13_HIGH } });
    expect(engine.warnings.some((w) => w.code === 'module_not_simulated' && w.message.startsWith('O1'))).toBe(true);

    const wired = createSimulation(circuitOf([
      { ref: 'U1', kind: 'arduino_uno', value: '', nodes: unoNodesForPins({ A4: 'VSDA', A5: 'VSCL' }) },
      { ref: 'O1', kind: 'oled_display', value: '', nodes: ['NC_O1_1', '0', 'VSCL', 'VSDA'] },
    ]), { mcu: { program: TEST_PROGRAM_D13_HIGH } });
    expect(wired.ok).toBe(true);
    expect(wired.warnings.some((w) => w.code === 'module_not_simulated')).toBe(false);
    wired.advance(0.001, 50);
    expect(wired.observables().get('O1').fb).toBeInstanceOf(Uint8Array);
  });

  it('attaches I2C register sensors on the TWI pins and warns on address conflicts', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'U1', kind: 'arduino_uno', value: '', nodes: unoNodesForPins({ A4: 'VSDA', A5: 'VSCL' }) },
      // [VCC, GND, SCL, SDA]
      { ref: 'B1', kind: 'baro_sensor', value: 'BMP280', nodes: ['NC_B1_1', '0', 'VSCL', 'VSDA'] },
      { ref: 'M1', kind: 'imu_sensor', value: 'MPU6050', nodes: ['NC_M1_1', '0', 'VSCL', 'VSDA'] },
      // [GND, VCC, SDA, SCL] — RTC collides with the IMU at 0x68.
      { ref: 'K1', kind: 'rtc_module', value: 'DS3231', nodes: ['0', 'NC_K1_2', 'VSDA', 'VSCL'] },
    ]), { mcu: { program: TEST_PROGRAM_D13_HIGH } });
    expect(engine.ok).toBe(true);
    expect(engine.warnings.some((w) => w.code === 'module_not_simulated')).toBe(false);
    expect(engine.warnings.some((w) => w.code === 'i2c_address_conflict' && w.message.includes('M1') && w.message.includes('K1'))).toBe(true);
    // The baro's slave answers its chip ID through the live TWI bus.
    const handler = engine.mcuRunner.twi.eventHandler;
    handler.start(false);
    handler.connectToSlave(0x76, true);
    handler.writeByte(0xd0);
    handler.stop();
    handler.start(false);
    handler.connectToSlave(0x76, false);
    let chipId = null;
    const original = engine.mcuRunner.twi.completeRead.bind(engine.mcuRunner.twi);
    engine.mcuRunner.twi.completeRead = (value) => { chipId = value; original(value); };
    handler.readByte(false);
    handler.stop();
    expect(chipId).toBe(0x58);
  });

  it('reads a live divider through the MCP3008 over hardware SPI', () => {
    // 595-style DIP nodes: [CH0..CH7, DGND, CS, DIN, DOUT, CLK, AGND, VREF, VDD]
    const adcNodes = Array.from({ length: 16 }, (_, i) => `NC_A1_${i + 1}`);
    adcNodes[0] = 'VMID'; // CH0 on the divider midpoint
    adcNodes[8] = '0';
    adcNodes[9] = 'VCS';
    adcNodes[10] = 'VMOSI';
    adcNodes[11] = 'VMISO';
    adcNodes[12] = 'VSCK';
    const engine = createSimulation(circuitOf([
      { ref: 'U1', kind: 'arduino_uno', value: '', nodes: unoNodesForPins({ D10: 'VCS', D11: 'VMOSI', D12: 'VMISO', D13: 'VSCK' }) },
      { ref: 'A1', kind: 'adc_module', value: 'MCP3008', nodes: adcNodes },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCC5', 'VMID'] },
      { ref: 'R2', kind: 'resistor', value: '1k', nodes: ['VMID', '0'] },
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC5', '0'] },
    ]), { mcu: { program: buildSpiProgram([0x01, 0x80, 0x00]) } });
    expect(engine.ok).toBe(true);
    expect(engine.warnings.some((w) => w.code === 'module_not_simulated')).toBe(false);
    for (let i = 0; i < 10; i += 1) engine.advance(0.001, 50);
    const data = engine.mcuRunner.cpu.data;
    const value = ((data[0x0101] & 0x03) << 8) | data[0x0102];
    expect(Math.abs(value - 512)).toBeLessThanOrEqual(8);
  });

  it('rejects an MCP3008 not wired to the hardware SPI pins', () => {
    const adcNodes = Array.from({ length: 16 }, (_, i) => `NC_A1_${i + 1}`);
    adcNodes[9] = 'VCS';
    adcNodes[10] = 'VA';
    adcNodes[11] = 'VB';
    adcNodes[12] = 'VC';
    const engine = createSimulation(circuitOf([
      { ref: 'U1', kind: 'arduino_uno', value: '', nodes: unoNodesForPins({ D10: 'VCS', D5: 'VA', D6: 'VB', D7: 'VC' }) },
      { ref: 'A1', kind: 'adc_module', value: 'MCP3008', nodes: adcNodes },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCS', '0'] },
    ]), { mcu: { program: TEST_PROGRAM_D13_HIGH } });
    expect(engine.warnings.some((w) => w.code === 'module_not_simulated' && w.message.startsWith('A1'))).toBe(true);
  });

  it('decodes a bit-banged WS2812 frame into strip pixels', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'U1', kind: 'arduino_uno', value: '', nodes: unoNodesForPins({ D6: 'VDIN' }) },
      // [VCC, DIN, GND]
      { ref: 'LS1', kind: 'led_strip', value: 'WS2812', nodes: ['NC_LS1_1', 'VDIN', '0'] },
    ]), { mcu: { program: buildWs2812Program([0x30, 0xff, 0x00, 0x00, 0x40, 0x80]) } });
    expect(engine.ok).toBe(true);
    for (let i = 0; i < 5; i += 1) engine.advance(0.001, 50);
    const { pixels } = engine.observables().get('LS1');
    expect(pixels).toEqual([[0xff, 0x30, 0x00], [0x40, 0x00, 0x80]]); // GRB → RGB
  });

  it('queues serial input and delivers it once RX is enabled', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'U1', kind: 'arduino_uno', value: '', nodes: unoNodesForPins({ D13: 'VPIN' }) },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VPIN', '0'] },
    ]), { mcu: { program: TEST_PROGRAM_RX_ENABLE } });
    engine.sendSerial('A');
    engine.advance(0.001, 50);
    expect(engine.mcuRunner.cpu.data[0xc0] & 0x80).toBe(0x80); // RXC set
  });

  it('keeps unwired protocol modules on the warning path', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'U1', kind: 'arduino_uno', value: '', nodes: unoNodesForPins({ D13: 'VPIN' }) },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VPIN', '0'] },
      // Servo SIG on its own net — not shared with any Uno pin.
      { ref: 'M1', kind: 'servo', value: 'SG90', nodes: ['NC_M1_1', '0', 'VLOOSE'] },
      { ref: 'R2', kind: 'resistor', value: '1k', nodes: ['VLOOSE', '0'] },
    ]), { mcu: { program: TEST_PROGRAM_D13_HIGH } });
    expect(engine.ok).toBe(true);
    expect(engine.warnings.some((w) => w.code === 'module_not_simulated' && w.message.startsWith('M1'))).toBe(true);
    expect(engine.observables().get('M1')?.angle).toBeUndefined();
  });
});

describe('createSimulation — stimulus-driven sensors (Tier 2a)', () => {
  it('drives the TMP36 output from the temperature slider, 0 V unpowered', () => {
    const powered = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      // [VCC, OUT, GND]
      { ref: 'U1', kind: 'temp_sensor', value: 'TMP36', nodes: ['VCC', 'VOUT', '0'] },
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VOUT', '0'] },
    ]));
    expect(powered.solveDC()).toBe(true);
    expect(volts(powered, 'VOUT')).toBeCloseTo(0.75, 3); // 25 °C default
    powered.setControl('U1', 'tempC', 100);
    expect(powered.solveDC()).toBe(true);
    expect(volts(powered, 'VOUT')).toBeCloseTo(1.5, 3);

    const unpowered = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'RL', kind: 'resistor', value: '10k', nodes: ['VCC', '0'] },
      { ref: 'U1', kind: 'temp_sensor', value: 'TMP36', nodes: ['NC_U1_1', 'VOUT', '0'] },
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VOUT', '0'] },
    ]));
    expect(unpowered.solveDC()).toBe(true);
    expect(Math.abs(volts(unpowered, 'VOUT'))).toBeLessThan(0.01);
  });

  it('lights an LED through a BJT when the PIR sees motion', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'PIR1', kind: 'pir_sensor', value: '', nodes: ['VCC', 'VPIR', '0'] },
      { ref: 'RB', kind: 'resistor', value: '1k', nodes: ['VPIR', 'VB'] },
      { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['VC', 'VB', '0'] },
      { ref: 'R1', kind: 'resistor', value: '330', nodes: ['VCC', 'VLED'] },
      { ref: 'D1', kind: 'led', value: 'red', nodes: ['VLED', 'VC'] },
    ]));
    expect(engine.solveDC()).toBe(true);
    expect(Math.abs(engine.observables().get('D1').amps)).toBeLessThan(1e-4);
    engine.setControl('PIR1', 'motion', 1);
    expect(engine.solveDC()).toBe(true);
    expect(engine.observables().get('D1').amps).toBeGreaterThan(0.005);
  });

  it('sweeps the soil and gas analog outputs monotonically; gas DO flips at threshold', () => {
    const soil = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      // [VCC, GND, AOUT]
      { ref: 'U1', kind: 'soil_moisture', value: '', nodes: ['VCC', '0', 'AOUT'] },
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['AOUT', '0'] },
    ]));
    const soilReadings = [0.1, 0.5, 0.9].map((moisture) => {
      soil.setControl('U1', 'moisture', moisture);
      soil.solveDC();
      return volts(soil, 'AOUT');
    });
    expect(soilReadings[0]).toBeGreaterThan(soilReadings[1]);
    expect(soilReadings[1]).toBeGreaterThan(soilReadings[2]);

    const gas = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      // [VCC, GND, DO, AO]
      { ref: 'U1', kind: 'gas_sensor', value: 'MQ-2', nodes: ['VCC', '0', 'VDO', 'VAO'] },
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VAO', '0'] },
      { ref: 'R2', kind: 'resistor', value: '10k', nodes: ['VDO', '0'] },
    ]));
    gas.setControl('U1', 'gas', 0.2);
    gas.solveDC();
    const lowAO = volts(gas, 'VAO');
    expect(volts(gas, 'VDO')).toBeGreaterThan(4.5); // below threshold: DO high
    gas.setControl('U1', 'gas', 0.8);
    gas.solveDC();
    expect(volts(gas, 'VAO')).toBeGreaterThan(lowAO);
    expect(volts(gas, 'VDO')).toBeLessThan(0.2); // above threshold: DO low
  });

  it('pulls the hall sensor output low only while the magnet is near', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'RP', kind: 'resistor', value: '10k', nodes: ['VCC', 'VOUT'] },
      // [VCC, GND, OUT]
      { ref: 'U1', kind: 'hall_sensor', value: 'A3144', nodes: ['VCC', '0', 'VOUT'] },
    ]));
    expect(engine.solveDC()).toBe(true);
    expect(volts(engine, 'VOUT')).toBeGreaterThan(4.9);
    engine.setControl('U1', 'magnet', 1);
    expect(engine.solveDC()).toBe(true);
    expect(volts(engine, 'VOUT')).toBeLessThan(0.2);
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

  it('warns but simulates around a firmware-less MCU board', () => {
    const engine = createSimulation(circuitOf([
      { ref: 'U1', kind: 'arduino_uno', value: '', nodes: ['VCC', '3V3', '0', ...Array.from({ length: 21 }, (_, i) => `NC_U1_${i + 4}`)] },
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCC', 'VOUT'] },
      { ref: 'R2', kind: 'resistor', value: '1k', nodes: ['VOUT', '0'] },
    ]));
    expect(engine.ok).toBe(true);
    expect(engine.warnings.some((w) => w.code === 'mcu_no_firmware')).toBe(true);
    expect(engine.solveDC()).toBe(true);
    expect(volts(engine, 'VOUT')).toBeCloseTo(2.5, 6);
  });

  it('never throws or produces NaN on a kitchen-sink circuit of every kind', () => {
    const components = Object.keys(COMPONENT_KINDS).map((kind, index) => {
      const pinCount = DEFAULT_PIN_COUNT_BY_KIND[kind] ?? 2;
      const ref = `P${index + 1}`;
      // Each part gets private nets except pin 2, which grounds it — keeps the
      // system connected without wiring ideal sources against each other.
      // The buck converter is the one kind whose pin 2 (index 1) is its ideal
      // source's own OUT node — grounding it directly would short the source
      // against itself, so it grounds its actual GND pin (index 2) instead.
      const groundPin = kind === 'buck_converter' ? 2 : 1;
      const nodes = Array.from({ length: pinCount }, (_, pin) => (pin === groundPin ? '0' : `N_${ref}_${pin}`));
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
    // All eight formerly-deferred active kinds now simulate; wiring-only
    // modules (relay etc.) still warn.
    expect(engine.warnings.some((w) => w.code === 'kind_not_simulated')).toBe(false);
    expect(engine.warnings.some((w) => w.code === 'module_not_simulated')).toBe(true);
  });
});
