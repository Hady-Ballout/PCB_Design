import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportNetlist } from './export.js';
import { circuitSchema } from '../schemas.js';
import { circuitOf, rcLowPass } from '../testFixtures.js';

const parse = (circuit: unknown) => circuitSchema.parse(circuit);

const opampCircuit = parse(circuitOf([
  { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
  { ref: 'V2', kind: 'signal_source', value: '1V', nodes: ['VIN', '0'] },
  { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VIN', 'OPN'] },
  { ref: 'R2', kind: 'resistor', value: '100k', nodes: ['OPN', 'VOUT'] },
  { ref: 'XU1', kind: 'opamp', value: 'LM358', nodes: ['0', 'OPN', 'VOUT', 'VCC', '0'] },
], { title: 'Inverting amp' }));

let artifactDir: string;

beforeEach(() => {
  artifactDir = mkdtempSync(path.join(tmpdir(), 'pcb-mcp-export-'));
});

afterEach(() => {
  rmSync(artifactDir, { recursive: true, force: true });
});

describe('exportNetlist', () => {
  it('emits a SPICE deck containing every component and a terminator', () => {
    const result = exportNetlist({ circuit: parse(rcLowPass), format: 'spice' }, artifactDir);

    expect(result.content).toMatch(/^R1 /m);
    expect(result.content).toMatch(/^C1 /m);
    expect(result.content).toContain('.end');
  });

  it('injects the LM358 subcircuit when the deck references it', () => {
    const result = exportNetlist({ circuit: opampCircuit, format: 'spice' }, artifactDir);

    expect(result.content).toContain('.subckt LM358');
  });

  it('emits a KiCad netlist listing the components', () => {
    const result = exportNetlist({ circuit: parse(rcLowPass), format: 'kicad_netlist' }, artifactDir);

    expect(result.content).toContain('<export');
    expect(result.content).toContain('<comp ref="R1"');
  });

  it('emits a KiCad schematic with placed symbols', () => {
    const result = exportNetlist({ circuit: parse(rcLowPass), format: 'kicad_schematic' }, artifactDir);

    expect(result.content).toContain('kicad_sch');
  });

  it('writes each format to an artifact file with the right extension', () => {
    const spice = exportNetlist({ circuit: parse(rcLowPass), format: 'spice' }, artifactDir);
    const sch = exportNetlist({ circuit: parse(rcLowPass), format: 'kicad_schematic' }, artifactDir);

    expect(spice.path.endsWith('.cir')).toBe(true);
    expect(sch.path.endsWith('.kicad_sch')).toBe(true);
    expect(readFileSync(spice.path, 'utf8')).toBe(spice.content);
  });

  it('names the artifact after the circuit title', () => {
    const result = exportNetlist({ circuit: parse(rcLowPass), format: 'spice' }, artifactDir);

    expect(path.basename(result.path)).toBe('rc-low-pass.cir');
  });

  it('rejects a format it does not know', () => {
    expect(() => exportNetlist(
      { circuit: parse(rcLowPass), format: 'gerber' as never },
      artifactDir,
    )).toThrow(/gerber/);
  });
});
