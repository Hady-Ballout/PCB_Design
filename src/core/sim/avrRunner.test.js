import { describe, expect, it } from 'vitest';
import {
  TEST_PROGRAM_D13_HIGH,
  TEST_PROGRAM_D13_TOGGLE,
  UNO_PIN_MAP,
  createAvrRunner,
  loadHex,
} from './avrRunner.js';

describe('createAvrRunner', () => {
  it('drives D13 high with the hand-assembled program', () => {
    const runner = createAvrRunner({ program: TEST_PROGRAM_D13_HIGH });
    runner.run(100);
    expect(runner.pinState('D13')).toEqual({ mode: 'output', high: true });
  });

  it('toggles D13 across slices with the toggle program', () => {
    const runner = createAvrRunner({ program: TEST_PROGRAM_D13_TOGGLE });
    const seen = new Set();
    for (let i = 0; i < 10; i += 1) {
      runner.run(3); // ~1.5 instructions per slice: samples both phases
      seen.add(runner.pinState('D13').high);
    }
    expect(seen).toEqual(new Set([true, false]));
  });

  it('reports unconfigured pins as inputs', () => {
    const runner = createAvrRunner({ program: TEST_PROGRAM_D13_HIGH });
    runner.run(10);
    expect(runner.pinState('D2').mode).toBe('input');
    expect(runner.pinState('A3').mode).toBe('input');
  });

  it('exposes external digital inputs to the program via PINB', () => {
    const runner = createAvrRunner({ program: TEST_PROGRAM_D13_HIGH });
    runner.run(10);
    runner.setDigitalInput('D8', true); // PB0
    expect(runner.cpu.data[0x23] & 1).toBe(1); // PINB bit 0
    runner.setDigitalInput('D8', false);
    expect(runner.cpu.data[0x23] & 1).toBe(0);
  });

  it('injects analog channel voltages for the ADC', () => {
    const runner = createAvrRunner({ program: TEST_PROGRAM_D13_HIGH });
    runner.setAnalogVolts(0, 3.3);
    expect(runner.adc.channelValues[0]).toBeCloseTo(3.3, 9);
  });

  it('loads Intel HEX data records', () => {
    // :020000000C94  → two bytes 0x0C 0x94 at address 0 (rjmp opcode tail).
    const target = new Uint8Array(16);
    loadHex(':020000000C945E\n:00000001FF', target);
    expect(target[0]).toBe(0x0c);
    expect(target[1]).toBe(0x94);
  });

  it('routes I2C traffic to registered slaves and NACKs unknown addresses', () => {
    const runner = createAvrRunner({ program: TEST_PROGRAM_D13_HIGH });
    const received = [];
    runner.registerI2cSlave(0x3c, {
      writeByte: (value) => received.push(value),
    });
    const handler = runner.twi.eventHandler;
    // Drive the researched master-write sequence directly.
    handler.start(false);
    handler.connectToSlave(0x3c, true);
    handler.writeByte(0x00);
    handler.writeByte(0xaf);
    handler.stop();
    expect(received).toEqual([0x00, 0xaf]);
    // Unregistered address: bytes must not reach the slave.
    handler.start(false);
    handler.connectToSlave(0x27, true);
    handler.writeByte(0x55);
    handler.stop();
    expect(received).toEqual([0x00, 0xaf]);
  });

  it('maps all 20 Uno pins onto ports B/C/D', () => {
    expect(Object.keys(UNO_PIN_MAP)).toHaveLength(20);
    expect(UNO_PIN_MAP.D13).toEqual({ port: 'B', bit: 5 });
    expect(UNO_PIN_MAP.A5).toEqual({ port: 'C', bit: 5, adcChannel: 5 });
    expect(UNO_PIN_MAP.D0).toEqual({ port: 'D', bit: 0 });
  });
});
