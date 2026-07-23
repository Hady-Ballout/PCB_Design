import { describe, expect, it } from 'vitest';
import {
  TEST_PROGRAM_D13_HIGH,
  TEST_PROGRAM_DHT_START,
  TEST_PROGRAM_SERVO_1500,
  TEST_PROGRAM_SERVO_1750,
  TEST_PROGRAM_TRIG_PULSE,
  buildShiftOutProgram,
  buildSpiProgram,
  createAvrRunner,
} from './avrRunner.js';
import { buildNecEdges, createPeripheral } from './avrPeripherals.js';

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

describe('IR receiver peripheral', () => {
  it('builds NEC edge lists with 32 bit cells framed by AGC and stop marks', () => {
    const { edges, totalUs } = buildNecEdges(0x00, 0x1c);
    // AGC mark/space + 32 × (mark + space) + stop mark/release = 68 edges.
    expect(edges).toHaveLength(68);
    expect(edges[0]).toEqual([0, 0]);
    expect(edges[1]).toEqual([9000, 1]);
    // 0x00/0xFF/0x1C/0xE3 has 16 ones → 16×2250 + 16×1120 + framing.
    expect(totalUs).toBe(9000 + 4500 + 16 * 2250 + 16 * 1120 + 560);
  });

  it('drives OUT with a decodable NEC frame for a key press', () => {
    const runner = createAvrRunner({ program: TEST_PROGRAM_D13_HIGH });
    const ir = createPeripheral(
      { kind: 'ir_receiver', owner: 'IR1', pins: { OUT: 'D2' } },
      runner,
      new Map(),
    );
    expect(ir.level('OUT')).toBe(1); // idle high
    ir.onControl('key_5', 1);
    // Sample PIND bit 2 every 10 µs across the whole ~68 ms frame.
    const samples = [];
    for (let i = 0; i < 9000; i += 1) {
      runner.run(160);
      samples.push((runner.cpu.data[0x29] >> 2) & 1);
    }
    // Run-length encode the timeline (drop the leading idle-high stretch).
    const runs = [];
    for (const sample of samples) {
      if (runs.length && runs.at(-1).level === sample) runs.at(-1).length += 1;
      else runs.push({ level: sample, length: 1 });
    }
    if (runs[0]?.level === 1) runs.shift();
    // AGC: ~9 ms low (900 samples), ~4.5 ms high (450).
    expect(runs[0].level).toBe(0);
    expect(runs[0].length).toBeGreaterThan(850);
    expect(runs[0].length).toBeLessThan(950);
    expect(runs[1].length).toBeGreaterThan(420);
    expect(runs[1].length).toBeLessThan(480);
    // 32 data bits: mark, then a space whose length encodes the bit.
    const bits = [];
    for (let i = 0; i < 32; i += 1) {
      const mark = runs[2 + i * 2];
      const space = runs[3 + i * 2];
      expect(mark.level).toBe(0);
      bits.push(space.length > 100 ? 1 : 0); // 560 µs ≈ 56, 1690 µs ≈ 169
    }
    // LSB-first bytes: addr 0x00, ~addr 0xFF, cmd 0x1C, ~cmd 0xE3.
    const bytes = [0, 1, 2, 3].map((byteIndex) =>
      bits.slice(byteIndex * 8, byteIndex * 8 + 8).reduce((value, bit, i) => value | (bit << i), 0));
    expect(bytes).toEqual([0x00, 0xff, 0x1c, 0xe3]);
    expect(ir.observe().lastKey).toBe('5');
    expect(ir.level('OUT')).toBe(1); // released back to idle
  });
});

describe('RFID reader peripheral', () => {
  it('routes SPI frames to the MFRC522 model through the SDA chip select', () => {
    // Read VersionReg over hardware SPI with CS on D10 (buildSpiProgram's CS).
    const runner = createAvrRunner({ program: buildSpiProgram([0x80 | (0x37 << 1), 0x00]) });
    const rfid = createPeripheral(
      { kind: 'rfid_reader', owner: 'RF1', pins: { SDA: 'D10', MOSI: 'D11', MISO: 'D12', SCK: 'D13' } },
      runner,
      new Map(),
    );
    runner.run(20_000);
    expect(runner.cpu.data[0x0101]).toBe(0x92); // second transfer returned the version
    expect(rfid.observe()).toMatchObject({ cardPresent: false, uid: 'DE AD BE EF' });
  });

  it('presents the card for ~1.5 s after a tap', () => {
    const runner = createAvrRunner({ program: TEST_PROGRAM_D13_HIGH });
    const rfid = createPeripheral(
      { kind: 'rfid_reader', owner: 'RF1', pins: { SDA: 'D10', MOSI: 'D11', MISO: 'D12', SCK: 'D13' } },
      runner,
      new Map(),
    );
    rfid.onControl('tap', 1);
    expect(rfid.observe().cardPresent).toBe(true);
    runner.run(1.4 * 16e6);
    expect(rfid.observe().cardPresent).toBe(true);
    runner.run(0.2 * 16e6);
    expect(rfid.observe().cardPresent).toBe(false);
  });
});

describe('mouse sensor peripheral', () => {
  it('routes SPI frames to the PMW3360 model through the NCS chip select', () => {
    // Read Product_ID over hardware SPI with CS on D10 (buildSpiProgram's CS).
    const runner = createAvrRunner({ program: buildSpiProgram([0x00, 0x00]) });
    const mouse = createPeripheral(
      { kind: 'mouse_sensor', owner: 'M1', pins: { NCS: 'D10', MOSI: 'D11', MISO: 'D12', SCK: 'D13' } },
      runner,
      new Map(),
    );
    runner.run(20_000);
    expect(runner.cpu.data[0x0101]).toBe(0x42); // second transfer returned Product_ID
    expect(mouse.observe()).toMatchObject({ x: 0, y: 0, pending: false, cpi: 5000 });
  });

  it('drives MOT low while motion is pending and releases it once drained', () => {
    // The program reads the Motion register (0x02), which latches and drains.
    const runner = createAvrRunner({ program: buildSpiProgram([0x02, 0x00]) });
    const mouse = createPeripheral(
      { kind: 'mouse_sensor', owner: 'M1', pins: { NCS: 'D10', MOSI: 'D11', MISO: 'D12', SCK: 'D13', MOT: 'D2' } },
      runner,
      new Map(),
    );
    expect(mouse.level('MOT')).toBe(1); // idle high
    mouse.onControl('dx', 12);
    mouse.onControl('dy', -3);
    expect(mouse.level('MOT')).toBe(0);
    expect((runner.cpu.data[0x29] >> 2) & 1).toBe(0); // PIND bit 2 (D2) pulled low
    expect(mouse.observe()).toMatchObject({ x: 12, y: -3, pending: true });
    runner.run(20_000); // firmware reads Motion, draining the accumulators
    expect(runner.cpu.data[0x0101]).toBe(0x80); // MOT bit was set in the report
    expect(mouse.level('MOT')).toBe(1);
    expect(mouse.observe().pending).toBe(false);
  });
});

describe('shift register peripheral', () => {
  it('shifts a byte MSB-first and latches it to the outputs', () => {
    const runner = createAvrRunner({ program: buildShiftOutProgram(0b10110110) });
    const sr = createPeripheral(
      { kind: 'shift_register', owner: 'SR1', pins: { SER: 'D2', SRCLK: 'D3', RCLK: 'D4' } },
      runner,
      new Map(),
    );
    runner.run(500); // whole unrolled program
    // MSBFIRST: bit 7 of the value lands on QH, bit 0 on QA.
    expect(sr.level('QH')).toBe(1);
    expect(sr.level('QG')).toBe(0);
    expect(sr.level('QF')).toBe(1);
    expect(sr.level('QE')).toBe(1);
    expect(sr.level('QD')).toBe(0);
    expect(sr.level('QC')).toBe(1);
    expect(sr.level('QB')).toBe(1);
    expect(sr.level('QA')).toBe(0);
    expect(sr.observe().latch).toBe(0b10110110);
  });
});

describe('keypad peripheral', () => {
  it('pulls a row low only for a pressed key in the driven column', () => {
    // Program drives column C1 (D6/PD6) output-low, spins.
    const program = Uint16Array.from([0x9a56, 0x985e, 0xcfff]); // SBI DDRD,6; CBI PORTD,6
    const runner = createAvrRunner({ program });
    const keypad = createPeripheral(
      {
        kind: 'keypad', owner: 'K1',
        pins: { R1: 'D8', R2: 'D9', R3: 'D10', R4: 'D11', C1: 'D6', C2: 'D7', C3: 'D12', C4: 'D13' },
      },
      runner,
      new Map(),
    );
    runner.run(50);
    const rowBit = (bit) => (runner.cpu.data[0x23] >> bit) & 1; // PINB: D8=bit0...
    expect(rowBit(0)).toBe(1); // R1 idle high
    keypad.onControl('key_1', 1); // key '1' = row 1, col 1 — driven column
    expect(rowBit(0)).toBe(0); // R1 pulled low
    keypad.onControl('key_1', 0);
    expect(rowBit(0)).toBe(1);
    keypad.onControl('key_2', 1); // '2' = row 1, col 2 — column NOT driven
    expect(rowBit(0)).toBe(1); // row stays high
    expect(keypad.observe().pressed).toEqual(['2']);
  });
});

describe('display peripherals', () => {
  it('registers I2C slaves and exposes framebuffer/text observables', () => {
    const runner = createAvrRunner({ program: TEST_PROGRAM_D13_HIGH });
    const oled = createPeripheral({ kind: 'oled_display', owner: 'O1', pins: { SDA: 'A4', SCL: 'A5' } }, runner, new Map());
    const lcd = createPeripheral({ kind: 'lcd_display', owner: 'L1', pins: { SDA: 'A4', SCL: 'A5' } }, runner, new Map());
    const handler = runner.twi.eventHandler;
    // Drive the OLED at 0x3C: display-on command.
    handler.start(false);
    handler.connectToSlave(0x3c, true);
    handler.writeByte(0x00);
    handler.writeByte(0xaf);
    handler.stop();
    expect(oled.observe().on).toBe(true);
    expect(oled.observe().fb).toBeInstanceOf(Uint8Array);
    // LCD at 0x27 sees PCF8574 bytes (backlight bit).
    handler.start(false);
    handler.connectToSlave(0x27, true);
    handler.writeByte(0x08);
    handler.stop();
    expect(lcd.observe().backlight).toBe(true);
    expect(lcd.observe().lines).toHaveLength(2);
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
