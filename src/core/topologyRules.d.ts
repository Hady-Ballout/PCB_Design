export interface TopologyViolation {
  id: string;
  severity: 'error' | 'warning';
  refs: string[];
  nets: string[];
  message: string;
  fix: string;
  autoFixed: boolean;
}

export interface NetPin {
  ref: string;
  kind: string;
  pinIndex: number;
  pinName: string;
}

export interface ReachResult {
  nets: Set<string>;
  parts: Set<string>;
  hitsGround: boolean;
  hitsSupply: boolean;
  hitsGpio: boolean;
  gpioNetsHit: string[];
}

export interface CircuitGraph {
  byRef: Map<string, { ref: string; kind: string; value: string; nodes: string[] }>;
  netPins: Map<string, NetPin[]>;
  gpioNets: Map<string, Array<{ ref: string; kind: string; pinName: string }>>;
  supplyNets: Set<string>;
  groundNet: string;
  reach(startNet: string, opts?: {
    crossResistors?: boolean;
    crossDiodes?: boolean;
    crossDrivers?: boolean;
    skipRefs?: string[];
  }): ReachResult;
}

export interface TopologyRule {
  id: string;
  severity: 'error' | 'warning';
  supersedes?: string;
  check(graph: CircuitGraph, circuit: unknown): TopologyViolation[];
}

export function parseResistance(value: unknown): number | null;
export function applySafeAutoFixes(circuit: unknown, violations: TopologyViolation[]): {
  circuit: unknown;
  violations: TopologyViolation[];
  applied: boolean;
};
export function buildCircuitGraph(circuit: unknown): CircuitGraph;
export function checkCircuitTopology(circuit: unknown): { ok: boolean; violations: TopologyViolation[] };
export function composeTopologyCorrection(violations: TopologyViolation[]): string;
export const TOPOLOGY_RULES: TopologyRule[];
