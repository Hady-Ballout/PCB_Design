// Shared diagram construction for the tools that need placed geometry
// (KiCad schematic export and SVG rendering).

import { buildCircuitDiagram } from '../../src/core/pcbGenerator.js';
import { buildFallbackCircuitDiagram } from '../../src/core/schematicLayout.js';
import type { ParsedCircuit } from '../schemas.js';

export interface Diagram {
  width: number;
  height: number;
  components: Array<{ ref: string; [key: string]: unknown }>;
  nets: Array<{ name: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

/**
 * The constraint-based layout throws DiagramLayoutError on designs it cannot
 * route cleanly. The fallback grid layout always places everything, which is
 * what both callers need — a slightly ugly diagram beats no diagram.
 */
export const diagramFor = (circuit: ParsedCircuit): Diagram => {
  try {
    return buildCircuitDiagram(circuit) as unknown as Diagram;
  } catch {
    return buildFallbackCircuitDiagram(circuit) as unknown as Diagram;
  }
};
