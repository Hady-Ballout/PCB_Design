// validate_circuit — the check step between "Claude wrote a circuit" and
// "export/simulate it".
//
// Two independent layers run here, and both matter:
//   validateCircuit       structural — missing values, node counts, ground refs
//   checkCircuitTopology   functional — the rule engine that catches designs
//                          which are wired correctly but wrong (a GPIO driving
//                          a buzzer with no transistor, an LED with no series
//                          resistor, a floating MOSFET gate)

import { validateCircuit } from '../../src/core/pcbGenerator.js';
import { applySafeAutoFixes, checkCircuitTopology } from '../../src/core/topologyRules.js';
import type { TopologyViolation } from '../../src/core/topologyRules.js';
import type { ParsedCircuit } from '../schemas.js';

export interface ValidateArgs {
  circuit: ParsedCircuit;
  applyFixes?: boolean;
}

export interface ValidateResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  violations: TopologyViolation[];
  summary: { errors: number; warnings: number };
  fixesApplied: boolean;
  /** Only present when applyFixes actually changed something. */
  circuit?: ParsedCircuit;
}

export const validateCircuitTool = ({ circuit, applyFixes = false }: ValidateArgs): ValidateResult => {
  const structural = validateCircuit(circuit);
  const topology = checkCircuitTopology(circuit);

  let violations = topology.violations;
  let fixed: ParsedCircuit | undefined;
  let fixesApplied = false;

  if (applyFixes && violations.length) {
    const result = applySafeAutoFixes(circuit, violations);
    if (result.applied) {
      violations = result.violations;
      fixed = result.circuit as ParsedCircuit;
      fixesApplied = true;
    }
  }

  // An auto-fixed violation is resolved, so it no longer counts against the verdict.
  const outstanding = violations.filter((entry) => !entry.autoFixed);
  const errors = outstanding.filter((entry) => entry.severity === 'error').length;
  const warnings = outstanding.filter((entry) => entry.severity === 'warning').length;

  return {
    ok: structural.ok && errors === 0,
    errors: structural.errors ?? [],
    warnings: structural.warnings ?? [],
    violations,
    summary: { errors, warnings },
    fixesApplied,
    ...(fixed ? { circuit: fixed } : {}),
  };
};
