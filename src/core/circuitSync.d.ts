export function parseSpiceNetlist(source: string, baseCircuit: unknown): {
  ok: boolean;
  errors: string[];
  circuit: Record<string, unknown>;
};

export function parseCircuitJson(source: string, baseCircuit?: unknown): unknown;
export function circuitElectricalSignature(circuit: unknown): unknown;
export function circuitFromDiagram(diagram: unknown, baseCircuit: unknown): unknown;
export function parseKiCadNetlist(source: string, baseCircuit: unknown): unknown;
export function preserveDiagramLayout(diagram: unknown, previousDiagram: unknown, circuit?: unknown): unknown;
export function synchronizeResult(previousResult: unknown, circuit: unknown, previousDiagram: unknown, options?: Record<string, unknown>): unknown;
