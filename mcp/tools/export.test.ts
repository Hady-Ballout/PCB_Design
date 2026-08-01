import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Set by the refusal test to hand `exportNetlist` a layout with a failing
 * verdict; null everywhere else, so every other test runs the real placer and
 * router. Read lazily inside the stub, never during factory hoisting.
 */
let layoutOverride: unknown = null;

vi.mock('../../src/core/pcbLayout.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const real = actual.buildPcbLayout as (...args: unknown[]) => unknown;
  return { ...actual, buildPcbLayout: (...args: unknown[]) => layoutOverride ?? real(...args) };
});

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
  layoutOverride = null;
});

afterEach(() => {
  rmSync(artifactDir, { recursive: true, force: true });
  layoutOverride = null;
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
      { circuit: parse(rcLowPass), format: 'pdf' as never },
      fileSink(artifactDir),
    )).toThrow(/pdf/);
  });

  it('exports a zipped Gerber package for a routable board', () => {
    const result = exportNetlist({ circuit: parse(rcLowPass), format: 'gerber' }, fileSink(artifactDir));

    expect(result.artifact.location.endsWith('-gerbers.zip')).toBe(true);
    expect([...readFileSync(result.artifact.location).subarray(0, 4)])
      .toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('lists every fabrication file it produced', () => {
    const result = exportNetlist({ circuit: parse(rcLowPass), format: 'gerber' }, fileSink(artifactDir));

    expect(result.files).toEqual([
      'rc-low-pass.GTL', 'rc-low-pass.GBL',
      'rc-low-pass.GTS', 'rc-low-pass.GBS',
      'rc-low-pass.GTO', 'rc-low-pass.GBO',
      'rc-low-pass.GKO', 'rc-low-pass.DRL',
      'PCB-README.txt',
    ]);
    expect(result.summary.componentCount).toBe(3);
  });

  it('returns no inline content for a Gerber export — it is binary', () => {
    const result = exportNetlist({ circuit: parse(rcLowPass), format: 'gerber' }, fileSink(artifactDir));

    expect(result).not.toHaveProperty('content');
    expect(result).not.toHaveProperty('lines');
  });

  it('refuses to export Gerbers for a circuit with no components', () => {
    const empty = { ...parse(rcLowPass), components: [] };

    expect(() => exportNetlist({ circuit: empty, format: 'gerber' }, fileSink(artifactDir)))
      .toThrow('Cannot lay out a circuit with no components.');
  });

  it('surfaces the refusal report when the board is not fabricable', () => {
    // The verdict, not the geometry, is what decides an export — so stub the
    // layout rather than hunting for a circuit the router happens to fail on.
    layoutOverride = {
      board: { width: 10, height: 10, thickness: 1.6, outline: { x: 0, y: 0, width: 10, height: 10 } },
      components: [], traces: [], vias: [], nets: [],
      routing: { complete: false, failedNets: [{ net: 'VCC', reason: 'no_path' }] },
      drc: { ok: false, violations: [{ type: 'clearance', nets: ['VCC', 'GND'] }] },
      connectivity: { ok: false, incompleteNets: [{ net: 'VCC', islands: 2 }] },
    };

    try {
      exportNetlist({ circuit: parse(rcLowPass), format: 'gerber' }, fileSink(artifactDir));
      expect.unreachable('export should have refused');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('Gerber export refused: 1 unrouted nets, 1 DRC violations, 1 split nets.');
      expect(message).toContain('"net": "VCC"');
      expect(message).toContain('"islands": 2');
    }
  });
});
