#!/usr/bin/env node
// Component-value search over the E24 grid.
//
// CLAUDE.md step 4 says: "Write a script. Search the E24 grid, filter by error,
// rank by a secondary criterion." Hand-picking finds a value that works; a
// search finds the value that is best and proves the rest were worse. This is
// that script, written once, so the agent spends its turns on topology instead
// of rebuilding a nested loop.
//
// Non-E24 values are not purchasable and raise `non_standard_resistor` in the
// topology rules, so every value printed here is drawn from the grid.
//
//   node solve.mjs 555-astable  --period 2.0 --cap 100uF
//   node solve.mjs 555-astable  --freq 1 --cap 10uF
//   node solve.mjs led-resistor --supply 9 --vf 2.0 --current 15mA
//   node solve.mjs rc-lowpass   --fc 1kHz
//   node solve.mjs divider      --vin 9 --vout 3.3
//   node solve.mjs e24          --near 4700
//   node solve.mjs expr --target 2.0 --expr '0.693*(r1+2*r2)*c' --cap 100uF

const E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6,
  3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1];

/** Resistor grid, 10 Ω to 1 MΩ — the span the footprint and topology rules expect. */
const RESISTORS = [1e1, 1e2, 1e3, 1e4, 1e5]
  .flatMap((decade) => E24.map((mantissa) => mantissa * decade))
  .concat(1e6);

/** Capacitor grid — E12-ish preferred values actually stocked, 100pF to 1000uF. */
const CAPACITORS = [1.0, 1.5, 2.2, 3.3, 4.7, 6.8]
  .flatMap((mantissa) => [1e-10, 1e-9, 1e-8, 1e-7, 1e-6, 1e-5, 1e-4].map((decade) => mantissa * decade))
  .concat([1e-3]);

// ------------------------------------------------------------------ parsing

const SI = { p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };

/**
 * Parse a value with an optional SI prefix and unit: "100uF", "4k7" is NOT
 * supported (the engine's own parser returns null for it — see
 * knowledge/components/resistor.md), "1kHz", "15mA", "3.3".
 */
const parseValue = (text) => {
  const match = /^([\d.]+)\s*([pnuµmkKMG]?)\s*(?:[A-Za-zΩ]*)$/.exec(String(text).trim());
  if (!match) return NaN;
  const [, digits, prefix] = match;
  return Number(digits) * (prefix ? SI[prefix] : 1);
};

/** Format a resistance the way the circuit JSON wants it: "3k", "330", "1M". */
const formatResistance = (ohms) => {
  if (ohms >= 1e6) return `${trim(ohms / 1e6)}M`;
  if (ohms >= 1e3) return `${trim(ohms / 1e3)}k`;
  return `${trim(ohms)}`;
};

const formatCapacitance = (farads) => {
  if (farads >= 1e-3) return `${trim(farads / 1e-3)}mF`;
  if (farads >= 1e-6) return `${trim(farads / 1e-6)}uF`;
  if (farads >= 1e-9) return `${trim(farads / 1e-9)}nF`;
  return `${trim(farads / 1e-12)}pF`;
};

const trim = (value) => Number(value.toPrecision(4)).toString();
const percent = (actual, target) => (Math.abs(actual - target) / target) * 100;

const flags = (argv) => {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    const key = argv[index].slice(2);
    const next = argv[index + 1];
    out[key] = next && !next.startsWith('--') ? next : 'true';
  }
  return out;
};

const table = (rows, headers) => {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => String(row[column]).length)));
  const line = (cells) => cells.map((cell, column) => String(cell).padEnd(widths[column])).join('  ');
  return [line(headers), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n');
};

// --------------------------------------------------------------- topologies

/**
 * 555 astable. T = 0.693 * (R1 + 2*R2) * C, duty = (R1+R2)/(R1+2*R2).
 *
 * Duty is always above 50% without a diode across R2, so the search ranks by
 * closeness to 50% among candidates that hit the period — a squarer wave is the
 * better board when the period is equally good.
 */
const astable555 = (options) => {
  const cap = parseValue(options.cap || '10uF');
  const target = options.freq ? 1 / parseValue(options.freq) : parseValue(options.period || '1');
  if (!Number.isFinite(cap) || !Number.isFinite(target)) throw new Error('need --cap and --period (or --freq)');

  const results = [];
  for (const r1 of RESISTORS) {
    // R1 sets the discharge current floor; below ~1k the 555 sinks too much.
    if (r1 < 1e3) continue;
    for (const r2 of RESISTORS) {
      if (r2 < 1e3) continue;
      const period = 0.693 * (r1 + 2 * r2) * cap;
      const error = percent(period, target);
      if (error > 1) continue;
      const duty = (r1 + r2) / (r1 + 2 * r2);
      results.push({ r1, r2, period, error, duty });
    }
  }
  if (!results.length) {
    return `No E24 pair within 1% for T=${target}s at C=${formatCapacitance(cap)}. Try another capacitor.`;
  }
  results.sort((a, b) => Math.abs(a.duty - 0.5) - Math.abs(b.duty - 0.5) || a.error - b.error);

  return [
    `555 astable — target ${trim(target)} s (${trim(1 / target)} Hz), C = ${formatCapacitance(cap)}`,
    `${results.length} E24 pairs within 1%; ranked by duty closest to 50%.`,
    '',
    table(results.slice(0, 8).map((row) => [
      formatResistance(row.r1),
      formatResistance(row.r2),
      `${trim(row.period)}s`,
      `${row.error.toFixed(2)}%`,
      row.duty.toFixed(3),
      `${trim(0.693 * (row.r1 + row.r2) * cap)}s`,
      `${trim(0.693 * row.r2 * cap)}s`,
    ]), ['R1', 'R2', 'period', 'err', 'duty', 't_high', 't_low']),
  ].join('\n');
};

/** LED series resistor. R = (Vdrive - Vf) / I. */
const ledResistor = (options) => {
  const supply = parseValue(options.supply || '5');
  const vf = parseValue(options.vf || '2.0');
  const current = parseValue(options.current || '15mA');
  // A 555 output does not swing to the rail — it lands about 1.7 V below it.
  const drive = options.driver === '555' ? supply - 1.7 : supply;
  if (drive <= vf) throw new Error(`drive ${trim(drive)}V is below the LED's ${trim(vf)}V forward drop`);

  const ideal = (drive - vf) / current;
  const results = RESISTORS
    .map((ohms) => ({ ohms, current: (drive - vf) / ohms }))
    .filter((row) => row.current > 0.001 && row.current < 0.03)
    .sort((a, b) => Math.abs(a.current - current) - Math.abs(b.current - current));

  return [
    `LED series resistor — drive ${trim(drive)}V${options.driver === '555' ? ' (555 output, rail minus 1.7V)' : ''}`
      + `, Vf ${trim(vf)}V, target ${trim(current * 1000)}mA`,
    `Ideal ${trim(ideal)} ohm; nearest E24 values by current error:`,
    '',
    table(results.slice(0, 6).map((row) => [
      formatResistance(row.ohms),
      `${trim(row.current * 1000)}mA`,
      `${percent(row.current, current).toFixed(1)}%`,
      `${trim((drive - vf) * row.current * 1000)}mW`,
    ]), ['R', 'I', 'err', 'P_R']),
  ].join('\n');
};

/** RC low-pass. fc = 1 / (2*pi*R*C). */
const rcLowpass = (options) => {
  const target = parseValue(options.fc || '1kHz');
  const results = [];
  for (const ohms of RESISTORS) {
    if (ohms < 100 || ohms > 1e6) continue;
    for (const farads of CAPACITORS) {
      const fc = 1 / (2 * Math.PI * ohms * farads);
      const error = percent(fc, target);
      if (error > 2) continue;
      results.push({ ohms, farads, fc, error });
    }
  }
  if (!results.length) return `No E24 R/C pair within 2% of ${trim(target)} Hz.`;
  // Prefer a mid-range resistor: too low loads the source, too high picks up noise.
  results.sort((a, b) => Math.abs(Math.log10(a.ohms) - 4) - Math.abs(Math.log10(b.ohms) - 4) || a.error - b.error);

  return [
    `RC low-pass — target ${trim(target)} Hz`,
    'Ranked by resistor closest to 10k (low R loads the source, high R picks up noise).',
    '',
    table(results.slice(0, 8).map((row) => [
      formatResistance(row.ohms), formatCapacitance(row.farads),
      `${trim(row.fc)}Hz`, `${row.error.toFixed(2)}%`,
    ]), ['R', 'C', 'fc', 'err']),
  ].join('\n');
};

/** Resistive divider. Vout = Vin * R2 / (R1 + R2). */
const divider = (options) => {
  const vin = parseValue(options.vin || '9');
  const vout = parseValue(options.vout || '3.3');
  if (vout >= vin) throw new Error('--vout must be below --vin');
  const budget = parseValue(options.current || '1mA');

  const results = [];
  for (const r1 of RESISTORS) {
    for (const r2 of RESISTORS) {
      const actual = vin * (r2 / (r1 + r2));
      const error = percent(actual, vout);
      if (error > 1) continue;
      const drain = vin / (r1 + r2);
      if (drain > budget * 2 || drain < budget / 20) continue;
      results.push({ r1, r2, actual, error, drain });
    }
  }
  if (!results.length) return `No E24 pair within 1% of ${trim(vout)}V from ${trim(vin)}V at ~${trim(budget * 1000)}mA.`;
  results.sort((a, b) => a.error - b.error || Math.abs(a.drain - budget) - Math.abs(b.drain - budget));

  return [
    `Divider — ${trim(vin)}V to ${trim(vout)}V, target drain ${trim(budget * 1000)}mA`,
    '',
    table(results.slice(0, 8).map((row) => [
      formatResistance(row.r1), formatResistance(row.r2),
      `${trim(row.actual)}V`, `${row.error.toFixed(2)}%`, `${trim(row.drain * 1000)}mA`,
    ]), ['R1(top)', 'R2(bot)', 'Vout', 'err', 'I']),
  ].join('\n');
};

/** Nearest purchasable values to an arbitrary resistance. */
const e24 = (options) => {
  const target = parseValue(options.near || '1000');
  const ranked = RESISTORS
    .map((ohms) => ({ ohms, error: percent(ohms, target) }))
    .sort((a, b) => a.error - b.error)
    .slice(0, 5);
  return [
    `Nearest E24 values to ${trim(target)} ohm`,
    '',
    table(ranked.map((row) => [formatResistance(row.ohms), `${row.error.toFixed(2)}%`]), ['R', 'err']),
  ].join('\n');
};

/**
 * Generic two-resistor sweep for a topology this file does not name.
 *
 * The expression may use r1, r2 and c only, and is evaluated with no scope of
 * its own — it is arithmetic, not a program. Use it when the equation is known
 * but the topology is not one of the four above.
 */
const expr = (options) => {
  if (!options.expr) throw new Error("need --expr, e.g. --expr '0.693*(r1+2*r2)*c'");
  const target = parseValue(options.target);
  const cap = parseValue(options.cap || '10uF');
  if (!Number.isFinite(target)) throw new Error('need --target');
  if (!/^[\dr12c+\-*/(). eE]+$/.test(options.expr)) {
    throw new Error('--expr may use only r1, r2, c, numbers and + - * / ( )');
  }

  // eslint-disable-next-line no-new-func -- arithmetic only, guarded by the regex above
  const evaluate = new Function('r1', 'r2', 'c', `"use strict"; return (${options.expr});`);
  const results = [];
  for (const r1 of RESISTORS) {
    for (const r2 of RESISTORS) {
      const value = evaluate(r1, r2, cap);
      const error = percent(value, target);
      if (Number.isFinite(error) && error <= 1) results.push({ r1, r2, value, error });
    }
  }
  if (!results.length) return `No E24 pair within 1% of ${trim(target)} for that expression at C=${formatCapacitance(cap)}.`;
  results.sort((a, b) => a.error - b.error);
  return [
    `${options.expr} = ${trim(target)}  (C = ${formatCapacitance(cap)})`,
    '',
    table(results.slice(0, 8).map((row) => [
      formatResistance(row.r1), formatResistance(row.r2), trim(row.value), `${row.error.toFixed(3)}%`,
    ]), ['R1', 'R2', 'value', 'err']),
  ].join('\n');
};

// --------------------------------------------------------------------- main

const TOPOLOGIES = {
  '555-astable': astable555,
  'led-resistor': ledResistor,
  'rc-lowpass': rcLowpass,
  divider,
  e24,
  expr,
};

const usage = () => [
  'Component-value search over the E24 grid. Every value printed is purchasable.',
  '',
  '  node solve.mjs 555-astable  --period 2.0 --cap 100uF',
  '  node solve.mjs 555-astable  --freq 1 --cap 10uF',
  '  node solve.mjs led-resistor --supply 9 --vf 2.0 --current 15mA [--driver 555]',
  '  node solve.mjs rc-lowpass   --fc 1kHz',
  '  node solve.mjs divider      --vin 9 --vout 3.3 [--current 1mA]',
  '  node solve.mjs e24          --near 4700',
  "  node solve.mjs expr         --target 2.0 --expr '0.693*(r1+2*r2)*c' --cap 100uF",
  '',
  'Values parse with SI prefixes: 100uF, 1kHz, 15mA. Note "4k7" is NOT valid',
  'here or in the circuit JSON — the engine parses it as null. Write "4.7k".',
].join('\n');

const [topology, ...rest] = process.argv.slice(2);
if (!topology || topology === '--help' || topology === '-h') {
  console.log(usage());
  process.exit(0);
}
const solver = TOPOLOGIES[topology];
if (!solver) {
  console.error(`Unknown topology "${topology}".\n\n${usage()}`);
  process.exit(2);
}
try {
  console.log(solver(flags(rest)));
} catch (error) {
  console.error(`${error.message}\n\n${usage()}`);
  process.exit(2);
}
