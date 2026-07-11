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
  };

  for (const [name, circuit] of Object.entries(corpus)) {
    it(`${name} has no error-severity violations`, () => {
      const result = checkCircuitTopology(circuit);
      expect(errorsOf(result)).toEqual([]);
      expect(result.ok).toBe(true);
    });
  }
});
