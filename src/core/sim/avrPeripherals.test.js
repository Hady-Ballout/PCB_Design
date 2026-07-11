import { describe, expect, it } from 'vitest';
import {
  TEST_PROGRAM_D13_HIGH,
  TEST_PROGRAM_DHT_START,
  TEST_PROGRAM_SERVO_1500,
  TEST_PROGRAM_SERVO_1750,
  TEST_PROGRAM_TRIG_PULSE,
  createAvrRunner,
} from './avrRunner.js';
import { createPeripheral } from './avrPeripherals.js';

const controlsWith = (owner, state) => new Map([[owner, state]]);

describe('servo peripheral', () => {
  it('decodes a 1500 µs pulse as 90 degrees', () => {
    const runner = createAvrRunner({ program: TEST_PROGRAM_SERVO_1500 });
    const servo = createPeripheral({ kind: 'servo', owner: 'M1', pins: { SIG: 'D9' } }, runner, new Map());
    runner.run(700_000); // two full ~20 ms periods
    expect(servo.observe().angle).toBeGreaterThan(88);
    expect(servo.observe().angle).toBeLessThan(92);
  });

  it('decodes a 1750 µs pulse as 135 degrees', () => {
    const runner = createAvrRunner({ program: TEST_PROGRAM_SERVO_1750 });
    const servo = createPeripheral({ kind: 'servo', owner: 'M1', pins: { SIG: 'D9' } }, runner, new Map());
    runner.run(700_000);
    expect(servo.observe().angle).toBeGreaterThan(133);
    expect(servo.observe().angle).toBeLessThan(137);
  });

  it('defaults to 90 degrees without pulses', () => {
    const runner = createAvrRunner({ program: TEST_PROGRAM_D13_HIGH });
    const servo = createPeripheral({ kind: 'servo', owner: 'M1', pins: { SIG: 'D9' } }, runner, new Map());
    runner.run(100_000);
    expect(servo.observe().angle).toBe(90);
  });
});

describe('ultrasonic peripheral', () => {
  it('answers a TRIG pulse with an ECHO of distance·58 µs', () => {
    const runner = createAvrRunner({ program: TEST_PROGRAM_TRIG_PULSE });
    createPeripheral(
      { kind: 'ultrasonic_sensor', owner: 'U2', pins: { TRIG: 'D7', ECHO: 'D8' } },
      runner,
      controlsWith('U2', { distanceCm: 50 }),
    );
    // Sample PINB bit 0 (D8) while the response plays out. 50 cm → 2.9 ms.
    let highCycles = 0;
    const slice = 160; // 10 µs
    for (let i = 0; i < 500; i += 1) {
      runner.run(slice);
      if (runner.cpu.data[0x23] & 1) highCycles += slice;
    }
    const expected = 50 * 58 * 16;
    expect(highCycles).toBeGreaterThan(expected * 0.95);
    expect(highCycles).toBeLessThan(expected * 1.05);
  });
});

describe('DHT peripheral', () => {
  it('responds to a start pulse with the preamble and data bits', () => {
    const runner = createAvrRunner({ program: TEST_PROGRAM_DHT_START });
    createPeripheral(
      { kind: 'dht_sensor', owner: 'U3', pins: { DATA: 'D2' } },
      runner,
      controlsWith('U3', { tempC: 25, humidity: 40 }),
    );
    // Run through the 1.2 ms start pulse plus the ~5 ms response, sampling
    // PIND bit 2 every 2 µs to reconstruct the edge timeline.
    const samples = [];
    for (let i = 0; i < 4000; i += 1) {
      runner.run(32); // 2 µs
      samples.push((runner.cpu.data[0x29] >> 2) & 1);
    }
    const text = samples.join('');
    // Preamble: ~80 µs low then ~80 µs high = ~40 samples each.
    const preambleLow = /0{30,50}1{30,50}/.exec(text);
    expect(preambleLow).not.toBeNull();
    // The response contains 40 bit cells: at least 40 falling edges after it.
    const afterPreamble = text.slice(preambleLow.index + preambleLow[0].length);
    const fallingEdges = (afterPreamble.match(/10/g) ?? []).length;
    expect(fallingEdges).toBeGreaterThanOrEqual(40);
  });
});

describe('encoder peripheral', () => {
  it('emits a gray-code detent readable at PIND', () => {
    const runner = createAvrRunner({ program: TEST_PROGRAM_D13_HIGH });
    const encoder = createPeripheral(
      { kind: 'rotary_encoder', owner: 'ENC1', pins: { CLK: 'D3', DT: 'D4', SW: 'D5' } },
      runner,
      new Map(),
    );
    const readPair = () => [(runner.cpu.data[0x29] >> 3) & 1, (runner.cpu.data[0x29] >> 4) & 1].join('');
    expect(readPair()).toBe('11'); // idle
    encoder.onControl('step', 1);
    const seen = [readPair()];
    for (let i = 0; i < 10; i += 1) {
      runner.run(16_000); // 1 ms
      const pair = readPair();
      if (pair !== seen[seen.length - 1]) seen.push(pair);
    }
    expect(seen).toEqual(['11', '01', '00', '10', '11']);
    expect(encoder.observe().detents).toBe(1);

    encoder.onControl('sw', 1);
    runner.run(16_000);
    expect((runner.cpu.data[0x29] >> 5) & 1).toBe(0); // SW held low
    runner.run(16_000 * 60);
    expect((runner.cpu.data[0x29] >> 5) & 1).toBe(1); // released after 50 ms
  });
});
