// pcb_layout — single-board placement and clearance-aware two-layer routing.
//
// The full geometry (every pad coordinate, every trace segment) goes to a JSON
// artifact; what returns inline is the board envelope, where each footprint
// landed, how much copper it took, and — so a caller can never mistake a
// half-routed board for a finished one — the router's and the design rule
// checker's own verdict on it.

import { buildPcbLayout } from '../../src/core/pcbLayout.js';
import { slugify } from '../artifacts.js';
import type { ArtifactSink } from '../artifactSink.js';
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
  pour: unknown;
  nets: string[];
  routing: { complete: boolean; failedNets: Array<{ net: string; reason: string }> };
  drc: { ok: boolean; violations: Array<{ type: string; netA: string; netB: string | null }> };
  connectivity: { ok: boolean; incompleteNets: Array<{ net: string; islands: number }> };
}

export const pcbLayoutTool = ({ circuit }: LayoutArgs, sink: ArtifactSink) => {
  const layout = buildPcbLayout(circuit) as RawLayout | null;
  if (!layout) {
    throw new Error('Cannot lay out a circuit with no components.');
  }

  const artifact = sink.put(
    `${slugify(circuit.title)}-layout.json`,
    JSON.stringify(layout, null, 2),
  );

  return {
    artifact,
    board: layout.board,
    layers: 2,
    components: layout.components.map(({ ref, kind, value, body, x, y, width, height }) => ({
      ref, kind, value, body, x, y, width, height,
    })),
    traceCount: layout.traces.length,
    viaCount: layout.vias.length,
    nets: layout.nets,
    manufacturable: layout.routing.complete && layout.drc.ok && layout.connectivity.ok,
    routing: {
      complete: layout.routing.complete,
      failedNets: layout.routing.failedNets.map(({ net, reason }) => ({ net, reason })),
    },
    drc: {
      ok: layout.drc.ok,
      violations: layout.drc.violations.map(({ type, netA, netB }) => ({ type, netA, netB })),
    },
    connectivity: layout.connectivity,
  };
};
