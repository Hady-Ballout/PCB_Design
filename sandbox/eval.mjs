#!/usr/bin/env node
// Scoring the sandbox.
//
// The question this answers is "is this model good enough to generate boards",
// and it answers it with a number rather than an impression. A single good run
// proves nothing — the failure mode in this domain is a board that verifies
// clean and does not work, and that only shows up across cases.
//
// Each case is a prompt plus assertions. The assertions are the part that
// matters: the five engine verdicts cannot see intent, so a case asserts what
// the circuit must structurally be, and the same expression language the agent
// uses in WORKSPACE.md evaluates them.
//
//   node sandbox/eval.mjs                      # whole suite, sequential
//   node sandbox/eval.mjs blink-1hz            # one case
//   node sandbox/eval.mjs --parallel 3
//   node sandbox/eval.mjs --keep               # do not delete workspaces
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create, say, readSession } from './session.mjs';
import { readEnvFile, envFileName } from './agent.mjs';
import { compact, loadPricing, money, runRow } from './cost.mjs';

const sandboxDir = dirname(fileURLToPath(import.meta.url));
const suiteDir = resolve(sandboxDir, 'suite');
const resultsDir = resolve(sandboxDir, 'results');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const GREY = '\x1b[90m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';

const loadCases = (only) => readdirSync(suiteDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(resolve(suiteDir, name), 'utf8')))
  .filter((testCase) => !only.length || only.includes(testCase.name))
  .sort((a, b) => a.name.localeCompare(b.name));

/** Run one case to completion and return a scored row. */
const runCase = async (testCase, { keep, maxTurns }) => {
  const started = Date.now();
  const id = `eval-${testCase.name}-${started.toString(36).slice(-4)}`;
  const workspace = create({ prompt: testCase.prompt, id, assertions: testCase.assertions || [] });

  let result = null;
  let verify = null;
  let toolCalls = 0;
  let denials = 0;

  try {
    for await (const event of say(workspace, testCase.prompt, { maxTurns })) {
      if (event.event === 'tool') toolCalls += 1;
      if (event.event === 'permission' && event.behavior === 'deny') denials += 1;
      if (event.event === 'result') result = event;
      if (event.event === 'verify') verify = event.verify;
      if (event.event === 'error') verify = { pass: false, error: event.message };
    }
  } catch (error) {
    verify = { pass: false, error: error.message };
  }

  const failures = [
    ...(verify?.error ? [verify.error] : []),
    ...(verify?.validation?.errors || []),
    ...(verify?.validation?.warnings || []).map((warning) => `warning: ${warning}`),
    ...(verify?.topology?.violations || []).map((violation) => `topology ${violation.id}`),
    ...(verify?.routing && !verify.routing.complete ? [`routing failed: ${verify.routing.failedNets.join(', ')}`] : []),
    ...(verify?.drc?.violations || []).map((violation) => `drc ${violation.type}`),
    ...(verify?.asserts || []).filter((entry) => !entry.ok).map((entry) => `assert ${entry.expression} — ${entry.detail}`),
  ];

  // Price from the stored token counts rather than the SDK's figure, so the
  // report is consistent with `cli.mjs cost` and reprices when rates change.
  const priced = runRow(readSession(workspace) ?? {}, loadPricing());

  const row = {
    name: testCase.name,
    pass: Boolean(verify?.pass),
    turns: result?.turns ?? 0,
    requests: priced.requests,
    toolCalls,
    denials,
    seconds: Math.round((Date.now() - started) / 1000),
    costUsd: priced.cost,
    reportedCostUsd: result?.reportedCostUsd ?? 0,
    input: priced.input,
    cacheRead: priced.cacheRead,
    outputTokens: priced.output,
    tokens: priced.tokens,
    costPerComponent: priced.costPerComponent,
    workspace: workspace.id,
    board: priced.size,
    components: priced.components,
    areaCm2: priced.areaCm2,
    failures: failures.slice(0, 6),
  };

  if (!keep && row.pass) workspace.dispose();
  return row;
};

/** Run cases with a bounded number in flight. */
const runAll = async (cases, options) => {
  const rows = [];
  const queue = [...cases];
  const worker = async () => {
    while (queue.length) {
      const testCase = queue.shift();
      console.log(`${GREY}→ ${testCase.name}${OFF}`);
      const row = await runCase(testCase, options);
      rows.push(row);
      console.log(`${row.pass ? `${GREEN}PASS` : `${RED}FAIL`}${OFF} ${BOLD}${row.name}${OFF}  `
        + `${row.turns} turns · ${row.requests} req · ${row.seconds}s · ${compact(row.tokens)} tok · ${money(row.costUsd)}`
        + `${row.failures.length ? `\n     ${row.failures.join('\n     ')}` : ''}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.parallel, cases.length) }, worker));
  return rows.sort((a, b) => a.name.localeCompare(b.name));
};

const markdownReport = (rows, meta) => {
  const passed = rows.filter((row) => row.pass).length;
  const total = (key) => rows.reduce((sum, row) => sum + row[key], 0);
  const lines = [
    `# Sandbox eval — ${meta.model}`,
    '',
    `${meta.at} · ${passed}/${rows.length} passed · ${total('turns')} turns · `
      + `${total('seconds')}s · $${total('costUsd').toFixed(4)}`,
    '',
    '| Case | Result | Board | Parts | Req | Input | Cached | Output | Time | Cost | $/part |',
    '|------|--------|-------|-------|-----|-------|--------|--------|------|------|--------|',
    ...rows.map((row) => `| ${row.name} | ${row.pass ? 'PASS' : 'FAIL'} | ${row.board} | ${row.components} | `
      + `${row.requests} | ${compact(row.input)} | ${compact(row.cacheRead)} | ${compact(row.outputTokens)} | `
      + `${row.seconds}s | ${money(row.costUsd)} | ${row.costPerComponent ? money(row.costPerComponent) : '—'} |`),
    '',
    `Priced from token counts via \`sandbox/pricing.json\`. Totals: `
      + `${compact(total('input'))} fresh input · ${compact(total('cacheRead'))} cache read · `
      + `${compact(total('outputTokens'))} output.`,
  ];

  const built = rows.filter((row) => row.pass && row.components);
  if (built.length) {
    // The question this suite is meant to answer: does a bigger board cost more,
    // and how much more. One line per board, cheapest first.
    lines.push('', '## Cost against board size', '');
    lines.push('| Case | Parts | Area | Tokens | Cost |', '|------|-------|------|--------|------|');
    for (const row of [...built].sort((a, b) => a.components - b.components)) {
      lines.push(`| ${row.name} | ${row.components} | ${row.areaCm2.toFixed(1)} cm² | `
        + `${compact(row.tokens)} | ${money(row.costUsd)} |`);
    }
  }

  const failed = rows.filter((row) => !row.pass);
  if (failed.length) {
    lines.push('', '## Failures', '');
    for (const row of failed) {
      lines.push(`### ${row.name}`, '', `Workspace \`sandbox/runs/${row.workspace}\``, '');
      for (const failure of row.failures) lines.push(`- ${failure}`);
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
};

// --------------------------------------------------------------------- main

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const only = argv.filter((arg, index) => !arg.startsWith('--') && argv[index - 1] !== '--parallel' && argv[index - 1] !== '--max-turns');

const cases = loadCases(only);
if (!cases.length) {
  console.error(`No cases matched. Available: ${readdirSync(suiteDir).map((n) => n.replace('.json', '')).join(', ')}`);
  process.exit(2);
}

const model = readEnvFile(envFileName()).ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL || '(default)';
console.log(`${BOLD}${cases.length} case${cases.length === 1 ? '' : 's'}${OFF} · ${model}\n`);

const rows = await runAll(cases, {
  parallel: Number(flag('--parallel', 1)),
  maxTurns: Number(flag('--max-turns', 60)),
  keep: argv.includes('--keep'),
});

const passed = rows.filter((row) => row.pass).length;
console.log(`\n${passed === rows.length ? GREEN : RED}${passed}/${rows.length} passed${OFF}`);

mkdirSync(resultsDir, { recursive: true });
const at = new Date().toISOString();
const file = resolve(resultsDir, `${at.slice(0, 19).replace(/[:T]/g, '-')}-${model.replace(/[^\w.-]/g, '')}.md`);
writeFileSync(file, markdownReport(rows, { model, at }));
console.log(`${GREY}${file}${OFF}`);

// Failed workspaces are kept regardless of --keep: a failure you cannot open is
// a failure you cannot diagnose.
const kept = rows.filter((row) => !row.pass).map((row) => row.workspace);
if (kept.length) console.log(`${GREY}kept for inspection: ${kept.join(', ')}${OFF}`);

process.exit(passed === rows.length ? 0 : 1);
