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
  // 940nm emitter diode: lower Vf than a visible LED (DIR model), dark lens artwork.
  ir_led: { spicePrefix: 'D', pins: 2, symbolType: 'led', label: 'IR emitter LED' },
  bjt_npn: { spicePrefix: 'Q', pins: 3, symbolType: 'bjt_npn', label: 'NPN transistor' },
  bjt_pnp: { spicePrefix: 'Q', pins: 3, symbolType: 'bjt_pnp', label: 'PNP transistor' },
  mosfet_n: { spicePrefix: 'M', pins: 3, symbolType: 'generic', label: 'N-channel MOSFET' },
  mosfet_p: { spicePrefix: 'M', pins: 3, symbolType: 'generic', label: 'P-channel MOSFET' },
  opamp: { spicePrefix: 'X', pins: 5, symbolType: 'opamp', label: 'Op amp' },
  // Physically a three-pin IN/GND/OUT device. The SPICE exporter currently
  // approximates it as an ideal DC source on its output node, hence the V.
  regulator: {
    spicePrefix: 'V', pins: 3, symbolType: 'generic', label: 'Voltage regulator',
    fixedPins: ['IN', 'GND', 'OUT'],
  },
  // LM2596 step-down switcher, TO-220-5, fixed-output variants only (output
  // volts parse from the value, e.g. "LM2596-5.0"). Like the linear regulator
  // the SPICE image is one ideal DC source — placed on the OUT (switch) pin;
  // the external inductor / catch schottky / caps are separate parts.
  buck_converter: {
    spicePrefix: 'V', pins: 5, symbolType: 'generic', label: 'Buck converter (LM2596)',
    fixedPins: ['VIN', 'OUT', 'GND', 'FB', 'ON_OFF'],
  },
  voltage_source: { spicePrefix: 'V', pins: 2, symbolType: 'voltage_source', label: 'Voltage source' },
  signal_source: { spicePrefix: 'V', pins: 2, symbolType: 'voltage_source', label: 'Signal source' },
  // DC source variant: feeds the breadboard rails like a battery pack (drawn
  // as a photovoltaic panel) and exports as a plain "V... DC" line.
  solar_panel: { spicePrefix: 'V', pins: 2, symbolType: 'voltage_source', label: 'Solar panel' },
  load: { spicePrefix: 'R', pins: 2, symbolType: 'resistor', label: 'Load' },
  zener: { spicePrefix: 'D', pins: 2, symbolType: 'diode', label: 'Zener diode' },
  // Low forward drop rectifier; simulated with the DSCH model.
  schottky: { spicePrefix: 'D', pins: 2, symbolType: 'diode', label: 'Schottky diode' },
  // Simulated as a tiny series resistance ("1A" ratings fall back to 0.05Ω).
  fuse: { spicePrefix: 'R', pins: 2, symbolType: 'generic', label: 'Fuse' },
  photoresistor: { spicePrefix: 'R', pins: 2, symbolType: 'resistor', label: 'Photoresistor (LDR)' },
  // Raw 2-pin analog IR receiver: conductance follows an "IR light" slider,
  // like the LDR. For demodulated remote protocols use ir_receiver instead.
  ir_phototransistor: { spicePrefix: 'R', pins: 2, symbolType: 'resistor', label: 'IR phototransistor (raw receiver)' },
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
  // Compound SPICE image: four DGEN diodes (_A.._D) in the standard bridge
  // topology — AC1/AC2 anodes into V+, V- anodes into AC1/AC2.
  bridge_rectifier: {
    spicePrefix: 'D', pins: 4, symbolType: 'generic', label: 'Bridge rectifier',
    fixedPins: ['AC1', 'AC2', 'V+', 'V-'],
  },
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
  // Pager/coin motor; same winding-resistance model and driver/flyback rules
  // as dc_motor.
  vibration_motor: { spicePrefix: 'R', pins: 2, symbolType: 'generic', label: 'Vibration motor' },
  relay_module: {
    spicePrefix: 'U', pins: 6, symbolType: 'generic', label: 'Relay module',
    wiringOnly: true,
    fixedPins: ['VCC', 'GND', 'IN', 'COM', 'NO', 'NC'],
  },
  // 5-wire JST order (blue, pink, yellow, orange, red); COM is the +5V common.
  // Coils must be driven through a stepper_driver, never GPIOs directly.
  stepper_motor: {
    spicePrefix: 'U', pins: 5, symbolType: 'generic', label: 'Stepper motor (28BYJ-48)',
    wiringOnly: true,
    fixedPins: ['A', 'B', 'C', 'D', 'COM'],
  },
  // Control header (MCU side) first, then power, then the coil outputs that
  // mirror the motor's A-D pins.
  stepper_driver: {
    spicePrefix: 'U', pins: 10, symbolType: 'generic', label: 'Stepper driver (ULN2003)',
    wiringOnly: true,
    fixedPins: ['IN1', 'IN2', 'IN3', 'IN4', 'VCC', 'GND', 'OUTA', 'OUTB', 'OUTC', 'OUTD'],
  },
  // Dual H-bridge: VS is the motor supply, OUT1/OUT2 and OUT3/OUT4 are the
  // switched channel outputs a dc_motor connects across.
  motor_driver: {
    spicePrefix: 'U', pins: 12, symbolType: 'generic', label: 'Motor driver (L298N)',
    wiringOnly: true,
    fixedPins: ['VS', 'GND', 'ENA', 'IN1', 'IN2', 'ENB', 'IN3', 'IN4', 'OUT1', 'OUT2', 'OUT3', 'OUT4'],
  },
  // 16x2 character LCD behind a PCF8574 I2C backpack; header order matches
  // the physical backpack (GND first).
  lcd_display: {
    spicePrefix: 'U', pins: 4, symbolType: 'generic', label: 'LCD 16x2 (I2C)',
    wiringOnly: true,
    fixedPins: ['GND', 'VCC', 'SDA', 'SCL'],
  },
  rotary_encoder: {
    spicePrefix: 'U', pins: 5, symbolType: 'generic', label: 'Rotary encoder (KY-040)',
    wiringOnly: true,
    fixedPins: ['CLK', 'DT', 'SW', 'VCC', 'GND'],
  },
  // Addressable strip head-end only (no DOUT — chaining is out of scope).
  // VCC must come from the 5V supply, never a GPIO.
  led_strip: {
    spicePrefix: 'U', pins: 3, symbolType: 'generic', label: 'LED strip (WS2812 NeoPixel)',
    wiringOnly: true,
    fixedPins: ['VCC', 'DIN', 'GND'],
  },
  imu_sensor: {
    spicePrefix: 'U', pins: 4, symbolType: 'generic', label: 'IMU (MPU6050, I2C)',
    wiringOnly: true,
    fixedPins: ['VCC', 'GND', 'SCL', 'SDA'],
  },
  // TSOP38xx demodulating receiver, pins 1-3 facing the lens.
  ir_receiver: {
    spicePrefix: 'U', pins: 3, symbolType: 'generic', label: 'IR receiver (TSOP38xx)',
    wiringOnly: true,
    fixedPins: ['OUT', 'GND', 'VCC'],
  },
  // 74HC595 in DIP-16 physical pin order 1-16 (the timer_555 pattern: canonical
  // order = DIP order, so the straddle leg layout is the identity). QH2 is the
  // QH' serial-out on pin 9.
  shift_register: {
    spicePrefix: 'U', pins: 16, symbolType: 'generic', label: 'Shift register (74HC595)',
    wiringOnly: true,
    fixedPins: ['QB', 'QC', 'QD', 'QE', 'QF', 'QG', 'QH', 'GND', 'QH2', 'SRCLR', 'SRCLK', 'RCLK', 'OE', 'SER', 'QA', 'VCC'],
  },
  // Sharp PC817 DIP-4, canonical order = physical DIP pins 1-4 (anode,
  // cathode, emitter, collector) so the straddle leg layout is the identity.
  // Simulated via the PC817 subcircuit — NOT wiring-only.
  optocoupler: {
    spicePrefix: 'X', pins: 4, symbolType: 'generic', label: 'Optocoupler (PC817)',
    fixedPins: ['A', 'K', 'E', 'C'],
  },
  // ACS712 hall-effect module. IP+/IP- are the series load path (screw
  // terminals) and carry the real current: the SPICE image is one derived
  // milliohm shunt line <REF>_S across them (compound pattern). VCC/OUT/GND
  // are wiring-only header pins.
  current_sensor: {
    spicePrefix: 'R', pins: 5, symbolType: 'generic', label: 'Current sensor (ACS712)',
    fixedPins: ['IP+', 'IP-', 'VCC', 'OUT', 'GND'],
  },
  // 4x4 membrane keypad; 8-pin ribbon in physical order, rows then columns.
  keypad: {
    spicePrefix: 'U', pins: 8, symbolType: 'generic', label: 'Keypad (4x4 membrane)',
    wiringOnly: true,
    fixedPins: ['R1', 'R2', 'R3', 'R4', 'C1', 'C2', 'C3', 'C4'],
  },
  joystick: {
    spicePrefix: 'U', pins: 5, symbolType: 'generic', label: 'Joystick (KY-023)',
    wiringOnly: true,
    fixedPins: ['GND', 'VCC', 'VRX', 'VRY', 'SW'],
  },
  rtc_module: {
    spicePrefix: 'U', pins: 4, symbolType: 'generic', label: 'RTC (DS3231, I2C)',
    wiringOnly: true,
    fixedPins: ['GND', 'VCC', 'SDA', 'SCL'],
  },
  sd_card: {
    spicePrefix: 'U', pins: 6, symbolType: 'generic', label: 'SD card module (SPI)',
    wiringOnly: true,
    fixedPins: ['VCC', 'GND', 'MISO', 'MOSI', 'SCK', 'CS'],
  },
  // RC522 breakout, physical 8-pin header order. SDA doubles as the SPI SS.
  // 3.3V only — the prompt steers VCC to the 3V3 supply.
  rfid_reader: {
    spicePrefix: 'U', pins: 8, symbolType: 'generic', label: 'RFID reader (RC522)',
    wiringOnly: true,
    fixedPins: ['3V3', 'RST', 'GND', 'IRQ', 'MISO', 'MOSI', 'SCK', 'SDA'],
  },
  // PMW3360 breakout, physical header order (RS GD MT SS SC MO MI VI).
  // NCS is the SPI chip select; MOT is the active-low motion interrupt.
  mouse_sensor: {
    spicePrefix: 'U', pins: 8, symbolType: 'generic', label: 'Mouse sensor (PMW3360, SPI)',
    wiringOnly: true,
    fixedPins: ['RST', 'GND', 'MOT', 'NCS', 'SCK', 'MOSI', 'MISO', 'VCC'],
  },
  soil_moisture: {
    spicePrefix: 'U', pins: 3, symbolType: 'generic', label: 'Soil moisture sensor (capacitive)',
    wiringOnly: true,
    fixedPins: ['VCC', 'GND', 'AOUT'],
  },
  gas_sensor: {
    spicePrefix: 'U', pins: 4, symbolType: 'generic', label: 'Gas sensor (MQ-2)',
    wiringOnly: true,
    fixedPins: ['VCC', 'GND', 'DO', 'AO'],
  },
  sound_sensor: {
    spicePrefix: 'U', pins: 4, symbolType: 'generic', label: 'Sound sensor (KY-038)',
    wiringOnly: true,
    fixedPins: ['VCC', 'GND', 'DO', 'AO'],
  },
  // TO-92 like temp_sensor, but NOTE the A3144 pin order is [VCC, GND, OUT]
  // (not VCC/OUT/GND) and OUT is open-collector — it needs a pull-up.
  hall_sensor: {
    spicePrefix: 'U', pins: 3, symbolType: 'generic', label: 'Hall sensor (A3144)',
    wiringOnly: true,
    fixedPins: ['VCC', 'GND', 'OUT'],
  },
  baro_sensor: {
    spicePrefix: 'U', pins: 4, symbolType: 'generic', label: 'Barometric sensor (BMP280, I2C)',
    wiringOnly: true,
    fixedPins: ['VCC', 'GND', 'SCL', 'SDA'],
  },
  // MCP3008 in DIP-16 physical order (shift_register pattern: canonical =
  // DIP order, identity straddle legs). Gives the Raspberry Pi analog inputs.
  adc_module: {
    spicePrefix: 'U', pins: 16, symbolType: 'generic', label: 'ADC (MCP3008)',
    wiringOnly: true,
    fixedPins: ['CH0', 'CH1', 'CH2', 'CH3', 'CH4', 'CH5', 'CH6', 'CH7', 'DGND', 'CS', 'DIN', 'DOUT', 'CLK', 'AGND', 'VREF', 'VDD'],
  },
  arduino_uno: {
    spicePrefix: 'U', pins: 24, symbolType: 'generic', label: 'Arduino Uno',
    wiringOnly: true, mcu: true,
    // Full usable header: power | digital D0-D13 | analog A0-A5 (A4/A5 double
    // as I2C SDA/SCL). Order is the positional contract every other pin array
    // and the AI prompt must match by index.
    fixedPins: ['5V', '3V3', 'GND', 'VIN', 'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5'],
  },
  raspberry_pi: {
    spicePrefix: 'U', pins: 14, symbolType: 'generic', label: 'Raspberry Pi',
    wiringOnly: true, mcu: true,
    // GPIO8-11 (SPI0 CE0/MISO/MOSI/SCLK) were appended in a later release —
    // new pins are only ever APPENDED so older saved circuits stay index-
    // compatible and padMcuNodes can migrate them by padding with NC pins.
    fixedPins: ['5V', '3V3', 'GND', 'GPIO2', 'GPIO3', 'GPIO4', 'GPIO17', 'GPIO18', 'GPIO27', 'GPIO22', 'GPIO8', 'GPIO9', 'GPIO10', 'GPIO11'],
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
export const COMPOUND_SPICE_KINDS = new Set(['potentiometer', 'switch_spdt', 'rgb_led', 'seven_segment', 'current_sensor', 'bridge_rectifier']);

export const kindLabel = (kind) =>
  COMPONENT_KINDS[kind]?.label || String(kind || '').replaceAll('_', ' ');

// Pads an MCU board whose saved nodes predate a pin-list extension (new pins
// are only ever appended) with NC placeholders so older circuits keep loading
// without node-count errors. Returns the same object when nothing changes so
// callers can cheaply detect whether a migration happened.
export const padMcuNodes = (circuit) => {
  const components = circuit?.components;
  if (!Array.isArray(components)) return circuit;
  let changed = false;
  const padded = components.map((part) => {
    const fixed = part && MCU_KINDS.has(part.kind) ? COMPONENT_KINDS[part.kind].fixedPins : null;
    if (!fixed || !Array.isArray(part.nodes) || part.nodes.length >= fixed.length) return part;
    changed = true;
    const nodes = [...part.nodes];
    while (nodes.length < fixed.length) nodes.push(`NC_${part.ref}_${nodes.length + 1}`);
    return { ...part, nodes };
  });
  return changed ? { ...circuit, components: padded } : circuit;
};
