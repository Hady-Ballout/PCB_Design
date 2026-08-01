// Shared circuit fixtures for the MCP tool tests. Mirrors the helpers in
// src/core/topologyRules.test.js so the two suites talk about the same designs.

import { FIXED_PIN_NAMES } from '../src/core/componentKinds.js';

type Part = { ref: string; kind: string; value: string; nodes: string[] };

export const mcuPart = (kind: string, ref: string, pinMap: Record<string, string>): Part => ({
  ref,
  kind,
  value: kind,
  nodes: (FIXED_PIN_NAMES as Record<string, string[]>)[kind]
    .map((name, index) => pinMap[name] || `NC_${ref}_${index + 1}`),
});

export const circuitOf = (components: Part[], extra: Record<string, unknown> = {}) => ({
  title: 'fixture',
  type: 'test',
  supplyVoltage: 5,
  components,
  notes: [] as string[],
  ...extra,
});

/** A clean RC low-pass: no topology violations, simulates cleanly. */
export const rcLowPass = circuitOf([
  { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VIN', '0'] },
  { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VIN', 'VOUT'] },
  { ref: 'C1', kind: 'capacitor', value: '100nF', nodes: ['VOUT', '0'] },
], { title: 'RC low-pass' });

/** LED straight across the supply — trips led_no_series_resistor (error). */
export const ledNoResistor = circuitOf([
  { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
  { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['VCC', '0'] },
], { title: 'LED with no series resistor' });

/** Floating MOSFET gate — the additive auto-fix adds a 100k pull-down. */
export const floatingMosfetGate = circuitOf([
  mcuPart('esp32', 'U1', { '3V3': '3V3', GND: '0', GPIO2: 'GATE' }),
  { ref: 'M1', kind: 'mosfet_n', value: 'IRLZ44N', nodes: ['LOAD', 'GATE', '0'] },
  { ref: 'R1', kind: 'resistor', value: '100', nodes: ['3V3', 'LOAD'] },
], { title: 'MOSFET low-side switch' });
