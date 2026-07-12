import { describe, expect, it } from 'vitest';
import {
  createBmp280,
  createDs3231,
  createMcp3008,
  createMpu6050,
  createRegisterSlave,
  createWs2812Decoder,
} from './registerModels.js';

// Wire-style access: pointer write, then an N-byte burst read.
const burstRead = (slave, reg, count) => {
  slave.start(true);
  slave.writeByte(reg);
  slave.start?.(false);
  return Array.from({ length: count }, () => slave.readByte(true));
};

const writeReg = (slave, reg, ...values) => {
  slave.start(true);
  slave.writeByte(reg);
  for (const value of values) slave.writeByte(value);
};

describe('createRegisterSlave', () => {
  it('auto-increments through reads and writes', () => {
    const regs = new Map();
    const { i2cSlave } = createRegisterSlave({
      read: (reg) => regs.get(reg) ?? 0,
      write: (reg, value) => regs.set(reg, value),
    });
    writeReg(i2cSlave, 0x10, 1, 2, 3);
    expect([regs.get(0x10), regs.get(0x11), regs.get(0x12)]).toEqual([1, 2, 3]);
    expect(burstRead(i2cSlave, 0x11, 2)).toEqual([2, 3]);
  });
});

describe('createMpu6050', () => {
  it('answers WHO_AM_I and reads back range configs', () => {
    const { i2cSlave } = createMpu6050({ pitch: 0, roll: 0, tempC: 25 });
    expect(burstRead(i2cSlave, 0x75, 1)).toEqual([0x68]);
    writeReg(i2cSlave, 0x1b, 0x08);
    expect(burstRead(i2cSlave, 0x1b, 1)).toEqual([0x08]);
    // Reset bit self-clears on readback.
    writeReg(i2cSlave, 0x6b, 0x80);
    expect(burstRead(i2cSlave, 0x6b, 1)[0] & 0x80).toBe(0);
  });

  it('maps orientation to gravity components in the accel burst', () => {
    const state = { pitch: 90, roll: 0, tempC: 25 };
    const { i2cSlave } = createMpu6050(state);
    let burst = burstRead(i2cSlave, 0x3b, 14);
    // pitch 90° → ax = −1 g = −16384 → big-endian 0xC0 0x00.
    expect(burst[0]).toBe(0xc0);
    expect(burst[1]).toBe(0x00);
    // az ≈ 0 at pitch 90.
    expect(Math.abs(((burst[4] << 8) | burst[5]) << 16 >> 16)).toBeLessThan(50);

    state.pitch = 0;
    burst = burstRead(i2cSlave, 0x3b, 14);
    const az = ((burst[4] << 8) | burst[5]) << 16 >> 16;
    expect(az).toBe(16384); // flat → +1 g on Z
    const tempRaw = ((burst[6] << 8) | burst[7]) << 16 >> 16;
    expect(tempRaw / 340 + 36.53).toBeCloseTo(25, 1);
  });
});

describe('createDs3231', () => {
  it('serves BCD time rolled forward by sim cycles and accepts adjust()', () => {
    let cycles = 0;
    const rtc = createDs3231(() => cycles);
    let regs = burstRead(rtc.i2cSlave, 0x00, 7);
    expect(regs[0]).toBe(0x00); // 00 s at the base epoch
    expect(regs[6]).toBe(0x26); // year 26 BCD
    cycles = 65 * 16e6; // +65 s
    regs = burstRead(rtc.i2cSlave, 0x00, 7);
    expect(regs[0]).toBe(0x05); // 05 s
    expect(regs[1]).toBe(0x01); // 01 min
    // adjust() to 12:34:56 15-06-2027.
    writeReg(rtc.i2cSlave, 0x00, 0x56, 0x34, 0x12, 0x03, 0x15, 0x06, 0x27);
    regs = burstRead(rtc.i2cSlave, 0x00, 7);
    expect(regs[0]).toBe(0x56);
    expect(regs[2]).toBe(0x12);
    expect(regs[4]).toBe(0x15);
    expect(rtc.text()).toBe('2027-06-15 12:34:56');
    // lostPower() reads OSF clear.
    expect(burstRead(rtc.i2cSlave, 0x0f, 1)).toEqual([0x00]);
  });
});

describe('createBmp280', () => {
  // The verbatim Bosch integer compensation from Adafruit_BMP280.cpp,
  // implemented here so the degenerate-calibration inversion is verified
  // against the exact math the library runs.
  const compensate = (calib, adcT, adcP) => {
    const dig = {
      T1: calib[0] | (calib[1] << 8),
      T2: (calib[2] | (calib[3] << 8)) << 16 >> 16,
      T3: (calib[4] | (calib[5] << 8)) << 16 >> 16,
      P1: calib[6] | (calib[7] << 8),
      P2: (calib[8] | (calib[9] << 8)) << 16 >> 16,
      P3: (calib[10] | (calib[11] << 8)) << 16 >> 16,
      P4: (calib[12] | (calib[13] << 8)) << 16 >> 16,
      P5: (calib[14] | (calib[15] << 8)) << 16 >> 16,
      P6: (calib[16] | (calib[17] << 8)) << 16 >> 16,
      P7: (calib[18] | (calib[19] << 8)) << 16 >> 16,
      P8: (calib[20] | (calib[21] << 8)) << 16 >> 16,
      P9: (calib[22] | (calib[23] << 8)) << 16 >> 16,
    };
    let var1 = (((adcT >> 3) - (dig.T1 << 1)) * dig.T2) >> 11;
    let var2 = ((((adcT >> 4) - dig.T1) * ((adcT >> 4) - dig.T1)) >> 12) * dig.T3 >> 14;
    const tFine = var1 + var2;
    const temperature = ((tFine * 5 + 128) >> 8) / 100;

    let p1 = BigInt(tFine) - 128000n;
    let p2 = p1 * p1 * BigInt(dig.P6);
    p2 += (p1 * BigInt(dig.P5)) << 17n;
    p2 += BigInt(dig.P4) << 35n;
    p1 = ((p1 * p1 * BigInt(dig.P3)) >> 8n) + ((p1 * BigInt(dig.P2)) << 12n);
    p1 = (((1n << 47n) + p1) * BigInt(dig.P1)) >> 33n;
    if (p1 === 0n) return { temperature, pressure: 0 };
    let p = 1048576n - BigInt(adcP);
    p = (((p << 31n) - p2) * 3125n) / p1;
    p1 = (BigInt(dig.P9) * (p >> 13n) * (p >> 13n)) >> 25n;
    p2 = (BigInt(dig.P8) * p) >> 19n;
    p = ((p + p1 + p2) >> 8n) + (BigInt(dig.P7) << 4n);
    return { temperature, pressure: Number(p) / 256 };
  };

  const readModel = (state) => {
    const { i2cSlave } = createBmp280(state);
    expect(burstRead(i2cSlave, 0xd0, 1)).toEqual([0x58]);
    const calib = burstRead(i2cSlave, 0x88, 24);
    const raw = burstRead(i2cSlave, 0xf7, 6);
    const adcP = ((raw[0] << 16) | (raw[1] << 8) | raw[2]) >> 4;
    const adcT = ((raw[3] << 16) | (raw[4] << 8) | raw[5]) >> 4;
    return compensate(calib, adcT, adcP);
  };

  it('compensates to exactly the slider values at 25 °C / 1013 hPa', () => {
    const { temperature, pressure } = readModel({ tempC: 25, pressureHpa: 1013 });
    expect(temperature).toBeCloseTo(25.0, 2);
    expect(pressure).toBeCloseTo(101300, 0);
  });

  it('holds at a second point (−10 °C / 900 hPa)', () => {
    const { temperature, pressure } = readModel({ tempC: -10, pressureHpa: 900 });
    expect(temperature).toBeCloseTo(-10.0, 1);
    expect(pressure).toBeCloseTo(90000, 0);
  });
});

describe('createMcp3008', () => {
  it('answers the 3-byte frame with the 10-bit conversion', () => {
    const { spiDevice } = createMcp3008((ch) => (ch === 3 ? 2.5 : 0));
    spiDevice.onDeselect();
    const b0 = spiDevice.onByte(0x01);
    const b1 = spiDevice.onByte(0x80 | (3 << 4));
    const b2 = spiDevice.onByte(0x00);
    const value = ((b1 & 0x03) << 8) | b2;
    expect(b0).toBe(0);
    expect(Math.abs(value - 512)).toBeLessThanOrEqual(1);
  });

  it('resets the frame on deselect', () => {
    const { spiDevice } = createMcp3008(() => 5);
    spiDevice.onByte(0x01);
    spiDevice.onDeselect(); // CS pulsed high mid-frame
    const b1 = spiDevice.onByte(0x01); // this is phase 0 again
    expect(b1).toBe(0);
  });
});

describe('createWs2812Decoder', () => {
  const CYCLES_PER_BIT = 20;
  const emitByte = (decoder, byte, start) => {
    let t = start;
    for (let bit = 7; bit >= 0; bit -= 1) {
      const high = (byte >> bit) & 1 ? 13 : 5;
      decoder.edge(true, t);
      decoder.edge(false, t + high);
      t += CYCLES_PER_BIT;
    }
    return t;
  };

  it('decodes GRB bytes into RGB pixels on latch', () => {
    const decoder = createWs2812Decoder({ maxPixels: 4 });
    let t = 1000;
    t = emitByte(decoder, 0x30, t); // G
    t = emitByte(decoder, 0xff, t); // R
    t = emitByte(decoder, 0x00, t); // B
    decoder.commitIfIdle(t + 700); // latch gap
    expect(decoder.state.pixels).toEqual([[0xff, 0x30, 0x00]]);
    expect(decoder.state.version).toBe(1);
  });

  it('splits frames on the latch gap between transmissions', () => {
    const decoder = createWs2812Decoder({});
    let t = emitByte(decoder, 0x11, 0);
    t = emitByte(decoder, 0x22, t);
    t = emitByte(decoder, 0x33, t);
    // Next frame starts after a >640-cycle idle: commit happens on its first rising edge.
    t += 1000;
    t = emitByte(decoder, 0x44, t);
    t = emitByte(decoder, 0x55, t);
    t = emitByte(decoder, 0x66, t);
    decoder.commitIfIdle(t + 700);
    expect(decoder.state.version).toBe(2);
    expect(decoder.state.pixels).toEqual([[0x55, 0x44, 0x66]]);
  });
});
