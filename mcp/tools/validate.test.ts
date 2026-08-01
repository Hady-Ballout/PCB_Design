import { describe, expect, it } from 'vitest';
import { validateCircuitTool } from './validate.js';
import { circuitSchema } from '../schemas.js';
import { floatingMosfetGate, ledNoResistor, rcLowPass } from '../testFixtures.js';

const parse = (circuit: unknown) => circuitSchema.parse(circuit);

describe('validateCircuitTool', () => {
  it('passes a clean RC low-pass', () => {
    const result = validateCircuitTool({ circuit: parse(rcLowPass) });

    expect(result.ok).toBe(true);
    expect(result.summary.errors).toBe(0);
  });

  it('reports the functional violation for an LED with no series resistor', () => {
    const result = validateCircuitTool({ circuit: parse(ledNoResistor) });

    expect(result.ok).toBe(false);
    const violation = result.violations.find((entry) => entry.id === 'led_no_series_resistor');
    expect(violation?.severity).toBe('error');
    expect(violation?.refs).toContain('DLED1');
    expect(violation?.fix).toBeTruthy();
  });

  it('counts errors and warnings separately in the summary', () => {
    const result = validateCircuitTool({ circuit: parse(ledNoResistor) });

    expect(result.summary.errors).toBeGreaterThan(0);
    expect(result.summary.errors + result.summary.warnings).toBe(result.violations.length);
  });

  it('leaves the circuit untouched when applyFixes is not requested', () => {
    const result = validateCircuitTool({ circuit: parse(floatingMosfetGate) });

    expect(result.fixesApplied).toBe(false);
    expect(result.circuit).toBeUndefined();
  });

  it('returns the patched circuit when applyFixes adds a gate pull-down', () => {
    const result = validateCircuitTool({ circuit: parse(floatingMosfetGate), applyFixes: true });

    expect(result.fixesApplied).toBe(true);
    const pulldown = result.circuit?.components.find((part) => part.ref === 'RPD1');
    expect(pulldown).toMatchObject({ kind: 'resistor', value: '100k', nodes: ['GATE', '0'] });
    expect(result.violations.find((entry) => entry.id === 'mosfet_gate_no_pulldown')?.autoFixed).toBe(true);
  });

  it('surfaces schema-level problems such as a missing value', () => {
    const circuit = parse({
      title: 'broken',
      components: [{ ref: 'R1', kind: 'resistor', value: 'x', nodes: ['A', '0'] }],
    });
    // Blank the value after parsing — the zod layer rejects it, but a circuit
    // reaching this tool from elsewhere still has to be reported, not thrown.
    circuit.components[0].value = '';

    const result = validateCircuitTool({ circuit });

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/R1/);
  });
});
