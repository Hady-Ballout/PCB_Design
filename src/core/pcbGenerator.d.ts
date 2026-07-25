export class DiagramLayoutError extends Error {
  code: string;
  violations: Array<{ type: string; [key: string]: unknown }>;
  constructor(message: string, violations?: Array<{ type: string; [key: string]: unknown }>);
}

export function validateCircuit(circuit: unknown): { ok: boolean; errors?: string[]; warnings?: string[] };
export function buildCircuitDiagram(circuit: unknown): Record<string, unknown>;
export function buildFallbackCircuitDiagram(circuit: unknown): Record<string, unknown>;
export function simulateCircuit(circuit: unknown): unknown;
export function toDiagramSvg(diagram: unknown): string;
export function toSpice(circuit: unknown): string;
export function toKiCadNetlist(circuit: unknown): string;
export function addMissingSpiceModels(spice: string, circuit: unknown): string;
export const LM358_SUBCIRCUIT: string;
