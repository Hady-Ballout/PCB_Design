#!/usr/bin/env node
// Head-to-head over the 20-case extension suite, GLM 5.2 on both sides.
// Same scoring rules as compare.mjs: every circuit from either side goes
// through THIS branch's verify.mjs with the case's own assertions.
//
//   node sandbox/compare20.mjs [--json]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPricing, runRow } from './cost.mjs';

const sandboxDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(sandboxDir, '..');
const suiteDir = resolve(sandboxDir, 'suite');
const runsDir = resolve(sandboxDir, 'runs');
const baselineDir = process.env.BASELINE_DIR || resolve(repoRoot, '../PCB_baseline/bench/results');
const VERIFY = resolve(sandboxDir, 'tools/verify.mjs');
const pricing = loadPricing();

const CASES = ['astable-4hz', 'astable-25khz', 'monostable-3s', 'rc-highpass-500hz', 'inverting-amp-15',
  'divider-9to3', 'led-12ma', 'comparator-night-light', 'npn-led-driver', 'mosfet-load-switch',
  'relay-lamp', 'stepper-basic', 'seven-seg-counter', 'i2c-two-devices', 'ultrasonic-alarm',
  'opto-input', 'linear-reg-5v', 'zener-clamp', 'hall-tach', 'keypad-entry'];

const GLM = { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 1.4 };

const score = (file, assertions) => {
  const args = [VERIFY, file, '--json'];
  for (const assertion of assertions) args.push('--assert', assertion);
  try {
    return JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }));
  } catch (error) {
    try { return JSON.parse(error.stdout); } catch {
      return { pass: false, error: (error.stderr || error.message || '').trim().slice(0, 200) };
    }
  }
};

const failuresOf = (verify) => [
  ...(verify?.error ? [verify.error] : []),
  ...(verify?.validation?.errors || []),
  ...(verify?.topology?.violations || []).map((v) => `topology ${v.id}`),
  ...(verify?.routing && !verify.routing.complete ? ['routing incomplete'] : []),
  ...(verify?.drc?.violations || []).map((v) => `drc ${v.type}`),
  ...(verify?.asserts || []).filter((a) => !a.ok).map((a) => `assert ${a.expression} (${a.detail})`),
];

const latestRun = (name) => {
  const candidates = readdirSync(runsDir)
    .filter((id) => id.startsWith(`eval-${name}-`))
    .sort()
    .reverse();
  for (const id of candidates) {
    const root = resolve(runsDir, id);
    if (existsSync(resolve(root, 'circuit.json'))) return root;
  }
  return null;
};

const rows = [];
for (const name of CASES) {
  const suite = JSON.parse(readFileSync(resolve(suiteDir, `${name}.json`), 'utf8'));
  const assertions = suite.assertions || [];

  // --- sandbox side
  const runRoot = latestRun(name);
  let sandbox = { pass: false, failures: ['no run found'] };
  if (runRoot) {
    const verify = score(resolve(runRoot, 'circuit.json'), assertions);
    const session = JSON.parse(readFileSync(resolve(runRoot, 'session.json'), 'utf8'));
    const priced = runRow(session, pricing);
    sandbox = {
      pass: Boolean(verify.pass),
      failures: failuresOf(verify).slice(0, 4),
      requests: priced.requests,
      costUsd: priced.cost,
      input: priced.input,
      cacheRead: priced.cacheRead,
      output: priced.output,
      seconds: Math.round((session.totals?.durationMs ?? 0) / 1000),
    };
  }

  // --- baseline side
  const recordFile = resolve(baselineDir, `${name}.json`);
  let baseline = { pass: false, failures: ['no result found'] };
  if (existsSync(recordFile)) {
    const record = JSON.parse(readFileSync(recordFile, 'utf8'));
    const circuitFile = resolve(baselineDir, `${name}.circuit.json`);
    const verify = record.error
      ? { pass: false, error: `pipeline error: ${record.error.slice(0, 120)}` }
      : existsSync(circuitFile) ? score(circuitFile, assertions) : { pass: false, error: 'no circuit produced' };
    const usage = record.usage || { input: 0, output: 0, cacheRead: 0 };
    baseline = {
      pass: Boolean(verify.pass),
      failures: failuresOf(verify).slice(0, 4),
      requests: record.requests,
      costUsd: (usage.input * GLM.input + usage.output * GLM.output + usage.cacheRead * GLM.cacheRead) / 1e6,
      input: usage.input,
      cacheRead: usage.cacheRead,
      output: usage.output,
      seconds: Math.round((record.durationMs ?? 0) / 1000),
    };
  }

  rows.push({ name, sandbox, baseline });
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

const total = (side, key) => rows.reduce((sum, row) => sum + (row[side][key] ?? 0), 0);
const passes = (side) => rows.filter((row) => row[side].pass).length;

console.log(`${'case'.padEnd(24)}${'sandbox'.padEnd(10)}${'cost'.padEnd(10)}${'baseline'.padEnd(10)}cost`);
for (const row of rows) {
  console.log(`${row.name.padEnd(24)}`
    + `${(row.sandbox.pass ? 'PASS' : 'FAIL').padEnd(10)}${('$' + (row.sandbox.costUsd ?? 0).toFixed(4)).padEnd(10)}`
    + `${(row.baseline.pass ? 'PASS' : 'FAIL').padEnd(10)}$${(row.baseline.costUsd ?? 0).toFixed(4)}`);
  for (const side of ['sandbox', 'baseline']) {
    if (!row[side].pass && row[side].failures?.length) {
      console.log(`    ${side}: ${row[side].failures.join(' · ')}`);
    }
  }
}
console.log('');
console.log(`sandbox  ${passes('sandbox')}/20 · $${total('sandbox', 'costUsd').toFixed(4)} total `
  + `· ${total('sandbox', 'requests')} requests · ${Math.round(total('sandbox', 'seconds') / 60)} min`);
console.log(`baseline ${passes('baseline')}/20 · $${total('baseline', 'costUsd').toFixed(4)} total `
  + `· ${total('baseline', 'requests')} requests · ${Math.round(total('baseline', 'seconds') / 60)} min`);
