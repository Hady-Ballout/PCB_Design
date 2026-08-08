#!/usr/bin/env node
// Design accuracy — the axis pass/fail cannot see.
//
// Four of the ten cases name a number the circuit must hit: a blink period, a
// cutoff frequency, a gain. Nothing in the engine simulates any of it, so two
// boards can both verify completely clean while one is 0.07% off target and the
// other is 25% off. That difference is the whole argument for searching the E24
// grid instead of picking a plausible value, so it is worth measuring directly.
//
// Each checker re-derives the achieved value from the produced JSON — reading
// the actual nets, not the title or the reply — and reports the error against
// what the prompt asked for.
//
//   node sandbox/accuracy.mjs <circuit.json> <case-name>
//   node sandbox/accuracy.mjs --table            # both sides, every case
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { table } from './cost.mjs';

const sandboxDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(sandboxDir, '..');
const runsDir = resolve(sandboxDir, 'runs');
const baselineDir = process.env.BASELINE_DIR || resolve(repoRoot, '../PCB_baseline/bench/results');

const SI = { p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6 };
const num = (text) => {
  const match = /^([\d.]+)\s*([pnuµmkKM]?)/.exec(String(text ?? '').trim());
  return match ? Number(match[1]) * (match[2] ? SI[match[2]] : 1) : NaN;
};

const partsOf = (circuit, kind) => (circuit.components || []).filter((part) => part.kind === kind);
const between = (parts, a, b) => parts.find((part) => part.nodes?.includes(a) && part.nodes?.includes(b));

/** 555 astable period from the actual RC network, located by the timer's own pins. */
const periodOf = (circuit, timer) => {
  const n = timer.nodes;
  const resistors = partsOf(circuit, 'resistor');
  const caps = [...partsOf(circuit, 'capacitor'), ...partsOf(circuit, 'electrolytic')];
  const r1 = between(resistors, n[7], n[6]);   // VCC -> DISCH
  const r2 = between(resistors, n[6], n[1]);   // DISCH -> TRIG/THRES
  const cap = between(caps, n[1], '0');        // timing cap to ground
  if (!r1 || !r2 || !cap) return NaN;
  return 0.693 * (num(r1.value) + 2 * num(r2.value)) * num(cap.value);
};

const CHECKS = {
  'blink-1hz': (circuit) => {
    const timer = partsOf(circuit, 'timer_555')[0];
    if (!timer) return null;
    return [{ what: 'period', target: 1, unit: 's', achieved: periodOf(circuit, timer) }];
  },

  'dual-blinker': (circuit) => {
    const timers = partsOf(circuit, 'timer_555');
    if (timers.length < 2) return null;
    // The prompt names 2 s and 2.5 s; match each timer to its nearer target so
    // stage order does not decide the score.
    const periods = timers.map((timer) => periodOf(circuit, timer)).sort((a, b) => a - b);
    return [
      { what: 'period A', target: 2, unit: 's', achieved: periods[0] },
      { what: 'period B', target: 2.5, unit: 's', achieved: periods[1] },
    ];
  },

  'rc-filter': (circuit) => {
    const resistors = partsOf(circuit, 'resistor');
    const caps = partsOf(circuit, 'capacitor');
    // The filter cap is the one sharing a net with a resistor and ground.
    for (const cap of caps) {
      const signal = cap.nodes.find((net) => net !== '0');
      const resistor = resistors.find((part) => part.nodes.includes(signal));
      if (!resistor || !cap.nodes.includes('0')) continue;
      return [{
        what: 'cutoff', target: 1000, unit: 'Hz',
        achieved: 1 / (2 * Math.PI * num(resistor.value) * num(cap.value)),
      }];
    }
    return null;
  },

  'opamp-preamp': (circuit) => {
    const opamp = partsOf(circuit, 'opamp')[0];
    if (!opamp) return null;
    const [inPlus, inMinus, out] = opamp.nodes;
    const resistors = partsOf(circuit, 'resistor');
    const feedback = between(resistors, out, inMinus);
    const ground = between(resistors, inMinus, '0');
    if (feedback && ground) {
      return [{ what: 'gain', target: 10, unit: 'x', achieved: 1 + num(feedback.value) / num(ground.value) }];
    }
    // An inverting build is a legitimate reading of "gain of 10" too.
    const input = resistors.find((part) => part.nodes.includes(inMinus) && part !== feedback);
    if (feedback && input) {
      return [{ what: 'gain (inverting)', target: 10, unit: 'x', achieved: num(feedback.value) / num(input.value) }];
    }
    void inPlus;
    return null;
  },
};

const errorPct = (achieved, target) => (Math.abs(achieved - target) / target) * 100;

const measure = (file, name) => {
  const check = CHECKS[name];
  if (!check || !existsSync(file)) return null;
  let circuit;
  try {
    circuit = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const results = check(circuit);
  if (!results) return null;
  return results.map((entry) => ({
    ...entry,
    error: Number.isFinite(entry.achieved) ? errorPct(entry.achieved, entry.target) : NaN,
  }));
};

const fmt = (value, unit) => (Number.isFinite(value)
  ? `${Number(value.toPrecision(4))}${unit === 'x' ? '' : ` ${unit}`}`
  : '—');

if (!process.argv.includes('--table')) {
  const [file, name] = process.argv.slice(2);
  if (!file || !name) {
    console.error('usage: accuracy.mjs <circuit.json> <case-name>   |   accuracy.mjs --table');
    process.exit(2);
  }
  const results = measure(resolve(file), name);
  if (!results) {
    console.error(`No accuracy check for "${name}", or its network could not be read.`);
    process.exit(1);
  }
  for (const entry of results) {
    console.log(`${entry.what}: ${fmt(entry.achieved, entry.unit)} (target ${fmt(entry.target, entry.unit)}, `
      + `${Number.isFinite(entry.error) ? `${entry.error.toFixed(2)}% error` : 'unreadable'})`);
  }
  process.exit(0);
}

// --table: both sides, every measurable case.
const sandboxCircuit = (name) => {
  const dir = existsSync(runsDir)
    ? readdirSync(runsDir).filter((entry) => entry.startsWith(`eval-${name}-`)).sort().pop()
    : null;
  return dir ? resolve(runsDir, dir, 'circuit.json') : '';
};

const rows = [];
for (const name of Object.keys(CHECKS)) {
  const mine = measure(sandboxCircuit(name), name);
  const theirs = measure(resolve(baselineDir, `${name}.circuit.json`), name);
  const count = Math.max(mine?.length ?? 0, theirs?.length ?? 0, 1);
  for (let index = 0; index < count; index += 1) {
    const a = mine?.[index];
    const b = theirs?.[index];
    const target = a?.target ?? b?.target;
    const unit = a?.unit ?? b?.unit;
    rows.push([
      index === 0 ? name : '',
      a?.what ?? b?.what ?? '',
      target === undefined ? '—' : fmt(target, unit),
      a ? fmt(a.achieved, unit) : '—',
      a && Number.isFinite(a.error) ? `${a.error.toFixed(2)}%` : '—',
      b ? fmt(b.achieved, unit) : '—',
      b && Number.isFinite(b.error) ? `${b.error.toFixed(2)}%` : '—',
    ]);
  }
}

console.log(table(
  ['case', 'quantity', 'target', 'sandbox', 'err', 'baseline', 'err'],
  rows,
  ['l', 'l', 'r', 'r', 'r', 'r', 'r'],
));
