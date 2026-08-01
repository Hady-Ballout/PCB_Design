import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pcbLayoutTool } from './layout.js';
import { circuitSchema } from '../schemas.js';
import { rcLowPass } from '../testFixtures.js';
import { fileSink } from '../artifactSink.js';

const parse = (circuit: unknown) => circuitSchema.parse(circuit);

let artifactDir: string;

beforeEach(() => {
  artifactDir = mkdtempSync(path.join(tmpdir(), 'pcb-mcp-layout-'));
});

afterEach(() => {
  rmSync(artifactDir, { recursive: true, force: true });
});

describe('pcbLayoutTool', () => {
  it('reports the board envelope in millimetres', () => {
    const result = pcbLayoutTool({ circuit: parse(rcLowPass) }, fileSink(artifactDir));

    expect(result.board.width).toBeGreaterThan(0);
    expect(result.board.height).toBeGreaterThan(0);
    expect(result.board.thickness).toBe(1.6);
  });

  it('summarizes each placed footprint without dumping its pads', () => {
    const result = pcbLayoutTool({ circuit: parse(rcLowPass) }, fileSink(artifactDir));

    expect(result.components).toHaveLength(3);
    const r1 = result.components.find((part) => part.ref === 'R1');
    expect(r1).toMatchObject({ kind: 'resistor' });
    expect(r1).not.toHaveProperty('pads');
  });

  it('counts routed copper and lists the nets it routed', () => {
    const result = pcbLayoutTool({ circuit: parse(rcLowPass) }, fileSink(artifactDir));

    expect(result.traceCount).toBeGreaterThan(0);
    expect(result.nets).toContain('VOUT');
  });

  it('writes the full geometry to a JSON artifact', () => {
    const result = pcbLayoutTool({ circuit: parse(rcLowPass) }, fileSink(artifactDir));

    expect(path.basename(result.artifact.location)).toBe('rc-low-pass-layout.json');
    const geometry = JSON.parse(readFileSync(result.artifact.location, 'utf8'));
    expect(geometry.components[0].pads.length).toBeGreaterThan(0);
    expect(geometry.traces.length).toBe(result.traceCount);
  });

  it('explains itself when a circuit has nothing to place', () => {
    const empty = { ...parse(rcLowPass), components: [] };

    expect(() => pcbLayoutTool({ circuit: empty }, fileSink(artifactDir))).toThrow(/no components/i);
  });
});
