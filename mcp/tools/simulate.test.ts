import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simulateCircuitTool, summarizeSeries } from './simulate.js';
import { circuitSchema } from '../schemas.js';
import { rcLowPass } from '../testFixtures.js';
import { fileSink } from '../artifactSink.js';

const parse = (circuit: unknown) => circuitSchema.parse(circuit);

let artifactDir: string;

beforeEach(() => {
  artifactDir = mkdtempSync(path.join(tmpdir(), 'pcb-mcp-sim-'));
});

afterEach(() => {
  rmSync(artifactDir, { recursive: true, force: true });
  delete process.env.NGSPICE_BINARY;
});

describe('summarizeSeries', () => {
  const ramp = {
    name: 'VOUT',
    points: Array.from({ length: 1000 }, (_, index) => ({ x: index / 1000, y: index / 100 })),
  };

  it('reduces a long waveform to at most maxPoints samples', () => {
    const summary = summarizeSeries(ramp, 40);

    expect(summary.samples).toBe(1000);
    expect(summary.points.length).toBeLessThanOrEqual(40);
  });

  it('keeps the first and last sample so the endpoints stay honest', () => {
    const summary = summarizeSeries(ramp, 40);

    expect(summary.points[0]).toEqual({ x: 0, y: 0 });
    expect(summary.points.at(-1)).toEqual({ x: 0.999, y: 9.99 });
  });

  it('reports min, max, mean and the settled final value', () => {
    const summary = summarizeSeries(ramp, 40);

    expect(summary.min).toBeCloseTo(0);
    expect(summary.max).toBeCloseTo(9.99);
    expect(summary.final).toBeCloseTo(9.99);
    expect(summary.mean).toBeCloseTo(4.995, 2);
  });

  it('does not downsample a waveform already under the limit', () => {
    const short = { name: 'A', points: [{ x: 0, y: 1 }, { x: 1, y: 2 }] };

    expect(summarizeSeries(short, 40).points).toHaveLength(2);
  });
});

describe('simulateCircuitTool', () => {
  it('runs the RC low-pass through ngspice and summarizes each node', async () => {
    const result = await simulateCircuitTool({ circuit: parse(rcLowPass) }, fileSink(artifactDir));

    expect(result.ok).toBe(true);
    const vout = result.series.find((entry) => entry.name.toUpperCase() === 'VOUT');
    expect(vout).toBeDefined();
    // A 1k/100nF low-pass on a 5V DC rail settles at the rail.
    expect(vout?.final).toBeGreaterThan(4.9);
  });

  it('writes the full sample set to a CSV artifact instead of inlining it', async () => {
    const result = await simulateCircuitTool({ circuit: parse(rcLowPass), maxPoints: 20 }, fileSink(artifactDir));

    expect(result.waveformCsv.location.endsWith('.csv')).toBe(true);
    const csv = readFileSync(result.waveformCsv.location, 'utf8');
    expect(csv.split('\n').length).toBeGreaterThan(20);
    for (const series of result.series) {
      expect(series.points.length).toBeLessThanOrEqual(20);
    }
  });

  it('puts the time column first in the CSV header', async () => {
    const result = await simulateCircuitTool({ circuit: parse(rcLowPass) }, fileSink(artifactDir));

    expect(readFileSync(result.waveformCsv.location, 'utf8').split('\n')[0]).toMatch(/^time,/);
  });

  it('reports a missing ngspice binary as an actionable error, not a crash', async () => {
    process.env.NGSPICE_BINARY = 'ngspice-that-does-not-exist';

    const result = await simulateCircuitTool({ circuit: parse(rcLowPass) }, fileSink(artifactDir));

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/not found|PATH/i);
  });
});
