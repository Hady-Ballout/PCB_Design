#!/usr/bin/env node
// Turns the run directories left by `eval.mjs --keep` into BENCHMARK.md.
//
// The eval reports under results/ are git-ignored: they are raw, one per run,
// and they multiply. This produces the single committed record — what the suite
// covers, what it cost, and what failed — from the same session.json files, so
// the document cannot drift from the runs it claims to describe.
//
//   node sandbox/eval.mjs --parallel 3 --keep
//   node sandbox/benchmark.mjs > sandbox/BENCHMARK.md
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPricing, money, priceRun, promptTokens, compact, runRow } from './cost.mjs';

const sandboxDir = dirname(fileURLToPath(import.meta.url));
const runsDir = resolve(sandboxDir, 'runs');
const suiteDir = resolve(sandboxDir, 'suite');
const pricing = loadPricing();

const cases = Object.fromEntries(readdirSync(suiteDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => {
    const testCase = JSON.parse(readFileSync(resolve(suiteDir, name), 'utf8'));
    return [testCase.name, testCase];
  }));

// One run per case: the most recent, so a re-run of a single case supersedes.
const byCase = new Map();
for (const dir of existsSync(runsDir) ? readdirSync(runsDir) : []) {
  const file = resolve(runsDir, dir, 'session.json');
  if (!dir.startsWith('eval-') || !existsSync(file)) continue;
  const record = JSON.parse(readFileSync(file, 'utf8'));
  const name = Object.keys(cases).find((key) => dir.startsWith(`eval-${key}-`));
  if (!name) continue;
  // A run still in flight has no verdict and no tokens yet. Including it would
  // publish a case as a $0 failure purely because the suite was still going.
  if (record.status === 'running') continue;
  const previous = byCase.get(name);
  if (!previous || record.createdAt > previous.createdAt) byCase.set(name, record);
}

const rows = Object.keys(cases)
  .filter((name) => byCase.has(name))
  .map((name) => ({ name, testCase: cases[name], ...runRow(byCase.get(name), pricing) }))
  .sort((a, b) => a.name.localeCompare(b.name));

if (!rows.length) {
  console.error('No eval runs found. Run: node sandbox/eval.mjs --parallel 3 --keep');
  process.exit(1);
}

const seconds = (ms) => `${Math.round(ms / 1000)}s`;
const passed = rows.filter((row) => row.pass);
const sum = (key) => rows.reduce((total, row) => total + row[key], 0);
const mean = (list, key) => (list.length ? list.reduce((t, r) => t + r[key], 0) / list.length : 0);
const model = Object.keys(byCase.values().next().value.usageByModel || { unknown: 1 })
  .find((name) => !name.includes('flash')) || 'unknown';

const out = [];
const w = (...lines) => out.push(...lines);

w('# Benchmark', '');
w(`${rows.length} circuits built end to end through the sandbox — a prompt in, a verified`,
  'board out — with no human in the loop. Every row below is a real agent run: it read',
  'the knowledge base, searched component values, wrote `circuit.json`, ran `verify.mjs`',
  'against the engine, and iterated until the gates passed or it gave up.', '');
w(`**Model** \`${model}\` · **${passed.length}/${rows.length} passed** · `
  + `${money(sum('cost'))} total · ${seconds(rows.reduce((t, r) => t + (byCase.get(r.name).totals?.durationMs ?? 0), 0))} of model time`, '');
w('Regenerate with `node sandbox/eval.mjs --parallel 3 --keep && node sandbox/benchmark.mjs > sandbox/BENCHMARK.md`.', '');

w('## Results', '');
w('| Case | Result | Board | Parts | Req | Fresh in | Cached | Out | Time | Cost |');
w('|---|---|---|---|---|---|---|---|---|---|');
for (const row of rows) {
  const durationMs = byCase.get(row.name).totals?.durationMs ?? 0;
  w(`| ${row.name} | ${row.pass ? '**PASS**' : 'FAIL'} | ${row.size || '—'} | ${row.components || '—'} | `
    + `${row.requests} | ${compact(row.input)} | ${compact(row.cacheRead)} | ${compact(row.output)} | `
    + `${seconds(durationMs)} | ${money(row.cost)} |`);
}
w('');

w('## Cost', '');
if (passed.length) {
  w(`Mean over the ${passed.length} passing board${passed.length === 1 ? '' : 's'}: `
    + `**${money(mean(passed, 'cost'))} per board**, ${Math.round(mean(passed, 'requests'))} API requests, `
    + `${money(mean(passed, 'costPerComponent'))} per component.`, '');
}
const usage = rows.reduce((total, row) => ({
  input: total.input + row.input,
  cacheRead: total.cacheRead + row.cacheRead,
  cacheWrite: total.cacheWrite + row.cacheWrite,
  output: total.output + row.output,
}), { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
w(`Across all ${rows.length} runs: ${compact(usage.input)} fresh input · ${compact(usage.cacheRead)} cache read · `
  + `${compact(usage.output)} output. `
  + `${Math.round((100 * usage.cacheRead) / Math.max(1, promptTokens(usage)))}% of prompt tokens were cache hits, `
  + 'which is why the bill tracks fresh input rather than total tokens.', '');
w('Priced from stored token counts via `sandbox/pricing.json`. The Agent SDK\'s own',
  '`total_cost_usd` reports roughly 20x these figures on this endpoint, because it prices',
  'from its internal rate table rather than the provider\'s — see `README.md`.', '');

// Does cost track board size? The interesting answer is usually "barely".
const sized = passed.filter((row) => row.components > 0).sort((a, b) => a.components - b.components);
if (sized.length > 2) {
  const smallest = sized[0];
  const largest = sized[sized.length - 1];
  w('### Cost against board size', '');
  w('| Case | Parts | Area | Requests | Cost |');
  w('|---|---|---|---|---|');
  for (const row of sized) {
    w(`| ${row.name} | ${row.components} | ${row.areaCm2.toFixed(1)} cm² | ${row.requests} | ${money(row.cost)} |`);
  }
  w('');
  const ratio = smallest.cost > 0 ? largest.cost / smallest.cost : 0;
  w(`Largest board is ${(largest.components / Math.max(1, smallest.components)).toFixed(1)}x the part count of the `
    + `smallest but ${ratio.toFixed(1)}x the cost. Component count drives design turns, not prompt size, `
    + 'and turns are mostly cache reads — so per-board cost is far flatter than part count suggests.', '');
}

w('## How to read this', '');
w('A PASS means the board cleared all five engine gates — validation with zero warnings,',
  '28 topology rules, complete routing, clean DRC, complete connectivity — **and** the',
  "case's assertions about what it structurally had to be. That second half is the one",
  'that matters: a 555 blinker wired as a one-shot passes all five gates on a board that',
  'cannot blink, so the gates alone do not distinguish a working circuit from a',
  'manufacturable one.', '');
w('It does **not** mean the board was simulated, or that its values are right. Nothing',
  'here checks the arithmetic. Where a case has a design equation, the numbers were',
  'spot-checked by hand against the produced JSON — the op-amp came out at a gain of',
  'exactly 10.000 from 27k/3k, and the buck converter put the inductor and the catch',
  'diode cathode on the switch node with FB taken from the output rail, which is the',
  'contract most often got wrong from recall.', '');
w('**The assertions are the weak link, not the model.** Three cases failed during',
  'authoring because the assertion was wrong, not the circuit: one demanded two resistors',
  'from a design that correctly needed one, one used arithmetic the expression language',
  'did not support, and one named pins the parser could not read. Each was a real defect',
  'in this harness, fixed and covered by a test. Treat a new failure as a claim to check',
  'before it is a verdict.', '');

w('## What each case is for', '');
for (const row of rows) {
  w(`**${row.name}** — ${row.testCase.prompt}`, '');
  if (row.testCase.notes) w(`> ${row.testCase.notes}`, '');
}

const failures = rows.filter((row) => !row.pass);
if (failures.length) {
  w('## Failures', '');
  for (const row of failures) {
    const record = byCase.get(row.name);
    const verify = record.verify || {};
    w(`### ${row.name}`, '');
    const reasons = [
      ...(verify.error ? [verify.error] : []),
      ...(verify.validation?.errors || []),
      ...(verify.validation?.warnings || []).map((warning) => `warning: ${warning}`),
      ...(verify.topology?.violations || []).map((v) => `topology ${v.id}: ${v.message || ''}`),
      ...(verify.asserts || []).filter((a) => !a.ok).map((a) => `assertion \`${a.expression}\` — ${a.detail}`),
      ...(verify.drc?.violations || []).map((v) => `drc ${v.type}`),
    ];
    for (const reason of reasons.slice(0, 8)) w(`- ${reason}`);
    w('');
  }
}

console.log(out.join('\n'));
