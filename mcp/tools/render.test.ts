import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderSchematic } from './render.js';
import { circuitSchema } from '../schemas.js';
import { rcLowPass } from '../testFixtures.js';

const parse = (circuit: unknown) => circuitSchema.parse(circuit);

let artifactDir: string;

beforeEach(() => {
  artifactDir = mkdtempSync(path.join(tmpdir(), 'pcb-mcp-render-'));
});

afterEach(() => {
  rmSync(artifactDir, { recursive: true, force: true });
});

describe('renderSchematic', () => {
  it('writes an SVG artifact named after the circuit', () => {
    const result = renderSchematic({ circuit: parse(rcLowPass) }, artifactDir);

    expect(path.basename(result.path)).toBe('rc-low-pass.svg');
    expect(readFileSync(result.path, 'utf8')).toContain('<svg');
  });

  it('returns the drawing size and what was placed, not the markup', () => {
    const result = renderSchematic({ circuit: parse(rcLowPass) }, artifactDir);

    expect(result.components).toBe(3);
    expect(result.nets).toBeGreaterThan(0);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(result).not.toHaveProperty('content');
  });

  it('labels every component it placed so the caller can cross-check refs', () => {
    const result = renderSchematic({ circuit: parse(rcLowPass) }, artifactDir);

    expect(result.placed.sort()).toEqual(['C1', 'R1', 'V1']);
  });
});
