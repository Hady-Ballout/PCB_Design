#!/usr/bin/env node
// The sandbox from a terminal.
//
//   node sandbox/cli.mjs new "blink an LED every 2 seconds"
//   node sandbox/cli.mjs say <id> "make it 5 seconds and add a power LED"
//   node sandbox/cli.mjs show <id>
//   node sandbox/cli.mjs list
//   node sandbox/cli.mjs done <id>
//   node sandbox/cli.mjs rm <id>
import { create, say, close, open, readSession, summaries } from './session.mjs';
import {
  EMPTY_USAGE, addUsage, compact, costOf, loadPricing, money, normalizeUsage, priceRun,
  promptTokens, ratesFor, runRow, table, thousands, totalTokens,
} from './cost.mjs';

const GREY = '\x1b[90m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const OFF = '\x1b[0m';

const usage = () => `PCB sandbox — an agent builds circuit JSON in a disposable workspace.

  node sandbox/cli.mjs new  "<request>"  [--assert 'U1.TRIG == U1.THRES'] [--id <id>]
  node sandbox/cli.mjs say  <id> "<message>"
  node sandbox/cli.mjs show <id> [--trace] [--circuit] [--report]
  node sandbox/cli.mjs list
  node sandbox/cli.mjs done <id> [--note "<why>"]
  node sandbox/cli.mjs cost [<id>] [--requests] [--json]
  node sandbox/cli.mjs rm   <id>

A run stays open after it passes. Review it, send follow-ups with \`say\`, and
close it with \`done\` when you are satisfied — the agent never closes its own run.`;

const flagValue = (args, name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const collectFlag = (args, name) => args.reduce((out, arg, index) => {
  if (arg === name && args[index + 1]) out.push(args[index + 1]);
  return out;
}, []);

const seconds = (ms) => `${(ms / 1000).toFixed(0)}s`;

const truncate = (text, limit) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

/** Render the agent's event stream as it arrives. */
const renderStream = async (stream) => {
  let verify = null;
  let requests = 0;
  let model = '';
  let live = { ...EMPTY_USAGE };
  for await (const event of stream) {
    switch (event.event) {
      case 'init':
        model = event.model;
        console.log(`${GREY}model ${event.model}${OFF}\n`);
        break;
      case 'text':
        console.log(event.text.trim());
        console.log();
        break;
      case 'tool':
        console.log(`${GREY}  · ${event.tool}${event.input?.command ? `  ${truncate(event.input.command, 70)}`
          : event.input?.file_path ? `  ${event.input.file_path}` : ''}${OFF}`);
        break;
      case 'permission':
        // Only denials are worth showing — they are usually the agent probing a
        // boundary, and they explain a turn that otherwise looks wasted.
        if (event.behavior === 'deny') console.log(`${RED}  · denied ${event.tool}: ${event.reason}${OFF}`);
        break;
      case 'usage': {
        const usage = normalizeUsage(event.usage);
        requests += 1;
        live = addUsage(live, usage);
        break;
      }
      case 'result':
        console.log(`${GREY}${event.turns} turns · ${requests} requests · ${seconds(event.durationMs)} · `
          + `${compact(totalTokens(live))} tokens (${compact(live.cacheRead)} cached) · `
          + `${money(costOf(live, ratesFor(model, loadPricing())))}${OFF}`);
        break;
      case 'verify':
        verify = event.verify;
        break;
      case 'error':
        console.error(`${RED}${event.message}${OFF}`);
        break;
      default:
        break;
    }
  }
  return verify;
};

const printVerdict = (verify) => {
  if (!verify) return;
  if (verify.pass) {
    const { board } = verify;
    console.log(`\n${GREEN}${BOLD}PASS${OFF}  ${verify.title || ''}`);
    if (board) {
      console.log(`${board.width} x ${board.height} mm · ${verify.componentCount} components · `
        + `${verify.traces} traces · ${verify.vias} vias`);
    }
    return;
  }
  console.log(`\n${RED}${BOLD}FAIL${OFF}  ${verify.error || ''}`);
  for (const error of verify.validation?.errors || []) console.log(`  ! ${error}`);
  for (const warning of verify.validation?.warnings || []) console.log(`  ! ${warning}`);
  for (const violation of verify.topology?.violations || []) console.log(`  ! ${violation.id}: ${violation.message || ''}`);
  for (const assertion of (verify.asserts || []).filter((entry) => !entry.ok)) {
    console.log(`  ! assertion ${assertion.expression} — ${assertion.detail}`);
  }
  if (verify.routing && !verify.routing.complete) console.log(`  ! routing failed: ${verify.routing.failedNets.join(', ')}`);
  for (const violation of verify.drc?.violations || []) console.log(`  ! drc ${violation.type}`);
};

const reviewHint = (id, verify) => {
  console.log(`\n${GREY}run ${id}${OFF}`);
  console.log(`${GREY}  node sandbox/cli.mjs show ${id}${OFF}`);
  console.log(`${GREY}  node sandbox/cli.mjs say ${id} "…"${OFF}`);
  if (verify?.pass) console.log(`${GREY}  node sandbox/cli.mjs done ${id}${OFF}`);
};

// ------------------------------------------------------------------ commands

const commands = {
  async new(args) {
    const prompt = args.find((arg) => !arg.startsWith('--')
      && args[args.indexOf(arg) - 1] !== '--assert' && args[args.indexOf(arg) - 1] !== '--id');
    if (!prompt) throw new Error('What should it build?\n\n' + usage());

    const workspace = create({
      prompt,
      id: flagValue(args, '--id'),
      assertions: collectFlag(args, '--assert'),
    });
    console.log(`${BOLD}${workspace.id}${OFF}  ${prompt}\n`);

    const verify = await renderStream(say(workspace, prompt));
    printVerdict(verify);
    reviewHint(workspace.id, verify);
    return verify?.pass ? 0 : 1;
  },

  async say(args) {
    const [id, ...rest] = args.filter((arg) => !arg.startsWith('--'));
    const message = rest.join(' ');
    if (!id || !message) throw new Error('Usage: say <id> "<message>"');
    const workspace = open(id);
    console.log(`${BOLD}${id}${OFF}  ${message}\n`);
    const verify = await renderStream(say(workspace, message));
    printVerdict(verify);
    reviewHint(id, verify);
    return verify?.pass ? 0 : 1;
  },

  show(args) {
    const id = args.find((arg) => !arg.startsWith('--'));
    if (!id) throw new Error('Usage: show <id>');
    const workspace = open(id);
    const record = readSession(workspace);

    if (args.includes('--circuit')) {
      console.log(workspace.exists('circuit.json') ? workspace.read('circuit.json') : 'No circuit.json.');
      return 0;
    }
    if (args.includes('--report')) {
      console.log(workspace.exists('report.md') ? workspace.read('report.md') : 'No report.md.');
      return 0;
    }
    if (args.includes('--trace')) {
      console.log(workspace.read('trace.jsonl'));
      return 0;
    }

    console.log(`${BOLD}${record.id}${OFF}  ${record.status}`);
    console.log(`${GREY}${record.prompt}${OFF}`);
    console.log(`${GREY}${workspace.root}${OFF}\n`);

    for (const turn of record.turns) {
      console.log(`${GREY}› ${truncate(turn.message, 76)}${OFF}`);
      console.log(`  ${truncate(turn.reply, 200)}`);
      console.log(`${GREY}  ${turn.turns} turns · ${seconds(turn.durationMs)} · $${turn.costUsd.toFixed(4)} · `
        + `${turn.pass ? 'pass' : 'fail'}${OFF}\n`);
    }

    printVerdict(record.verify);
    const priced = priceRun(record.usageByModel, loadPricing());
    console.log(`\n${GREY}totals: ${record.totals.turns} turns · ${record.requests?.length ?? 0} requests · `
      + `${seconds(record.totals.durationMs)} · ${compact(totalTokens(priced.usage))} tokens · `
      + `${money(priced.total)}  (node sandbox/cli.mjs cost ${id})${OFF}`);
    console.log(`${GREY}files: ${workspace.outputs().join(', ')}${OFF}`);
    if (record.status !== 'done') reviewHint(id, record.verify);
    return 0;
  },

  list() {
    const rows = summaries();
    if (!rows.length) {
      console.log('No runs yet.  node sandbox/cli.mjs new "blink an LED once per second"');
      return 0;
    }
    for (const { record } of rows) {
      const mark = record.status === 'done' ? `${GREEN}done${OFF}`
        : record.status === 'failed' ? `${RED}failed${OFF}`
          : record.status;
      console.log(`${BOLD}${record.id}${OFF}  ${mark.padEnd(24)} ${truncate(record.prompt, 50)}`);
    }
    return 0;
  },

  cost(args) {
    const pricing = loadPricing();
    const id = args.find((arg) => !arg.startsWith('--'));
    const rows = (id ? [readSession(open(id))] : summaries().map((entry) => entry.record))
      .filter(Boolean)
      .map((record) => runRow(record, pricing));

    if (!rows.length) {
      console.log('No runs to price yet.');
      return 0;
    }
    if (args.includes('--json')) {
      console.log(JSON.stringify(rows, null, 2));
      return 0;
    }

    // One run: show where the tokens went, per request.
    if (id) {
      const [row] = rows;
      const record = readSession(open(id));
      console.log(`${BOLD}${row.id}${OFF}  ${truncate(row.prompt, 60)}\n`);
      console.log(table(
        ['', 'tokens', 'rate $/M', 'cost'],
        [
          ['fresh input', thousands(row.input), '', ''],
          ['cache read', thousands(row.cacheRead), '', ''],
          ['cache write', thousands(row.cacheWrite), '', ''],
          ['output', thousands(row.output), '', ''],
          ['', '', '', ''],
          ...row.models.map((entry) => [
            entry.model,
            compact(totalTokens(entry.usage)),
            `${entry.rates.input}/${entry.rates.output}`,
            money(entry.cost),
          ]),
        ],
        ['l', 'r', 'r', 'r'],
      ));
      console.log(`\n${BOLD}${money(row.cost)}${OFF} over ${row.requests} requests`
        + `${row.components ? ` · ${row.components} components · ${row.size}` : ''}`);
      if (row.components) {
        console.log(`${GREY}${money(row.costPerComponent)}/component · ${money(row.costPerCm2)}/cm²${OFF}`);
      }
      // The SDK's own number, for comparison. A gap means pricing.json and the
      // SDK's internal table disagree — ours is the one you can correct.
      if (Math.abs(row.cost - row.reportedCost) > 0.0005) {
        console.log(`${GREY}SDK reported ${money(row.reportedCost)} using its own rate table${OFF}`);
      }

      if (args.includes('--requests')) {
        console.log(`\n${BOLD}per request${OFF}`);
        console.log(table(
          ['#', 'turn', 'model', 'input', 'cached', 'output'],
          (record.requests || []).map((entry, index) => [
            index + 1, entry.turn + 1, entry.model,
            thousands(entry.input), thousands(entry.cacheRead), thousands(entry.output),
          ]),
          ['r', 'r', 'l', 'r', 'r', 'r'],
        ));
      }
      return 0;
    }

    // All runs: the shape of cost against board size. A run with no requests
    // predates token tracking — show a dash, because rendering it as $0.0000
    // would read as "this board was free".
    const priced = rows.filter((row) => row.requests > 0);
    console.log(table(
      ['run', 'ok', 'parts', 'board', 'req', 'input', 'cached', 'output', 'cost', '$/part'],
      rows.map((row) => (row.requests === 0
        ? [row.id, row.pass ? 'y' : 'n', row.components || '', row.size, '—', '—', '—', '—', '—', '—']
        : [
          row.id, row.pass ? 'y' : 'n', row.components || '', row.size,
          row.requests, compact(row.input), compact(row.cacheRead), compact(row.output),
          money(row.cost), row.costPerComponent ? money(row.costPerComponent) : '',
        ])),
      ['l', 'l', 'r', 'l', 'r', 'r', 'r', 'r', 'r', 'r'],
    ));

    const untracked = rows.length - priced.length;
    if (untracked) console.log(`${GREY}${untracked} run(s) have no token data — they ran before tracking existed${OFF}`);
    if (!priced.length) return 0;

    const totalCost = priced.reduce((sum, row) => sum + row.cost, 0);
    const totalRequests = priced.reduce((sum, row) => sum + row.requests, 0);
    const built = priced.filter((row) => row.pass && row.components);
    console.log(`\n${priced.length} run${priced.length === 1 ? '' : 's'} · ${totalRequests} requests · ${BOLD}${money(totalCost)}${OFF}`);
    if (built.length) {
      const perBoard = built.reduce((sum, row) => sum + row.cost, 0) / built.length;
      const perPart = built.reduce((sum, row) => sum + row.costPerComponent, 0) / built.length;
      console.log(`${GREY}mean over ${built.length} passing boards: ${money(perBoard)}/board · ${money(perPart)}/component${OFF}`);
    }
    // Cache reads usually dwarf fresh input here, so the cache rate is what
    // actually moves the bill — worth seeing before tuning anything else.
    const usage = priced.reduce((sum, row) => ({
      input: sum.input + row.input, cacheRead: sum.cacheRead + row.cacheRead,
      cacheWrite: sum.cacheWrite + row.cacheWrite, output: sum.output + row.output,
    }), { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
    const share = (100 * usage.cacheRead) / Math.max(1, promptTokens(usage));
    console.log(`${GREY}${share.toFixed(0)}% of prompt tokens were cache reads${OFF}`);
    console.log(`${GREY}rates from sandbox/pricing.json — correct them and every run reprices${OFF}`);
    return 0;
  },

  done(args) {
    const id = args.find((arg) => !arg.startsWith('--'));
    if (!id) throw new Error('Usage: done <id>');
    const workspace = open(id);
    const record = close(workspace, { note: flagValue(args, '--note') });
    console.log(`${GREEN}${record.id} closed${OFF}  ${record.totals.turns} turns · $${record.totals.costUsd.toFixed(4)}`);
    console.log(`${GREY}${workspace.root}/circuit.json${OFF}`);
    return 0;
  },

  rm(args) {
    const id = args.find((arg) => !arg.startsWith('--'));
    if (!id) throw new Error('Usage: rm <id>');
    open(id).dispose();
    console.log(`${id} removed`);
    return 0;
  },
};

const [command, ...args] = process.argv.slice(2);
if (!command || command === '--help' || command === '-h' || !commands[command]) {
  console.log(usage());
  process.exit(command && !commands[command] ? 2 : 0);
}

try {
  process.exit((await commands[command](args)) ?? 0);
} catch (error) {
  console.error(`${RED}${error.message}${OFF}`);
  process.exit(2);
}
