// simulate_circuit — runs the deck through Ngspice and reports what happened.
//
// A transient run produces thousands of samples per node. Inlining those would
// bury the answer in numbers, so this tool returns per-node statistics plus a
// downsampled trace, and writes the full sample set to a CSV artifact.

import { addMissingSpiceModels, toSpice } from '../../src/core/pcbGenerator.js';
import { runNgspiceSimulation } from '../../server/simulation/simulator.js';
import type { Circuit, WaveformSeries } from '../../server/types.js';
import { slugify } from '../artifacts.js';
import type { ArtifactSink } from '../artifactSink.js';
import type { ParsedCircuit } from '../schemas.js';

export interface SimulateArgs {
  circuit: ParsedCircuit;
  /** Overrides the deck generated from the circuit — use to hand-tune .tran or add models. */
  spice?: string;
  maxPoints?: number;
}

export interface SeriesSummary {
  name: string;
  samples: number;
  min: number;
  max: number;
  mean: number;
  final: number;
  points: Array<{ x: number; y: number }>;
}

const DEFAULT_MAX_POINTS = 40;

/** Evenly spaced downsample that always keeps the first and last sample. */
const downsample = <T>(points: T[], maxPoints: number): T[] => {
  if (points.length <= maxPoints || maxPoints < 2) return points;
  const step = (points.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, index) => points[Math.round(index * step)]);
};

export const summarizeSeries = (series: WaveformSeries, maxPoints = DEFAULT_MAX_POINTS): SeriesSummary => {
  const values = series.points.map((point) => point.y);
  const total = values.reduce((sum, value) => sum + value, 0);

  return {
    name: series.name,
    samples: series.points.length,
    min: values.length ? Math.min(...values) : 0,
    max: values.length ? Math.max(...values) : 0,
    mean: values.length ? total / values.length : 0,
    final: values.length ? values[values.length - 1] : 0,
    points: downsample(series.points, maxPoints),
  };
};

/** Wide CSV: one time column, then one column per plotted node. */
const toCsv = (series: WaveformSeries[]): string => {
  if (!series.length) return 'time\n';
  const rows = series[0].points.map((point, index) => [
    point.x,
    ...series.map((entry) => entry.points[index]?.y ?? ''),
  ].join(','));

  return [['time', ...series.map((entry) => entry.name)].join(','), ...rows].join('\n');
};

export const simulateCircuitTool = async (
  { circuit, spice, maxPoints = DEFAULT_MAX_POINTS }: SimulateArgs,
  sink: ArtifactSink,
) => {
  const deck = spice?.trim() || addMissingSpiceModels(toSpice(circuit), circuit);
  const result = await runNgspiceSimulation({ circuit: circuit as unknown as Circuit, spice: deck });

  const series = result.waveform.series.map((entry) => summarizeSeries(entry, maxPoints));
  const waveformCsv = sink.put(
    `${slugify(circuit.title)}-waveform.csv`,
    toCsv(result.waveform.series),
  );

  return {
    ok: result.ok,
    errors: result.errors,
    warnings: result.warnings,
    xLabel: result.waveform.xLabel,
    yLabel: result.waveform.yLabel,
    series,
    waveformCsv,
    // The ngspice log is only useful when something went wrong.
    ...(result.ok ? {} : { rawOutput: result.rawOutput.slice(-4000) }),
  };
};
