#!/usr/bin/env node
// Head-to-head: the sandbox against main's tool-calling pipeline.
//
// Fairness rules, all of them deliberate:
//
//  - Same ten prompts, read from the same suite/*.json files by both harnesses.
//  - Same model, deepseek-v4-pro. The sandbox reaches it through DeepSeek's
//    Anthropic-compatible endpoint (what the Agent SDK speaks), the baseline
//    through its OpenAI-compatible one. Same weights either way.
//  - Same scoring: every circuit from either side is run through THIS branch's
//    verify.mjs with the case's own assertions. The exploration engine is a
//    superset of main's — it adds three connector kinds and removes nothing —
//    so a circuit valid on main is valid here, and neither side is scored by an
//    engine that cannot represent its output.
//  - Same pricing: sandbox/pricing.json, applied to the token split each
//    harness recorded.
//
// The one asymmetry that cannot be removed is stated in the report rather than
// hidden: main has no pin_header, terminal_block or barrel_jack, and six of the
// ten prompts ask for a connector. That is a component-library difference, not a
// framework difference, so failures caused by it are counted separately.
//
//   node sandbox/compare.mjs [--json] > sandbox/COMPARISON.md
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { costOf, loadPricing, money, compact, ratesFor, runRow, table } from './cost.mjs';
import { readSession } from './session.mjs';
import { open as openWorkspace } from './workspace.mjs';

const sandboxDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(sandboxDir, '..');
const suiteDir = resolve(sandboxDir, 'suite');
const runsDir = resolve(sandboxDir, 'runs');
const baselineDir = process.env.BASELINE_DIR || resolve(repoRoot, '../PCB_baseline/bench/results');
const VERIFY = resolve(sandboxDir, 'tools/verify.mjs');
const pricing = loadPricing();

// Kinds this branch added. Worth surfacing on a failure so the reader can tell
// a library gap from a framework one — but only as a label. Judging *why* a
// board failed is a reading task, not a string match, and this script does not
// pretend otherwise.
const ADDED_KINDS = ['pin_header', 'terminal_block', 'barrel_jack'];

const cases = readdirSync(suiteDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(resolve(suiteDir, name), 'utf8')))
  .sort((a, b) => a.name.localeCompare(b.name));

/** Score any circuit file with this branch's verify.mjs and the case's assertions. */
const score = (file, assertions) => {
  const args = [VERIFY, file, '--json'];
  for (const assertion of assertions) args.push('--assert', assertion);
  try {
    return JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }));
  } catch (error) {
    // verify.mjs exits 1 on a failing board and still prints its report.
    try {
      return JSON.parse(error.stdout);
    } catch {
      return { pass: false, error: (error.stderr || error.message || '').trim().slice(0, 200) };
    }
  }
};

/** Why a run failed, in one phrase, and whether the cause is the missing kinds. */
const diagnose = (verify, record) => {
  if (!verify) return { reason: 'no circuit produced', libraryGap: false };
  if (verify.error) return { reason: verify.error, libraryGap: false };

  const reasons = [
    ...(verify.validation?.errors || []),
    ...(verify.validation?.warnings || []).map((w) => w),
    ...(verify.topology?.violations || []).map((v) => `${v.id}`),
    ...(verify.asserts || []).filter((a) => !a.ok).map((a) => `assert ${a.expression}`),
    ...(verify.routing && !verify.routing.complete ? ['routing incomplete'] : []),
    ...(verify.drc?.violations || []).map((v) => `drc ${v.type}`),
  ];
  // An assertion naming a kind that does not exist on main can never pass there.
  const libraryGap = reasons.some((reason) => ADDED_KINDS.some((kind) => reason.includes(kind)))
    || (record?.error || '').includes('is not supported');
  return { reason: reasons[0] || 'unknown', libraryGap, all: reasons };
};

// ------------------------------------------------------------ sandbox side

const sandboxRows = cases.map((testCase) => {
  const dir = existsSync(runsDir)
    ? readdirSync(runsDir).filter((name) => name.startsWith(`eval-${testCase.name}-`)).sort().pop()
    : null;
  if (!dir) return { name: testCase.name, missing: true };

  const record = readSession(openWorkspace(dir));
  const row = runRow(record, pricing);
  const file = resolve(runsDir, dir, 'circuit.json');
  const verify = existsSync(file) ? score(file, testCase.assertions || []) : null;
  return {
    name: testCase.name,
    pass: Boolean(verify?.pass),
    seconds: Math.round((record.totals?.durationMs ?? 0) / 1000),
    requests: row.requests,
    input: row.input,
    cacheRead: row.cacheRead,
    output: row.output,
    cost: row.cost,
    components: verify?.componentCount ?? 0,
    board: verify?.board ? `${verify.board.width}x${verify.board.height}mm` : '',
    ...diagnose(verify, record),
  };
});

// ----------------------------------------------------------- baseline side

const baselineRows = cases.map((testCase) => {
  const file = resolve(baselineDir, `${testCase.name}.json`);
  if (!existsSync(file)) return { name: testCase.name, missing: true };

  const record = JSON.parse(readFileSync(file, 'utf8'));
  const circuitFile = resolve(baselineDir, `${testCase.name}.circuit.json`);
  const verify = existsSync(circuitFile) ? score(circuitFile, testCase.assertions || []) : null;
  const usage = { ...record.usage, cacheWrite: record.usage.cacheWrite ?? 0 };
  const rates = ratesFor(record.model, pricing);
  return {
    name: testCase.name,
    pass: Boolean(verify?.pass),
    seconds: Math.round(record.durationMs / 1000),
    requests: record.requests,
    input: usage.input,
    cacheRead: usage.cacheRead,
    output: usage.output,
    cost: costOf(usage, rates),
    components: verify?.componentCount ?? 0,
    board: verify?.board ? `${verify.board.width}x${verify.board.height}mm` : '',
    ...diagnose(verify, record),
  };
});

const byName = (rows) => Object.fromEntries(rows.map((row) => [row.name, row]));
const S = byName(sandboxRows);
const B = byName(baselineRows);
const present = cases.filter((testCase) => !S[testCase.name]?.missing && !B[testCase.name]?.missing);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ sandbox: sandboxRows, baseline: baselineRows }, null, 2));
  process.exit(0);
}

// ---------------------------------------------------------------- report

const out = [];
const w = (...lines) => out.push(...lines);
const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] || 0), 0);
const passed = (rows) => rows.filter((row) => row.pass);

const sRows = present.map((testCase) => S[testCase.name]);
const bRows = present.map((testCase) => B[testCase.name]);

w('# Sandbox vs. tool-calling pipeline', '');
w(`The same ${present.length} prompts, the same model (\`deepseek-v4-pro\`), the same scoring.`,
  'The sandbox is this branch: an agent with a shell, a snapshot of the engine and',
  '`verify.mjs`. The baseline is `main`: a three-stage prompt pipeline with a topology',
  'gate and one correction retry, no filesystem and no ability to run the engine.', '');

w('| | Sandbox | Baseline (main) |', '|---|---|---|');
w(`| Passed | **${passed(sRows).length}/${sRows.length}** | **${passed(bRows).length}/${bRows.length}** |`);
w(`| Total cost | ${money(sum(sRows, 'cost'))} | ${money(sum(bRows, 'cost'))} |`);
w(`| Cost per board | ${money(sum(sRows, 'cost') / Math.max(1, sRows.length))} | `
  + `${money(sum(bRows, 'cost') / Math.max(1, bRows.length))} |`);
const sPass = passed(sRows);
const bPass = passed(bRows);
w(`| Cost per **working** board | ${sPass.length ? money(sum(sRows, 'cost') / sPass.length) : '—'} | `
  + `${bPass.length ? money(sum(bRows, 'cost') / bPass.length) : 'no working boards'} |`);
w(`| Wall time | ${Math.round(sum(sRows, 'seconds') / 60)} min | ${Math.round(sum(bRows, 'seconds') / 60)} min |`);
w(`| Provider calls | ${sum(sRows, 'requests')} | ${sum(bRows, 'requests')} |`);
w(`| Fresh input | ${compact(sum(sRows, 'input'))} | ${compact(sum(bRows, 'input'))} |`);
w(`| Cache reads | ${compact(sum(sRows, 'cacheRead'))} | ${compact(sum(bRows, 'cacheRead'))} |`);
w(`| Output | ${compact(sum(sRows, 'output'))} | ${compact(sum(bRows, 'output'))} |`);
w('');

w('## Per case', '');
w(table(
  ['case', 'sandbox', 'cost', 'time', 'baseline', 'cost', 'time', 'baseline failed on'],
  present.map((testCase) => {
    const s = S[testCase.name];
    const b = B[testCase.name];
    return [
      testCase.name,
      s.pass ? 'PASS' : 'FAIL', money(s.cost), `${s.seconds}s`,
      b.pass ? 'PASS' : 'FAIL', money(b.cost), `${b.seconds}s`,
      b.pass ? '' : `${b.reason}${b.libraryGap ? ' (library gap)' : ''}`,
    ];
  }),
  ['l', 'l', 'r', 'r', 'l', 'r', 'r', 'l'],
));
w('');

const failed = bRows.filter((row) => !row.pass);
if (failed.length) {
  w('## Baseline failures', '');
  w(`\`main\` has no \`${ADDED_KINDS.join('`, `')}\`, and six of the ten prompts ask for a`,
    'connector. Where that is the cause it is a component-library difference, not a',
    'framework one — the label below flags it, but which failures really reduce to it is',
    'a judgement made by reading the boards, not by matching strings.', '');
  for (const row of failed) {
    w(`- **${row.name}**${row.libraryGap ? ' _(touches a missing kind)_' : ''} — `
      + `${(row.all || [row.reason]).slice(0, 3).join('; ')}`);
  }
  w('');
}

console.log(out.join('\n'));
