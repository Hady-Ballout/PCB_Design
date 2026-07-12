// Protocol-module peripherals for the Arduino bridge. Their timing (10 µs
// TRIG pulses, 26/70 µs DHT bits, µs-precision servo PWM) is far finer than
// the 20 µs MNA lockstep, so they talk to the AVR at cycle resolution:
// AVRIOPort listeners catch MCU port writes, cpu.addClockEvent + port.setPin
// deliver timed responses. The MNA engine stays the electrical truth; the
// engine reads each module's current output level for display-only branches.
import { UNO_PIN_MAP, AVR_CLOCK_HZ } from './avrRunner.js';
import { createHd44780, createSsd1306 } from './displayModels.js';
import {
  createBmp280,
  createDs3231,
  createMcp3008,
  createMpu6050,
  createWs2812Decoder,
} from './registerModels.js';

const usToCycles = (us) => Math.round((us * AVR_CLOCK_HZ) / 1e6);

// Watch one Uno pin for edges. The callback receives the pin's fresh state
// ({mode, high}) on every port/DDR write that could affect it.
const pinWatch = (runner, unoPin, onChange) => {
  const map = UNO_PIN_MAP[unoPin];
  const port = runner.ports[map.port];
  const listener = () => onChange(runner.pinState(unoPin), runner.cpu.cycles);
  port.addListener(listener);
  return () => port.removeListener(listener);
};

const at = (runner, cyclesFromNow, callback) => {
  runner.cpu.addClockEvent(callback, cyclesFromNow);
};

// SG90-style servo: measures the SIG pulse width; 1000-2000 µs → 0-180°.
const createServo = (record, runner) => {
  let angle = 90;
  let riseAt = null;
  let lastPulseAt = null;
  const unwatch = pinWatch(runner, record.pins.SIG, ({ mode, high }, cycles) => {
    if (mode !== 'output') return;
    if (high) {
      riseAt = cycles;
      return;
    }
    if (riseAt == null) return;
    const width = cycles - riseAt;
    riseAt = null;
    if (width >= usToCycles(500) && width <= usToCycles(2500)) {
      angle = Math.min(180, Math.max(0, ((width / 16 - 1000) / 1000) * 180));
      lastPulseAt = cycles;
    }
  });
  return {
    observe: () => ({
      angle: lastPulseAt == null || runner.cpu.cycles - lastPulseAt > usToCycles(100e3) ? 90 : angle,
    }),
    level: () => 0,
    dispose: unwatch,
  };
};

// HC-SR04: a ≥10 µs TRIG pulse schedules an ECHO pulse of distance·58 µs
// after a ~250 µs ultrasonic-burst delay. Distance comes from the slider.
const createUltrasonic = (record, runner, controlState) => {
  let trigRise = null;
  let echoLevel = 0;
  const setEcho = (high) => {
    echoLevel = high ? 1 : 0;
    runner.setDigitalInput(record.pins.ECHO, high);
  };
  const unwatch = pinWatch(runner, record.pins.TRIG, ({ mode, high }, cycles) => {
    if (mode !== 'output') return;
    if (high) {
      trigRise = cycles;
      return;
    }
    if (trigRise == null || cycles - trigRise < usToCycles(10)) return;
    trigRise = null;
    const distanceCm = controlState.get(record.owner)?.distanceCm ?? 50;
    at(runner, usToCycles(250), () => setEcho(true));
    at(runner, usToCycles(250) + usToCycles(distanceCm * 58), () => setEcho(false));
  });
  return {
    observe: () => ({}),
    level: (pin) => (pin === 'ECHO' ? echoLevel : 0),
    dispose: unwatch,
  };
};

// DHT22 protocol: after the MCU holds DATA low ≥0.9 ms and releases, walk the
// response — 80 µs low + 80 µs high preamble, then 40 bits of 50 µs low +
// 26/70 µs high — with chained clock events. Packet: RH×10, T×10 (signed),
// byte-sum checksum. setPin only affects the PIN register while the MCU has
// DATA in input mode, so there is no bus fight during the start pulse.
const createDht = (record, runner, controlState) => {
  let dataLevel = 1; // idle high (pull-up)
  let lowStart = null;
  let responding = false;

  const setData = (high) => {
    dataLevel = high ? 1 : 0;
    runner.setDigitalInput(record.pins.DATA, high);
  };

  const buildBits = () => {
    const state = controlState.get(record.owner) ?? {};
    const humidity = Math.round(Math.min(100, Math.max(0, state.humidity ?? 40)) * 10);
    const tempC = state.tempC ?? 25;
    const tempMag = Math.round(Math.min(80, Math.abs(tempC)) * 10);
    const tempWord = (tempC < 0 ? 0x8000 : 0) | tempMag;
    const bytes = [humidity >> 8, humidity & 0xff, tempWord >> 8, tempWord & 0xff];
    bytes.push(bytes.reduce((sum, byte) => sum + byte, 0) & 0xff);
    return bytes.flatMap((byte) => Array.from({ length: 8 }, (_, i) => (byte >> (7 - i)) & 1));
  };

  const respond = () => {
    responding = true;
    // Absolute edge times (µs from now): preamble, then 40 data bits.
    const edges = [];
    let t = 30; // MCU released; wait 30 µs then pull low
    edges.push([t, 0]);
    t += 80;
    edges.push([t, 1]); // 80 µs response low done → 80 µs high
    t += 80;
    for (const bit of buildBits()) {
      edges.push([t, 0]);
      t += 50; // 50 µs bit-start low
      edges.push([t, 1]);
      t += bit ? 70 : 26; // data high: 26 µs = '0', 70 µs = '1'
    }
    edges.push([t, 0]);
    t += 54;
    edges.push([t, 1]); // release back to idle high
    for (const [atUs, level] of edges) {
      at(runner, usToCycles(atUs), () => setData(level === 1));
    }
    at(runner, usToCycles(t) + 1, () => {
      responding = false;
    });
  };

  const unwatch = pinWatch(runner, record.pins.DATA, ({ mode, high }, cycles) => {
    if (responding) return;
    if (mode === 'output' && !high) {
      lowStart ??= cycles;
      return;
    }
    // Released (input) or driven high after a long-enough low: start pulse.
    if (lowStart != null && cycles - lowStart >= usToCycles(900)) {
      lowStart = null;
      respond();
    } else if (mode !== 'output' || high) {
      lowStart = null;
    }
  });

  return {
    observe: () => ({}),
    level: (pin) => (pin === 'DATA' ? dataLevel : 0),
    dispose: unwatch,
  };
};

// KY-040 encoder: stepper control emits one quadrature detent (4 edges, 1 ms
// apart); the SW button pulses low for 50 ms. All pins are module-driven.
const createEncoder = (record, runner, controlState) => {
  const levels = { CLK: 1, DT: 1, SW: 1 };
  let detents = 0;
  const setPin = (pinName, high) => {
    levels[pinName] = high ? 1 : 0;
    if (record.pins[pinName]) runner.setDigitalInput(record.pins[pinName], high);
  };
  setPin('CLK', true);
  setPin('DT', true);
  if (record.pins.SW) setPin('SW', true);

  return {
    observe: () => ({ detents }),
    level: (pin) => levels[pin] ?? 0,
    onControl: (name, value) => {
      if (name === 'step') {
        detents += value >= 0 ? 1 : -1;
        // Gray sequence from idle (1,1): CW leads with CLK, CCW with DT.
        const [first, second] = value >= 0 ? ['CLK', 'DT'] : ['DT', 'CLK'];
        at(runner, usToCycles(1000), () => setPin(first, false));
        at(runner, usToCycles(2000), () => setPin(second, false));
        at(runner, usToCycles(3000), () => setPin(first, true));
        at(runner, usToCycles(4000), () => setPin(second, true));
      }
      if (name === 'sw' && record.pins.SW) {
        setPin('SW', false);
        at(runner, usToCycles(50e3), () => setPin('SW', true));
      }
    },
    dispose: () => {},
  };
};

// SSD1306 OLED on the hardware I2C bus at 0x3C: the parser lives in
// displayModels.js; the React layer renders the raw framebuffer.
const createOled = (record, runner) => {
  const oled = createSsd1306();
  runner.registerI2cSlave(0x3c, oled.i2cSlave);
  return {
    observe: () => ({
      fb: oled.framebuffer,
      fbVersion: oled.state.version,
      on: oled.state.on,
      invert: oled.state.invert,
    }),
    level: () => 1, // SDA/SCL idle high
    dispose: () => {},
  };
};

// PCF8574-backpack HD44780 16×2 at 0x27.
const createLcd = (record, runner) => {
  const lcd = createHd44780();
  runner.registerI2cSlave(0x27, lcd.i2cSlave);
  return {
    observe: () => ({
      lines: lcd.lines(),
      backlight: lcd.state.backlight,
      displayOn: lcd.state.displayOn,
      lcdVersion: lcd.state.version,
    }),
    level: () => 1,
    dispose: () => {},
  };
};

// 74HC595: SRCLK rising shifts SER in (MSB-first as shiftOut produces),
// RCLK rising latches to the outputs. OE high forces outputs low (Hi-Z
// approximated as 0 — real circuits tie OE low); SRCLR low clears.
const createShiftRegister = (record, runner) => {
  let shiftReg = 0;
  let latch = 0;
  const pinLevel = (unoPin) => {
    const state = runner.pinState(unoPin);
    return state.mode === 'output' && state.high ? 1 : 0;
  };
  const enabled = () => (record.pins.OE ? pinLevel(record.pins.OE) === 0 : true);
  const unwatchers = [];
  unwatchers.push(pinWatch(runner, record.pins.SRCLK, ({ mode, high }) => {
    if (mode !== 'output' || !high) return; // rising edges only
    if (record.pins.SRCLR && pinLevel(record.pins.SRCLR) === 0) {
      shiftReg = 0;
      return;
    }
    shiftReg = ((shiftReg << 1) | pinLevel(record.pins.SER)) & 0xff;
  }));
  unwatchers.push(pinWatch(runner, record.pins.RCLK, ({ mode, high }) => {
    if (mode === 'output' && high) latch = shiftReg;
  }));
  // Output naming: QH received the FIRST shifted bit (bit 7 after 8 shifts),
  // QA the last — matching shiftOut(..., MSBFIRST, value) semantics where
  // bit 7 of `value` lands on QH.
  const OUTPUT_BIT = { QA: 0, QB: 1, QC: 2, QD: 3, QE: 4, QF: 5, QG: 6, QH: 7 };
  return {
    observe: () => ({ latch }),
    level: (pinName) => {
      if (pinName === 'QH2') return (shiftReg >> 7) & 1;
      if (!enabled()) return 0;
      return (latch >> (OUTPUT_BIT[pinName] ?? 0)) & 1;
    },
    dispose: () => unwatchers.forEach((unwatch) => unwatch()),
  };
};

// 4×4 matrix keypad crossbar. The stock Keypad library drives COLUMNS as
// OUTPUT LOW one at a time and reads ROWS as INPUT_PULLUP, so on any column
// write (or key change) we recompute every row input.
const KEYPAD_LEGEND = [
  ['1', '2', '3', 'A'],
  ['4', '5', '6', 'B'],
  ['7', '8', '9', 'C'],
  ['*', '0', '#', 'D'],
]; // must match KEYPAD_LEGEND in parts.jsx

const createKeypad = (record, runner) => {
  const pressed = new Set();
  const columnLow = (colIndex) => {
    const state = runner.pinState(record.pins[`C${colIndex + 1}`]);
    return state.mode === 'output' && !state.high;
  };
  const recompute = () => {
    for (let row = 0; row < 4; row += 1) {
      const shorted = KEYPAD_LEGEND[row].some((key, col) => pressed.has(key) && columnLow(col));
      runner.setDigitalInput(record.pins[`R${row + 1}`], !shorted);
    }
  };
  const unwatchers = [1, 2, 3, 4].map((col) => pinWatch(runner, record.pins[`C${col}`], recompute));
  recompute(); // rows idle high
  return {
    observe: () => ({ pressed: [...pressed] }),
    level: () => 1,
    onControl: (name, value) => {
      if (!name.startsWith('key_')) return;
      const key = name.slice(4);
      if (value) pressed.add(key);
      else pressed.delete(key);
      recompute();
    },
    dispose: () => unwatchers.forEach((unwatch) => unwatch()),
  };
};

// One simulated device per I2C address: the engine warns and skips later
// claimants (IMU and RTC both live at 0x68 in the real world too).
export const I2C_ADDRESS_BY_KIND = {
  oled_display: 0x3c,
  lcd_display: 0x27,
  imu_sensor: 0x68,
  rtc_module: 0x68,
  baro_sensor: 0x76,
};

// MPU6050 register slave; pitch/roll sliders orient the gravity vector.
const createImu = (record, runner, controlState) => {
  const mpu = createMpu6050(new Proxy({}, {
    get: (_, key) => controlState.get(record.owner)?.[key],
  }));
  runner.registerI2cSlave(0x68, mpu.i2cSlave);
  return { observe: () => ({}), level: () => 1, dispose: () => {} };
};

// DS3231 register slave; time rolls forward with the AVR cycle clock.
const createRtc = (record, runner) => {
  const rtc = createDs3231(() => runner.cpu.cycles);
  runner.registerI2cSlave(0x68, rtc.i2cSlave);
  return { observe: () => ({ text: rtc.text() }), level: () => 1, dispose: () => {} };
};

// BMP280 register slave; temperature/pressure sliders drive the raw ADC
// registers through the degenerate-calibration linear maps.
const createBaro = (record, runner, controlState) => {
  const bmp = createBmp280(new Proxy({}, {
    get: (_, key) => controlState.get(record.owner)?.[key],
  }));
  runner.registerI2cSlave(0x76, bmp.i2cSlave);
  return { observe: () => ({}), level: () => 1, dispose: () => {} };
};

// MCP3008 on the SPI bus; channel voltages arrive from the engine's lockstep
// feedback (the module's CH0-7 pins read live circuit nets).
const createAdcModule = (record, runner) => {
  const channelVolts = new Array(8).fill(0);
  const mcp = createMcp3008((channel) => channelVolts[channel]);
  runner.registerSpiDevice(record.pins.CS, mcp.spiDevice);
  return {
    observe: () => ({}),
    level: () => 1,
    setChannelVolts: (channel, volts) => {
      channelVolts[channel] = volts;
    },
    dispose: () => {},
  };
};

// WS2812 strip: decode the bit-banged DIN stream from cycle-timestamped
// port writes into RGB pixels.
const createLedStrip = (record, runner) => {
  const decoder = createWs2812Decoder({ maxPixels: 30 });
  const unwatch = pinWatch(runner, record.pins.DIN, ({ mode, high }, cycles) => {
    if (mode === 'output') decoder.edge(high, cycles);
  });
  return {
    observe: () => {
      decoder.commitIfIdle(runner.cpu.cycles);
      return { pixels: decoder.state.pixels, pixelVersion: decoder.state.version };
    },
    level: () => 0,
    dispose: unwatch,
  };
};

const FACTORIES = {
  servo: createServo,
  ultrasonic_sensor: createUltrasonic,
  dht_sensor: createDht,
  rotary_encoder: createEncoder,
  oled_display: createOled,
  lcd_display: createLcd,
  shift_register: createShiftRegister,
  keypad: createKeypad,
  imu_sensor: createImu,
  rtc_module: createRtc,
  baro_sensor: createBaro,
  adc_module: createAdcModule,
  led_strip: createLedStrip,
};

export const createPeripheral = (record, runner, controlState) =>
  FACTORIES[record.kind]?.(record, runner, controlState) ?? null;
