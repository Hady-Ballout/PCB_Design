// One verdict for the top-bar status pill, derived from what the generation
// pass and the board layout already report. Pure so the pill can never
// disagree with the issues list or the Gerber gate.
//
//   null                          → nothing to judge yet (no circuit)
//   { tone: 'error', label }      → rule errors, or a layout that will not fab
//   { tone: 'warn',  label }      → warnings only
//   { tone: 'ok',    label }      → every check clean
export function designStatus({ hasCircuit, issues = [], pcbLayout = null }) {
  if (!hasCircuit) return null;

  const layoutBroken = Boolean(
    pcbLayout && !(pcbLayout.routing?.complete && pcbLayout.drc?.ok && pcbLayout.connectivity?.ok),
  );
  if (layoutBroken) return { tone: 'error', label: 'Layout incomplete' };

  const errors = issues.filter((issue) => issue.severity === 'error').length;
  if (errors > 0) return { tone: 'error', label: `${errors} ${errors === 1 ? 'error' : 'errors'}` };

  const warnings = issues.filter((issue) => issue.severity === 'warning').length;
  if (warnings > 0) return { tone: 'warn', label: `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}` };

  return { tone: 'ok', label: 'Checks pass' };
}
