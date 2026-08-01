import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportNetlist } from './export.js';
import { circuitSchema } from '../schemas.js';
import { circuitOf, rcLowPass } from '../testFixtures.js';
import { fileSink } from '../artifactSink.js';

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
    const result = exportNetlist({ circuit: parse(rcLowPass), format: 'spice' }, fileSink(artifactDir));

    expect(result.content).toMatch(/^R1 /m);
    expect(result.content).toMatch(/^C1 /m);
    expect(result.content).toContain('.end');
  });

  it('injects the LM358 subcircuit when the deck references it', () => {
    const result = exportNetlist({ circuit: opampCircuit, format: 'spice' }, fileSink(artifactDir));

    expect(result.content).toContain('.subckt LM358');
  });

  it('emits a KiCad netlist listing the components', () => {
    const result = exportNetlist({ circuit: parse(rcLowPass), format: 'kicad_netlist' }, fileSink(artifactDir));

    expect(result.content).toContain('<export');
    expect(result.content).toContain('<comp ref="R1"');
  });

  it('emits a KiCad schematic with placed symbols', () => {
    const result = exportNetlist({ circuit: parse(rcLowPass), format: 'kicad_schematic' }, fileSink(artifactDir));

    expect(result.content).toContain('kicad_sch');
  });

  it('emits a KiCad PCB board file', () => {
    const result = exportNetlist({ circuit: parse(rcLowPass), format: 'kicad_pcb' }, fileSink(artifactDir));

    expect(result.content.startsWith('(kicad_pcb ')).toBe(true);
    expect(result.artifact.location.endsWith('.kicad_pcb')).toBe(true);
  });

  it('refuses to lay out a kicad_pcb board with no components', () => {
    const empty = { ...parse(rcLowPass), components: [] };

    expect(() => exportNetlist({ circuit: empty, format: 'kicad_pcb' }, fileSink(artifactDir)))
      .toThrow('Cannot lay out a circuit with no components.');
  });

  it('writes each format to an artifact file with the right extension', () => {
    const spice = exportNetlist({ circuit: parse(rcLowPass), format: 'spice' }, fileSink(artifactDir));
    const sch = exportNetlist({ circuit: parse(rcLowPass), format: 'kicad_schematic' }, fileSink(artifactDir));

    expect(spice.artifact.location.endsWith('.cir')).toBe(true);
    expect(sch.artifact.location.endsWith('.kicad_sch')).toBe(true);
    expect(readFileSync(spice.artifact.location, 'utf8')).toBe(spice.content);
  });

  it('names the artifact after the circuit title', () => {
    const result = exportNetlist({ circuit: parse(rcLowPass), format: 'spice' }, fileSink(artifactDir));

    expect(path.basename(result.artifact.location)).toBe('rc-low-pass.cir');
  });

  it('rejects a format it does not know', () => {
    expect(() => exportNetlist(
      { circuit: parse(rcLowPass), format: 'gerber' as never },
      fileSink(artifactDir),
    )).toThrow(/gerber/);
  });
});
