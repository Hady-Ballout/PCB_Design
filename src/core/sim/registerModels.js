// Pure register-map device models for the I2C/SPI sensor peripherals — no
// engine or avr8js imports (the displayModels pattern). Each I2C model rides
// createRegisterSlave's pointer-write-then-read protocol; the MCP3008 is an
// SPI device the runner's CS-keyed router drives.

// Standard I2C register access: the first written byte sets the register
// pointer, further writes store with auto-increment, reads return registers
// with auto-increment (how Wire.write(reg) + Wire.requestFrom bursts work).
export const createRegisterSlave = ({ read, write }) => {
  let pointer = 0;
  let pointerPending = false;
  return {
    i2cSlave: {
      start(isWrite) {
        if (isWrite) pointerPending = true;
      },
      writeByte(value) {
        if (pointerPending) {
          pointer = value;
          pointerPending = false;
          return;
        }
        write?.(pointer, value);
        pointer = (pointer + 1) & 0xff;
      },
      readByte() {
        const value = read(pointer) ?? 0;
        pointer = (pointer + 1) & 0xff;
        return value & 0xff;
      },
    },
  };
};

const clampInt16 = (value) => Math.max(-32768, Math.min(32767, Math.round(value)));

// MPU6050: identity + config readback + the 14-byte big-endian burst at
// ACCEL_XOUT_H that Adafruit_MPU6050.getEvent() reads. Acceleration is the
// gravity vector for the slider orientation (±2g scale, 16384 LSB/g);
// gyro reads zero; temperature raw = (T − 36.53)·340.
export const createMpu6050 = (state) => {
  const written = new Map();
  let burst = new Uint8Array(14);

  const stageBurst = () => {
    const p = ((state.pitch ?? 0) * Math.PI) / 180;
    const r = ((state.roll ?? 0) * Math.PI) / 180;
    const g = 16384;
    const values = [
      clampInt16(-Math.sin(p) * g),
      clampInt16(Math.sin(r) * Math.cos(p) * g),
      clampInt16(Math.cos(r) * Math.cos(p) * g),
      clampInt16(((state.tempC ?? 25) - 36.53) * 340),
      0, 0, 0,
    ];
    burst = new Uint8Array(14);
    values.forEach((value, index) => {
      burst[index * 2] = (value >> 8) & 0xff;
      burst[index * 2 + 1] = value & 0xff;
    });
  };

  const { i2cSlave } = createRegisterSlave({
    read: (reg) => {
      if (reg === 0x75) return 0x68; // WHO_AM_I
      if (reg === 0x6b) return (written.get(0x6b) ?? 0) & 0x7f; // reset self-clears
      if (reg === 0x1b || reg === 0x1c) return written.get(reg) ?? 0; // range readback
      if (reg === 0x3b) stageBurst();
      if (reg >= 0x3b && reg < 0x3b + 14) return burst[reg - 0x3b];
      return 0;
    },
    write: (reg, value) => {
      written.set(reg, value);
    },
  });
  return { i2cSlave };
};

const bin2bcd = (value) => value + 6 * Math.floor(value / 10);
const bcd2bin = (value) => value - 6 * (value >> 4);

// DS3231 RTC: BCD time registers rolled forward from a fixed base epoch by
// elapsed AVR cycles (never Date.now — the sim clock is the truth). adjust()
// writes become the new base; lostPower() reads false; temp fixed at 25 °C.
export const createDs3231 = (cyclesNow) => {
  // Fixed base: 2026-01-01 00:00:00 (UTC math on a constant epoch only).
  let baseMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  let anchorCycles = 0;

  const currentDate = () => {
    const elapsedS = Math.floor((cyclesNow() - anchorCycles) / 16e6);
    return new Date(baseMs + elapsedS * 1000);
  };

  const timeRegs = () => {
    const d = currentDate();
    return [
      bin2bcd(d.getUTCSeconds()),
      bin2bcd(d.getUTCMinutes()),
      bin2bcd(d.getUTCHours()),
      d.getUTCDay() + 1,
      bin2bcd(d.getUTCDate()),
      bin2bcd(d.getUTCMonth() + 1),
      bin2bcd(d.getUTCFullYear() - 2000),
    ];
  };

  const pendingWrite = new Map();
  const applyPendingTime = () => {
    if (pendingWrite.size === 0) return;
    const now = currentDate();
    const get = (reg, fallback) => (pendingWrite.has(reg) ? bcd2bin(pendingWrite.get(reg)) : fallback);
    baseMs = Date.UTC(
      2000 + get(6, now.getUTCFullYear() - 2000),
      get(5, now.getUTCMonth() + 1) - 1,
      get(4, now.getUTCDate()),
      get(2, now.getUTCHours()),
      get(1, now.getUTCMinutes()),
      get(0, now.getUTCSeconds()),
    );
    anchorCycles = cyclesNow();
    pendingWrite.clear();
  };

  const { i2cSlave } = createRegisterSlave({
    read: (reg) => {
      if (reg <= 0x06) return timeRegs()[reg];
      if (reg === 0x0f) return 0x00; // OSF clear — lostPower() false
      if (reg === 0x11) return 0x19; // 25 °C
      if (reg === 0x12) return 0x00;
      return 0;
    },
    write: (reg, value) => {
      if (reg <= 0x06) {
        pendingWrite.set(reg, value);
        if (reg === 0x06) applyPendingTime(); // adjust() writes 0x00..0x06
      }
      // Control/status writes accepted silently.
    },
  });

  const text = () => {
    const d = currentDate();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  };
  return { i2cSlave, text };
};

// BMP280 with a deliberately degenerate calibration (dig_T1=16384,
// dig_T2=16384, dig_P1=6250, everything else zero) so the Bosch integer
// compensation collapses to exact linear maps: t_fine = adc_T − 262144 =
// 5120·T(°C) — the T1 offset keeps adc_T unsigned for sub-zero temperatures —
// and adc_P = 1048576 − P(Pa) (pressure is t_fine-independent because every
// t_fine coefficient P2..P6 is zero). Sliders invert trivially; the library
// computes the exact values back.
const BMP280_CALIBRATION = [
  0x00, 0x40, // dig_T1 = 16384 (LE)
  0x00, 0x40, // dig_T2 = 16384 (LE)
  0x00, 0x00, // dig_T3 = 0
  0x6a, 0x18, // dig_P1 = 6250 (LE)
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // dig_P2..P5
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // dig_P6..P9
];
const BMP280_ADC_T_OFFSET = 262144; // 16·dig_T1

export const createBmp280 = (state) => {
  const { i2cSlave } = createRegisterSlave({
    read: (reg) => {
      if (reg === 0xd0) return 0x58; // chip ID
      if (reg >= 0x88 && reg < 0x88 + 24) return BMP280_CALIBRATION[reg - 0x88];
      if (reg === 0xf3) return 0x00; // status: measurement done
      if (reg >= 0xf7 && reg <= 0xfc) {
        const adcT = Math.round((5120 * (state.tempC ?? 25) + BMP280_ADC_T_OFFSET) / 8) * 8;
        const adcP = 1048576 - Math.round((state.pressureHpa ?? 1013) * 100);
        const reg24 = (value) => (value << 4) & 0xffffff;
        const t24 = reg24(adcT);
        const p24 = reg24(adcP);
        return [
          (p24 >> 16) & 0xff, (p24 >> 8) & 0xff, p24 & 0xff,
          (t24 >> 16) & 0xff, (t24 >> 8) & 0xff, t24 & 0xff,
        ][reg - 0xf7];
      }
      return 0;
    },
    write: () => {}, // ctrl_meas/config accepted
  });
  return { i2cSlave };
};

// MCP3008 over SPI: CS-framed 3-byte transaction — 0x01 start, then
// (0x80 | channel<<4), then a dummy; the 10-bit result rides bytes 2-3.
export const createMcp3008 = (readChannelVolts) => {
  let phase = 0;
  let result = 0;
  return {
    spiDevice: {
      onByte(mosi) {
        let miso = 0x00;
        if (phase === 1) {
          const channel = (mosi >> 4) & 0x07;
          const volts = readChannelVolts(channel) ?? 0;
          result = Math.max(0, Math.min(1023, Math.round((volts / 5) * 1023)));
          miso = (result >> 8) & 0x03;
        } else if (phase === 2) {
          miso = result & 0xff;
        }
        phase = Math.min(phase + 1, 3);
        return miso;
      },
      onDeselect() {
        phase = 0;
      },
    },
  };
};

// WS2812 bitstream decoder: Adafruit's 16 MHz bit-bang emits ~5-cycle highs
// for 0 and ~13-cycle highs for 1 (20 cycles per bit); a low gap ≥ 40 µs
// (640 cycles) latches the frame. Bytes are MSB-first in GRB order.
export const createWs2812Decoder = ({ maxPixels = 30 } = {}) => {
  const state = { pixels: [], version: 0 };
  let bits = [];
  let riseAt = null;
  let lastFallAt = null;

  const commit = () => {
    if (bits.length < 24) {
      bits = [];
      return;
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      bytes.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
    }
    const pixels = [];
    for (let i = 0; i + 3 <= bytes.length && pixels.length < maxPixels; i += 3) {
      const [g, r, b] = bytes.slice(i, i + 3);
      pixels.push([r, g, b]);
    }
    state.pixels = pixels;
    state.version += 1;
    bits = [];
  };

  return {
    state,
    edge(high, cycles) {
      if (high) {
        if (lastFallAt != null && cycles - lastFallAt >= 640) commit();
        riseAt = cycles;
      } else if (riseAt != null) {
        bits.push(cycles - riseAt > 10 ? 1 : 0);
        lastFallAt = cycles;
        riseAt = null;
      }
    },
    commitIfIdle(cycles) {
      if (bits.length > 0 && lastFallAt != null && cycles - lastFallAt >= 640) commit();
    },
  };
};
