// circuit JSON → primitive simulation netlist. Mirrors the electrical
// treatment of toSpice() in pcbGenerator.js (same expansions, same model
// parameters, same leg-skipping rules for compound kinds) so the live sim and
// the ngspice waveform page tell the same story.

import { MCU_KINDS, WIRING_ONLY_KINDS, kindLabel } from '../componentKinds.js';
import {
  parseAmps,
  parseFarads,
  parseHenries,
  parseOhms,
  parseSourceWaveform,
  parseVolts,
  regulatorVolts,
  zenerVolts,
} from './simValues.js';

export const GROUND = -1;

const isUnconnectedTerminal = (node, ref, pin) =>
  /^NC_/i.test(String(node)) || String(node) === `${ref}_${pin}`;

// Diode junction parameters straight from the toSpice .model lines. Series
// resistance is expanded into a real resistor + internal node by this module,
// so the device solver only ever sees ideal junctions.
const DIODE_MODELS = {
  DGEN: { is: 1e-14, n: 1, rs: 1 },
  DRED: { is: 1e-20, n: 2, rs: 10, bv: 5, ibv: 10e-6 },
  DGRN: { is: 1e-20, n: 2, rs: 10, bv: 5, ibv: 10e-6 },
  DBLU: { is: 1e-20, n: 2, rs: 10, bv: 5, ibv: 10e-6 },
  DSCH: { is: 1e-8, n: 1.05, rs: 0.5, bv: 40, ibv: 1e-6 },
  // PC817 optocoupler input LED (mirrors the DOPTOLED subcircuit model).
  DOPTOLED: { is: 1e-16, n: 1.8, rs: 2 },
};

const SEVEN_SEGMENT_SEGMENTS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'DP'];

// Wiring-only registry kinds that nevertheless get behavioral models: the
// relay, the Tier-2a stimulus-driven analog sensors (their outputs are
// plain voltages/switches, so they work without MCU firmware), and the
// Tier-2c driver/motion modules (their pins are switched by node voltages).
const SIMULATED_MODULE_KINDS = new Set([
  'relay_module', 'temp_sensor', 'pir_sensor', 'soil_moisture', 'gas_sensor', 'sound_sensor', 'hall_sensor',
  'stepper_driver', 'stepper_motor', 'motor_driver',
]);

// Protocol modules that ride the Arduino firmware bridge at cycle resolution
// (avrPeripherals.js). Simulated only when their protocol pins are wired
// DIRECTLY to the firmware-carrying Uno's signal pins — a series resistor
// between module and pin breaks the net-identity discovery.
const AVR_PERIPHERAL_KINDS = new Set([
  'servo', 'ultrasonic_sensor', 'dht_sensor', 'rotary_encoder',
  'oled_display', 'lcd_display', 'shift_register', 'keypad',
  'imu_sensor', 'rtc_module', 'baro_sensor', 'adc_module', 'led_strip',
]);

// Protocol pins per kind: which the MCU drives vs the module drives, which
// are required to attach, and — for module-driven pins — the Thevenin
// resistance of the display/drive branch (1 kΩ display presence by default;
// the 595's outputs drive real load current so they get 50 Ω).
const PERIPHERAL_PIN_SPECS = {
  // `ownsInputs`: Uno pins whose digital input level the peripheral sets at
  // cycle resolution — the engine must NOT overwrite them from net voltages
  // in the lockstep feedback (the crossbar/protocol is the source of truth).
  servo: { required: ['SIG'], moduleDriven: [] },
  ultrasonic_sensor: { required: ['TRIG', 'ECHO'], moduleDriven: ['ECHO'], ownsInputs: ['ECHO'] },
  dht_sensor: { required: ['DATA'], moduleDriven: ['DATA'], ownsInputs: ['DATA'] },
  rotary_encoder: { required: ['CLK', 'DT'], optional: ['SW'], moduleDriven: ['CLK', 'DT', 'SW'], ownsInputs: ['CLK', 'DT', 'SW'] },
  // I2C displays ride the hardware TWI pins only (SDA↔A4, SCL↔A5).
  oled_display: { required: ['SCL', 'SDA'], moduleDriven: ['SDA', 'SCL'], i2c: true },
  lcd_display: { required: ['SDA', 'SCL'], moduleDriven: ['SDA', 'SCL'], i2c: true },
  shift_register: {
    required: ['SER', 'SRCLK', 'RCLK'],
    optional: ['OE', 'SRCLR'],
    // Outputs drive real current (LEDs / 7-seg segments) behind ~50 Ω; they
    // connect to arbitrary nets, not Uno pins (handled separately below).
    moduleDriven: [],
    outputs: ['QA', 'QB', 'QC', 'QD', 'QE', 'QF', 'QG', 'QH', 'QH2'],
    driveOhms: 50,
  },
  keypad: {
    required: ['R1', 'R2', 'R3', 'R4', 'C1', 'C2', 'C3', 'C4'],
    // Rows live purely in the digital side-channel (the matrix stays
    // electrically untouched — the crossbar owns the row input levels).
    moduleDriven: [],
    ownsInputs: ['R1', 'R2', 'R3', 'R4'],
  },
  // Register-map I2C sensors (hardware TWI pins only, like the displays).
  imu_sensor: { required: ['SDA', 'SCL'], moduleDriven: ['SDA', 'SCL'], i2c: true },
  rtc_module: { required: ['SDA', 'SCL'], moduleDriven: ['SDA', 'SCL'], i2c: true },
  baro_sensor: { required: ['SDA', 'SCL'], moduleDriven: ['SDA', 'SCL'], i2c: true },
  // MCP3008 rides hardware SPI: DIN↔MOSI(D11), DOUT↔MISO(D12), CLK↔SCK(D13);
  // CS may be any Uno pin. CH0-7 read live circuit nets (no branches).
  adc_module: { required: ['CS', 'DIN', 'DOUT', 'CLK'], moduleDriven: [], spi: true },
  // WS2812 strip: the MCU bit-bangs DIN; no display branch needed (the
  // mcu_pin branch already drives the net electrically).
  led_strip: { required: ['DIN'], moduleDriven: [] },
};

// Module pin-name → fixedPins index (protocol pins only).
const PERIPHERAL_PIN_INDEX = {
  servo: { SIG: 2 }, // [VCC, GND, SIG]
  ultrasonic_sensor: { TRIG: 1, ECHO: 2 }, // [VCC, TRIG, ECHO, GND]
  dht_sensor: { DATA: 1 }, // [VCC, DATA, GND]
  rotary_encoder: { CLK: 0, DT: 1, SW: 2 }, // [CLK, DT, SW, VCC, GND]
  oled_display: { SCL: 2, SDA: 3 }, // [VCC, GND, SCL, SDA]
  lcd_display: { SDA: 2, SCL: 3 }, // [GND, VCC, SDA, SCL]
  // DIP-16 physical order: [QB..QH, GND, QH2, SRCLR, SRCLK, RCLK, OE, SER, QA, VCC]
  shift_register: {
    SER: 13, SRCLK: 10, RCLK: 11, OE: 12, SRCLR: 9,
    QA: 14, QB: 0, QC: 1, QD: 2, QE: 3, QF: 4, QG: 5, QH: 6, QH2: 8,
  },
  keypad: { R1: 0, R2: 1, R3: 2, R4: 3, C1: 4, C2: 5, C3: 6, C4: 7 },
  imu_sensor: { SCL: 2, SDA: 3 }, // [VCC, GND, SCL, SDA]
  rtc_module: { SDA: 2, SCL: 3 }, // [GND, VCC, SDA, SCL]
  baro_sensor: { SCL: 2, SDA: 3 }, // [VCC, GND, SCL, SDA]
  // MCP3008 DIP-16: [CH0..CH7, DGND, CS, DIN, DOUT, CLK, AGND, VREF, VDD]
  adc_module: { CS: 9, DIN: 10, DOUT: 11, CLK: 12 },
  led_strip: { DIN: 1 }, // [VCC, DIN, GND]
};

const KEYPAD_KEYS = ['1', '2', '3', 'A', '4', '5', '6', 'B', '7', '8', '9', 'C', '*', '0', '#', 'D'];

const regulatorOutputNode = (nodes = []) => nodes.find((node) => /^v?out/i.test(node)) || nodes.at(-1) || 'VOUT';

// Uno signal-pin names in fixedPins positional order (after 5V/3V3/GND/VIN).
const UNO_SIGNAL_PINS = [
  ...Array.from({ length: 14 }, (_, i) => `D${i}`),
  ...Array.from({ length: 6 }, (_, i) => `A${i}`),
];

export const buildSimNetlist = (circuit, options = {}) => {
  const { mcuRef = null } = options;
  const components = circuit?.components ?? [];
  const devices = [];
  const controls = [];
  const warnings = [];
  const nodeIndex = new Map();
  let branchCount = 0;
  // net name → Uno pin name, built while emitting the firmware Uno's pins;
  // resolved against protocol-module pins in the post-loop pass.
  const mcuPinByNet = new Map();
  const peripheralCandidates = [];

  const warnOnce = (code, message) => {
    if (!warnings.some((entry) => entry.code === code && entry.message === message)) {
      warnings.push({ code, message });
    }
  };

  const indexOf = (net) => {
    const name = String(net);
    if (name === '0') return GROUND;
    if (!nodeIndex.has(name)) nodeIndex.set(name, nodeIndex.size);
    return nodeIndex.get(name);
  };

  // Internal nodes (diode series resistance) never correspond to a circuit
  // net; give them names that cannot collide with user nets.
  const internalNode = (id) => indexOf(`__int_${id}`);

  const addResistor = (id, owner, kind, n1, n2, ohms) => {
    devices.push({ type: 'resistor', id, owner, kind, n1, n2, ohms });
  };

  const addVariableResistor = (id, owner, kind, n1, n2, model, params) => {
    devices.push({ type: 'vres', id, owner, kind, n1, n2, model, params });
  };

  const addVsource = (id, owner, kind, np, nm, waveform) => {
    devices.push({ type: 'vsource', id, owner, kind, np, nm, branch: branchCount, waveform });
    branchCount += 1;
  };

  const addDiode = (id, owner, kind, anodeNet, cathodeNet, modelName, channel = null) => {
    const model = modelName.startsWith('DZEN')
      ? { is: 1e-14, n: 1, rs: 1, bv: zenerVolts(modelName.replace('DZEN:', '')), ibv: 5e-3 }
      : DIODE_MODELS[modelName];
    const anode = indexOf(anodeNet);
    const cathode = indexOf(cathodeNet);
    if (model.rs > 0) {
      const int = internalNode(id);
      addResistor(`${id}__rs`, owner, 'diode_rs', anode, int, model.rs);
      devices.push({ type: 'diode', id, owner, kind, anode: int, cathode, model, channel });
    } else {
      devices.push({ type: 'diode', id, owner, kind, anode, cathode, model, channel });
    }
  };

  for (const part of components) {
    const { ref, kind, value } = part;
    const nodes = part.nodes ?? [];
    const [a, b, c, d] = nodes;

    if (MCU_KINDS.has(kind)) {
      // The Uno carrying firmware becomes a live device: powered rails plus a
      // bridged branch per connected signal pin (mode set each step from the
      // avr8js pin states). Other boards — and firmware-less Unos — float.
      if (kind === 'arduino_uno' && ref === mcuRef) {
        // Internal 5 V reference always exists (USB power); 0.5 Ω series on
        // the exposed power pins so a parallel user battery can't make two
        // ideal sources fight.
        const fiveV = internalNode(`${ref}_5V`);
        addVsource(`${ref}_5V`, ref, 'mcu_power', fiveV, GROUND, parseSourceWaveform('DC 5'));
        if (!isUnconnectedTerminal(nodes[0], ref, 1)) {
          addResistor(`${ref}_5V__rs`, ref, 'mcu_power_rs', fiveV, indexOf(nodes[0]), 0.5);
        }
        if (!isUnconnectedTerminal(nodes[1], ref, 2)) {
          const threeV = internalNode(`${ref}_3V3`);
          addVsource(`${ref}_3V3`, ref, 'mcu_power', threeV, GROUND, parseSourceWaveform('DC 3.3'));
          addResistor(`${ref}_3V3__rs`, ref, 'mcu_power_rs', threeV, indexOf(nodes[1]), 0.5);
        }
        if (!isUnconnectedTerminal(nodes[2], ref, 3) && indexOf(nodes[2]) !== GROUND) {
          // Tie the GND pin's net to global ground — unless it already IS
          // net '0', where a 0 V ground-to-ground branch would be degenerate.
          addVsource(`${ref}_GND`, ref, 'mcu_power', indexOf(nodes[2]), GROUND, parseSourceWaveform('DC 0'));
        }
        UNO_SIGNAL_PINS.forEach((unoPin, index) => {
          const pinIndex = index + 4; // after 5V/3V3/GND/VIN
          const node = nodes[pinIndex];
          if (node == null || isUnconnectedTerminal(node, ref, pinIndex + 1)) return;
          mcuPinByNet.set(String(node), unoPin);
          const int = internalNode(`${ref}_${unoPin}`);
          addResistor(`${ref}_${unoPin}__ro`, ref, 'mcu_pin_ro', int, indexOf(node), 40);
          devices.push({
            type: 'mcu_pin', id: `${ref}_${unoPin}`, owner: ref, kind,
            unoPin, net: indexOf(node), int, fiveV,
            adcChannel: unoPin.startsWith('A') ? Number(unoPin.slice(1)) : null,
            branch: branchCount, mode: 'input', level: 0,
          });
          branchCount += 1;
        });
        continue;
      }
      warnOnce(
        kind === 'arduino_uno' ? 'mcu_no_firmware' : 'mcu_not_simulated',
        kind === 'arduino_uno'
          ? `${ref} (${kindLabel(kind)}) has no firmware — its pins float; write a sketch in the Code tab`
          : `${ref} (${kindLabel(kind)}) is not simulated — its pins float`,
      );
      continue;
    }
    // Most wiring-only modules stay unsimulated (they need MCU firmware to be
    // meaningful), but a few carry behavioral models: the relay, the
    // stimulus-driven analog sensors, and — when a firmware Uno is present —
    // the protocol modules resolved in the post-loop pass below.
    if (WIRING_ONLY_KINDS.has(kind) && !SIMULATED_MODULE_KINDS.has(kind)) {
      if (AVR_PERIPHERAL_KINDS.has(kind) && mcuRef) {
        peripheralCandidates.push(part);
        continue;
      }
      warnOnce('module_not_simulated', `${ref} (${kindLabel(kind)}) is a wiring-only module — not simulated`);
      continue;
    }

    switch (kind) {
      case 'resistor':
      case 'load':
        addResistor(ref, ref, kind, indexOf(a), indexOf(b), parseOhms(value, 1e3));
        break;
      case 'buzzer':
        addResistor(ref, ref, kind, indexOf(a), indexOf(b), parseOhms(value, 1e3));
        break;
      case 'dc_motor':
        addResistor(ref, ref, kind, indexOf(a), indexOf(b), parseOhms(value, 10));
        break;
      case 'vibration_motor':
        addResistor(ref, ref, kind, indexOf(a), indexOf(b), parseOhms(value, 27));
        break;
      case 'fuse':
        // Ratings like "1A" don't parse as a resistance → 50 mΩ, like toSpice.
        // The rating drives the i²t blow rule (event state); a resistance-style
        // value falls back to a 1 A rating.
        addResistor(ref, ref, kind, indexOf(a), indexOf(b), parseOhms(value, 0.05));
        Object.assign(devices.at(-1), {
          ratingAmps: parseAmps(value, 1),
          state: { blown: false, overSince: null },
        });
        break;
      case 'capacitor':
        devices.push({ type: 'capacitor', id: ref, owner: ref, n1: indexOf(a), n2: indexOf(b), farads: parseFarads(value, 1e-6) });
        break;
      case 'crystal':
        devices.push({ type: 'capacitor', id: ref, owner: ref, n1: indexOf(a), n2: indexOf(b), farads: 20e-12 });
        break;
      case 'inductor':
        devices.push({ type: 'inductor', id: ref, owner: ref, n1: indexOf(a), n2: indexOf(b), henries: parseHenries(value, 1e-3) });
        break;
      case 'voltage_source':
        addVsource(ref, ref, kind, indexOf(a), indexOf(b), parseSourceWaveform(`DC ${parseVolts(value, 5)}`));
        break;
      case 'solar_panel': {
        // Real small panels sag under load: ideal source behind ~5 Ω.
        // (toSpice emits an ideal source — intentional sim divergence.)
        const int = internalNode(ref);
        addVsource(ref, ref, kind, int, indexOf(b), parseSourceWaveform(`DC ${parseVolts(value, 5)}`));
        addResistor(`${ref}__rs`, ref, 'solar_rs', int, indexOf(a), 5);
        break;
      }
      case 'signal_source': {
        const waveform = parseSourceWaveform(value);
        if (waveform.warning) warnOnce('source_value', `${ref}: ${waveform.warning} — treating as 0V`);
        addVsource(ref, ref, kind, indexOf(a), indexOf(b), waveform);
        break;
      }
      case 'regulator': {
        const inConnected = !isUnconnectedTerminal(a, ref, 1);
        if (!inConnected) {
          warnOnce('regulator_unpowered', `${ref} (${kindLabel(kind)}) has no input supply wired — output modeled as ideal anyway`);
        }
        const vnom = regulatorVolts(value);
        addVsource(ref, ref, kind, indexOf(regulatorOutputNode(nodes)), GROUND, parseSourceWaveform(`DC ${vnom}`));
        // Dropout sensing (event-updated): output tracks min(vnom, vIN − 1.5)
        // when the input pin is wired; an unpowered regulator stays ideal to
        // match toSpice (warning above covers the realism gap).
        Object.assign(devices.at(-1), { inNode: inConnected ? indexOf(a) : null, vnom });
        break;
      }
      case 'diode':
        addDiode(ref, ref, kind, a, b, 'DGEN');
        break;
      case 'led':
        addDiode(ref, ref, kind, a, b, 'DRED');
        break;
      case 'schottky':
        addDiode(ref, ref, kind, a, b, 'DSCH');
        break;
      case 'zener':
        addDiode(ref, ref, kind, a, b, `DZEN:${value ?? ''}`);
        break;
      case 'rgb_led': {
        const models = { R: 'DRED', G: 'DGRN', B: 'DBLU' };
        ['R', 'G', 'B'].forEach((channel, index) => {
          const anode = nodes[index];
          if (isUnconnectedTerminal(anode, ref, index + 1) || isUnconnectedTerminal(d, ref, 4)) return;
          addDiode(`${ref}_${channel}`, ref, kind, anode, d, models[channel], channel);
        });
        break;
      }
      case 'seven_segment': {
        const com = nodes[8];
        SEVEN_SEGMENT_SEGMENTS.forEach((segment, index) => {
          const anode = nodes[index];
          if (!anode || !com) return;
          if (isUnconnectedTerminal(anode, ref, index + 1) || isUnconnectedTerminal(com, ref, 9)) return;
          addDiode(`${ref}_${segment}`, ref, kind, anode, com, 'DRED', segment);
        });
        break;
      }
      case 'bridge_rectifier': {
        const legs = [['A', a, c, 1, 3], ['B', b, c, 2, 3], ['C', d, a, 4, 1], ['D', d, b, 4, 2]];
        legs.forEach(([suffix, anode, cathode, anodePin, cathodePin]) => {
          if (isUnconnectedTerminal(anode, ref, anodePin) || isUnconnectedTerminal(cathode, ref, cathodePin)) return;
          addDiode(`${ref}_${suffix}`, ref, kind, anode, cathode, 'DGEN');
        });
        break;
      }
      case 'current_sensor': {
        const shuntConnected = !isUnconnectedTerminal(a, ref, 1) && !isUnconnectedTerminal(b, ref, 2);
        if (shuntConnected) {
          addResistor(`${ref}_S`, ref, kind, indexOf(a), indexOf(b), 0.0012);
        }
        // ACS712 analog output: 2.5 V + 185 mV/A, event-updated from the shunt
        // current. Only driven when the module is actually powered and wired.
        // (toSpice emits no OUT drive — intentional sim divergence.)
        const [, , vccNet, outNet, gndNet] = nodes;
        if (shuntConnected
          && !isUnconnectedTerminal(vccNet, ref, 3)
          && !isUnconnectedTerminal(outNet, ref, 4)
          && !isUnconnectedTerminal(gndNet, ref, 5)) {
          devices.push({
            type: 'sensor_out', id: `${ref}_OUT`, owner: ref, kind,
            out: indexOf(outNet), gnd: indexOf(gndNet), shuntId: `${ref}_S`,
            branch: branchCount, overrideVolts: 2.5,
          });
          branchCount += 1;
        }
        break;
      }
      case 'temp_sensor': // [VCC, OUT, GND] — TMP36 analog out
        if (!isUnconnectedTerminal(b, ref, 2)) {
          devices.push({
            type: 'sensor_source', id: `${ref}_OUT`, owner: ref, kind,
            out: indexOf(b), gnd: indexOf(c), vcc: indexOf(a),
            law: 'tmp36', stimulusName: 'tempC', branch: branchCount, overrideVolts: 0,
          });
          branchCount += 1;
        }
        controls.push({ ref, kind, type: 'slider', name: 'tempC', min: -40, max: 125, step: 1, value: 25, label: 'Temperature (°C)' });
        break;
      case 'pir_sensor': // [VCC, OUT, GND] — motion toggle drives OUT
        if (!isUnconnectedTerminal(b, ref, 2)) {
          devices.push({
            type: 'sensor_source', id: `${ref}_OUT`, owner: ref, kind,
            out: indexOf(b), gnd: indexOf(c), vcc: indexOf(a),
            law: 'pir', stimulusName: 'motion', branch: branchCount, overrideVolts: 0,
          });
          branchCount += 1;
        }
        controls.push({ ref, kind, type: 'toggle', name: 'motion', value: 0 });
        break;
      case 'soil_moisture': // [VCC, GND, AOUT]
        if (!isUnconnectedTerminal(c, ref, 3)) {
          devices.push({
            type: 'sensor_source', id: `${ref}_AOUT`, owner: ref, kind,
            out: indexOf(c), gnd: indexOf(b), vcc: indexOf(a),
            law: 'soil', stimulusName: 'moisture', branch: branchCount, overrideVolts: 0,
          });
          branchCount += 1;
        }
        controls.push({ ref, kind, type: 'slider', name: 'moisture', min: 0, max: 1, step: 0.01, value: 0.3, label: 'Moisture' });
        break;
      case 'gas_sensor': // [VCC, GND, DO, AO]
      case 'sound_sensor': {
        const stimulusName = kind === 'gas_sensor' ? 'gas' : 'level';
        if (!isUnconnectedTerminal(c, ref, 3)) {
          devices.push({
            type: 'sensor_source', id: `${ref}_DO`, owner: ref, kind,
            out: indexOf(c), gnd: indexOf(b), vcc: indexOf(a),
            law: 'module_do', stimulusName, branch: branchCount, overrideVolts: 0,
          });
          branchCount += 1;
        }
        if (!isUnconnectedTerminal(d, ref, 4)) {
          devices.push({
            type: 'sensor_source', id: `${ref}_AO`, owner: ref, kind,
            out: indexOf(d), gnd: indexOf(b), vcc: indexOf(a),
            law: 'module_ao', stimulusName, branch: branchCount, overrideVolts: 0,
          });
          branchCount += 1;
        }
        controls.push({
          ref, kind, type: 'slider', name: stimulusName, min: 0, max: 1, step: 0.01, value: 0.1,
          label: kind === 'gas_sensor' ? 'Gas level' : 'Sound level',
        });
        break;
      }
      case 'hall_sensor': // [VCC, GND, OUT] — open-collector, needs a pull-up
        addVariableResistor(`${ref}_OC`, ref, kind, indexOf(c), indexOf(b), 'hall_switch', {});
        controls.push({ ref, kind, type: 'toggle', name: 'magnet', value: 0 });
        break;
      case 'relay_module': {
        // [VCC, GND, IN, COM, NO, NC]: energized closes COM–NO, idle rests on
        // COM–NC; the coil loads the supply when energized.
        devices.push({
          type: 'relay', id: ref, owner: ref, kind,
          vcc: indexOf(a), gnd: indexOf(b), in: indexOf(c),
          com: indexOf(nodes[3]), no: indexOf(nodes[4]), nc: indexOf(nodes[5]),
          state: { energized: false },
        });
        break;
      }
      case 'stepper_driver': {
        // ULN2003: four independent open-collector Darlington switches. Each
        // OUT is pulled to GND (~10 Ω, ≈0.9 V sat across a 50 Ω coil) while
        // its IN reads high; the event update in simEngine flips the state
        // from the solved IN node voltages (2.5 V on / 2.3 V off hysteresis).
        // fixedPins: [IN1, IN2, IN3, IN4, VCC, GND, OUTA, OUTB, OUTC, OUTD].
        const gndNode = indexOf(nodes[5]);
        const ins = [0, 1, 2, 3].map((i) =>
          (isUnconnectedTerminal(nodes[i], ref, i + 1) ? null : indexOf(nodes[i])));
        const outs = [6, 7, 8, 9].map((i) =>
          (isUnconnectedTerminal(nodes[i], ref, i + 1) ? null : indexOf(nodes[i])));
        // High-value input ties (the timer_555 tie pattern) so floating or
        // input-mode-GPIO INs solve cleanly instead of drifting.
        ins.forEach((node, i) => {
          if (node != null) addResistor(`${ref}__tin${i + 1}`, ref, 'stepper_driver_tie', node, gndNode, 10e3);
        });
        devices.push({
          type: 'stepper_driver', id: ref, owner: ref, kind,
          in: ins, gnd: gndNode, out: outs,
          state: { on: [false, false, false, false] },
        });
        break;
      }
      case 'stepper_motor': {
        // 28BYJ-48: four ~50 Ω windings from the +V common to A/B/C/D, plus a
        // stamp-less tracker that accumulates shaft angle from the energized-
        // coil sequence (event-updated in simEngine; the output shaft turns
        // 360/4096 ° per half step through the 64:1 gearbox).
        // fixedPins: [A, B, C, D, COM].
        if (isUnconnectedTerminal(nodes[4], ref, 5)) break; // no common, no circuit
        const com = indexOf(nodes[4]);
        const coilOhms = parseOhms(value, 50);
        const coils = [0, 1, 2, 3].map((i) => {
          if (isUnconnectedTerminal(nodes[i], ref, i + 1)) return null;
          const node = indexOf(nodes[i]);
          addResistor(`${ref}_${'ABCD'[i]}`, ref, kind, com, node, coilOhms);
          return node;
        });
        devices.push({
          type: 'stepper_motor', id: `${ref}_TRK`, owner: ref, kind,
          coils, com,
          state: { patternIndex: null, halfSteps: 0, angle: 0 },
        });
        break;
      }
      case 'motor_driver': {
        // L298N: two independent H-bridge channels, event-updated from the
        // solved EN/IN node voltages. Each OUT switches to the VS or GND net
        // through 2 Ω when its channel is enabled (≈2 V total bridge drop at
        // 1 A across a pair — close to the real L298), floats (10 MΩ) when
        // disabled. Unwired EN pins default enabled — real boards ship with
        // the EN jumpers on.
        // fixedPins: [VS, GND, ENA, IN1, IN2, ENB, IN3, IN4, OUT1..OUT4].
        const idx = (i) => (isUnconnectedTerminal(nodes[i], ref, i + 1) ? null : indexOf(nodes[i]));
        const vs = idx(0);
        const gndNode = indexOf(nodes[1]);
        // High-value ties keep floating/input-mode control pins solvable, and
        // the board's own electronics load VS quiescently.
        [2, 3, 4, 5, 6, 7].forEach((i) => {
          const node = idx(i);
          if (node != null) addResistor(`${ref}__t${i + 1}`, ref, 'motor_driver_tie', node, gndNode, 10e3);
        });
        if (vs != null) addResistor(`${ref}__q`, ref, 'motor_driver_tie', vs, gndNode, 10e3);
        devices.push({
          type: 'motor_driver', id: ref, owner: ref, kind, vs, gnd: gndNode,
          channels: [
            { en: idx(2), enConnected: idx(2) != null, inA: idx(3), inB: idx(4), outA: idx(8), outB: idx(9) },
            { en: idx(5), enConnected: idx(5) != null, inA: idx(6), inB: idx(7), outA: idx(10), outB: idx(11) },
          ],
          state: { ch: [{ en: true, inA: false, inB: false }, { en: true, inA: false, inB: false }] },
        });
        break;
      }
      case 'pushbutton':
        addVariableResistor(ref, ref, kind, indexOf(a), indexOf(b), 'pushbutton', {});
        controls.push({ ref, kind, type: 'momentary', name: 'pressed', value: 0 });
        break;
      case 'switch_spdt': {
        // [A, COM, B]: pin 2 is the common, matching the SPICE image.
        const com = indexOf(b);
        addVariableResistor(`${ref}_A`, ref, kind, com, indexOf(a), 'switch_throw', { throw: 'A' });
        addVariableResistor(`${ref}_B`, ref, kind, com, indexOf(c), 'switch_throw', { throw: 'B' });
        controls.push({ ref, kind, type: 'toggle', name: 'position', value: 'A' });
        break;
      }
      case 'potentiometer': {
        const total = parseOhms(value, 10e3);
        addVariableResistor(`${ref}_A`, ref, kind, indexOf(a), indexOf(b), 'pot_upper', { total });
        addVariableResistor(`${ref}_B`, ref, kind, indexOf(b), indexOf(c), 'pot_lower', { total });
        controls.push({ ref, kind, type: 'slider', name: 'wiper', min: 0, max: 1, step: 0.01, value: 0.5, label: 'Wiper' });
        break;
      }
      case 'photoresistor':
        addVariableResistor(ref, ref, kind, indexOf(a), indexOf(b), 'photoresistor', {});
        controls.push({ ref, kind, type: 'slider', name: 'light', min: 0, max: 1, step: 0.01, value: 0.55, label: 'Light' });
        break;
      case 'thermistor':
        addVariableResistor(ref, ref, kind, indexOf(a), indexOf(b), 'thermistor', { r25: parseOhms(value, 10e3) });
        controls.push({ ref, kind, type: 'slider', name: 'tempC', min: -20, max: 100, step: 1, value: 25, label: 'Temperature (°C)' });
        break;
      case 'bjt_npn':
      case 'bjt_pnp':
        // toSpice Q-line node order: collector, base, emitter.
        devices.push({
          type: 'bjt', id: ref, owner: ref, kind,
          c: indexOf(a), b: indexOf(b), e: indexOf(c),
          params: { is: 1e-14, bf: 200, br: 1 },
          polarity: kind === 'bjt_pnp' ? -1 : 1,
        });
        break;
      case 'mosfet_n':
      case 'mosfet_p':
        // toSpice M-line node order: drain, gate, source (bulk tied to source).
        devices.push({
          type: 'mosfet', id: ref, owner: ref, kind,
          d: indexOf(a), g: indexOf(b), s: indexOf(c),
          params: kind === 'mosfet_p' ? { kp: 10e-6, vto: 2, lambda: 0.01 } : { kp: 20e-6, vto: 2, lambda: 0.01 },
          polarity: kind === 'mosfet_p' ? -1 : 1,
        });
        break;
      case 'opamp': {
        // [IN+, IN-, OUT, V+, V-]. The branch drives an internal node behind
        // a real 100 Ω output resistance (the diode __rs pattern) so a
        // shorted output burns power in Ro instead of contradicting the matrix.
        const outInt = internalNode(`${ref}_out`);
        addResistor(`${ref}__ro`, ref, 'opamp_ro', outInt, indexOf(c), 100);
        devices.push({
          type: 'opamp', id: ref, owner: ref, kind,
          inp: indexOf(a), inn: indexOf(b), out: outInt,
          vcp: indexOf(d), vcm: indexOf(nodes[4]),
          branch: branchCount,
        });
        branchCount += 1;
        break;
      }
      case 'comparator':
        // Open-collector output: 30 Ω to the V- pin when low, 10 MΩ released.
        // (The LM393 SPICE subcircuit is push-pull; open-collector is the
        // physically correct LM393 behavior and what the topology rules'
        // pull-up expectations assume.)
        devices.push({
          type: 'comparator', id: ref, owner: ref, kind,
          inp: indexOf(a), inn: indexOf(b), out: indexOf(c), vcm: indexOf(nodes[4]),
          state: { low: false },
        });
        break;
      case 'timer_555': {
        // fixedPins: [GND, TRIG, OUT, RESET, CTRL, THRES, DISCH, VCC].
        const [gndNet, trigNet, outNet, resetNet, ctrlNet, thresNet, dischNet, vccNet] = nodes;
        const gnd = indexOf(gndNet);
        const ctrl = indexOf(ctrlNet);
        const vcc = indexOf(vccNet);
        // Real internal ladder seen from CTRL: v(CTRL) self-derives 2/3·VCC
        // and external CTRL parts shift the thresholds naturally.
        addResistor(`${ref}__lad1`, ref, 'timer_555_ladder', vcc, ctrl, 5e3);
        addResistor(`${ref}__lad2`, ref, 'timer_555_ladder', ctrl, gnd, 10e3);
        // High-value ties mirror the subcircuit's RTRIG/RRST so floating
        // control pins solve cleanly.
        addResistor(`${ref}__tt`, ref, 'timer_555_tie', indexOf(trigNet), gnd, 10e6);
        addResistor(`${ref}__th`, ref, 'timer_555_tie', indexOf(thresNet), gnd, 10e6);
        addResistor(`${ref}__tr`, ref, 'timer_555_tie', indexOf(resetNet), gnd, 10e6);
        const outInt = internalNode(`${ref}_out`);
        addResistor(`${ref}__ro`, ref, 'timer_555_ro', outInt, indexOf(outNet), 10);
        devices.push({
          type: 'timer_555', id: ref, owner: ref, kind,
          gnd, trig: indexOf(trigNet), out: outInt, reset: indexOf(resetNet),
          ctrl, thres: indexOf(thresNet), disch: indexOf(dischNet), vcc,
          resetConnected: !isUnconnectedTerminal(resetNet, ref, 4),
          branch: branchCount,
          state: { q: false },
        });
        branchCount += 1;
        break;
      }
      case 'optocoupler': {
        // [A, K, E, C]: input LED is a real NR diode; the output transistor is
        // an on/off switch keyed to the LED junction voltage, mirroring the
        // PC817 subcircuit (SW VT=1.1 VH=0.15, no CTR — beginner-facing).
        addDiode(`${ref}_LED`, ref, kind, a, b, 'DOPTOLED');
        devices.push({
          type: 'opto_out', id: `${ref}_CE`, owner: ref, kind,
          c: indexOf(d), e: indexOf(c), ledId: `${ref}_LED`,
          state: { on: false },
        });
        break;
      }
      default:
        warnOnce('kind_not_simulated', `${ref} (${kindLabel(kind)}) is not yet simulated — its pins float`);
        break;
    }
  }

  // Post-loop pass: attach protocol modules whose pins are wired directly to
  // the firmware Uno's signal pins (net-name identity — a series resistor
  // between module and pin breaks discovery, documented).
  for (const part of peripheralCandidates) {
    const spec = PERIPHERAL_PIN_SPECS[part.kind];
    const indexByName = PERIPHERAL_PIN_INDEX[part.kind];
    const pins = {};
    let wired = true;
    for (const name of [...spec.required, ...(spec.optional ?? [])]) {
      const node = part.nodes?.[indexByName[name]];
      const unoPin = node != null ? mcuPinByNet.get(String(node)) : undefined;
      if (unoPin) pins[name] = unoPin;
      else if (spec.required.includes(name)) wired = false;
    }
    // I2C devices ride the hardware TWI pins only: SDA must land on A4 and
    // SCL on A5 (Wire owns those; software-I2C wirings stay warned).
    if (wired && spec.i2c && !(pins.SDA === 'A4' && pins.SCL === 'A5')) wired = false;
    // SPI devices likewise need the hardware pins: DIN↔MOSI(D11),
    // DOUT↔MISO(D12), CLK↔SCK(D13); CS is any discovered Uno pin.
    if (wired && spec.spi && !(pins.DIN === 'D11' && pins.DOUT === 'D12' && pins.CLK === 'D13')) wired = false;
    if (!wired) {
      warnOnce('module_not_simulated', `${part.ref} (${kindLabel(part.kind)}) is a wiring-only module — not simulated`);
      continue;
    }
    const record = {
      type: 'avr_peripheral', id: part.ref, owner: part.ref, kind: part.kind, pins,
      ownedPins: (spec.ownsInputs ?? []).map((name) => pins[name]).filter(Boolean),
    };
    if (part.kind === 'adc_module') {
      // CH0-7 (fixedPins 0-7) read live circuit nets — inputs, no branches.
      record.channelNets = Array.from({ length: 8 }, (_, channel) => {
        const node = part.nodes?.[channel];
        return node == null || isUnconnectedTerminal(node, part.ref, channel + 1) ? null : indexOf(node);
      });
    }
    devices.push(record);
    if (part.kind === 'ultrasonic_sensor') {
      controls.push({ ref: part.ref, kind: part.kind, type: 'slider', name: 'distanceCm', min: 2, max: 400, step: 1, value: 50, label: 'Distance (cm)' });
    } else if (part.kind === 'dht_sensor') {
      controls.push({ ref: part.ref, kind: part.kind, type: 'slider', name: 'tempC', min: -40, max: 80, step: 1, value: 25, label: 'Temperature (°C)' });
      controls.push({ ref: part.ref, kind: part.kind, type: 'slider', name: 'humidity', min: 0, max: 100, step: 1, value: 40, label: 'Humidity (%)' });
    } else if (part.kind === 'rotary_encoder') {
      controls.push({ ref: part.ref, kind: part.kind, type: 'stepper', name: 'step', value: 0, label: 'Rotate' });
      if (pins.SW) controls.push({ ref: part.ref, kind: part.kind, type: 'button', name: 'sw', value: 0, label: 'Press' });
    } else if (part.kind === 'keypad') {
      // Unrendered by the stimulus panel — these exist so artwork clicks
      // route through setControl/controlState into the crossbar.
      for (const key of KEYPAD_KEYS) {
        controls.push({ ref: part.ref, kind: part.kind, type: 'matrix-key', name: `key_${key}`, value: 0 });
      }
    } else if (part.kind === 'imu_sensor') {
      controls.push({ ref: part.ref, kind: part.kind, type: 'slider', name: 'pitch', min: -90, max: 90, step: 1, value: 0, label: 'Pitch (°)' });
      controls.push({ ref: part.ref, kind: part.kind, type: 'slider', name: 'roll', min: -90, max: 90, step: 1, value: 0, label: 'Roll (°)' });
    } else if (part.kind === 'baro_sensor') {
      controls.push({ ref: part.ref, kind: part.kind, type: 'slider', name: 'tempC', min: -40, max: 85, step: 1, value: 25, label: 'Temperature (°C)' });
      controls.push({ ref: part.ref, kind: part.kind, type: 'slider', name: 'pressureHpa', min: 300, max: 1100, step: 1, value: 1013, label: 'Pressure (hPa)' });
    }
    // Display-only presence for module-driven pins: a weak (1 kΩ) Thevenin so
    // the legend/V-map track the digital level while the MCU's 40 Ω driver
    // still visibly wins any shared-net moments (e.g. the DHT start pulse).
    for (const name of spec.moduleDriven) {
      if (!pins[name]) continue;
      const node = part.nodes[indexByName[name]];
      const int = internalNode(`${part.ref}_${name}`);
      addResistor(`${part.ref}_${name}__rp`, part.ref, 'periph_pin_r', int, indexOf(node), 1000);
      devices.push({ type: 'periph_pin', id: `${part.ref}_${name}`, owner: part.ref, pinName: name, int, branch: branchCount });
      branchCount += 1;
    }
    // Real drive outputs (the 595's QA-QH/QH2): they power LEDs/segments on
    // arbitrary nets — not Uno pins — behind a stiffer Thevenin.
    for (const name of spec.outputs ?? []) {
      const node = part.nodes?.[indexByName[name]];
      if (node == null || isUnconnectedTerminal(node, part.ref, indexByName[name] + 1)) continue;
      const int = internalNode(`${part.ref}_${name}`);
      addResistor(`${part.ref}_${name}__rp`, part.ref, 'periph_pin_r', int, indexOf(node), spec.driveOhms ?? 50);
      devices.push({ type: 'periph_pin', id: `${part.ref}_${name}`, owner: part.ref, pinName: name, int, branch: branchCount });
      branchCount += 1;
    }
  }

  if (devices.length === 0) {
    return { ok: false, error: { code: 'nothing_to_simulate', message: 'No simulatable components in this circuit' }, devices, nodeIndex, nodeCount: nodeIndex.size, branchCount: 0, controls, warnings };
  }

  const touchesGround = components.some((part) =>
    !WIRING_ONLY_KINDS.has(part.kind)
    && (part.nodes ?? []).some((node) => String(node) === '0'))
    || devices.some((device) => device.np === GROUND || device.nm === GROUND);
  if (!touchesGround) {
    return { ok: false, error: { code: 'no_ground', message: 'Connect the circuit to GND (net 0) to simulate' }, devices, nodeIndex, nodeCount: nodeIndex.size, branchCount, controls, warnings };
  }

  const sources = devices.filter((device) => device.type === 'vsource');
  if (sources.length === 0) {
    return { ok: false, error: { code: 'no_source', message: 'Add a power source (battery, supply, or signal source) to simulate' }, devices, nodeIndex, nodeCount: nodeIndex.size, branchCount, controls, warnings };
  }
  const short = sources.find((device) => device.np === device.nm);
  if (short) {
    return { ok: false, error: { code: 'source_short', message: `${short.owner} is short-circuited — both terminals are on the same net` }, devices, nodeIndex, nodeCount: nodeIndex.size, branchCount, controls, warnings };
  }

  return { ok: true, error: null, devices, nodeIndex, nodeCount: nodeIndex.size, branchCount, controls, warnings };
};
