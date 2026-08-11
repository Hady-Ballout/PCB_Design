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
//   category     taxonomy bucket (must be an id in COMPONENT_CATEGORIES); powers
//                the component-library grouping and the AI kind-picker guide
//   aliases      synonyms/part numbers the user may type ("op-amp", "ldr", "555");
//                fed to library search AND the AI prompt so those names map here
//   keywords     extra fuzzy-search terms (role/function words) — search only
//   preferredValues  optional common value hints (E24 passives, supply rails);
//                    guidance for a value dropdown / the AI, never separate parts
//   fixedPins    positional pin-name contract (MCU boards, modules, DIP ICs);
//                the AI must list nodes in exactly this order
//   wiringOnly   never appears in the SPICE deck (emitted as a comment line)
//   mcu          microcontroller board (off-board artwork, firmware target)

export const COMPONENT_KINDS = {
  resistor: {
    spicePrefix: 'R', pins: 2, symbolType: 'resistor', label: 'Resistor',
    category: 'passive',
    aliases: ['r', 'res'],
    keywords: ['ohm', 'resistance', 'pull-up', 'pull-down', 'current limiting'],
    preferredValues: ['100', '220', '330', '470', '1k', '2.2k', '4.7k', '10k', '47k', '100k', '1M'],
  },
  capacitor: {
    spicePrefix: 'C', pins: 2, symbolType: 'capacitor', label: 'Capacitor',
    category: 'passive',
    aliases: ['cap', 'c'],
    keywords: ['farad', 'decoupling', 'bypass', 'filter', 'coupling', 'smoothing'],
    preferredValues: ['1nF', '10nF', '100nF', '1uF', '10uF', '100uF', '470uF'],
  },
  inductor: {
    spicePrefix: 'L', pins: 2, symbolType: 'inductor', label: 'Inductor',
    category: 'passive',
    aliases: ['coil', 'choke', 'l'],
    keywords: ['henry', 'magnetic', 'filter'],
    preferredValues: ['10uH', '100uH', '1mH', '10mH'],
  },
  diode: {
    spicePrefix: 'D', pins: 2, symbolType: 'diode', label: 'Diode',
    category: 'diode',
    aliases: ['rectifier diode', '1n4148', '1n4007'],
    keywords: ['rectifier', 'one-way', 'clamp'],
  },
  led: {
    spicePrefix: 'D', pins: 2, symbolType: 'led', label: 'LED',
    category: 'diode',
    aliases: ['light emitting diode'],
    keywords: ['light', 'indicator', 'lamp'],
  },
  // 940nm emitter diode: lower Vf than a visible LED (DIR model), dark lens artwork.
  ir_led: {
    spicePrefix: 'D', pins: 2, symbolType: 'led', label: 'IR emitter LED',
    category: 'diode',
    aliases: ['infrared led', 'ir emitter'],
    keywords: ['infrared', '940nm', 'remote', 'emitter'],
  },
  bjt_npn: {
    spicePrefix: 'Q', pins: 3, symbolType: 'bjt_npn', label: 'NPN transistor',
    category: 'transistor',
    aliases: ['npn', 'transistor', '2n2222', 'bc547'],
    keywords: ['switch', 'amplifier', 'bipolar'],
  },
  bjt_pnp: {
    spicePrefix: 'Q', pins: 3, symbolType: 'bjt_pnp', label: 'PNP transistor',
    category: 'transistor',
    aliases: ['pnp', '2n2907', 'bc557'],
    keywords: ['switch', 'amplifier', 'bipolar'],
  },
  mosfet_n: {
    spicePrefix: 'M', pins: 3, symbolType: 'generic', label: 'N-channel MOSFET',
    category: 'transistor',
    aliases: ['nmos', 'n-mosfet', 'n-fet', 'irfz44'],
    keywords: ['switch', 'transistor', 'gate', 'power'],
  },
  mosfet_p: {
    spicePrefix: 'M', pins: 3, symbolType: 'generic', label: 'P-channel MOSFET',
    category: 'transistor',
    aliases: ['pmos', 'p-mosfet', 'p-fet'],
    keywords: ['switch', 'transistor', 'gate', 'high-side'],
  },
  opamp: {
    spicePrefix: 'X', pins: 5, symbolType: 'opamp', label: 'Op amp',
    category: 'analog-ic',
    aliases: ['op-amp', 'operational amplifier', 'lm358', 'lm324'],
    keywords: ['amplifier', 'gain', 'buffer', 'inverting', 'non-inverting'],
  },
  // uA741 single op amp in DIP-8: canonical order = physical pins 1-8 (the
  // timer_555 pattern), so leg layouts and KiCad pin numbers are the identity.
  // OFS1/OFS2 (offset null) and NC exist physically but ride NC_* nets unless
  // the user explicitly wires an offset-trim circuit.
  ua741: {
    spicePrefix: 'X', pins: 8, symbolType: 'generic', label: 'Op amp (uA741)',
    fixedPins: ['OFS1', 'IN-', 'IN+', 'V-', 'OFS2', 'OUT', 'V+', 'NC'],
    category: 'analog-ic',
    aliases: ['741', 'ua741', 'lm741'],
    keywords: ['op amp', 'amplifier', 'dip-8', 'single'],
  },
  // Physically a three-pin IN/GND/OUT device. The SPICE exporter currently
  // approximates it as an ideal DC source on its output node, hence the V.
  regulator: {
    spicePrefix: 'V', pins: 3, symbolType: 'generic', label: 'Voltage regulator',
    fixedPins: ['IN', 'GND', 'OUT'],
    category: 'power',
    aliases: ['ldo', 'linear regulator', '7805', 'lm7805', 'ams1117'],
    keywords: ['power', 'voltage', 'supply', 'stabilizer', '3.3v', '5v'],
  },
  // LM2596 step-down switcher, TO-220-5, fixed-output variants only (output
  // volts parse from the value, e.g. "LM2596-5.0"). Like the linear regulator
  // the SPICE image is one ideal DC source — placed on the OUT (switch) pin;
  // the external inductor / catch schottky / caps are separate parts.
  buck_converter: {
    spicePrefix: 'V', pins: 5, symbolType: 'generic', label: 'Buck converter (LM2596)',
    fixedPins: ['VIN', 'OUT', 'GND', 'FB', 'ON_OFF'],
    category: 'power',
    aliases: ['buck', 'step-down', 'lm2596', 'dc-dc'],
    keywords: ['switching', 'regulator', 'power', 'supply', 'converter'],
  },
  // TP4056 charging module with onboard DW01 protection: IN± from a 5V
  // source, B± to the cell, OUT± to the load. SPICE/sim image is an ideal DC
  // source on OUT+ (4.2V full-charge default) like the other power bricks.
  // No dropout sensing on purpose: a protected module's OUT follows the
  // battery, so an unpowered IN does not collapse OUT.
  charge_controller: {
    spicePrefix: 'V', pins: 6, symbolType: 'generic', label: 'Li-ion charger (TP4056)',
    fixedPins: ['IN+', 'IN-', 'B+', 'B-', 'OUT+', 'OUT-'],
    category: 'power',
    aliases: ['tp4056', 'lipo charger', 'battery charger', 'charging module'],
    keywords: ['power', 'battery', 'li-ion', 'lipo', 'charge', 'protection', 'usb'],
  },
  voltage_source: {
    spicePrefix: 'V', pins: 2, symbolType: 'voltage_source', label: 'Voltage source',
    category: 'source',
    aliases: ['battery', 'dc source', 'power supply', 'vcc'],
    keywords: ['dc', 'supply', 'rail', 'volts'],
    preferredValues: ['3.3V', '5V', '9V', '12V'],
  },
  signal_source: {
    spicePrefix: 'V', pins: 2, symbolType: 'voltage_source', label: 'Signal source',
    category: 'source',
    aliases: ['function generator', 'ac source', 'waveform'],
    keywords: ['sine', 'pulse', 'ac', 'signal', 'oscillator', 'input'],
    preferredValues: ['SINE(0 1 1k)', 'PULSE(0 5 0 1u 1u 1m 2m)'],
  },
  // DC source variant: feeds the breadboard rails like a battery pack (drawn
  // as a photovoltaic panel) and exports as a plain "V... DC" line.
  solar_panel: {
    spicePrefix: 'V', pins: 2, symbolType: 'voltage_source', label: 'Solar panel',
    category: 'source',
    aliases: ['pv panel', 'photovoltaic'],
    keywords: ['solar', 'renewable', 'dc', 'supply'],
  },
  load: {
    spicePrefix: 'R', pins: 2, symbolType: 'resistor', label: 'Load',
    category: 'passive',
    aliases: ['resistive load', 'dummy load'],
    keywords: ['output', 'sink', 'resistor'],
  },
  zener: {
    spicePrefix: 'D', pins: 2, symbolType: 'diode', label: 'Zener diode',
    category: 'diode',
    aliases: ['zener diode'],
    keywords: ['reference', 'clamp', 'regulator', 'voltage', 'breakdown'],
    preferredValues: ['3.3V', '5.1V', '9.1V', '12V'],
  },
  // Low forward drop rectifier; simulated with the DSCH model.
  schottky: {
    spicePrefix: 'D', pins: 2, symbolType: 'diode', label: 'Schottky diode',
    category: 'diode',
    aliases: ['schottky diode', '1n5819'],
    keywords: ['rectifier', 'low drop', 'fast', 'flyback', 'catch'],
  },
  // Unidirectional transient suppressor, simulated as a hard zener-style
  // clamp (DTVS model). Value is the standoff/clamp voltage ("5V").
  tvs: {
    spicePrefix: 'D', pins: 2, symbolType: 'diode', label: 'TVS diode',
    category: 'diode',
    aliases: ['tvs diode', 'transient suppressor', 'esd diode', 'surge suppressor'],
    keywords: ['protection', 'transient', 'surge', 'esd', 'clamp', 'spike'],
    preferredValues: ['5V', '12V', '24V'],
  },
  // Simulated as a tiny series resistance ("1A" ratings fall back to 0.05Ω).
  fuse: {
    spicePrefix: 'R', pins: 2, symbolType: 'generic', label: 'Fuse',
    category: 'passive',
    aliases: ['ptc'],
    keywords: ['protection', 'overcurrent', 'safety'],
  },
  photoresistor: {
    spicePrefix: 'R', pins: 2, symbolType: 'resistor', label: 'Photoresistor (LDR)',
    category: 'sensor',
    aliases: ['ldr', 'light dependent resistor', 'photocell'],
    keywords: ['light', 'sensor', 'ambient', 'brightness'],
  },
  // Raw 2-pin analog IR receiver: conductance follows an "IR light" slider,
  // like the LDR. For demodulated remote protocols use ir_receiver instead.
  ir_phototransistor: {
    spicePrefix: 'R', pins: 2, symbolType: 'resistor', label: 'IR phototransistor (raw receiver)',
    category: 'sensor',
    aliases: ['photodiode', 'ir receiver diode'],
    keywords: ['infrared', 'light', 'sensor', 'receiver', 'reflectance'],
  },
  thermistor: {
    spicePrefix: 'R', pins: 2, symbolType: 'resistor', label: 'Thermistor',
    category: 'sensor',
    aliases: ['ntc', 'ptc thermistor'],
    keywords: ['temperature', 'sensor', 'heat'],
    preferredValues: ['10k'],
  },
  // Simulated as a resistive load so the deck stays runnable.
  buzzer: {
    spicePrefix: 'R', pins: 2, symbolType: 'generic', label: 'Buzzer',
    category: 'actuator',
    aliases: ['piezo', 'beeper'],
    keywords: ['sound', 'alarm', 'tone', 'audio'],
  },
  // Simulated as a small load capacitance stand-in.
  crystal: {
    spicePrefix: 'C', pins: 2, symbolType: 'generic', label: 'Crystal',
    category: 'passive',
    aliases: ['xtal', 'quartz', 'oscillator'],
    keywords: ['clock', 'frequency', 'timing', 'mhz'],
  },
  temp_sensor: {
    spicePrefix: 'U', pins: 3, symbolType: 'generic', label: 'Temperature sensor',
    wiringOnly: true,
    fixedPins: ['VCC', 'OUT', 'GND'],
    category: 'sensor',
    aliases: ['lm35', 'tmp36'],
    keywords: ['temperature', 'analog', 'heat', 'thermometer'],
  },
  comparator: {
    spicePrefix: 'X', pins: 5, symbolType: 'opamp', label: 'Comparator',
    category: 'analog-ic',
    aliases: ['lm393', 'lm339'],
    keywords: ['compare', 'threshold', 'schmitt', 'op amp'],
  },
  // Simulated in the unpressed (open) state as a very large resistance.
  pushbutton: {
    spicePrefix: 'R', pins: 2, symbolType: 'generic', label: 'Pushbutton',
    category: 'switch',
    aliases: ['button', 'momentary switch', 'tactile switch'],
    keywords: ['switch', 'press', 'input', 'trigger'],
  },
  // Compound SPICE image: two resistors (_A/_B) at the 50% wiper position.
  potentiometer: {
    spicePrefix: 'R', pins: 3, symbolType: 'generic', label: 'Potentiometer',
    category: 'passive',
    aliases: ['pot', 'variable resistor', 'trimmer'],
    keywords: ['adjustable', 'volume', 'wiper', 'divider', 'knob'],
    preferredValues: ['1k', '10k', '100k'],
  },
  // Compound SPICE image: closed throw A (1m) + open throw B (10Meg).
  switch_spdt: {
    spicePrefix: 'R', pins: 3, symbolType: 'generic', label: 'SPDT switch',
    category: 'switch',
    aliases: ['spdt', 'toggle switch', 'selector'],
    keywords: ['switch', 'throw', 'select', 'changeover'],
  },
  // Compound SPICE image: three diodes (_R/_G/_B) to the common cathode.
  rgb_led: {
    spicePrefix: 'D', pins: 4, symbolType: 'generic', label: 'RGB LED',
    category: 'diode',
    aliases: ['rgb', 'tri-color led'],
    keywords: ['light', 'color', 'red', 'green', 'blue'],
  },
  // Compound SPICE image: four DGEN diodes (_A.._D) in the standard bridge
  // topology — AC1/AC2 anodes into V+, V- anodes into AC1/AC2.
  bridge_rectifier: {
    spicePrefix: 'D', pins: 4, symbolType: 'generic', label: 'Bridge rectifier',
    fixedPins: ['AC1', 'AC2', 'V+', 'V-'],
    category: 'diode',
    aliases: ['full bridge', 'diode bridge', 'graetz'],
    keywords: ['rectifier', 'ac to dc', 'power', 'four diode'],
  },
  // Compound SPICE image: one diode per used segment to COM (common cathode).
  seven_segment: {
    spicePrefix: 'D', pins: 9, symbolType: 'generic', label: '7-segment display',
    fixedPins: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'DP', 'COM'],
    category: 'display',
    aliases: ['7 segment', 'seven segment display', '7-seg'],
    keywords: ['display', 'digit', 'number', 'numeric', 'led'],
  },
  timer_555: {
    spicePrefix: 'X', pins: 8, symbolType: 'generic', label: '555 timer',
    fixedPins: ['GND', 'TRIG', 'OUT', 'RESET', 'CTRL', 'THRES', 'DISCH', 'VCC'],
    category: 'analog-ic',
    aliases: ['555', 'ne555', '555 timer ic'],
    keywords: ['oscillator', 'astable', 'monostable', 'pwm', 'clock', 'blink'],
  },
  ultrasonic_sensor: {
    spicePrefix: 'U', pins: 4, symbolType: 'generic', label: 'Ultrasonic sensor (HC-SR04)',
    wiringOnly: true,
    fixedPins: ['VCC', 'TRIG', 'ECHO', 'GND'],
    category: 'sensor',
    aliases: ['hc-sr04', 'ultrasonic', 'sonar'],
    keywords: ['distance', 'range', 'proximity', 'sensor'],
  },
  dht_sensor: {
    spicePrefix: 'U', pins: 3, symbolType: 'generic', label: 'DHT temperature/humidity sensor',
    wiringOnly: true,
    fixedPins: ['VCC', 'DATA', 'GND'],
    category: 'sensor',
    aliases: ['dht11', 'dht22', 'am2302'],
    keywords: ['temperature', 'humidity', 'sensor', 'climate'],
  },
  oled_display: {
    spicePrefix: 'U', pins: 4, symbolType: 'generic', label: 'OLED display (I2C)',
    wiringOnly: true,
    fixedPins: ['VCC', 'GND', 'SCL', 'SDA'],
    category: 'display',
    aliases: ['oled', 'ssd1306'],
    keywords: ['display', 'screen', 'i2c', 'graphics'],
  },
  pir_sensor: {
    spicePrefix: 'U', pins: 3, symbolType: 'generic', label: 'PIR motion sensor',
    wiringOnly: true,
    fixedPins: ['VCC', 'OUT', 'GND'],
    category: 'sensor',
    aliases: ['pir', 'motion sensor', 'hc-sr501'],
    keywords: ['motion', 'presence', 'infrared', 'detector'],
  },
  servo: {
    spicePrefix: 'U', pins: 3, symbolType: 'generic', label: 'Servo motor',
    wiringOnly: true,
    fixedPins: ['VCC', 'GND', 'SIG'],
    category: 'actuator',
    aliases: ['servo motor', 'sg90', 'mg996r'],
    keywords: ['motor', 'angle', 'position', 'pwm', 'actuator'],
  },
  // Simulated as a resistive load (winding resistance).
  dc_motor: {
    spicePrefix: 'R', pins: 2, symbolType: 'generic', label: 'DC motor',
    category: 'actuator',
    aliases: ['motor', 'brushed motor'],
    keywords: ['motor', 'drive', 'rotation', 'actuator'],
  },
  // Pager/coin motor; same winding-resistance model and driver/flyback rules
  // as dc_motor.
  vibration_motor: {
    spicePrefix: 'R', pins: 2, symbolType: 'generic', label: 'Vibration motor',
    category: 'actuator',
    aliases: ['vibrator', 'coin motor', 'pager motor'],
    keywords: ['motor', 'haptic', 'buzz', 'actuator'],
  },
  relay_module: {
    spicePrefix: 'U', pins: 6, symbolType: 'generic', label: 'Relay module',
    wiringOnly: true,
    fixedPins: ['VCC', 'GND', 'IN', 'COM', 'NO', 'NC'],
    category: 'driver-ic',
    aliases: ['relay', 'relay board'],
    keywords: ['switch', 'high voltage', 'mains', 'isolation', 'coil'],
  },
  // 5-wire JST order (blue, pink, yellow, orange, red); COM is the +5V common.
  // Coils must be driven through a stepper_driver, never GPIOs directly.
  stepper_motor: {
    spicePrefix: 'U', pins: 5, symbolType: 'generic', label: 'Stepper motor (28BYJ-48)',
    wiringOnly: true,
    fixedPins: ['A', 'B', 'C', 'D', 'COM'],
    category: 'actuator',
    aliases: ['stepper', '28byj-48'],
    keywords: ['motor', 'step', 'position', 'precise', 'actuator'],
  },
  // Control header (MCU side) first, then power, then the coil outputs that
  // mirror the motor's A-D pins.
  stepper_driver: {
    spicePrefix: 'U', pins: 10, symbolType: 'generic', label: 'Stepper driver (ULN2003)',
    wiringOnly: true,
    fixedPins: ['IN1', 'IN2', 'IN3', 'IN4', 'VCC', 'GND', 'OUTA', 'OUTB', 'OUTC', 'OUTD'],
    category: 'driver-ic',
    aliases: ['uln2003', 'darlington array', 'driver board'],
    keywords: ['driver', 'motor', 'stepper', 'buffer'],
  },
  // Dual H-bridge: VS is the motor supply, OUT1/OUT2 and OUT3/OUT4 are the
  // switched channel outputs a dc_motor connects across.
  motor_driver: {
    spicePrefix: 'U', pins: 12, symbolType: 'generic', label: 'Motor driver (L298N)',
    wiringOnly: true,
    fixedPins: ['VS', 'GND', 'ENA', 'IN1', 'IN2', 'ENB', 'IN3', 'IN4', 'OUT1', 'OUT2', 'OUT3', 'OUT4'],
    category: 'driver-ic',
    aliases: ['l298n', 'h-bridge', 'motor shield'],
    keywords: ['driver', 'motor', 'dc', 'direction', 'pwm'],
  },
  // 16x2 character LCD behind a PCF8574 I2C backpack; header order matches
  // the physical backpack (GND first).
  lcd_display: {
    spicePrefix: 'U', pins: 4, symbolType: 'generic', label: 'LCD 16x2 (I2C)',
    wiringOnly: true,
    fixedPins: ['GND', 'VCC', 'SDA', 'SCL'],
    category: 'display',
    aliases: ['lcd', '1602', 'character lcd'],
    keywords: ['display', 'screen', 'text', 'i2c'],
  },
  rotary_encoder: {
    spicePrefix: 'U', pins: 5, symbolType: 'generic', label: 'Rotary encoder (KY-040)',
    wiringOnly: true,
    fixedPins: ['CLK', 'DT', 'SW', 'VCC', 'GND'],
    category: 'input',
    aliases: ['encoder', 'ky-040'],
    keywords: ['rotary', 'knob', 'input', 'position', 'quadrature'],
  },
  // Addressable strip head-end only (no DOUT — chaining is out of scope).
  // VCC must come from the 5V supply, never a GPIO.
  led_strip: {
    spicePrefix: 'U', pins: 3, symbolType: 'generic', label: 'LED strip (WS2812 NeoPixel)',
    wiringOnly: true,
    fixedPins: ['VCC', 'DIN', 'GND'],
    category: 'display',
    aliases: ['neopixel', 'ws2812', 'addressable led'],
    keywords: ['light', 'rgb', 'strip', 'pixel', 'color'],
  },
  imu_sensor: {
    spicePrefix: 'U', pins: 4, symbolType: 'generic', label: 'IMU (MPU6050, I2C)',
    wiringOnly: true,
    fixedPins: ['VCC', 'GND', 'SCL', 'SDA'],
    category: 'sensor',
    aliases: ['imu', 'mpu6050', 'accelerometer', 'gyroscope'],
    keywords: ['motion', 'orientation', 'tilt', 'sensor', 'i2c'],
  },
  // TSOP38xx demodulating receiver, pins 1-3 facing the lens.
  ir_receiver: {
    spicePrefix: 'U', pins: 3, symbolType: 'generic', label: 'IR receiver (TSOP38xx)',
    wiringOnly: true,
    fixedPins: ['OUT', 'GND', 'VCC'],
    category: 'sensor',
    aliases: ['tsop', 'ir sensor', 'remote receiver'],
    keywords: ['infrared', 'remote', 'demodulator', 'receiver'],
  },
  // 74HC595 in DIP-16 physical pin order 1-16 (the timer_555 pattern: canonical
  // order = DIP order, so the straddle leg layout is the identity). QH2 is the
  // QH' serial-out on pin 9.
  shift_register: {
    spicePrefix: 'U', pins: 16, symbolType: 'generic', label: 'Shift register (74HC595)',
    wiringOnly: true,
    fixedPins: ['QB', 'QC', 'QD', 'QE', 'QF', 'QG', 'QH', 'GND', 'QH2', 'SRCLR', 'SRCLK', 'RCLK', 'OE', 'SER', 'QA', 'VCC'],
    category: 'driver-ic',
    aliases: ['74hc595', 'shift reg'],
    keywords: ['serial', 'parallel', 'expander', 'gpio', 'spi'],
  },
  // Sharp PC817 DIP-4, canonical order = physical DIP pins 1-4 (anode,
  // cathode, emitter, collector) so the straddle leg layout is the identity.
  // Simulated via the PC817 subcircuit — NOT wiring-only.
  optocoupler: {
    spicePrefix: 'X', pins: 4, symbolType: 'generic', label: 'Optocoupler (PC817)',
    fixedPins: ['A', 'K', 'E', 'C'],
    category: 'driver-ic',
    aliases: ['opto', 'pc817', 'optoisolator'],
    keywords: ['isolation', 'isolator', 'led', 'phototransistor'],
  },
  // ACS712 hall-effect module. IP+/IP- are the series load path (screw
  // terminals) and carry the real current: the SPICE image is one derived
  // milliohm shunt line <REF>_S across them (compound pattern). VCC/OUT/GND
  // are wiring-only header pins.
  current_sensor: {
    spicePrefix: 'R', pins: 5, symbolType: 'generic', label: 'Current sensor (ACS712)',
    fixedPins: ['IP+', 'IP-', 'VCC', 'OUT', 'GND'],
    category: 'sensor',
    aliases: ['acs712', 'hall current sensor'],
    keywords: ['current', 'ampere', 'measure', 'shunt', 'sensor'],
  },
  // 4x4 membrane keypad; 8-pin ribbon in physical order, rows then columns.
  keypad: {
    spicePrefix: 'U', pins: 8, symbolType: 'generic', label: 'Keypad (4x4 membrane)',
    wiringOnly: true,
    fixedPins: ['R1', 'R2', 'R3', 'R4', 'C1', 'C2', 'C3', 'C4'],
    category: 'input',
    aliases: ['membrane keypad', 'matrix keypad', '4x4 keypad'],
    keywords: ['input', 'buttons', 'matrix', 'keys'],
  },
  joystick: {
    spicePrefix: 'U', pins: 5, symbolType: 'generic', label: 'Joystick (KY-023)',
    wiringOnly: true,
    fixedPins: ['GND', 'VCC', 'VRX', 'VRY', 'SW'],
    category: 'input',
    aliases: ['ky-023', 'thumbstick'],
    keywords: ['input', 'analog', 'xy', 'control'],
  },
  rtc_module: {
    spicePrefix: 'U', pins: 4, symbolType: 'generic', label: 'RTC (DS3231, I2C)',
    wiringOnly: true,
    fixedPins: ['GND', 'VCC', 'SDA', 'SCL'],
    category: 'module',
    aliases: ['rtc', 'ds3231', 'ds1307', 'real time clock'],
    keywords: ['clock', 'time', 'date', 'i2c'],
  },
  sd_card: {
    spicePrefix: 'U', pins: 6, symbolType: 'generic', label: 'SD card module (SPI)',
    wiringOnly: true,
    fixedPins: ['VCC', 'GND', 'MISO', 'MOSI', 'SCK', 'CS'],
    category: 'module',
    aliases: ['micro sd', 'sd module', 'card reader'],
    keywords: ['storage', 'memory', 'spi', 'logging'],
  },
  // RC522 breakout, physical 8-pin header order. SDA doubles as the SPI SS.
  // 3.3V only — the prompt steers VCC to the 3V3 supply.
  rfid_reader: {
    spicePrefix: 'U', pins: 8, symbolType: 'generic', label: 'RFID reader (RC522)',
    wiringOnly: true,
    fixedPins: ['3V3', 'RST', 'GND', 'IRQ', 'MISO', 'MOSI', 'SCK', 'SDA'],
    category: 'module',
    aliases: ['rfid', 'rc522', 'nfc reader'],
    keywords: ['rfid', 'tag', 'card', 'spi', 'access'],
  },
  // PMW3360 breakout, physical header order (RS GD MT SS SC MO MI VI).
  // NCS is the SPI chip select; MOT is the active-low motion interrupt.
  mouse_sensor: {
    spicePrefix: 'U', pins: 8, symbolType: 'generic', label: 'Mouse sensor (PMW3360, SPI)',
    wiringOnly: true,
    fixedPins: ['RST', 'GND', 'MOT', 'NCS', 'SCK', 'MOSI', 'MISO', 'VCC'],
    category: 'sensor',
    aliases: ['pmw3360', 'optical sensor'],
    keywords: ['mouse', 'motion', 'tracking', 'spi', 'optical'],
  },
  soil_moisture: {
    spicePrefix: 'U', pins: 3, symbolType: 'generic', label: 'Soil moisture sensor (capacitive)',
    wiringOnly: true,
    fixedPins: ['VCC', 'GND', 'AOUT'],
    category: 'sensor',
    aliases: ['soil sensor', 'moisture sensor'],
    keywords: ['soil', 'moisture', 'water', 'plant', 'garden'],
  },
  gas_sensor: {
    spicePrefix: 'U', pins: 4, symbolType: 'generic', label: 'Gas sensor (MQ-2)',
    wiringOnly: true,
    fixedPins: ['VCC', 'GND', 'DO', 'AO'],
    category: 'sensor',
    aliases: ['mq-2', 'mq2', 'smoke sensor'],
    keywords: ['gas', 'smoke', 'air', 'detector', 'analog'],
  },
  sound_sensor: {
    spicePrefix: 'U', pins: 4, symbolType: 'generic', label: 'Sound sensor (KY-038)',
    wiringOnly: true,
    fixedPins: ['VCC', 'GND', 'DO', 'AO'],
    category: 'sensor',
    aliases: ['ky-038', 'microphone module', 'mic'],
    keywords: ['sound', 'audio', 'noise', 'microphone', 'detector'],
  },
  // TO-92 like temp_sensor, but NOTE the A3144 pin order is [VCC, GND, OUT]
  // (not VCC/OUT/GND) and OUT is open-collector — it needs a pull-up.
  hall_sensor: {
    spicePrefix: 'U', pins: 3, symbolType: 'generic', label: 'Hall sensor (A3144)',
    wiringOnly: true,
    fixedPins: ['VCC', 'GND', 'OUT'],
    category: 'sensor',
    aliases: ['a3144', 'hall effect'],
    keywords: ['magnetic', 'magnet', 'sensor', 'proximity'],
  },
  baro_sensor: {
    spicePrefix: 'U', pins: 4, symbolType: 'generic', label: 'Barometric sensor (BMP280, I2C)',
    wiringOnly: true,
    fixedPins: ['VCC', 'GND', 'SCL', 'SDA'],
    category: 'sensor',
    aliases: ['bmp280', 'barometer', 'pressure sensor'],
    keywords: ['pressure', 'altitude', 'weather', 'i2c'],
  },
  // MCP3008 in DIP-16 physical order (shift_register pattern: canonical =
  // DIP order, identity straddle legs). Gives the Raspberry Pi analog inputs.
  adc_module: {
    spicePrefix: 'U', pins: 16, symbolType: 'generic', label: 'ADC (MCP3008)',
    wiringOnly: true,
    fixedPins: ['CH0', 'CH1', 'CH2', 'CH3', 'CH4', 'CH5', 'CH6', 'CH7', 'DGND', 'CS', 'DIN', 'DOUT', 'CLK', 'AGND', 'VREF', 'VDD'],
    category: 'driver-ic',
    aliases: ['mcp3008', 'adc'],
    keywords: ['analog', 'digital', 'converter', 'spi', 'channels'],
  },
  // ---- Connectors -------------------------------------------------
  // How a board meets the outside world. All wiringOnly: a connector is copper
  // and a mating face, never a SPICE element. pin_header takes its pin count
  // from the nodes array (2-8 map to real 1xNN library footprints; more falls
  // through to the synthesized header), so it has no fixedPins contract.
  pin_header: {
    spicePrefix: 'J', pins: 2, symbolType: 'generic', label: 'Pin header',
    category: 'connector',
    aliases: ['header', 'jumper', 'breakout header', 'dupont'],
    keywords: ['connector', 'io', 'expansion', 'breakout', 'pins', 'off-board'],
    wiringOnly: true,
  },
  terminal_block: {
    spicePrefix: 'J', pins: 2, symbolType: 'generic', label: 'Screw terminal block',
    category: 'connector',
    aliases: ['screw terminal', 'terminal', 'bornier', 'wire clamp'],
    keywords: ['connector', 'power in', 'screw', 'wire', 'mains'],
    wiringOnly: true,
  },
  barrel_jack: {
    spicePrefix: 'J', pins: 2, symbolType: 'generic', label: 'DC barrel jack',
    fixedPins: ['VIN', 'GND'],
    category: 'connector',
    aliases: ['dc jack', 'power jack', 'dc socket', '2.1mm jack'],
    keywords: ['connector', 'power in', 'wall adapter', '5.5mm'],
    wiringOnly: true,
  },
  usb_c: {
    spicePrefix: 'J', pins: 17, symbolType: 'generic', label: 'USB-C connector (USB 2.0)',
    wiringOnly: true,
    // Full 16-pin USB 2.0 Type-C receptacle in physical order (A1→A12 then
    // B12→B1) plus SHIELD. Repeated roles carry their pin position (VBUS_A4);
    // CC1/CC2/SBU1/SBU2 appear once each so they keep their bare names.
    fixedPins: ['GND_A1', 'VBUS_A4', 'CC1', 'DP_A6', 'DM_A7', 'SBU1', 'VBUS_A9', 'GND_A12',
      'GND_B12', 'VBUS_B9', 'SBU2', 'DM_B7', 'DP_B6', 'CC2', 'VBUS_B4', 'GND_B1', 'SHIELD'],
    category: 'connector',
    aliases: ['usb-c', 'type-c', 'usb c', 'type c receptacle', 'usb connector'],
    keywords: ['connector', 'usb', 'power in', 'data', '5v', 'charging', 'cc'],
  },
  terminal_block_3: {
    spicePrefix: 'J', pins: 3, symbolType: 'generic', label: 'Screw terminal block (3-pos)',
    category: 'connector',
    aliases: ['3-pin screw terminal', '3-position terminal', 'bornier 3'],
    keywords: ['connector', 'screw', 'wire', 'power', 'three'],
    wiringOnly: true,
  },
  battery_connector: {
    spicePrefix: 'J', pins: 2, symbolType: 'generic', label: 'Battery connector (JST-PH)',
    fixedPins: ['BAT+', 'BAT-'],
    category: 'connector',
    aliases: ['jst', 'jst-ph', 'lipo connector', 'battery jack'],
    keywords: ['connector', 'battery', 'lipo', 'li-ion', 'power in', '2mm'],
    wiringOnly: true,
  },
  arduino_uno: {
    spicePrefix: 'U', pins: 24, symbolType: 'generic', label: 'Arduino Uno',
    wiringOnly: true, mcu: true,
    // Full usable header: power | digital D0-D13 | analog A0-A5 (A4/A5 double
    // as I2C SDA/SCL). Order is the positional contract every other pin array
    // and the AI prompt must match by index.
    fixedPins: ['5V', '3V3', 'GND', 'VIN', 'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5'],
    category: 'microcontroller',
    aliases: ['arduino', 'uno', 'atmega328'],
    keywords: ['microcontroller', 'board', 'mcu', 'atmega'],
  },
  raspberry_pi: {
    spicePrefix: 'U', pins: 14, symbolType: 'generic', label: 'Raspberry Pi',
    wiringOnly: true, mcu: true,
    // GPIO8-11 (SPI0 CE0/MISO/MOSI/SCLK) were appended in a later release —
    // new pins are only ever APPENDED so older saved circuits stay index-
    // compatible and padMcuNodes can migrate them by padding with NC pins.
    fixedPins: ['5V', '3V3', 'GND', 'GPIO2', 'GPIO3', 'GPIO4', 'GPIO17', 'GPIO18', 'GPIO27', 'GPIO22', 'GPIO8', 'GPIO9', 'GPIO10', 'GPIO11'],
    category: 'microcontroller',
    aliases: ['pi', 'rpi', 'raspberry'],
    keywords: ['microcontroller', 'sbc', 'board', 'gpio', 'linux'],
  },
  esp32: {
    spicePrefix: 'U', pins: 12, symbolType: 'generic', label: 'ESP32',
    wiringOnly: true, mcu: true,
    fixedPins: ['3V3', 'GND', 'VIN', 'EN', 'GPIO2', 'GPIO4', 'GPIO5', 'GPIO13', 'GPIO18', 'GPIO19', 'GPIO21', 'GPIO22'],
    category: 'microcontroller',
    aliases: ['esp', 'wroom', 'devkit'],
    keywords: ['microcontroller', 'wifi', 'bluetooth', 'board', 'mcu'],
  },
  esp32_s3_wroom: {
    spicePrefix: 'U', pins: 41, symbolType: 'generic', label: 'ESP32-S3-WROOM-1',
    wiringOnly: true, mcu: true,
    // Bare ESP32-S3-WROOM-1 module — pins 1-41 in the Espressif datasheet's
    // own order, names as printed there (IOn rather than GPIOn). RXD0/TXD0 are
    // GPIO44/GPIO43; EPAD is the bottom thermal pad and belongs on ground.
    // IO35/IO36/IO37 are unavailable on octal-PSRAM (R8) variants — the pins
    // exist on every module, so they stay in the contract.
    fixedPins: ['GND', '3V3', 'EN', 'IO4', 'IO5', 'IO6', 'IO7', 'IO15', 'IO16', 'IO17', 'IO18', 'IO8', 'IO19', 'IO20', 'IO3', 'IO46', 'IO9', 'IO10', 'IO11', 'IO12', 'IO13', 'IO14', 'IO21', 'IO47', 'IO48', 'IO45', 'IO0', 'IO35', 'IO36', 'IO37', 'IO38', 'IO39', 'IO40', 'IO41', 'IO42', 'RXD0', 'TXD0', 'IO2', 'IO1', 'GND', 'EPAD'],
    category: 'microcontroller',
    aliases: ['esp32-s3', 'esp32s3', 's3 wroom', 'wroom-1'],
    keywords: ['microcontroller', 'wifi', 'bluetooth', 'module', 'mcu', 'usb otg', 'castellated'],
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

// Board-to-world connectors. Wired to nothing but power and ground is their
// normal, correct state — a barrel jack has no signal pin to participate — so
// the dead_active_device rule has to skip them.
export const CONNECTOR_KINDS = new Set(
  Object.entries(COMPONENT_KINDS)
    .filter(([, spec]) => spec.category === 'connector')
    .map(([kind]) => kind),
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

// --- Discovery metadata (categories, synonyms, value hints) ---
// Everything above is unchanged; the exports below are purely additive and power
// the component-library UI (grouping + search) and the AI kind-picker guide.

// Ordered category descriptors: general → specific, boards last (matching the
// historical browse order). `id` matches each kind's `category`; `title` is the
// heading shown in the UI and the AI prompt. Reorder freely — grouped views
// follow this order.
export const COMPONENT_CATEGORIES = [
  { id: 'passive', title: 'Passives' },
  { id: 'diode', title: 'Diodes & LEDs' },
  { id: 'transistor', title: 'Transistors' },
  { id: 'analog-ic', title: 'Analog ICs' },
  { id: 'source', title: 'Sources' },
  { id: 'power', title: 'Power' },
  { id: 'switch', title: 'Switches' },
  { id: 'input', title: 'Input devices' },
  { id: 'sensor', title: 'Sensors' },
  { id: 'display', title: 'Displays' },
  { id: 'actuator', title: 'Actuators & motors' },
  { id: 'driver-ic', title: 'Drivers & interface ICs' },
  { id: 'connector', title: 'Connectors' },
  { id: 'module', title: 'Modules' },
  { id: 'microcontroller', title: 'Boards' },
];

export const KIND_CATEGORY = Object.fromEntries(
  entries.map(([kind, info]) => [kind, info.category]),
);

export const KIND_ALIASES = Object.fromEntries(
  entries.map(([kind, info]) => [kind, info.aliases ?? []]),
);

export const KIND_KEYWORDS = Object.fromEntries(
  entries.map(([kind, info]) => [kind, info.keywords ?? []]),
);

export const PREFERRED_VALUES = Object.fromEntries(
  entries.filter(([, info]) => info.preferredValues).map(([kind, info]) => [kind, info.preferredValues]),
);

// Registry kinds bucketed by category, preserving registry order within each
// bucket and COMPONENT_CATEGORIES order across buckets. Every kind lands in
// exactly one bucket; a kind whose category is missing from COMPONENT_CATEGORIES
// throws at module load so the taxonomy can never silently drop a component.
export const KINDS_BY_CATEGORY = (() => {
  const known = new Set(COMPONENT_CATEGORIES.map((category) => category.id));
  const byCategory = Object.fromEntries(COMPONENT_CATEGORIES.map((category) => [category.id, []]));
  for (const [kind, info] of entries) {
    if (!known.has(info.category)) {
      throw new Error(`componentKinds: "${kind}" has unknown category "${info.category}"`);
    }
    byCategory[info.category].push(kind);
  }
  return byCategory;
})();

// Lowercased search haystack for a kind: label + slug + aliases + keywords, so a
// library search for "op-amp", "pot", "ldr", or "555" resolves to its kind.
export const kindSearchText = (kind) => {
  const info = COMPONENT_KINDS[kind];
  if (!info) return String(kind || '').toLowerCase();
  return [info.label, kind, ...(info.aliases ?? []), ...(info.keywords ?? [])]
    .join(' ')
    .toLowerCase();
};

// True when the (trimmed, lowercased) query is empty or is a substring of the
// kind's search haystack. Empty query matches everything.
export const kindMatchesQuery = (kind, query) => {
  const needle = String(query || '').trim().toLowerCase();
  return !needle || kindSearchText(kind).includes(needle);
};

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
