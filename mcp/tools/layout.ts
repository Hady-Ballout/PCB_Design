// pcb_layout — single-board placement and L-shaped two-layer routing.
//
// The full geometry (every pad coordinate, every trace segment) goes to a JSON
// artifact; what returns inline is the board envelope, where each footprint
// landed, and how much copper it took.

import { buildPcbLayout } from '../../src/core/pcbLayout.js';
import { slugify, writeArtifact } from '../artifacts.js';
import type { ParsedCircuit } from '../schemas.js';

export interface LayoutArgs {
  circuit: ParsedCircuit;
}

interface RawLayout {
  board: { width: number; height: number; thickness: number };
  components: Array<{
    ref: string; kind: string; value: string; body: string;
    x: number; y: number; width: number; height: number;
    pads: Array<Record<string, unknown>>;
  }>;
  traces: unknown[];
  vias: unknown[];
  nets: string[];
}

export const pcbLayoutTool = ({ circuit }: LayoutArgs, artifactDir: string) => {
  const layout = buildPcbLayout(circuit) as RawLayout | null;
  if (!layout) {
    throw new Error('Cannot lay out a circuit with no components.');
  }

  const file = writeArtifact(
    artifactDir,
    `${slugify(circuit.title)}-layout.json`,
    JSON.stringify(layout, null, 2),
  );

  return {
    path: file,
    board: layout.board,
    layers: 2,
    components: layout.components.map(({ ref, kind, value, body, x, y, width, height }) => ({
      ref, kind, value, body, x, y, width, height,
    })),
    traceCount: layout.traces.length,
    viaCount: layout.vias.length,
    nets: layout.nets,
  };
};
