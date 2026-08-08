#!/usr/bin/env node
// Design accuracy for the 20-case extension suite — same idea as accuracy.mjs
// (which knows only the original ten cases): re-derive each achieved value from
// the produced circuit JSON and report the error against what the prompt asked.
//
//   node sandbox/accuracy20.mjs --table
//   node sandbox/accuracy20.mjs <circuit.json> <case-name>
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const partsOfAny = (circuit, kinds) => (circuit.components || []).filter((part) => kinds.includes(part.kind));
const between = (parts, a, b) => parts.find((part) => part.nodes?.includes(a) && part.nodes?.includes(b));
const touching = (parts, net) => parts.filter((part) => part.nodes?.includes(net));
const otherEnd = (part, net) => part.nodes.find((candidate) => candidate !== net);

/** 555 astable period from the actual RC network, located by the timer's own pins. */
const astablePeriod = (circuit, timer) => {
  const n = timer.nodes;
  const resistors = partsOf(circuit, 'resistor');
  const caps = partsOf(circuit, 'capacitor');
  const r1 = between(resistors, n[7], n[6]);   // VCC -> DISCH
  const r2 = between(resistors, n[6], n[1]);   // DISCH -> TRIG/THRES
  const cap = between(caps, n[1], '0');        // timing cap to ground
  if (!r1 || !r2 || !cap) return NaN;
  return 0.693 * (num(r1.value) + 2 * num(r2.value)) * num(cap.value);
};

/** 555 monostable pulse width: R from VCC to THRES/DISCH, C from THRES to ground. */
const monostablePulse = (circuit, timer) => {
  const n = timer.nodes;
  const resistors = partsOf(circuit, 'resistor');
  const caps = partsOf(circuit, 'capacitor');
  const thres = n[5];
  const r = between(resistors, n[7], thres) || between(resistors, n[7], n[6]);
  const cap = between(caps, thres, '0') || between(caps, n[6], '0');
  if (!r || !cap) return NaN;
  return 1.1 * num(r.value) * num(cap.value);
};

const CHECKS = {
  'astable-4hz': (circuit) => {
    const timer = partsOf(circuit, 'timer_555')[0];
    if (!timer) return null;
    return [{ what: 'period', target: 0.25, unit: 's', achieved: astablePeriod(circuit, timer) }];
  },

  'astable-25khz': (circuit) => {
    const timer = partsOf(circuit, 'timer_555')[0];
    if (!timer) return null;
    const period = astablePeriod(circuit, timer);
    return [{ what: 'frequency', target: 25000, unit: 'Hz', achieved: period > 0 ? 1 / period : NaN }];
  },

  'monostable-3s': (circuit) => {
    const timer = partsOf(circuit, 'timer_555')[0];
    if (!timer) return null;
    return [{ what: 'pulse', target: 3, unit: 's', achieved: monostablePulse(circuit, timer) }];
  },

  'rc-highpass-500hz': (circuit) => {
    // High-pass: series C from the source's signal net, then the shunt R on the
    // C's far side. The R may terminate on ground or on a bypassed bias rail
    // (both are AC ground), so trace from the source rather than from "0" —
    // tracing from ground grabbed a bias-divider leg on a correct board.
    const source = partsOf(circuit, 'signal_source')[0];
    if (!source) return null;
    const signal = source.nodes.find((net) => net !== '0');
    const caps = partsOf(circuit, 'capacitor');
    const resistors = partsOf(circuit, 'resistor');
    const series = caps.find((part) => part.nodes.includes(signal));
    if (!series) return null;
    const mid = otherEnd(series, signal);
    const shunt = resistors.find((part) => part.nodes.includes(mid));
    if (!shunt) return null;
    return [{
      what: 'cutoff', target: 500, unit: 'Hz',
      achieved: 1 / (2 * Math.PI * num(shunt.value) * num(series.value)),
    }];
  },

  'inverting-amp-15': (circuit) => {
    const amp = partsOfAny(circuit, ['opamp', 'ua741'])[0];
    if (!amp) return null;
    const pins = amp.kind === 'opamp'
      ? { inMinus: amp.nodes[1], out: amp.nodes[2] }
      : { inMinus: amp.nodes[1], out: amp.nodes[5] };
    const resistors = partsOf(circuit, 'resistor');
    const feedback = between(resistors, pins.inMinus, pins.out);
    const input = touching(resistors, pins.inMinus).find((part) => part !== feedback);
    if (!feedback || !input) return null;
    return [{ what: 'gain', target: 15, unit: 'x', achieved: num(feedback.value) / num(input.value) }];
  },

  'divider-9to3': (circuit) => {
    // Chain: source net -> R_top -> VOUT -> R_bottom -> ground.
    const resistors = partsOf(circuit, 'resistor');
    for (const bottom of resistors) {
      if (!bottom.nodes.includes('0')) continue;
      const mid = otherEnd(bottom, '0');
      const top = resistors.find((part) => part !== bottom && part.nodes.includes(mid));
      if (!top) continue;
      const rTop = num(top.value);
      const rBottom = num(bottom.value);
      const current = 9 / (rTop + rBottom);
      return [
        { what: 'ratio', target: 1 / 3, unit: '', achieved: rBottom / (rTop + rBottom) },
        // Overshoot-only error: any current at or under the 1 mA budget is 0% off.
        { what: 'drain', target: 0.001, unit: 'A', achieved: current, overshootOnly: true },
      ];
    }
    return null;
  },

  'led-12ma': (circuit) => {
    const resistor = partsOf(circuit, 'resistor')[0];
    if (!resistor) return null;
    // Vf assumed 2.0 V for a red LED — the same arithmetic the prompt implies.
    return [{ what: 'current', target: 0.012, unit: 'A', achieved: (12 - 2.0) / num(resistor.value) }];
  },

  'comparator-night-light': (circuit) => {
    // The reference divider: two resistors meeting on a comparator input net,
    // one to the supply, one to ground, with no photoresistor on that net.
    const comparator = partsOf(circuit, 'comparator')[0];
    if (!comparator) return null;
    const resistors = partsOf(circuit, 'resistor');
    const ldrNets = new Set(partsOf(circuit, 'photoresistor').flatMap((part) => part.nodes || []));
    for (const net of [comparator.nodes[0], comparator.nodes[1]]) {
      if (ldrNets.has(net)) continue;
      const legs = touching(resistors, net);
      const bottom = legs.find((part) => part.nodes.includes('0'));
      const top = legs.find((part) => part !== bottom);
      if (!bottom || !top) continue;
      const ratio = num(bottom.value) / (num(top.value) + num(bottom.value));
      return [{ what: 'threshold', target: 0.5, unit: 'Vcc', achieved: ratio }];
    }
    return null;
  },

  'linear-reg-5v': (circuit) => {
    // The landmine probe: parse the regulator value the way the engine does
    // (first number wins), so "LM7805" scores as 7805 V and "5V" as 5 V.
    const regulator = partsOf(circuit, 'regulator')[0];
    if (!regulator) return null;
    return [{ what: 'reg value parses to', target: 5, unit: 'V', achieved: num(regulator.value) }];
  },

  'keypad-entry': (circuit) => {
    const keypad = partsOf(circuit, 'keypad')[0];
    if (!keypad) return null;
    const real = (keypad.nodes || []).filter((net) => net && !String(net).startsWith('NC_'));
    return [{ what: 'distinct matrix nets', target: 8, unit: '', achieved: new Set(real).size }];
  },
};

// ------------------------------------------------------------------ sources

const latestRunCircuit = (name) => {
  if (!existsSync(runsDir)) return null;
  const candidates = readdirSync(runsDir)
    .filter((id) => id.startsWith(`eval-${name}-`))
    .sort()
    .reverse();
  for (const id of candidates) {
    const file = resolve(runsDir, id, 'circuit.json');
    if (existsSync(file)) {
      try { return JSON.parse(readFileSync(file, 'utf8')); } catch { /* keep looking */ }
    }
  }
  return null;
};

const baselineCircuit = (name) => {
  const file = resolve(baselineDir, `${name}.circuit.json`);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
};

const errorOf = (entry) => {
  if (!entry || !Number.isFinite(entry.achieved)) return NaN;
  if (entry.overshootOnly) return Math.max(0, (entry.achieved - entry.target) / entry.target);
  return Math.abs(entry.achieved - entry.target) / entry.target;
};

const fmt = (value) => (Number.isFinite(value)
  ? (Math.abs(value) >= 1000 ? value.toPrecision(4) : Number(value.toPrecision(4)).toString())
  : '—');
const pct = (value) => (Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '—');

// ---------------------------------------------------------------------- main

const args = process.argv.slice(2);

if (args.includes('--table')) {
  const rows = [];
  for (const [name, check] of Object.entries(CHECKS)) {
    const sides = { sandbox: latestRunCircuit(name), baseline: baselineCircuit(name) };
    const entries = {};
    for (const [side, circuit] of Object.entries(sides)) {
      entries[side] = circuit ? check(circuit) : null;
    }
    const count = Math.max(entries.sandbox?.length ?? 0, entries.baseline?.length ?? 0);
    for (let index = 0; index < count; index += 1) {
      const sand = entries.sandbox?.[index] ?? null;
      const base = entries.baseline?.[index] ?? null;
      const what = (sand ?? base)?.what ?? '?';
      const target = (sand ?? base)?.target;
      const unit = (sand ?? base)?.unit ?? '';
      rows.push({
        case: name, what, target: `${fmt(target)}${unit ? ` ${unit}` : ''}`,
        sandbox: sand ? fmt(sand.achieved) : '—', sandboxErr: errorOf(sand),
        baseline: base ? fmt(base.achieved) : '—', baselineErr: errorOf(base),
      });
    }
  }

  const width = { case: 24, what: 24, target: 12, value: 12, err: 9 };
  console.log(`${'case'.padEnd(width.case)}${'metric'.padEnd(width.what)}${'target'.padEnd(width.target)}`
    + `${'sandbox'.padEnd(width.value)}${'err'.padEnd(width.err)}${'baseline'.padEnd(width.value)}err`);
  for (const row of rows) {
    console.log(`${row.case.padEnd(width.case)}${row.what.padEnd(width.what)}${row.target.padEnd(width.target)}`
      + `${String(row.sandbox).padEnd(width.value)}${pct(row.sandboxErr).padEnd(width.err)}`
      + `${String(row.baseline).padEnd(width.value)}${pct(row.baselineErr)}`);
  }

  for (const side of ['sandboxErr', 'baselineErr']) {
    const errors = rows.map((row) => row[side]).filter(Number.isFinite);
    const mean = errors.length ? errors.reduce((total, value) => total + value, 0) / errors.length : NaN;
    console.log(`mean ${side.replace('Err', '')} error over ${errors.length} measurable metrics: ${pct(mean)}`);
  }
  process.exit(0);
}

const [file, caseName] = args;
if (!file || !caseName || !CHECKS[caseName]) {
  console.error('Usage: node sandbox/accuracy20.mjs <circuit.json> <case-name> | --table');
  console.error(`Cases with checkers: ${Object.keys(CHECKS).join(', ')}`);
  process.exit(2);
}
const circuit = JSON.parse(readFileSync(file, 'utf8'));
const entries = CHECKS[caseName](circuit);
if (!entries) { console.log('checker could not locate the network'); process.exit(1); }
for (const entry of entries) {
  console.log(`${entry.what}: achieved ${fmt(entry.achieved)}${entry.unit ? ` ${entry.unit}` : ''} `
    + `against ${fmt(entry.target)} — ${pct(errorOf(entry))} off`);
}
