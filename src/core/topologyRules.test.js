import { describe, expect, it } from 'vitest';
import { FIXED_PIN_NAMES } from './componentKinds.js';
import {
  applySafeAutoFixes,
  checkCircuitTopology,
  composeTopologyCorrection,
  parseResistance,
} from './topologyRules.js';

// Builds an MCU part with nodes assigned by pin name; unnamed pins get the
// canonical NC_<REF>_<n> placeholder.
const mcuPart = (kind, ref, pinMap) => ({
  ref,
  kind,
  value: kind,
  nodes: FIXED_PIN_NAMES[kind].map((name, index) => pinMap[name] || `NC_${ref}_${index + 1}`),
});

const circuitOf = (components, extra = {}) => ({
  title: 'fixture',
  type: 'test',
  supplyVoltage: 5,
  nodes: [...new Set(components.flatMap((part) => part.nodes))],
  components,
  notes: [],
  ...extra,
});

const idsOf = (result) => result.violations.map((entry) => entry.id);
const errorsOf = (result) => result.violations.filter((entry) => entry.severity === 'error');

// The exact field bug this engine was built for: every net is correctly
// formed (continuity checkers pass) but there is no transistor driver — the
// buzzer is permanently fed from 3V3, R2 forms a fixed divider to ground, and
// GPIO2 fights the load directly.
const esp32BuzzerBug = circuitOf([
  mcuPart('esp32', 'U1', { '3V3': '3V3', GND: '0', GPIO2: 'BUZZER' }),
  { ref: 'R2', kind: 'resistor', value: '330', nodes: ['BUZZER', '0'] },
  { ref: 'RBZ1', kind: 'buzzer', value: '5V active', nodes: ['3V3', 'BUZZER'] },
]);

// The corrected topology: GPIO2 -> 1k base resistor -> NPN, buzzer between
// 3V3 and the collector.
const esp32BuzzerFixed = circuitOf([
  mcuPart('esp32', 'U1', { '3V3': '3V3', GND: '0', GPIO2: 'CTRL' }),
  { ref: 'R2', kind: 'resistor', value: '1k', nodes: ['CTRL', 'BASE'] },
  { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['BZ_LOW', 'BASE', '0'] },
  { ref: 'RBZ1', kind: 'buzzer', value: '5V active', nodes: ['3V3', 'BZ_LOW'] },
]);

describe('esp32 buzzer divider bug (named regression)', () => {
  it('flags the divider-powered load with the misused resistor named', () => {
    const result = checkCircuitTopology(esp32BuzzerBug);
    expect(result.ok).toBe(false);
    const divider = result.violations.find((entry) => entry.id === 'divider_powered_load');
    expect(divider).toBeDefined();
    expect(divider.severity).toBe('error');
    expect(divider.refs).toContain('R2');
    expect(divider.refs).toContain('RBZ1');
    expect(divider.message).toContain('GPIO2');
    expect(divider.fix).toMatch(/NPN transistor/);
  });

  it('supersedes the generic gpio_direct_load finding for the same load', () => {
    const result = checkCircuitTopology(esp32BuzzerBug);
    expect(idsOf(result)).not.toContain('gpio_direct_load');
  });

  it('passes the corrected transistor-driver topology', () => {
    const result = checkCircuitTopology(esp32BuzzerFixed);
    expect(errorsOf(result)).toEqual([]);
  });
});

describe('gpio_direct_load', () => {
  it('flags a buzzer wired straight from a GPIO to ground', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('esp32', 'U1', { '3V3': '3V3', GND: '0', GPIO2: 'BZ' }),
      { ref: 'RBZ1', kind: 'buzzer', value: '5V active', nodes: ['BZ', '0'] },
    ]));
    const hit = result.violations.find((entry) => entry.id === 'gpio_direct_load');
    expect(hit).toBeDefined();
    expect(hit.refs).toContain('RBZ1');
    expect(hit.message).toContain('GPIO2');
  });

  it('accepts a motor switched through a relay module', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('arduino_uno', 'U1', { '5V': 'VCC5', GND: '0', D2: 'RLY' }),
      { ref: 'U2', kind: 'relay_module', value: '1ch', nodes: ['VCC5', '0', 'RLY', 'MCOM', 'MNO', 'NC_U2_6'] },
      { ref: 'RM1', kind: 'dc_motor', value: '6V', nodes: ['VCC5', 'MCOM'] },
    ]));
    expect(idsOf(result)).not.toContain('gpio_direct_load');
  });
});

describe('led_no_series_resistor', () => {
  it('flags an LED across the supply with no resistor', () => {
    const result = checkCircuitTopology(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['VCC', '0'] },
    ]));
    expect(idsOf(result)).toContain('led_no_series_resistor');
  });

  it('accepts an LED with a series resistor', () => {
    const result = checkCircuitTopology(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '330', nodes: ['VCC', 'LEDA'] },
      { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['LEDA', '0'] },
    ]));
    expect(idsOf(result)).not.toContain('led_no_series_resistor');
  });
});

describe('led_polarity', () => {
  it('flags an unambiguously reversed LED', () => {
    const result = checkCircuitTopology(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '330', nodes: ['LEDA', '0'] },
      { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['LEDA', 'VCC'] },
    ]));
    expect(idsOf(result)).toContain('led_polarity');
  });

  it('skips a flyback diode whose orientation is ambiguous', () => {
    const result = checkCircuitTopology(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'RM1', kind: 'dc_motor', value: '6V', nodes: ['VCC', 'SW'] },
      { ref: 'D1', kind: 'diode', value: '1N4007', nodes: ['SW', 'VCC'] },
      { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['SW', 'BASE', '0'] },
      { ref: 'RB1', kind: 'resistor', value: '1k', nodes: ['CTRL', 'BASE'] },
      { ref: 'V2', kind: 'signal_source', value: 'PULSE(0 5 0 1u 1u 1m 2m)', nodes: ['CTRL', '0'] },
    ]));
    expect(idsOf(result)).not.toContain('led_polarity');
  });

  it('skips a correctly wired buck converter catch diode even when loadless', () => {
    // Loadless is the case the exemption exists for: with nothing pulling
    // VOUT to ground, the naive anode-ground/cathode-supply check would
    // otherwise misread this correct catch schottky as reversed (see the
    // buck_converter describe block for the mechanism).
    const result = checkCircuitTopology(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '12V', nodes: ['VIN', '0'] },
      { ref: 'U1', kind: 'buck_converter', value: 'LM2596-5.0', nodes: ['VIN', 'SW', '0', 'VOUT', '0'] },
      { ref: 'L1', kind: 'inductor', value: '33uH', nodes: ['SW', 'VOUT'] },
      { ref: 'D1', kind: 'schottky', value: '1N5819', nodes: ['0', 'SW'] },
    ]));
    expect(idsOf(result)).not.toContain('led_polarity');
  });

  it('still flags an LED miswired onto the buck switch node', () => {
    // The catch-diode exemption is scoped to rectifier kinds (diode/schottky)
    // only. An LED wired the same way — anode grounded, cathode on the raw
    // switch node — is a genuine miswire (LEDs aren't catch diodes) and must
    // still trip led_polarity.
    const result = checkCircuitTopology(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '12V', nodes: ['VIN', '0'] },
      { ref: 'U1', kind: 'buck_converter', value: 'LM2596-5.0', nodes: ['VIN', 'SW', '0', 'VOUT', '0'] },
      { ref: 'L1', kind: 'inductor', value: '33uH', nodes: ['SW', 'VOUT'] },
      { ref: 'DL1', kind: 'led', value: 'red', nodes: ['0', 'SW'] },
    ]));
    expect(idsOf(result)).toContain('led_polarity');
  });
});

describe('IR discrete parts', () => {
  it('flags an IR emitter LED across the supply with no resistor', () => {
    const result = checkCircuitTopology(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'DIR1', kind: 'ir_led', value: '940nm', nodes: ['VCC', '0'] },
    ]));
    expect(idsOf(result)).toContain('led_no_series_resistor');
  });

  it('accepts an IR emitter LED behind a series resistor', () => {
    const result = checkCircuitTopology(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '220', nodes: ['VCC', 'IRA'] },
      { ref: 'DIR1', kind: 'ir_led', value: '940nm', nodes: ['IRA', '0'] },
    ]));
    expect(idsOf(result)).not.toContain('led_no_series_resistor');
    expect(errorsOf(result)).toEqual([]);
  });

  it('flags an unambiguously reversed IR emitter LED', () => {
    const result = checkCircuitTopology(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '220', nodes: ['IRA', '0'] },
      { ref: 'DIR1', kind: 'ir_led', value: '940nm', nodes: ['IRA', 'VCC'] },
    ]));
    expect(idsOf(result)).toContain('led_polarity');
  });

  it('does not let an IR emitter LED pass for a flyback diode', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('esp32', 'U1', { '3V3': 'V33', GND: '0', GPIO4: 'CTRL' }),
      { ref: 'RB1', kind: 'resistor', value: '1k', nodes: ['CTRL', 'BASE'] },
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'RM1', kind: 'dc_motor', value: '6V', nodes: ['VCC', 'MLOW'] },
      { ref: 'DIR1', kind: 'ir_led', value: '940nm', nodes: ['MLOW', 'VCC'] },
      { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['MLOW', 'BASE', '0'] },
    ]));
    expect(idsOf(result)).toContain('missing_flyback_diode');
  });

  it('keeps an IR phototransistor divider clean', () => {
    const result = checkCircuitTopology(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'RIR1', kind: 'ir_phototransistor', value: '', nodes: ['VCC', 'VSENSE'] },
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VSENSE', '0'] },
    ]));
    expect(result.violations).toEqual([]);
  });
});

describe('i2c_missing_pullups', () => {
  it('warns when SDA/SCL have no pull-up resistors', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('esp32', 'U1', { '3V3': '3V3', GND: '0', GPIO21: 'SDA', GPIO22: 'SCL' }),
      { ref: 'U2', kind: 'oled_display', value: 'SSD1306', nodes: ['3V3', '0', 'SCL', 'SDA'] },
    ]));
    const hit = result.violations.find((entry) => entry.id === 'i2c_missing_pullups');
    expect(hit).toBeDefined();
    expect(hit.severity).toBe('warning');
  });

  it('accepts pull-ups to the supply', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('esp32', 'U1', { '3V3': '3V3', GND: '0', GPIO21: 'SDA', GPIO22: 'SCL' }),
      { ref: 'U2', kind: 'oled_display', value: 'SSD1306', nodes: ['3V3', '0', 'SCL', 'SDA'] },
      { ref: 'R1', kind: 'resistor', value: '4.7k', nodes: ['SDA', '3V3'] },
      { ref: 'R2', kind: 'resistor', value: '4.7k', nodes: ['SCL', '3V3'] },
    ]));
    expect(idsOf(result)).not.toContain('i2c_missing_pullups');
  });

  // The rule keys off SDA/SCL in fixedPins, so the new I2C kinds are covered
  // with no rule change.
  it('auto-covers the I2C LCD backpack and the MPU6050 IMU', () => {
    for (const [kind, ref] of [['lcd_display', 'U2'], ['imu_sensor', 'U3'], ['rtc_module', 'U4'], ['baro_sensor', 'U5']]) {
      const pinMap = kind === 'lcd_display' || kind === 'rtc_module'
        ? { GND: '0', VCC: '3V3', SDA: 'SDA', SCL: 'SCL' }
        : { VCC: '3V3', GND: '0', SCL: 'SCL', SDA: 'SDA' };
      const result = checkCircuitTopology(circuitOf([
        mcuPart('esp32', 'U1', { '3V3': '3V3', GND: '0', GPIO21: 'SDA', GPIO22: 'SCL' }),
        mcuPart(kind, ref, pinMap),
      ]));
      const hit = result.violations.find((entry) => entry.id === 'i2c_missing_pullups');
      expect(hit, kind).toBeDefined();
      expect(hit.refs).toContain(ref);
    }
  });
});

describe('stepper_missing_driver', () => {
  it('flags coil pins wired directly to GPIOs', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('arduino_uno', 'U1', { '5V': 'VCC5', GND: '0', D8: 'CA', D9: 'CB', D10: 'CC', D11: 'CD' }),
      mcuPart('stepper_motor', 'M1', { A: 'CA', B: 'CB', C: 'CC', D: 'CD', COM: 'VCC5' }),
    ]));
    const hit = result.violations.find((entry) => entry.id === 'stepper_missing_driver');
    expect(hit).toBeDefined();
    expect(hit.severity).toBe('error');
    expect(hit.refs).toContain('M1');
    expect(hit.fix).toContain('stepper_driver');
  });

  it('flags a stepper with no driver board on its coils', () => {
    const result = checkCircuitTopology(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      mcuPart('stepper_motor', 'M1', { A: 'VCC', B: 'N1', C: 'N2', D: 'N3', COM: 'VCC' }),
    ]));
    const hit = result.violations.find((entry) => entry.id === 'stepper_missing_driver');
    expect(hit).toBeDefined();
    expect(hit.message).toContain('no driver board');
  });

  it('accepts coils driven through a ULN2003 stepper driver', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('arduino_uno', 'U1', { '5V': 'VCC5', GND: '0', D8: 'SIN1', D9: 'SIN2', D10: 'SIN3', D11: 'SIN4' }),
      mcuPart('stepper_driver', 'U2', { IN1: 'SIN1', IN2: 'SIN2', IN3: 'SIN3', IN4: 'SIN4', VCC: 'VCC5', GND: '0', OUTA: 'COILA', OUTB: 'COILB', OUTC: 'COILC', OUTD: 'COILD' }),
      mcuPart('stepper_motor', 'M1', { A: 'COILA', B: 'COILB', C: 'COILC', D: 'COILD', COM: 'VCC5' }),
    ]));
    expect(idsOf(result)).not.toContain('stepper_missing_driver');
  });

  it('stays silent for a freshly dropped part with all coils unconnected', () => {
    const result = checkCircuitTopology(circuitOf([
      { ref: 'M1', kind: 'stepper_motor', value: '28BYJ-48', nodes: ['NC_M1_1', 'NC_M1_2', 'NC_M1_3', 'NC_M1_4', 'NC_M1_5'] },
    ]));
    expect(idsOf(result)).not.toContain('stepper_missing_driver');
  });
});

describe('led_strip_power_from_gpio', () => {
  it('flags a strip powered from a GPIO pin', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('esp32', 'U1', { '3V3': 'V33', GND: '0', GPIO2: 'PWR', GPIO4: 'DATA' }),
      mcuPart('led_strip', 'LS1', { VCC: 'PWR', DIN: 'DATA', GND: '0' }),
    ]));
    const hit = result.violations.find((entry) => entry.id === 'led_strip_power_from_gpio');
    expect(hit).toBeDefined();
    expect(hit.severity).toBe('error');
    expect(hit.refs).toContain('LS1');
    expect(hit.message).toContain('GPIO2');
  });

  it('accepts VCC on the 5V supply with DIN on a GPIO', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('arduino_uno', 'U1', { '5V': 'VCC5', GND: '0', D6: 'DATA' }),
      mcuPart('led_strip', 'LS1', { VCC: 'VCC5', DIN: 'DATA', GND: '0' }),
    ]));
    expect(idsOf(result)).not.toContain('led_strip_power_from_gpio');
  });
});

describe('dc motor via H-bridge driver module (regression pins)', () => {
  const motorViaL298n = circuitOf([
    mcuPart('esp32', 'U1', { '3V3': 'V33', GND: '0', GPIO4: 'MIN1', GPIO5: 'MIN2', GPIO13: 'MEN' }),
    { ref: 'V1', kind: 'voltage_source', value: '6V', nodes: ['VMOT', '0'] },
    mcuPart('motor_driver', 'U2', { VS: 'VMOT', GND: '0', ENA: 'MEN', IN1: 'MIN1', IN2: 'MIN2', OUT1: 'MA', OUT2: 'MB' }),
    { ref: 'RM1', kind: 'dc_motor', value: '6V', nodes: ['MA', 'MB'] },
  ]);

  it('produces zero violations for a motor across the driver outputs', () => {
    const result = checkCircuitTopology(motorViaL298n);
    expect(errorsOf(result)).toEqual([]);
    expect(idsOf(result)).not.toContain('gpio_direct_load');
    expect(idsOf(result)).not.toContain('missing_flyback_diode');
  });

  it('still flags a bare motor wired straight to a GPIO', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('esp32', 'U1', { '3V3': 'V33', GND: '0', GPIO4: 'MOT' }),
      { ref: 'RM1', kind: 'dc_motor', value: '6V', nodes: ['MOT', '0'] },
    ]));
    expect(idsOf(result)).toContain('gpio_direct_load');
  });
});

describe('optocoupler conduction and rules', () => {
  it('flags an opto input LED with no series resistor', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('esp32', 'U1', { '3V3': 'V33', GND: '0', GPIO4: 'CTRL' }),
      mcuPart('optocoupler', 'XU1', { A: 'CTRL', K: '0', E: 'NC_XU1_3', C: 'NC_XU1_4' }),
    ]));
    const hit = result.violations.find((entry) => entry.id === 'led_no_series_resistor');
    expect(hit).toBeDefined();
    expect(hit.refs).toContain('XU1');
  });

  it('accepts an isolated load switched by the opto output', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('esp32', 'U1', { '3V3': 'V33', GND: '0', GPIO4: 'CTRL' }),
      { ref: 'R1', kind: 'resistor', value: '330', nodes: ['CTRL', 'ANO'] },
      mcuPart('optocoupler', 'XU1', { A: 'ANO', K: '0', E: '0', C: 'BZLOW' }),
      { ref: 'V1', kind: 'voltage_source', value: '12V', nodes: ['V12', '0'] },
      { ref: 'RBZ1', kind: 'buzzer', value: '12V active', nodes: ['V12', 'BZLOW'] },
    ]));
    expect(errorsOf(result)).toEqual([]);
    expect(idsOf(result)).not.toContain('gpio_direct_load');
  });

  it('still requires a flyback diode for a motor on the opto output', () => {
    // ISOLATOR_OUTPUT_PINS suppresses gpio_direct_load but must NOT suppress
    // missing_flyback_diode — a bare opto has no protection diode.
    const result = checkCircuitTopology(circuitOf([
      mcuPart('esp32', 'U1', { '3V3': 'V33', GND: '0', GPIO4: 'CTRL' }),
      { ref: 'R1', kind: 'resistor', value: '330', nodes: ['CTRL', 'ANO'] },
      mcuPart('optocoupler', 'XU1', { A: 'ANO', K: '0', E: '0', C: 'MLOW' }),
      { ref: 'V1', kind: 'voltage_source', value: '12V', nodes: ['V12', '0'] },
      { ref: 'RM1', kind: 'dc_motor', value: '12V', nodes: ['V12', 'MLOW'] },
    ]));
    expect(idsOf(result)).toContain('missing_flyback_diode');
    expect(idsOf(result)).not.toContain('gpio_direct_load');
  });
});

describe('current_sensor conduction', () => {
  it('reach() crosses the IP shunt so a sensed transistor-driven motor stays clean', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('esp32', 'U1', { '3V3': 'V33', GND: '0', GPIO4: 'CTRL' }),
      { ref: 'RB1', kind: 'resistor', value: '1k', nodes: ['CTRL', 'BASE'] },
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      mcuPart('current_sensor', 'RCS1', { 'IP+': 'VCC', 'IP-': 'MTOP', VCC: 'V33', OUT: 'NC_RCS1_4', GND: '0' }),
      { ref: 'RM1', kind: 'dc_motor', value: '6V', nodes: ['MTOP', 'MLOW'] },
      { ref: 'DFB1', kind: 'diode', value: '1N4007', nodes: ['MLOW', 'MTOP'] },
      { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['MLOW', 'BASE', '0'] },
    ]));
    expect(errorsOf(result)).toEqual([]);
  });
});

describe('raspberry_pi SPI pin extension', () => {
  it('treats the appended GPIO8-11 pins as GPIO nets', () => {
    // An LED wired straight to GPIO10 must trip led_no_series_resistor —
    // proof the new pins register as gpioNets.
    const result = checkCircuitTopology(circuitOf([
      mcuPart('raspberry_pi', 'U1', { '5V': 'VCC5', GND: '0', GPIO10: 'LEDA' }),
      { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['LEDA', '0'] },
    ]));
    expect(idsOf(result)).toContain('led_no_series_resistor');
  });

  it('flags a legacy 10-node raspberry_pi with fixed_pin_node_count', () => {
    const result = checkCircuitTopology(circuitOf([
      {
        ref: 'U1',
        kind: 'raspberry_pi',
        value: 'Pi 4',
        nodes: ['VCC5', 'NC_U1_2', '0', 'NC_U1_4', 'NC_U1_5', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8', 'NC_U1_9', 'NC_U1_10'],
      },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCC5', '0'] },
    ]));
    const hit = result.violations.find((entry) => entry.id === 'fixed_pin_node_count');
    expect(hit).toBeDefined();
    expect(hit.message).toContain('14');
  });
});

describe('voltage_domain_overdrive', () => {
  it('flags a 5V Uno pin driving a Pi GPIO (TC7)', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('arduino_uno', 'U1', { '5V': 'VCC5', GND: '0', D1: 'UART_TX' }),
      mcuPart('raspberry_pi', 'U3', { '5V': 'VCC5', GND: '0', GPIO9: 'UART_TX' }),
    ]));
    const hit = result.violations.find((entry) => entry.id === 'voltage_domain_overdrive');
    expect(hit).toBeDefined();
    expect(hit.severity).toBe('error');
    expect(hit.refs).toEqual(expect.arrayContaining(['U1', 'U3']));
    expect(hit.message).toContain('GPIO9');
  });
  it('flags Uno SPI pins into an RC522 (TC2)', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('arduino_uno', 'U1', { '3V3': 'VCC33', GND: '0', D11: 'MOSI_NET' }),
      { ref: 'U2', kind: 'rfid_reader', value: 'RC522',
        nodes: ['VCC33', 'NC_U2_2', '0', 'NC_U2_4', 'NC_U2_5', 'MOSI_NET', 'NC_U2_7', 'NC_U2_8'] },
    ]));
    expect(idsOf(result)).toContain('voltage_domain_overdrive');
  });
  it('stays silent when both ends share a 3.3V domain', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('esp32', 'U1', { '3V3': 'VCC33', GND: '0', GPIO5: 'MOSI_NET' }),
      { ref: 'U2', kind: 'rfid_reader', value: 'RC522',
        nodes: ['VCC33', 'NC_U2_2', '0', 'NC_U2_4', 'NC_U2_5', 'MOSI_NET', 'NC_U2_7', 'NC_U2_8'] },
    ]));
    expect(idsOf(result)).not.toContain('voltage_domain_overdrive');
  });
});

describe('tier-3 discrete kinds', () => {
  it('flags a reversed schottky like a plain diode', () => {
    const result = checkCircuitTopology(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '330', nodes: ['VCC', 'DK'] },
      { ref: 'DS1', kind: 'schottky', value: '1N5819', nodes: ['0', 'DK'] },
    ]));
    expect(idsOf(result)).toContain('led_polarity');
  });

  it('accepts a schottky as the flyback diode across a switched motor', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('esp32', 'U1', { '3V3': 'V33', GND: '0', GPIO4: 'CTRL' }),
      { ref: 'RB1', kind: 'resistor', value: '1k', nodes: ['CTRL', 'BASE'] },
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'RM1', kind: 'dc_motor', value: '6V', nodes: ['VCC', 'MLOW'] },
      { ref: 'DS1', kind: 'schottky', value: '1N5819', nodes: ['MLOW', 'VCC'] },
      { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['MLOW', 'BASE', '0'] },
    ]));
    expect(idsOf(result)).not.toContain('missing_flyback_diode');
    expect(errorsOf(result)).toEqual([]);
  });

  it('demands a flyback diode for a switched vibration motor, labeled by kind', () => {
    const bug = circuitOf([
      mcuPart('esp32', 'U1', { '3V3': 'V33', GND: '0', GPIO4: 'CTRL' }),
      { ref: 'RB1', kind: 'resistor', value: '1k', nodes: ['CTRL', 'BASE'] },
      { ref: 'V1', kind: 'voltage_source', value: '3V', nodes: ['VCC', '0'] },
      { ref: 'RVM1', kind: 'vibration_motor', value: '3V', nodes: ['VCC', 'MLOW'] },
      { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['MLOW', 'BASE', '0'] },
    ]);
    const result = checkCircuitTopology(bug);
    const hit = result.violations.find((entry) => entry.id === 'missing_flyback_diode');
    expect(hit).toBeDefined();
    expect(hit.message).toContain('Vibration motor');
    // The additive auto-fix generalizes: it inserts a 1N4007 across the motor.
    const fixed = applySafeAutoFixes(bug, result.violations);
    expect(fixed.applied).toBe(true);
    expect(fixed.circuit.components.some((part) => part.kind === 'diode' && part.value === '1N4007')).toBe(true);
  });

  it('still exempts a transistor-switched buzzer from the flyback rule', () => {
    const result = checkCircuitTopology(esp32BuzzerFixed);
    expect(idsOf(result)).not.toContain('missing_flyback_diode');
  });

  it('flags a vibration motor wired straight to a GPIO', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('esp32', 'U1', { '3V3': 'V33', GND: '0', GPIO4: 'VM' }),
      { ref: 'RVM1', kind: 'vibration_motor', value: '3V', nodes: ['VM', '0'] },
    ]));
    expect(idsOf(result)).toContain('gpio_direct_load');
  });

  it('sees through a fuse when hunting for missing series resistors', () => {
    // Fuse conducts even under crossResistors:false — an LED loop protected
    // only by a fuse still lacks a current-limiting resistor.
    const result = checkCircuitTopology(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'F1', kind: 'fuse', value: '1A', nodes: ['VCC', 'FOUT'] },
      { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['FOUT', '0'] },
    ]));
    expect(idsOf(result)).toContain('led_no_series_resistor');
  });

  it('registers a solar panel positive node as a supply net', () => {
    // A reversed LED between the panel + and ground is only detectable if
    // the panel's plus net registered in supplyNets.
    const result = checkCircuitTopology(circuitOf([
      { ref: 'VSOL1', kind: 'solar_panel', value: '6V', nodes: ['SUN', '0'] },
      { ref: 'R1', kind: 'resistor', value: '330', nodes: ['SUN', 'DK'] },
      { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['0', 'DK'] },
    ]));
    expect(idsOf(result)).toContain('led_polarity');
  });
});

describe('pushbutton_no_pull', () => {
  it('warns for a button on a GPIO with no pull resistor', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('esp32', 'U1', { '3V3': '3V3', GND: '0', GPIO4: 'BTN' }),
      { ref: 'RBTN', kind: 'pushbutton', value: '', nodes: ['BTN', '0'] },
    ]));
    const hit = result.violations.find((entry) => entry.id === 'pushbutton_no_pull');
    expect(hit).toBeDefined();
    expect(hit.severity).toBe('warning');
    expect(hit.fix).toContain('INPUT_PULLUP');
  });

  it('accepts a button with a pull-up on the GPIO net', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('esp32', 'U1', { '3V3': '3V3', GND: '0', GPIO4: 'BTN' }),
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['3V3', 'BTN'] },
      { ref: 'RBTN', kind: 'pushbutton', value: '', nodes: ['BTN', '0'] },
    ]));
    expect(idsOf(result)).not.toContain('pushbutton_no_pull');
  });
});

describe('driver_control_floating', () => {
  it('flags a transistor whose base connects to nothing else', () => {
    const result = checkCircuitTopology(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '330', nodes: ['VCC', 'LEDK'] },
      { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['LEDK', 'BASE', '0'] },
    ]));
    expect(idsOf(result)).toContain('driver_control_floating');
  });

  it('accepts a biased base', () => {
    const result = checkCircuitTopology(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '330', nodes: ['VCC', 'LEDK'] },
      { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['LEDK', 'BASE', '0'] },
      { ref: 'RB1', kind: 'resistor', value: '10k', nodes: ['VCC', 'BASE'] },
    ]));
    expect(idsOf(result)).not.toContain('driver_control_floating');
  });
});

describe('driver_missing_base_resistor', () => {
  it('flags a BJT base tied directly to a GPIO', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('esp32', 'U1', { '3V3': '3V3', GND: '0', GPIO2: 'CTRL' }),
      { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['LOAD', 'CTRL', '0'] },
      { ref: 'R1', kind: 'resistor', value: '100', nodes: ['3V3', 'LOAD'] },
    ]));
    expect(idsOf(result)).toContain('driver_missing_base_resistor');
  });

  it('warns for a MOSFET gate with no pull-down', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('esp32', 'U1', { '3V3': '3V3', GND: '0', GPIO2: 'GATE' }),
      { ref: 'M1', kind: 'mosfet_n', value: 'IRLZ44N', nodes: ['LOAD', 'GATE', '0'] },
      { ref: 'R1', kind: 'resistor', value: '100', nodes: ['3V3', 'LOAD'] },
    ]));
    const hit = result.violations.find((entry) => entry.id === 'mosfet_gate_no_pulldown');
    expect(hit).toBeDefined();
    expect(hit.severity).toBe('warning');
  });

  it('accepts a base fed through a series resistor', () => {
    const result = checkCircuitTopology(esp32BuzzerFixed);
    expect(idsOf(result)).not.toContain('driver_missing_base_resistor');
  });
});

describe('missing_flyback_diode', () => {
  it('flags a switched motor with no flyback diode', () => {
    const result = checkCircuitTopology(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'RM1', kind: 'dc_motor', value: '6V', nodes: ['VCC', 'SW'] },
      { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['SW', 'BASE', '0'] },
      { ref: 'RB1', kind: 'resistor', value: '1k', nodes: ['VCC', 'BASE'] },
    ]));
    expect(idsOf(result)).toContain('missing_flyback_diode');
  });

  it('accepts a motor with a diode across it', () => {
    const result = checkCircuitTopology(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'RM1', kind: 'dc_motor', value: '6V', nodes: ['VCC', 'SW'] },
      { ref: 'D1', kind: 'diode', value: '1N4007', nodes: ['SW', 'VCC'] },
      { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['SW', 'BASE', '0'] },
      { ref: 'RB1', kind: 'resistor', value: '1k', nodes: ['VCC', 'BASE'] },
    ]));
    expect(idsOf(result)).not.toContain('missing_flyback_diode');
  });
});

describe('gpio_current_budget', () => {
  it('warns when a GPIO branch draws more than 12 mA', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('esp32', 'U1', { '3V3': '3V3', GND: '0', GPIO2: 'OUT' }),
      { ref: 'R1', kind: 'resistor', value: '100', nodes: ['OUT', '0'] },
    ]));
    const hit = result.violations.find((entry) => entry.id === 'gpio_current_budget');
    expect(hit).toBeDefined();
    expect(hit.severity).toBe('warning');
  });

  it('escalates to an error at destructive current', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('esp32', 'U1', { '3V3': '3V3', GND: '0', GPIO2: 'OUT' }),
      { ref: 'R1', kind: 'resistor', value: '47', nodes: ['OUT', '0'] },
    ]));
    const hit = result.violations.find((entry) => entry.id === 'gpio_current_budget');
    expect(hit).toBeDefined();
    expect(hit.severity).toBe('error');
  });

  it('accepts a normal LED branch', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('esp32', 'U1', { '3V3': '3V3', GND: '0', GPIO2: 'LED' }),
      { ref: 'RLED', kind: 'resistor', value: '220', nodes: ['LED', 'LEDK'] },
      { ref: 'DLED1', kind: 'led', value: 'blue', nodes: ['LEDK', '0'] },
    ]));
    expect(idsOf(result)).not.toContain('gpio_current_budget');
  });
});

describe('fixed_pin_node_count', () => {
  it('flags an op amp with too few nodes', () => {
    const result = checkCircuitTopology(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '9V', nodes: ['VCC', '0'] },
      { ref: 'XU1', kind: 'opamp', value: 'LM358', nodes: ['VIN', 'VOUT', 'VOUT', 'VCC'] },
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VIN', '0'] },
    ]));
    const hit = result.violations.find((entry) => entry.id === 'fixed_pin_node_count');
    expect(hit).toBeDefined();
    expect(hit.fix).toContain('IN+');
  });

  it('accepts correct node counts', () => {
    const result = checkCircuitTopology(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '9V', nodes: ['VCC', '0'] },
      { ref: 'XU1', kind: 'opamp', value: 'LM358', nodes: ['VIN', 'VOUT', 'VOUT', 'VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VIN', '0'] },
    ]));
    expect(idsOf(result)).not.toContain('fixed_pin_node_count');
  });
});

describe('opamp_input_floating', () => {
  it('flags an op amp input on a node used by nothing else', () => {
    const result = checkCircuitTopology(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '9V', nodes: ['VCC', '0'] },
      { ref: 'XU1', kind: 'opamp', value: 'LM358', nodes: ['VINP', 'VOUT', 'VOUT', 'VCC', '0'] },
    ]));
    expect(idsOf(result)).toContain('opamp_input_floating');
  });

  it('accepts inputs joined to the rest of the circuit', () => {
    const result = checkCircuitTopology(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '9V', nodes: ['VCC', '0'] },
      { ref: 'XU1', kind: 'opamp', value: 'LM358', nodes: ['VIN', 'VOUT', 'VOUT', 'VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VIN', '0'] },
    ]));
    expect(idsOf(result)).not.toContain('opamp_input_floating');
  });
});

describe('electrolytic_cap_polarity', () => {
  it('warns for a reversed electrolytic capacitor', () => {
    // No resistive path between the rails: the orientation is unambiguous.
    const result = checkCircuitTopology(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'C1', kind: 'capacitor', value: '10uF', footprint: 'Capacitor_THT:CP_Radial_D5.0mm_P2.50mm', nodes: ['0', 'VCC'] },
    ]));
    const hit = result.violations.find((entry) => entry.id === 'electrolytic_cap_polarity');
    expect(hit).toBeDefined();
    expect(hit.severity).toBe('warning');
  });

  it('accepts a correctly oriented electrolytic', () => {
    const result = checkCircuitTopology(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCC', '0'] },
      { ref: 'C1', kind: 'capacitor', value: '10uF', footprint: 'Capacitor_THT:CP_Radial_D5.0mm_P2.50mm', nodes: ['VCC', '0'] },
    ]));
    expect(idsOf(result)).not.toContain('electrolytic_cap_polarity');
  });
});

describe('buck_converter (LM2596)', () => {
  const buckBase = () => ([
    { ref: 'V1', kind: 'voltage_source', value: '12V', nodes: ['VIN', '0'] },
  ]);

  it('flags a buck OUT net with no inductor', () => {
    const result = checkCircuitTopology(circuitOf([
      ...buckBase(),
      { ref: 'U1', kind: 'buck_converter', value: 'LM2596-5.0', nodes: ['VIN', 'SW', '0', 'VOUT', '0'] },
    ]));
    const hit = result.violations.find((entry) => entry.id === 'buck_missing_inductor');
    expect(hit).toBeDefined();
    expect(hit.severity).toBe('error');
    // No inductor yet, so the catch-diode rule must not pile on.
    expect(idsOf(result)).not.toContain('buck_missing_catch_diode');
  });

  it('accepts a buck OUT net with an inductor and catch diode', () => {
    const result = checkCircuitTopology(circuitOf([
      ...buckBase(),
      { ref: 'U1', kind: 'buck_converter', value: 'LM2596-5.0', nodes: ['VIN', 'SW', '0', 'VOUT', '0'] },
      { ref: 'L1', kind: 'inductor', value: '33uH', nodes: ['SW', 'VOUT'] },
      { ref: 'D1', kind: 'schottky', value: '1N5819', nodes: ['0', 'SW'] },
      { ref: 'C_OUT', kind: 'capacitor', value: '220uF', nodes: ['VOUT', '0'] },
    ]));
    expect(idsOf(result)).not.toContain('buck_missing_inductor');
  });

  it('flags an inductor with no catch diode', () => {
    const result = checkCircuitTopology(circuitOf([
      ...buckBase(),
      { ref: 'U1', kind: 'buck_converter', value: 'LM2596-5.0', nodes: ['VIN', 'SW', '0', 'VOUT', '0'] },
      { ref: 'L1', kind: 'inductor', value: '33uH', nodes: ['SW', 'VOUT'] },
    ]));
    const hit = result.violations.find((entry) => entry.id === 'buck_missing_catch_diode');
    expect(hit).toBeDefined();
    expect(hit.severity).toBe('error');
    // The inductor is present, so the missing-inductor rule must not pile on.
    expect(idsOf(result)).not.toContain('buck_missing_inductor');
  });

  it('accepts an inductor with a catch diode present', () => {
    const result = checkCircuitTopology(circuitOf([
      ...buckBase(),
      { ref: 'U1', kind: 'buck_converter', value: 'LM2596-5.0', nodes: ['VIN', 'SW', '0', 'VOUT', '0'] },
      { ref: 'L1', kind: 'inductor', value: '33uH', nodes: ['SW', 'VOUT'] },
      { ref: 'D1', kind: 'schottky', value: '1N5819', nodes: ['0', 'SW'] },
    ]));
    expect(idsOf(result)).not.toContain('buck_missing_catch_diode');
  });

  it('warns when FB is unconnected', () => {
    const result = checkCircuitTopology(circuitOf([
      ...buckBase(),
      { ref: 'U1', kind: 'buck_converter', value: 'LM2596-5.0', nodes: ['VIN', 'SW', '0', 'NC_U1_4', '0'] },
      { ref: 'L1', kind: 'inductor', value: '33uH', nodes: ['SW', 'VOUT'] },
      { ref: 'D1', kind: 'schottky', value: '1N5819', nodes: ['0', 'SW'] },
    ]));
    const hit = result.violations.find((entry) => entry.id === 'buck_fb_misrouted');
    expect(hit).toBeDefined();
    expect(hit.severity).toBe('warning');
  });

  it('warns when FB is tied to the raw switch node', () => {
    const result = checkCircuitTopology(circuitOf([
      ...buckBase(),
      { ref: 'U1', kind: 'buck_converter', value: 'LM2596-5.0', nodes: ['VIN', 'SW', '0', 'SW', '0'] },
      { ref: 'L1', kind: 'inductor', value: '33uH', nodes: ['SW', 'VOUT'] },
      { ref: 'D1', kind: 'schottky', value: '1N5819', nodes: ['0', 'SW'] },
    ]));
    expect(idsOf(result)).toContain('buck_fb_misrouted');
  });

  it('accepts FB wired to the filtered output rail', () => {
    const result = checkCircuitTopology(circuitOf([
      ...buckBase(),
      { ref: 'U1', kind: 'buck_converter', value: 'LM2596-5.0', nodes: ['VIN', 'SW', '0', 'VOUT', '0'] },
      { ref: 'L1', kind: 'inductor', value: '33uH', nodes: ['SW', 'VOUT'] },
      { ref: 'D1', kind: 'schottky', value: '1N5819', nodes: ['0', 'SW'] },
    ]));
    expect(idsOf(result)).not.toContain('buck_fb_misrouted');
  });

  it('warns when the input source has insufficient headroom', () => {
    const result = checkCircuitTopology(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '6V', nodes: ['VIN', '0'] },
      { ref: 'U1', kind: 'buck_converter', value: 'LM2596-5.0', nodes: ['VIN', 'SW', '0', 'VOUT', '0'] },
      { ref: 'L1', kind: 'inductor', value: '33uH', nodes: ['SW', 'VOUT'] },
      { ref: 'D1', kind: 'schottky', value: '1N5819', nodes: ['0', 'SW'] },
    ]));
    const hit = result.violations.find((entry) => entry.id === 'buck_insufficient_headroom');
    expect(hit).toBeDefined();
    expect(hit.severity).toBe('warning');
  });

  it('accepts sufficient input headroom', () => {
    const result = checkCircuitTopology(circuitOf([
      ...buckBase(),
      { ref: 'U1', kind: 'buck_converter', value: 'LM2596-5.0', nodes: ['VIN', 'SW', '0', 'VOUT', '0'] },
      { ref: 'L1', kind: 'inductor', value: '33uH', nodes: ['SW', 'VOUT'] },
      { ref: 'D1', kind: 'schottky', value: '1N5819', nodes: ['0', 'SW'] },
    ]));
    expect(idsOf(result)).not.toContain('buck_insufficient_headroom');
  });

  it('skips the headroom check when no source is found on VIN', () => {
    const result = checkCircuitTopology(circuitOf([
      { ref: 'U1', kind: 'buck_converter', value: 'LM2596-5.0', nodes: ['VIN', 'SW', '0', 'VOUT', '0'] },
      { ref: 'L1', kind: 'inductor', value: '33uH', nodes: ['SW', 'VOUT'] },
      { ref: 'D1', kind: 'schottky', value: '1N5819', nodes: ['0', 'SW'] },
    ]));
    expect(idsOf(result)).not.toContain('buck_insufficient_headroom');
  });

  it('produces zero violations for the full canonical buck circuit', () => {
    const result = checkCircuitTopology(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '12V', nodes: ['VIN', '0'] },
      { ref: 'U1', kind: 'buck_converter', value: 'LM2596-5.0', nodes: ['VIN', 'SW', '0', 'VOUT', '0'] },
      { ref: 'L1', kind: 'inductor', value: '33uH', nodes: ['SW', 'VOUT'] },
      { ref: 'D1', kind: 'schottky', value: '1N5819', nodes: ['0', 'SW'] },
      { ref: 'C_IN', kind: 'capacitor', value: '100uF', nodes: ['VIN', '0'] },
      { ref: 'C_OUT', kind: 'capacitor', value: '220uF', nodes: ['VOUT', '0'] },
      { ref: 'RLOAD', kind: 'load', value: '1k', nodes: ['VOUT', '0'] },
    ]));
    expect(result.violations).toEqual([]);
  });

  it('trips led_no_series_resistor for an LED wired straight onto the filtered output rail (proves supply-net propagation through the inductor)', () => {
    const result = checkCircuitTopology(circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '12V', nodes: ['VIN', '0'] },
      { ref: 'U1', kind: 'buck_converter', value: 'LM2596-5.0', nodes: ['VIN', 'SW', '0', 'VOUT', '0'] },
      { ref: 'L1', kind: 'inductor', value: '33uH', nodes: ['SW', 'VOUT'] },
      { ref: 'D1', kind: 'schottky', value: '1N5819', nodes: ['0', 'SW'] },
      { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['VOUT', '0'] },
    ]));
    expect(idsOf(result)).toContain('led_no_series_resistor');
  });
});

describe('composeTopologyCorrection', () => {
  it('renders numbered errors with fixes and a correction instruction', () => {
    const { violations } = checkCircuitTopology(esp32BuzzerBug);
    const text = composeTopologyCorrection(violations);
    expect(text).toContain('functional design errors');
    expect(text).toContain('[divider_powered_load]');
    expect(text).toContain('NPN transistor');
    expect(text).toContain('Return the corrected full circuit JSON');
  });

  it('returns an empty string when only warnings exist', () => {
    expect(composeTopologyCorrection([
      { id: 'x', severity: 'warning', refs: [], nets: [], message: 'm', fix: 'f' },
    ])).toBe('');
  });

  it('caps the correction at three errors', () => {
    const errors = Array.from({ length: 5 }, (_, index) => ({
      id: `rule_${index}`, severity: 'error', refs: [], nets: [], message: `m${index}`, fix: `f${index}`,
    }));
    const text = composeTopologyCorrection(errors);
    expect(text).toContain('m2');
    expect(text).not.toContain('m3');
  });
});

describe('applySafeAutoFixes', () => {
  it('adds a gate pull-down for a floating MOSFET gate and marks it autoFixed', () => {
    const circuit = circuitOf([
      mcuPart('esp32', 'U1', { '3V3': '3V3', GND: '0', GPIO2: 'GATE' }),
      { ref: 'M1', kind: 'mosfet_n', value: 'IRLZ44N', nodes: ['LOAD', 'GATE', '0'] },
      { ref: 'R1', kind: 'resistor', value: '100', nodes: ['3V3', 'LOAD'] },
    ]);
    const { violations } = checkCircuitTopology(circuit);
    const result = applySafeAutoFixes(circuit, violations);
    expect(result.applied).toBe(true);
    const pulldown = result.circuit.components.find((part) => part.ref === 'RPD1');
    expect(pulldown).toMatchObject({ kind: 'resistor', value: '100k', nodes: ['GATE', '0'] });
    expect(result.violations.find((entry) => entry.id === 'mosfet_gate_no_pulldown').autoFixed).toBe(true);
    // The fixed circuit passes its own rule.
    expect(idsOf(checkCircuitTopology(result.circuit))).not.toContain('mosfet_gate_no_pulldown');
  });

  it('adds a flyback diode with the cathode on the supply side', () => {
    const circuit = circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'RM1', kind: 'dc_motor', value: '6V', nodes: ['VCC', 'SW'] },
      { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['SW', 'BASE', '0'] },
      { ref: 'RB1', kind: 'resistor', value: '1k', nodes: ['VCC', 'BASE'] },
    ]);
    const { violations } = checkCircuitTopology(circuit);
    const result = applySafeAutoFixes(circuit, violations);
    expect(result.applied).toBe(true);
    const diode = result.circuit.components.find((part) => part.ref === 'DFB1');
    expect(diode).toMatchObject({ kind: 'diode', value: '1N4007', nodes: ['SW', 'VCC'] });
    expect(idsOf(checkCircuitTopology(result.circuit))).not.toContain('missing_flyback_diode');
  });

  it('leaves non-additive violations untouched', () => {
    const { violations } = checkCircuitTopology(esp32BuzzerBug);
    const result = applySafeAutoFixes(esp32BuzzerBug, violations);
    expect(result.applied).toBe(false);
    expect(result.circuit).toBe(esp32BuzzerBug);
    expect(result.violations).toBe(violations);
  });
});

describe('parseResistance', () => {
  it('parses common resistor notations', () => {
    expect(parseResistance('330')).toBe(330);
    expect(parseResistance('4.7k')).toBe(4700);
    expect(parseResistance('1Meg')).toBe(1e6);
    expect(parseResistance('10 ohms')).toBe(10);
    expect(parseResistance('5V active')).toBeNull();
  });
});

// Known-good corpus: none of the hand-authored reference circuits used across
// the breadboard tests may trip an error — the false-positive regression guard.
describe('known-good corpus produces zero errors', () => {
  const corpus = {
    divider: circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCC', 'VOUT'] },
      { ref: 'R2', kind: 'resistor', value: '1k', nodes: ['VOUT', '0'] },
    ]),
    opampBuffer: circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '9V', nodes: ['VCC', '0'] },
      { ref: 'XU1', kind: 'opamp', value: 'LM358', nodes: ['VIN', 'VOUT', 'VOUT', 'VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VIN', '0'] },
    ]),
    unoBlink: circuitOf([
      mcuPart('arduino_uno', 'U1', { '5V': 'VCC5', GND: '0', D13: 'LED' }),
      { ref: 'RLED', kind: 'resistor', value: '330', nodes: ['LED', 'LEDK'] },
      { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['LEDK', '0'] },
      { ref: 'R2', kind: 'resistor', value: '330', nodes: ['VCC5', 'LED2A'] },
      { ref: 'DLED2', kind: 'led', value: 'green', nodes: ['LED2A', '0'] },
    ]),
    esp32Led: circuitOf([
      mcuPart('esp32', 'U1', { '3V3': 'VCC3', GND: '0', GPIO2: 'LED' }),
      { ref: 'RLED', kind: 'resistor', value: '220', nodes: ['LED', 'LEDK'] },
      { ref: 'DLED1', kind: 'led', value: 'blue', nodes: ['LEDK', '0'] },
      { ref: 'R2', kind: 'resistor', value: '10k', nodes: ['VCC3', '0'] },
    ]),
    timer555: circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '9V', nodes: ['VCC', '0'] },
      { ref: 'XU1', kind: 'timer_555', value: 'NE555', nodes: ['0', 'TRIG', 'OUT', 'VCC', 'CTRL', 'TRIG', 'DIS', 'VCC'] },
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VCC', 'DIS'] },
      { ref: 'C1', kind: 'capacitor', value: '10uF', nodes: ['TRIG', '0'] },
      { ref: 'C2', kind: 'capacitor', value: '10nF', nodes: ['CTRL', '0'] },
    ]),
    comparator: circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '9V', nodes: ['VCC', '0'] },
      { ref: 'XU1', kind: 'comparator', value: 'LM393', nodes: ['VIN', 'VREF', 'VOUT', 'VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VIN', '0'] },
      { ref: 'R2', kind: 'resistor', value: '10k', nodes: ['VREF', '0'] },
      { ref: 'R3', kind: 'resistor', value: '10k', nodes: ['VOUT', 'VCC'] },
    ]),
    regulator: circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '12V', nodes: ['VIN', '0'] },
      { ref: 'VREG1', kind: 'regulator', value: '7805', nodes: ['VIN', '0', 'VOUT'] },
      { ref: 'CIN', kind: 'capacitor', value: '330nF', nodes: ['VIN', '0'] },
      { ref: 'COUT', kind: 'capacitor', value: '100nF', nodes: ['VOUT', '0'] },
      { ref: 'RLOAD', kind: 'load', value: '1k', nodes: ['VOUT', '0'] },
    ]),
    buttonPullup: circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VCC', 'BTN'] },
      { ref: 'RBTN', kind: 'pushbutton', value: '', nodes: ['BTN', '0'] },
    ]),
    transistorLedDriver: circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '330', nodes: ['VCC', 'LEDA'] },
      { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['LEDA', 'LEDK'] },
      { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['LEDK', 'BASE', '0'] },
      { ref: 'R2', kind: 'resistor', value: '10k', nodes: ['BASE', '0'] },
    ]),
    servoSweep: circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'U1', kind: 'servo', value: 'SG90', nodes: ['VCC', '0', 'SIG'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['SIG', '0'] },
    ]),
    tempSensor: circuitOf([
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'U1', kind: 'temp_sensor', value: 'TMP36', nodes: ['VCC', 'TOUT', '0'] },
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['TOUT', '0'] },
    ]),
    buzzerDriverFixed: esp32BuzzerFixed,
    stepperViaUln2003: circuitOf([
      mcuPart('arduino_uno', 'U1', { '5V': 'VCC5', GND: '0', D8: 'SIN1', D9: 'SIN2', D10: 'SIN3', D11: 'SIN4' }),
      mcuPart('stepper_driver', 'U2', { IN1: 'SIN1', IN2: 'SIN2', IN3: 'SIN3', IN4: 'SIN4', VCC: 'VCC5', GND: '0', OUTA: 'COILA', OUTB: 'COILB', OUTC: 'COILC', OUTD: 'COILD' }),
      mcuPart('stepper_motor', 'M1', { A: 'COILA', B: 'COILB', C: 'COILC', D: 'COILD', COM: 'VCC5' }),
    ]),
    motorViaL298n: circuitOf([
      mcuPart('esp32', 'U1', { '3V3': 'V33', GND: '0', GPIO4: 'MIN1', GPIO5: 'MIN2', GPIO13: 'MEN' }),
      { ref: 'V1', kind: 'voltage_source', value: '6V', nodes: ['VMOT', '0'] },
      mcuPart('motor_driver', 'U2', { VS: 'VMOT', GND: '0', ENA: 'MEN', IN1: 'MIN1', IN2: 'MIN2', OUT1: 'MA', OUT2: 'MB' }),
      { ref: 'RM1', kind: 'dc_motor', value: '6V', nodes: ['MA', 'MB'] },
    ]),
    lcdWithPullups: circuitOf([
      mcuPart('arduino_uno', 'U1', { '5V': 'VCC5', GND: '0', A4: 'SDA', A5: 'SCL' }),
      mcuPart('lcd_display', 'U2', { GND: '0', VCC: 'VCC5', SDA: 'SDA', SCL: 'SCL' }),
      { ref: 'R1', kind: 'resistor', value: '4.7k', nodes: ['SDA', 'VCC5'] },
      { ref: 'R2', kind: 'resistor', value: '4.7k', nodes: ['SCL', 'VCC5'] },
    ]),
    neopixelStrip: circuitOf([
      mcuPart('arduino_uno', 'U1', { '5V': 'VCC5', GND: '0', D6: 'DATA' }),
      mcuPart('led_strip', 'LS1', { VCC: 'VCC5', DIN: 'DATA', GND: '0' }),
    ]),
    encoderAndIr: circuitOf([
      mcuPart('esp32', 'U1', { '3V3': 'V33', GND: '0', GPIO4: 'CLK', GPIO5: 'DT', GPIO13: 'SW', GPIO18: 'IROUT' }),
      mcuPart('rotary_encoder', 'ENC1', { CLK: 'CLK', DT: 'DT', SW: 'SW', VCC: 'V33', GND: '0' }),
      mcuPart('ir_receiver', 'IR1', { OUT: 'IROUT', GND: '0', VCC: 'V33' }),
    ]),
  };

  for (const [name, circuit] of Object.entries(corpus)) {
    it(`${name} has no error-severity violations`, () => {
      const result = checkCircuitTopology(circuit);
      expect(errorsOf(result)).toEqual([]);
      expect(result.ok).toBe(true);
    });
  }
});
