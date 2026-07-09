// Single source of truth for every supported component kind. The server AI
// schema/prompt, client-side circuit validation, SPICE ref prefixes, canvas
// symbol mapping, and the realistic-schematic pin tables all derive from this
// table — add a kind here first, then give it SPICE and breadboard support.
//
// Per-kind fields:
//   spicePrefix  SPICE-safe ref prefix the exporter enforces (R/C/L/D/V/Q/M/X/U)
//   pins         default pin count when a circuit doesn't spell out its nodes
//   symbolType   canvas symbol family ('generic' draws a labeled box)
//   label        human-readable name for UI copy
//   fixedPins    positional pin-name contract (MCU boards, modules, DIP ICs);
//                the AI must list nodes in exactly this order
//   wiringOnly   never appears in the SPICE deck (emitted as a comment line)
//   mcu          microcontroller board (off-board artwork, firmware target)

export const COMPONENT_KINDS = {
  resistor: { spicePrefix: 'R', pins: 2, symbolType: 'resistor', label: 'Resistor' },
  capacitor: { spicePrefix: 'C', pins: 2, symbolType: 'capacitor', label: 'Capacitor' },
  inductor: { spicePrefix: 'L', pins: 2, symbolType: 'inductor', label: 'Inductor' },
  diode: { spicePrefix: 'D', pins: 2, symbolType: 'diode', label: 'Diode' },
  led: { spicePrefix: 'D', pins: 2, symbolType: 'led', label: 'LED' },
  bjt_npn: { spicePrefix: 'Q', pins: 3, symbolType: 'bjt_npn', label: 'NPN transistor' },
  bjt_pnp: { spicePrefix: 'Q', pins: 3, symbolType: 'bjt_pnp', label: 'PNP transistor' },
  mosfet_n: { spicePrefix: 'M', pins: 3, symbolType: 'generic', label: 'N-channel MOSFET' },
  mosfet_p: { spicePrefix: 'M', pins: 3, symbolType: 'generic', label: 'P-channel MOSFET' },
  opamp: { spicePrefix: 'X', pins: 5, symbolType: 'opamp', label: 'Op amp' },
  // Exported to SPICE as an ideal DC source on its output node, hence the V.
  regulator: { spicePrefix: 'V', pins: 2, symbolType: 'generic', label: 'Voltage regulator' },
  voltage_source: { spicePrefix: 'V', pins: 2, symbolType: 'voltage_source', label: 'Voltage source' },
  signal_source: { spicePrefix: 'V', pins: 2, symbolType: 'voltage_source', label: 'Signal source' },
  load: { spicePrefix: 'R', pins: 2, symbolType: 'resistor', label: 'Load' },
  zener: { spicePrefix: 'D', pins: 2, symbolType: 'diode', label: 'Zener diode' },
  photoresistor: { spicePrefix: 'R', pins: 2, symbolType: 'resistor', label: 'Photoresistor (LDR)' },
  thermistor: { spicePrefix: 'R', pins: 2, symbolType: 'resistor', label: 'Thermistor' },
  // Simulated as a resistive load so the deck stays runnable.
  buzzer: { spicePrefix: 'R', pins: 2, symbolType: 'generic', label: 'Buzzer' },
  // Simulated as a small load capacitance stand-in.
  crystal: { spicePrefix: 'C', pins: 2, symbolType: 'generic', label: 'Crystal' },
  temp_sensor: {
    spicePrefix: 'U', pins: 3, symbolType: 'generic', label: 'Temperature sensor',
    wiringOnly: true,
    fixedPins: ['VCC', 'OUT', 'GND'],
  },
  comparator: { spicePrefix: 'X', pins: 5, symbolType: 'opamp', label: 'Comparator' },
  // Simulated in the unpressed (open) state as a very large resistance.
  pushbutton: { spicePrefix: 'R', pins: 2, symbolType: 'generic', label: 'Pushbutton' },
  // Compound SPICE image: two resistors (_A/_B) at the 50% wiper position.
  potentiometer: { spicePrefix: 'R', pins: 3, symbolType: 'generic', label: 'Potentiometer' },
  // Compound SPICE image: closed throw A (1m) + open throw B (10Meg).
  switch_spdt: { spicePrefix: 'R', pins: 3, symbolType: 'generic', label: 'SPDT switch' },
  // Compound SPICE image: three diodes (_R/_G/_B) to the common cathode.
  rgb_led: { spicePrefix: 'D', pins: 4, symbolType: 'generic', label: 'RGB LED' },
  // Compound SPICE image: one diode per used segment to COM (common cathode).
  seven_segment: {
    spicePrefix: 'D', pins: 9, symbolType: 'generic', label: '7-segment display',
    fixedPins: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'DP', 'COM'],
  },
  timer_555: {
    spicePrefix: 'X', pins: 8, symbolType: 'generic', label: '555 timer',
    fixedPins: ['GND', 'TRIG', 'OUT', 'RESET', 'CTRL', 'THRES', 'DISCH', 'VCC'],
  },
  ultrasonic_sensor: {
    spicePrefix: 'U', pins: 4, symbolType: 'generic', label: 'Ultrasonic sensor (HC-SR04)',
    wiringOnly: true,
    fixedPins: ['VCC', 'TRIG', 'ECHO', 'GND'],
  },
  dht_sensor: {
    spicePrefix: 'U', pins: 3, symbolType: 'generic', label: 'DHT temperature/humidity sensor',
    wiringOnly: true,
    fixedPins: ['VCC', 'DATA', 'GND'],
  },
  oled_display: {
    spicePrefix: 'U', pins: 4, symbolType: 'generic', label: 'OLED display (I2C)',
    wiringOnly: true,
    fixedPins: ['VCC', 'GND', 'SCL', 'SDA'],
  },
  pir_sensor: {
    spicePrefix: 'U', pins: 3, symbolType: 'generic', label: 'PIR motion sensor',
    wiringOnly: true,
    fixedPins: ['VCC', 'OUT', 'GND'],
  },
  servo: {
    spicePrefix: 'U', pins: 3, symbolType: 'generic', label: 'Servo motor',
    wiringOnly: true,
    fixedPins: ['VCC', 'GND', 'SIG'],
  },
  // Simulated as a resistive load (winding resistance).
  dc_motor: { spicePrefix: 'R', pins: 2, symbolType: 'generic', label: 'DC motor' },
  relay_module: {
    spicePrefix: 'U', pins: 6, symbolType: 'generic', label: 'Relay module',
    wiringOnly: true,
    fixedPins: ['VCC', 'GND', 'IN', 'COM', 'NO', 'NC'],
  },
  arduino_uno: {
    spicePrefix: 'U', pins: 12, symbolType: 'generic', label: 'Arduino Uno',
    wiringOnly: true, mcu: true,
    fixedPins: ['5V', '3V3', 'GND', 'VIN', 'D2', 'D3', 'D5', 'D9', 'D13', 'A0', 'A1', 'A2'],
  },
  raspberry_pi: {
    spicePrefix: 'U', pins: 10, symbolType: 'generic', label: 'Raspberry Pi',
    wiringOnly: true, mcu: true,
    fixedPins: ['5V', '3V3', 'GND', 'GPIO2', 'GPIO3', 'GPIO4', 'GPIO17', 'GPIO18', 'GPIO27', 'GPIO22'],
  },
  esp32: {
    spicePrefix: 'U', pins: 12, symbolType: 'generic', label: 'ESP32',
    wiringOnly: true, mcu: true,
    fixedPins: ['3V3', 'GND', 'VIN', 'EN', 'GPIO2', 'GPIO4', 'GPIO5', 'GPIO13', 'GPIO18', 'GPIO19', 'GPIO21', 'GPIO22'],
  },
};

const entries = Object.entries(COMPONENT_KINDS);

export const ALLOWED_KINDS = entries.map(([kind]) => kind);

export const SPICE_PREFIX_BY_KIND = Object.fromEntries(
  entries.map(([kind, info]) => [kind, info.spicePrefix]),
);

export const DEFAULT_PIN_COUNT_BY_KIND = Object.fromEntries(
  entries.map(([kind, info]) => [kind, info.pins]),
);

export const SYMBOL_TYPE_BY_KIND = Object.fromEntries(
  entries.map(([kind, info]) => [kind, info.symbolType]),
);

export const FIXED_PIN_NAMES = Object.fromEntries(
  entries.filter(([, info]) => info.fixedPins).map(([kind, info]) => [kind, info.fixedPins]),
);

export const WIRING_ONLY_KINDS = new Set(
  entries.filter(([, info]) => info.wiringOnly).map(([kind]) => kind),
);

export const MCU_KINDS = new Set(
  entries.filter(([, info]) => info.mcu).map(([kind]) => kind),
);

export const MCU_PIN_COUNTS = Object.fromEntries(
  entries.filter(([, info]) => info.mcu).map(([kind, info]) => [kind, info.pins]),
);

// Kinds whose SPICE image is several derived element lines (suffixed with
// `_A`, `_R`, …) rather than one line. The SPICE parser recognizes those
// derived refs and carries the compound component over from the base circuit
// instead of degrading it into primitives.
export const COMPOUND_SPICE_KINDS = new Set(['potentiometer', 'switch_spdt', 'rgb_led', 'seven_segment']);

export const kindLabel = (kind) =>
  COMPONENT_KINDS[kind]?.label || String(kind || '').replaceAll('_', ' ');
