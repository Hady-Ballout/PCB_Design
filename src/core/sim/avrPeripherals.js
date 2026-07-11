// Protocol-module peripherals for the Arduino bridge. Their timing (10 µs
// TRIG pulses, 26/70 µs DHT bits, µs-precision servo PWM) is far finer than
// the 20 µs MNA lockstep, so they talk to the AVR at cycle resolution:
// AVRIOPort listeners catch MCU port writes, cpu.addClockEvent + port.setPin
// deliver timed responses. The MNA engine stays the electrical truth; the
// engine reads each module's current output level for display-only branches.
import { UNO_PIN_MAP, AVR_CLOCK_HZ } from './avrRunner.js';

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

const FACTORIES = {
  servo: createServo,
  ultrasonic_sensor: createUltrasonic,
  dht_sensor: createDht,
  rotary_encoder: createEncoder,
};

export const createPeripheral = (record, runner, controlState) =>
  FACTORIES[record.kind]?.(record, runner, controlState) ?? null;
