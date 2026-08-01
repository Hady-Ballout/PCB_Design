// Checks boards this pipeline produces against KiCad's own design rule checker.
//
// Why this exists as a script and not a vitest case: pcbDrc.js is an
// independent second opinion on our own geometry, but it is still OUR opinion —
// it shares the design rules, the pad model and the millimetre conventions with
// everything that built the board. kicad-cli shares nothing. If the two ever
// disagree, one of them is wrong about what a fab house would say, and that is
// worth knowing.
//
//   node scripts/kicad-drc-oracle.mjs
//
// kicad-cli is optional. Without it the script says so and exits 0 — an oracle
// that blocks a contributor who has no KiCad installed would be worse than no
// oracle at all. The CI job that runs it is non-gating for the same reason:
// KiCad's DRC has opinions of its own (courtyard overlaps, unconnected-item
// rules) that are not the same contract as ours, so a violation here is a
// prompt to go and look, not a build failure.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPcbLayout } from '../src/core/pcbLayout.js';
import { toKiCadPcb } from '../src/core/kicadPcb.js';

const FIXTURES = [
  {
    name: 'rc-low-pass',
    title: 'RC low-pass',
    components: [
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VIN', '0'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VIN', 'VOUT'] },
      { ref: 'C1', kind: 'capacitor', value: '100nF', nodes: ['VOUT', '0'] },
    ],
  },
  {
    // A TO-92 board: the neck-down ladder's reason to exist, and the tightest
    // copper the pipeline produces.
    name: 'bjt-led-driver',
    title: 'BJT LED driver',
    components: [
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['IN', 'B'] },
      { ref: 'R2', kind: 'resistor', value: '330', nodes: ['VCC', 'LEDA'] },
      { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['LEDA', 'C'] },
      { ref: 'Q1', kind: 'bjt_npn', value: '2N3904', nodes: ['C', 'B', '0'] },
      { ref: 'V2', kind: 'signal_source', value: '1Vpp', nodes: ['IN', '0'] },
    ],
  },
  {
    name: 'astable-555',
    title: '555 astable',
    components: [
      { ref: 'U1', kind: 'timer_555', value: 'NE555', nodes: ['0', 'THR', 'OUT', 'VCC', 'CTRL', 'THR', 'DIS', 'VCC'] },
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VCC', 'DIS'] },
      { ref: 'R2', kind: 'resistor', value: '47k', nodes: ['DIS', 'THR'] },
      { ref: 'C1', kind: 'capacitor', value: '10uF', nodes: ['THR', '0'] },
      { ref: 'C2', kind: 'capacitor', value: '10nF', nodes: ['CTRL', '0'] },
      { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['OUT', 'LEDA'] },
      { ref: 'R3', kind: 'resistor', value: '330', nodes: ['LEDA', '0'] },
      { ref: 'V1', kind: 'voltage_source', value: '9V', nodes: ['VCC', '0'] },
    ],
  },
];

const KICAD_CLI = process.env.KICAD_CLI || 'kicad-cli';

const hasKicadCli = () => {
  const probe = spawnSync(KICAD_CLI, ['version'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0;
};

const directory = mkdtempSync(join(tmpdir(), 'pcb-pilot-drc-'));
let failures = 0;

console.log(`Boards written to ${directory}`);

for (const fixture of FIXTURES) {
  const layout = buildPcbLayout(fixture);
  const file = join(directory, `${fixture.name}.kicad_pcb`);
  writeFileSync(file, toKiCadPcb(layout, fixture), 'utf8');

  // Our own verdict first, so a kicad-cli disagreement is legible as a
  // disagreement rather than as "the board was broken all along".
  const ours = layout.routing.complete && layout.drc.ok && layout.connectivity.ok;
  console.log(
    `${fixture.name}: ${layout.board.width} x ${layout.board.height} mm, `
    + `${layout.traces.length} traces, ${layout.vias.length} vias, `
    + `${layout.pour ? layout.pour.polygons.length : 0} pour polygons — `
    + `pcbDrc says ${ours ? 'OK' : 'NOT FABRICABLE'}`,
  );
  if (!ours) failures += 1;
}

if (!hasKicadCli()) {
  console.log(`\n${KICAD_CLI} not found on PATH — KiCad DRC skipped.`);
  console.log('Install KiCad (or set KICAD_CLI) to run the external oracle.');
  process.exit(failures ? 1 : 0);
}

for (const fixture of FIXTURES) {
  const file = join(directory, `${fixture.name}.kicad_pcb`);
  const report = join(directory, `${fixture.name}.drc.json`);
  const run = spawnSync(
    KICAD_CLI,
    ['pcb', 'drc', '--exit-code-violations', '--format', 'json', '--output', report, file],
    { encoding: 'utf8' },
  );
  const output = `${run.stdout || ''}${run.stderr || ''}`.trim();
  if (run.status === 0) {
    console.log(`\n${fixture.name}: kicad-cli DRC clean.`);
    continue;
  }
  failures += 1;
  console.log(`\n${fixture.name}: kicad-cli DRC reported violations (exit ${run.status}).`);
  if (output) console.log(output);
  console.log(`Full report: ${report}`);
}

process.exit(failures ? 1 : 0);
