#!/usr/bin/env node
// The five verdicts, the pin-assignment table, and the structural invariants —
// in one command.
//
// CLAUDE.md steps 7 and 8 both say "run it, do not inspect it", and step 8 is
// the one that catches the highest-frequency failure in this domain: a fixed-pin
// part wired in the wrong order validates clean, routes clean, passes DRC and
// exports fab-ready Gerbers for a circuit that does not work. Only pin *count*
// is checked by the engine.
//
// Without this file every agent re-derives the same harness from prose on every
// run, and hand-rolls the pin table from a component page. That is turns spent
// rebuilding scaffolding instead of designing, and a fresh chance to get the
// scaffolding wrong.
//
//   node verify.mjs [circuit.json] [--json] [--quiet]
//                   [--assert 'U1.TRIG == U1.THRES'] ...
//
// Exit code 0 when every gate passes, 1 otherwise, so the agent gets an
// unambiguous signal it cannot misread from prose.
//
// `--assert` is how *intent* gets checked. Nothing here can know whether a 555
// was meant to be astable or monostable — both are legal wirings, and a blinker
// wired as a one-shot passes all five gates. Measured on a real circuit:
// swapping TRIG and CTRL on local/blinker-1hz.json leaves validate, topology,
// routing, DRC and connectivity all clean. So the caller states what it meant
// and the assertion fails when the board does not match.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// This file is authored at sandbox/tools/verify.mjs and copied to the root of a
// run workspace, where the engine sits at ./src/core. Resolving both layouts
// means the copy and the original are the same file — it can be tested in the
// repo without a workspace, so a bug here is caught by the repo's own suite.
const ENGINE_CANDIDATES = [
  resolve(here, 'src/core'),         // workspace layout
  resolve(here, '../../src/core'),   // repo layout (sandbox/tools/ -> root)
];

const engineDir = ENGINE_CANDIDATES.find((candidate) => existsSync(resolve(candidate, 'pcbLayout.js')));
if (!engineDir) {
  console.error('Cannot find the engine. Expected src/core next to this script.');
  process.exit(2);
}

const load = (file) => import(new URL(`file://${resolve(engineDir, file)}`));
const { validateCircuit } = await load('pcbGenerator.js');
const { checkCircuitTopology, ROLE_PINS } = await load('topologyRules.js');
const { buildPcbLayout } = await load('pcbLayout.js');
const { COMPONENT_KINDS } = await load('componentKinds.js');

// ---------------------------------------------------------------- pin naming

/**
 * Pin names for a kind, in node order. Same resolution the knowledge-base
 * generator uses (scripts/build-component-docs.mjs): a kind's own `fixedPins`
 * wins, then the shared role table. Kinds with neither — resistors, capacitors —
 * genuinely have no order to get wrong.
 *
 * @returns {string[] | null}
 */
const pinNamesFor = (kind) => COMPONENT_KINDS[kind]?.fixedPins || ROLE_PINS[kind] || null;

// -------------------------------------------------------------- invariants
//
// Structural facts that no gate in the engine checks. Each returns a list of
// findings; `fail: true` means the circuit is definitely wrong, `fail: false` is
// an observation worth reading before shipping.
//
// The bar for `fail: true` is high on purpose. A 555 with TRIG and THRES on
// different nets is a perfectly legal monostable — flagging it as an error would
// train the agent to ignore this section, which is the one section that catches
// what nothing else does.

const netsOf = (part) => part.nodes || [];

/** A 555's mode is readable from its wiring; say which one was built. */
const check555 = (part) => {
  const n = netsOf(part);
  const [gnd, trig, , reset, , thres] = n;
  const findings = [];
  const astable = trig === thres;

  findings.push({
    fail: false,
    ref: part.ref,
    message: astable
      ? `astable (free-running) — TRIG and THRES share "${trig}"`
      : `monostable (one-shot) — TRIG is "${trig}", THRES is "${thres}". `
        + 'A blinker needs these on the same net.',
  });

  if (reset !== n[7]) {
    findings.push({
      fail: false,
      ref: part.ref,
      message: `RESET is "${reset}", not tied to VCC ("${n[7]}"). The timer is held resettable; `
        + 'tie RESET to VCC unless you are driving it deliberately.',
    });
  }
  if (gnd !== '0') {
    findings.push({ fail: true, ref: part.ref, message: `GND (pin 1) is "${gnd}", not "0".` });
  }
  return findings;
};

/** Ground on a fixed-pin part must be the literal net "0" — nothing else is ground. */
const checkGroundPins = (part) => {
  const names = pinNamesFor(part.kind);
  if (!names) return [];
  const findings = [];
  names.forEach((name, index) => {
    if (!/^(GND|DGND|AGND|V-)$/i.test(name)) return;
    const net = netsOf(part)[index];
    if (net && net !== '0' && !net.startsWith('NC_')) {
      findings.push({
        fail: true,
        ref: part.ref,
        message: `${name} (pin ${index + 1}) is "${net}". Ground is the net "0".`,
      });
    }
  });
  return findings;
};

// Node count is deliberately NOT checked here. The topology gate already does
// it, correctly, as `fixed_pin_node_count` — and it gets the hard part right:
// connectors are variable by design (a `pin_header` declares `pins: 2` as a
// default and sizes its footprint from the node count) and MCU nodes get padded
// by `padMcuNodes`. A duplicate check here flagged three circuits that were
// already verified clean before it was scoped to match. Duplicating a rule means
// maintaining its exceptions twice, so this one defers to the engine.
//
// What the engine genuinely cannot see is *which* net landed on which pin, which
// is what the pin table and the assertions below are for.

const INVARIANTS = { timer_555: check555 };

const runInvariants = (circuit) => (circuit.components || []).flatMap((part) => [
  ...checkGroundPins(part),
  ...(INVARIANTS[part.kind]?.(part) || []),
]);

// ------------------------------------------------------------------ asserts
//
// A deliberately tiny expression language. It exists so the eval suite and the
// agent express intent the same way, with one implementation:
//
//   U1.TRIG == U1.THRES         pin net equality, pins named or 1-based indexed
//   U1.RESET == VCC             right side is a net-name literal when unqualified
//   U1.kind == timer_555        component field
//   count(led) == 2             how many parts of a kind
//   timer_555[0].TRIG == ...    select by kind and position, not by ref
//
// The kind-indexed form exists because refs are the agent's choice. An eval
// case that asserts `U1.TRIG` is really asserting that the model happened to
// name its timer U1, and would fail a correct board that called it X1.
//
// Anything it cannot parse is reported as a failed assertion rather than
// silently passing — a typo in an assertion must never read as a green board.

const OPERATORS = {
  '==': (a, b) => String(a) === String(b),
  '!=': (a, b) => String(a) !== String(b),
  '>=': (a, b) => Number(a) >= Number(b),
  '<=': (a, b) => Number(a) <= Number(b),
  '>': (a, b) => Number(a) > Number(b),
  '<': (a, b) => Number(a) < Number(b),
};

/** Resolve one side of an assertion against the circuit. */
const resolveTerm = (term, circuit) => {
  const parts = circuit.components || [];

  // Sums, so "either of these kinds is present" is expressible:
  //   count(diode) + count(schottky) >= 1
  // Without this the whole term fell through to the net-literal branch below and
  // compared as a string, failing a correct board with an unreadable message.
  if (term.includes('+') && !/^\w*\[?\d*\]?\.[\w+-]+$/.test(term)) {
    return term.split('+')
      .map((piece) => Number(resolveTerm(piece.trim(), circuit)))
      .reduce((total, value) => {
        if (Number.isNaN(value)) throw new Error(`"${term}" is not a sum of numbers`);
        return total + value;
      }, 0);
  }

  const countMatch = /^count\(\s*([\w-]+)\s*\)$/.exec(term);
  if (countMatch) return parts.filter((part) => part.kind === countMatch[1]).length;
  // A malformed count() must not fall through to being read as a net name — a
  // typo would then compare as a string and quietly report a passing board.
  if (term.startsWith('count(')) throw new Error(`cannot parse "${term}" — expected count(kind)`);

  // Pin names are not all identifiers: an opamp's are `IN+`, `IN-`, `V+`, `V-`,
  // so the field part has to admit + and -. Neither collides with an operator
  // (== != >= <= > <), so the left/right split is unaffected.
  const dotted = /^([A-Za-z][\w]*)(?:\[(\d+)\])?\.([\w+-]+)$/.exec(term);
  if (dotted) {
    const [, ref, position, field] = dotted;
    // `timer_555[0]` selects the first part of that kind, in circuit order;
    // a bare `U1` selects by ref.
    const part = position === undefined
      ? parts.find((candidate) => candidate.ref === ref)
      : parts.filter((candidate) => candidate.kind === ref)[Number(position)];
    if (!part) {
      throw new Error(position === undefined
        ? `no component "${ref}"`
        : `no ${ref} at position ${position} (found ${parts.filter((c) => c.kind === ref).length})`);
    }
    if (field === 'kind' || field === 'value' || field === 'ref') return part[field];

    const names = pinNamesFor(part.kind) || [];
    // Accept a pin name, or a 1-based pin number for parts with no name table.
    const index = /^\d+$/.test(field)
      ? Number(field) - 1
      : names.findIndex((name) => name.toLowerCase() === field.toLowerCase());
    if (index < 0 || index >= (part.nodes || []).length) {
      throw new Error(`${ref} (${part.kind}) has no pin "${field}"`);
    }
    return part.nodes[index];
  }

  return term; // bare word or number — a net-name or numeric literal
};

const runAsserts = (expressions, circuit) => expressions.map((expression) => {
  const match = /^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/.exec(expression.trim());
  if (!match) {
    return { expression, ok: false, detail: 'cannot parse — expected `left <op> right`' };
  }
  const [, left, operator, right] = match;
  try {
    const a = resolveTerm(left.trim(), circuit);
    const b = resolveTerm(right.trim(), circuit);
    const ok = OPERATORS[operator](a, b);
    return { expression, ok, detail: ok ? `${a} ${operator} ${b}` : `got ${a} ${operator} ${b}` };
  } catch (error) {
    return { expression, ok: false, detail: error.message };
  }
});

// ------------------------------------------------------------------- report

const pad = (text, width) => String(text).padEnd(width);

const pinTable = (circuit) => (circuit.components || [])
  .map((part) => {
    const names = pinNamesFor(part.kind);
    if (!names) return null;
    const width = Math.max(...names.map((name) => name.length));
    const rows = names.map((name, index) => {
      const net = netsOf(part)[index] ?? '(missing)';
      const unused = String(net).startsWith('NC_');
      return `  ${pad(index + 1, 2)} ${pad(name, width)} -> ${net}${unused ? '   (unused)' : ''}`;
    });
    return `${part.ref}  ${part.kind}${part.value ? `  ${part.value}` : ''}\n${rows.join('\n')}`;
  })
  .filter(Boolean);

const main = () => {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const quiet = args.includes('--quiet');

  // Collect `--assert <expr>` pairs, then treat the first remaining bare token
  // as the circuit path so assertion text is never mistaken for a filename.
  const expressions = [];
  const bare = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--assert') {
      const expression = args[index + 1];
      if (expression === undefined) {
        console.error('--assert needs an expression, e.g. --assert \'U1.TRIG == U1.THRES\'');
        return 2;
      }
      expressions.push(expression);
      index += 1;
    } else if (!args[index].startsWith('--')) {
      bare.push(args[index]);
    }
  }
  const file = bare[0] || 'circuit.json';

  let circuit;
  try {
    circuit = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    const message = `Cannot read ${file}: ${error.message}`;
    if (asJson) console.log(JSON.stringify({ pass: false, stage: 'read', error: message }, null, 2));
    else console.error(message);
    return 1;
  }

  // A circuit that fails validation cannot be laid out, so stop rather than
  // throwing a stack trace the agent has to decode.
  const validation = validateCircuit(circuit);
  const topology = checkCircuitTopology(circuit);
  const invariants = runInvariants(circuit);
  const asserts = runAsserts(expressions, circuit);

  let layout = null;
  let layoutError = null;
  if (validation.ok) {
    try {
      layout = buildPcbLayout(circuit);
    } catch (error) {
      layoutError = error.message;
    }
  }

  const pass = Boolean(
    validation.ok
    && validation.warnings.length === 0     // a one-pin net means a part is not wired
    && topology.ok
    && layout
    && layout.routing.complete
    && layout.drc.ok
    && layout.connectivity.ok
    && !invariants.some((finding) => finding.fail)
    && asserts.every((assertion) => assertion.ok),
  );

  if (asJson) {
    console.log(JSON.stringify({
      pass,
      file,
      title: circuit.title,
      supplyVoltage: circuit.supplyVoltage,
      componentCount: (circuit.components || []).length,
      validation,
      topology,
      invariants,
      asserts,
      layoutError,
      board: layout?.board ?? null,
      traces: layout?.traces.length ?? 0,
      vias: layout?.vias.length ?? 0,
      routing: layout?.routing ?? null,
      drc: layout?.drc ?? null,
      connectivity: layout?.connectivity ?? null,
    }, null, 2));
    return pass ? 0 : 1;
  }

  const out = [];
  const verdict = (name, ok, detail) => out.push(`${pad(name, 13)}${ok ? 'ok  ' : 'FAIL'}  ${detail}`);

  verdict('validate', validation.ok && validation.warnings.length === 0,
    `${validation.errors.length} errors, ${validation.warnings.length} warnings`);
  for (const error of validation.errors) out.push(`               ! ${error}`);
  // Zero warnings matters: "net touches only one pin" means a part is dangling.
  for (const warning of validation.warnings) out.push(`               ! ${warning}`);

  verdict('topology', topology.ok, `${topology.violations.length} violations`);
  for (const violation of topology.violations) {
    out.push(`               ! ${violation.id}: ${violation.message || ''} ${violation.refs ? `[${violation.refs}]` : ''}`.trimEnd());
  }

  if (layoutError) {
    out.push(`${pad('board', 13)}FAIL  ${layoutError}`);
  } else if (layout) {
    const { width, height } = layout.board;
    out.push(`${pad('board', 13)}      ${width} x ${height} mm, `
      + `${circuit.components.length} components, ${layout.traces.length} traces, ${layout.vias.length} vias`);
    verdict('routing', layout.routing.complete,
      layout.routing.complete ? 'complete' : `failed nets: ${layout.routing.failedNets.join(', ')}`);
    verdict('drc', layout.drc.ok, `${layout.drc.violations.length} violations`);
    for (const violation of layout.drc.violations.slice(0, 10)) {
      out.push(`               ! ${violation.type}: ${violation.message || JSON.stringify(violation)}`);
    }
    verdict('connectivity', layout.connectivity.ok,
      layout.connectivity.ok ? 'ok' : `incomplete: ${layout.connectivity.incompleteNets.join(', ')}`);
  }

  if (!quiet) {
    const table = pinTable(circuit);
    if (table.length) {
      out.push('', 'PIN ASSIGNMENT  (no gate above checks this — only pin count is validated)', '');
      out.push(table.join('\n\n'));
    }
  }

  if (invariants.length) {
    out.push('', 'INVARIANTS', '');
    for (const finding of invariants) {
      out.push(`  ${finding.fail ? 'FAIL' : 'note'}  ${finding.ref}: ${finding.message}`);
    }
  }

  if (asserts.length) {
    out.push('', 'ASSERTIONS', '');
    for (const assertion of asserts) {
      out.push(`  ${assertion.ok ? 'ok  ' : 'FAIL'}  ${assertion.expression}   (${assertion.detail})`);
    }
  }

  out.push('', `VERDICT: ${pass ? 'PASS' : 'FAIL'}`);
  console.log(out.join('\n'));
  return pass ? 0 : 1;
};

process.exit(main());
