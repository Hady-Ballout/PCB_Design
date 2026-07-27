# Impedo Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make generated circuits trustworthy — every class of defect found in `Impedo_Test_Cases.md` gets a deterministic check, the checks actually gate generation, and the report the user reads tells the truth — in a way that generalizes to test cases not yet written.

**Architecture:** Impedo already has the right skeleton: a pure, shared rule engine (`src/core/topologyRules.js` — 19 rules, severities, auto-fixes, AI-correction composer) and a connectivity verifier (`verifyBoardConnectivity`). Two wiring gaps neutralize it: the live 3-stage pipeline (`server/ai/circuitPipeline.ts`, used by `server/index.ts`) never feeds rule violations back to the AI as corrections (only the legacy `ollamaProvider.ts` path does), and the breadboard debug report (`breadboardDescription.js`) never prints rule findings, so its `WARNINGS: (none)` line is a false "all clear". This plan (0) makes the report honest, (1) re-arms the deterministic gate in the live pipeline, (2) adds the missing netlist-semantic rules, (3) adds a new physical-realizability checker over the placed board model, (4) fixes package-fidelity bugs (op-amp DIP pinout, module placement), (5) makes the pipeline confess dropped parts, and (6) defines the protocol for turning future test cases into fixtures.

**Tech Stack:** JavaScript (ESM) in `src/`, TypeScript in `server/`, Vitest (`npm test -- <file>`), no new dependencies.

## Global Constraints

- Rules must be conservative: a false positive burns a generation retry and erodes trust; every rule skips ambiguous topologies (doctrine stated at `src/core/topologyRules.js:14`).
- Error-severity violations gate generation; warnings surface but never block.
- New rule = one entry in `TOPOLOGY_RULES` + a bug/fixed fixture pair in `topologyRules.test.js` (existing convention).
- `src/core/` stays plain JS with hand-maintained `.d.ts` files — update `topologyRules.d.ts` when exports change.
- Rule `check` crashes are swallowed by `checkCircuitTopology`'s try/catch — tests must therefore assert the violation fires, never rely on a crash.
- Run tests with `npm test -- <path>` (resolves to `vitest run --configLoader runner`).
- Per project practice, update `docs/*.md` in the same commit as any non-trivial code change (`docs/AI_AND_CIRCUIT_MODEL.md` for rules/pipeline, `docs/FRONTEND.md` for breadboard modules, `docs/OPERATIONS.md` for env vars).
- Do not revive deferred scope (esp32/raspberry_pi emulation, sd_card FAT) — placement reclassification in Phase 4 is fine, emulation is not.
- Test-case coverage map at the bottom of this file must stay accurate if tasks are edited.

---

## Phase 0 — Truthful reporting (the report the campaign reads must carry the findings)

### Task 1: Print design-rule findings in the breadboard debug description

**Files:**
- Modify: `src/features/realisticSchematic/breadboardDescription.js`
- Test: `src/features/realisticSchematic/breadboardDescription.test.js`

**Interfaces:**
- Consumes: `checkCircuitTopology(circuit)` → `{ ok, violations: [{ id, severity, refs, nets, message, fix, autoFixed }] }` from `src/core/topologyRules.js` (already exported).
- Produces: `describeBreadboard(circuit, model)` output gains a `== DESIGN RULE FINDINGS ==` section; signature unchanged.

- [ ] **Step 1: Write the failing test**

Append to `breadboardDescription.test.js` (reuse the file's existing circuit/model builders for a minimal LED circuit):

```js
describe('design rule findings section', () => {
  it('prints topology violations with severity tags', () => {
    // led with no series resistor: source -> LED -> ground
    const circuit = {
      title: 'bare led', type: 'test', supplyVoltage: 5,
      nodes: ['VCC', '0'],
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'], footprint: '' },
        { ref: 'D1', kind: 'led', value: 'red', nodes: ['VCC', '0'], footprint: '' },
      ],
    };
    const model = buildBreadboardModel(circuit); // same helper the other tests use
    const text = describeBreadboard(circuit, model);
    expect(text).toContain('== DESIGN RULE FINDINGS ==');
    expect(text).toContain('[error] led_no_series_resistor');
    expect(text).not.toMatch(/== DESIGN RULE FINDINGS ==\n\(none\)/);
  });

  it('prints (none) when no rules fire', () => {
    const circuit = {
      title: 'clean', type: 'test', supplyVoltage: 5,
      nodes: ['VCC', 'MID', '0'],
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'], footprint: '' },
        { ref: 'R1', kind: 'resistor', value: '330', nodes: ['VCC', 'MID'], footprint: '' },
        { ref: 'D1', kind: 'led', value: 'red', nodes: ['MID', '0'], footprint: '' },
      ],
    };
    const text = describeBreadboard(circuit, buildBreadboardModel(circuit));
    expect(text).toMatch(/== DESIGN RULE FINDINGS ==\n\(none\)/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/features/realisticSchematic/breadboardDescription.test.js`
Expected: FAIL — output does not contain `== DESIGN RULE FINDINGS ==`.

- [ ] **Step 3: Implement**

In `breadboardDescription.js`, add the import and a section between the connectivity check and the warnings block:

```js
import { checkCircuitTopology } from '../../core/topologyRules.js';
```

```js
  push('== DESIGN RULE FINDINGS (netlist-level, invisible to connectivity) ==');
  let findings = [];
  try {
    findings = checkCircuitTopology(circuit).violations;
  } catch { /* a rule crash must never break the report */ }
  if (!findings.length) push('(none)');
  findings.forEach((entry) => {
    const tag = entry.autoFixed ? 'auto-fixed' : entry.severity;
    push(`- [${tag}] ${entry.id}: ${entry.message}`);
    if (entry.fix && !entry.autoFixed) push(`  fix: ${entry.fix}`);
  });
  push();
```

Also reword the connectivity OK line so "OK" stops overclaiming:

```js
    push('OK: wiring matches the netlist (this checks connectivity only — see DESIGN RULE FINDINGS and WARNINGS for everything else).');
```

- [ ] **Step 4: Run tests**

Run: `npm test -- src/features/realisticSchematic/breadboardDescription.test.js`
Expected: PASS (fix any existing snapshot-style assertions that matched the old OK wording).

- [ ] **Step 5: Commit** (include a `docs/FRONTEND.md` line describing the new report section)

```bash
git add src/features/realisticSchematic/breadboardDescription.js src/features/realisticSchematic/breadboardDescription.test.js docs/FRONTEND.md
git commit -m "feat: include topology rule findings in the breadboard debug report"
```

### Task 2: Stop describing off-board modules as seated parts

**Files:**
- Modify: `src/features/realisticSchematic/breadboardDescription.js`
- Test: `src/features/realisticSchematic/breadboardDescription.test.js`

**Interfaces:**
- Consumes: `model.parts[].meta.slot` (set by `buildBreadboardModel` for off-board parts, see `breadboardModel.js:688`).

TC2/TC4/TC7 reviews repeatedly misread Uno/Pi flying-lead holes as a seated body ("U1 on bottom strip is geometrically incoherent"). The report must label them.

- [ ] **Step 1: Write the failing test** — build a model containing an `arduino_uno`; assert the part line reads `[off-board module — flying leads]` and does not contain `on bottom strip` / `on top strip`.

```js
it('labels off-board modules instead of claiming a strip', () => {
  const circuit = {
    title: 'uno', type: 'test', supplyVoltage: 5,
    nodes: ['VCC', 'MID', '0'],
    components: [
      { ref: 'U1', kind: 'arduino_uno', value: 'arduino_uno', footprint: '',
        nodes: ['VCC', ...Array.from({ length: 22 }, (_, i) => `NC_U1_${i + 2}`), '0'].slice(0, 24) },
      { ref: 'R1', kind: 'resistor', value: '330', nodes: ['VCC', 'MID'], footprint: '' },
      { ref: 'D1', kind: 'led', value: 'red', nodes: ['MID', '0'], footprint: '' },
    ],
  };
  const text = describeBreadboard(circuit, buildBreadboardModel(circuit));
  expect(text).toMatch(/U1\s+arduino_uno.*\[off-board module — flying leads\]/);
});
```

(Adjust the Uno's `nodes` so `5V` maps to `VCC` and `GND` to `0` per `FIXED_PIN_NAMES.arduino_uno` order: index 0 = `5V`, index 2 = `GND`.)

- [ ] **Step 2: Run** — expected FAIL (current output says `on <strip> strip`).
- [ ] **Step 3: Implement** in the `Parts:` loop:

```js
  (model?.parts ?? []).forEach((part) => {
    const value = part.value ? ` ${part.value}` : '';
    const where = part.meta?.slot
      ? '[off-board module — flying leads]'
      : `[${part.body}] on ${part.strip} strip`;
    push(`  ${part.ref}  ${part.kind}${value}  ${where}`);
```

- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit**

```bash
git add src/features/realisticSchematic/breadboardDescription.js src/features/realisticSchematic/breadboardDescription.test.js
git commit -m "fix: report off-board modules as flying-lead parts, not seated bodies"
```

---

## Phase 1 — Re-arm the deterministic gate in the live pipeline

### Task 3: Feed topology violations back into `runCircuitPipeline` as corrections + auto-fixes

**Files:**
- Modify: `server/ai/circuitPipeline.ts` (generator attempt loop, circa lines 520–610 where `validateCircuitResponse` succeeds)
- Test: `server/ai/circuitPipeline.test.ts`

**Interfaces:**
- Consumes: `checkCircuitTopology`, `composeTopologyCorrection`, `applySafeAutoFixes` from `../../src/core/topologyRules.js` (the legacy loop at `server/ai/ollamaProvider.ts:700-745` is the reference implementation to mirror).
- Produces: `runCircuitPipeline` result unchanged in shape; the returned circuit has error-severity violations either corrected by a retry or safe-auto-fixed; `server/index.ts:428`'s post-hoc check keeps running unchanged (surviving findings still reach the UI).

- [ ] **Step 1: Write the failing test.** In `circuitPipeline.test.ts`, following the file's existing mock-fetch pattern: first attempt returns a valid-schema circuit containing the named buzzer bug (copy the `esp32BuzzerBug` component list from `src/core/topologyRules.test.js`), second attempt returns the corrected topology. Assert:

```ts
expect(fetchMock).toHaveBeenCalledTimes(/* one more generator call than before */);
const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
const lastMessage = retryBody.messages.at(-1).content as string;
expect(lastMessage).toContain('functional design errors');
expect(lastMessage).toContain('divider_powered_load');
```

And a second test: when every attempt keeps an error violation but one is auto-fixable (`missing_flyback_diode` fixture from `topologyRules.test.js`), the returned circuit contains an added `DFB1` diode.

- [ ] **Step 2: Run** — `npm test -- server/ai/circuitPipeline.test.ts` — expected FAIL (no retry happens; no `DFB1`).
- [ ] **Step 3: Implement.** In the generator attempt loop, immediately after schema validation succeeds, mirror the legacy gate:

```ts
import { applySafeAutoFixes, checkCircuitTopology, composeTopologyCorrection } from '../../src/core/topologyRules.js';

// inside the attempt loop, after validateCircuitResponse passes:
const { violations } = checkCircuitTopology(circuit) as { violations: Array<{ severity: string }> };
const errorCount = violations.filter((entry) => entry.severity === 'error').length;
if (!best || errorCount <= best.errorCount) best = { circuit, code, errorCount, violations };
if (errorCount && attempt < MAX_ATTEMPTS - 1) {
  correction = { content, error: composeTopologyCorrection(violations as never) };
  continue;
}
```

After the loop (or on last attempt), apply safe fixes to the best candidate before handing to the reviewer stage:

```ts
const repaired = applySafeAutoFixes(best.circuit, best.violations as never) as { circuit: Circuit; applied: boolean };
const circuitForReview = repaired.applied ? repaired.circuit : best.circuit;
```

- [ ] **Step 4: Run the full server suite** — `npm test -- server/ai/circuitPipeline.test.ts` — expected PASS, no regressions in existing pipeline tests.
- [ ] **Step 5: Commit** (update `docs/AI_AND_CIRCUIT_MODEL.md`'s pipeline description — it currently documents this gate as existing; make the doc true).

```bash
git add server/ai/circuitPipeline.ts server/ai/circuitPipeline.test.ts docs/AI_AND_CIRCUIT_MODEL.md
git commit -m "feat: gate the live pipeline on topology rules with correction feedback and auto-fixes"
```

### Task 4: Harden the LLM reviewer prompt with the semantic checklist

**Files:**
- Modify: `server/ai/circuitPipeline.ts` (`REVIEWER_SYSTEM_PROMPT`, circa line 82)

No new test (prompt text); existing reviewer tests must stay green.

- [ ] **Step 1: Extend the reviewer checklist** with the failure classes the deterministic rules cannot express (these are exactly TC1's misses):

```
- Repeated stages (filter banks, LED arrays): verify the progression is monotonic and no stage duplicates another's values.
- Gain × input amplitude must fit within the supply rails with ~1.5V headroom on single-supply op amps.
- A "VU meter"/level detector needs a rectifier + RC envelope stage between filter output and LED, not a direct connection.
- Filter titles must match topology: a capacitor shunting a virtual-ground summing node contributes nothing — it is not a bandpass.
- Any AC-coupled input needs a series capacitor; bias networks need a bypass sized for the lowest signal frequency (corner = 1/(2π·R_source·C) well below f_min).
```

- [ ] **Step 2: Run** `npm test -- server/ai/circuitPipeline.test.ts` — expected PASS.
- [ ] **Step 3: Commit**

```bash
git add server/ai/circuitPipeline.ts
git commit -m "feat: teach the reviewer stage the analog semantic checklist from the test campaign"
```

---

## Phase 2 — New netlist-semantic rules

Every task in this phase follows the house pattern: fixture pair in `src/core/topologyRules.test.js` (bug fires / fixed stays silent), rule entry appended to `TOPOLOGY_RULES` in `src/core/topologyRules.js`, `topologyRules.d.ts` untouched (shape unchanged). One commit per rule. Use the existing `mcuPart`/`circuitOf` test helpers.

### Task 5: `voltage_domain_overdrive` (error) — the destroy-hardware rule

**Files:** Modify `src/core/topologyRules.js`; Test `src/core/topologyRules.test.js`

**Interfaces:**
- Produces: module-local `MAX_INPUT_VOLTS` and `SUPPLY_PIN_NAMES` — Task 6 reuses both.

- [ ] **Step 1: Failing tests** (TC7 and TC2 as fixtures):

```js
describe('voltage_domain_overdrive', () => {
  it('flags a 5V Uno pin driving a Pi GPIO (TC7)', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('arduino_uno', 'U1', { '5V': 'VCC5', GND: '0', D1: 'UART_TX' }),
      mcuPart('raspberry_pi', 'U3', { '5V': 'VCC5', GND: '0', GPIO9: 'UART_TX' }),
    ]));
    const hit = result.violations.find((entry) => entry.id === 'voltage_domain_overdrive');
    expect(hit).toBeDefined();
    expect(hit.severity).toBe('error');
    expect(hit.refs).toEqual(expect.arrayContaining(['U1', 'U3']));
    expect(hit.message).toContain('GPIO9');
  });
  it('flags Uno SPI pins into an RC522 (TC2)', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('arduino_uno', 'U1', { '3V3': 'VCC33', GND: '0', D11: 'MOSI_NET' }),
      { ref: 'U2', kind: 'rfid_reader', value: 'RC522',
        nodes: ['VCC33', 'NC_U2_2', '0', 'NC_U2_4', 'NC_U2_5', 'MOSI_NET', 'NC_U2_7', 'NC_U2_8'] },
    ]));
    expect(idsOf(result)).toContain('voltage_domain_overdrive');
  });
  it('stays silent when both ends share a 3.3V domain', () => {
    const result = checkCircuitTopology(circuitOf([
      mcuPart('esp32', 'U1', { '3V3': 'VCC33', GND: '0', GPIO5: 'MOSI_NET' }),
      { ref: 'U2', kind: 'rfid_reader', value: 'RC522',
        nodes: ['VCC33', 'NC_U2_2', '0', 'NC_U2_4', 'NC_U2_5', 'MOSI_NET', 'NC_U2_7', 'NC_U2_8'] },
    ]));
    expect(idsOf(result)).not.toContain('voltage_domain_overdrive');
  });
});
```

- [ ] **Step 2: Run** `npm test -- src/core/topologyRules.test.js` — expected FAIL (id absent).
- [ ] **Step 3: Implement.** Module-level additions:

```js
// 3.3V-only parts whose bare silicon is not 5V tolerant AND whose catalog
// entry already steers them to 3V3. Deliberately short: breakouts with onboard
// regulators/level circuitry (imu_sensor, oled_display, ...) stay out so the
// rule never false-positives on a tolerant module.
const MAX_INPUT_VOLTS = { raspberry_pi: 3.6, esp32: 3.6, rfid_reader: 3.6, mouse_sensor: 3.6 };
const SUPPLY_PIN_NAMES = new Set(['5V', '3V3', 'VIN', 'VCC', 'GND', 'VS', 'EN']);
```

Rule entry:

```js
  {
    // A push-pull 5V MCU output sharing a net with a pin of a 3.3V-only part:
    // first transition puts 5V on the pad. TC7 (Uno TX -> Pi GPIO) and TC2
    // (Uno SPI -> RC522) both die here.
    id: 'voltage_domain_overdrive',
    severity: 'error',
    check: (graph) => {
      const found = [];
      for (const [net, pins] of graph.netPins) {
        const driver = (graph.gpioNets.get(net) || [])
          .map((pin) => ({ ...pin, volts: MCU_LOGIC_VOLTS[pin.kind] || 3.3 }))
          .sort((a, b) => b.volts - a.volts)[0];
        if (!driver) continue;
        for (const pin of pins) {
          const max = MAX_INPUT_VOLTS[pin.kind];
          if (max == null || driver.volts <= max) continue;
          if (pin.ref === driver.ref || SUPPLY_PIN_NAMES.has(pin.pinName)) continue;
          found.push(violation(
            'voltage_domain_overdrive', 'error', [driver.ref, pin.ref], [net],
            `${driver.pinName} of ${driver.ref} drives ${driver.volts}V into ${pin.pinName} of ${pin.ref} (${kindLabel(pin.kind)}), which tolerates at most ${max}V — this can destroy the part.`,
            `Put a level shifter (or series resistor + divider) between ${driver.ref} ${driver.pinName} and ${pin.ref} ${pin.pinName}, or drive it from a 3.3V MCU pin.`,
          ));
        }
      }
      return found;
    },
  },
```

- [ ] **Step 4: Run** — expected PASS, whole file green.
- [ ] **Step 5: Commit** `git commit -m "feat(rules): voltage_domain_overdrive — flag 5V drivers on 3.3V-only pins"` (stage both files + `docs/AI_AND_CIRCUIT_MODEL.md` rules list; same pattern for every Phase 2 commit).

### Task 6: `pullup_exceeds_domain` (error)

**Files:** same pair.

**Interfaces:** Consumes `MAX_INPUT_VOLTS`, `SUPPLY_PIN_NAMES` from Task 5. Produces the module-local `buildNetVolts(graph, circuit)` helper (best-effort net→volts map).

- [ ] **Step 1: Failing test** — TC7's RPU1: `resistor 10k nodes ['UART_TX', 'VCC5']` added to the Task 5 TC7 fixture, plus a Pi on `UART_TX`; assert `pullup_exceeds_domain` fires naming `RPU1`. Silent fixture: same pull-up to a `VCC33` net (claimed 3.3 via an esp32 `3V3` pin).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** First the helper (module level):

```js
// Best-effort DC volts for nets that carry a known rail. Nets without a
// confident value are simply absent — consumers must treat missing as unknown.
const buildNetVolts = (graph, circuit) => {
  const volts = new Map();
  const claim = (net, value) => {
    if (!net || net === '0' || value == null) return;
    const existing = volts.get(net);
    if (existing == null || value > existing) volts.set(net, value);
  };
  for (const part of circuit.components) {
    const fixed = FIXED_PIN_NAMES[part.kind];
    if (MCU_KINDS.has(part.kind) && fixed) {
      if (fixed.indexOf('5V') >= 0) claim(String(part.nodes[fixed.indexOf('5V')] ?? ''), 5);
      if (fixed.indexOf('3V3') >= 0) claim(String(part.nodes[fixed.indexOf('3V3')] ?? ''), 3.3);
    }
    if (part.kind === 'voltage_source' || part.kind === 'solar_panel') claim(String(part.nodes[0] ?? ''), parseVolts(part.value, null));
    if (part.kind === 'regulator') claim(String(part.nodes[2] ?? ''), parseVolts(part.value, null));
    if (part.kind === 'buck_converter') claim(String(part.nodes[1] ?? ''), buckVolts(part.value));
  }
  return volts;
};
```

Then the rule:

```js
  {
    // A pull-up referencing a rail above the weakest device's input rating on
    // that net: the line idles at the destructive voltage even with every
    // driver tri-stated (TC7's RPU1 to 5V on a Pi net).
    id: 'pullup_exceeds_domain',
    severity: 'error',
    check: (graph, circuit) => {
      const netVolts = buildNetVolts(graph, circuit);
      const found = [];
      for (const part of circuit.components) {
        if (part.kind !== 'resistor' || (part.nodes ?? []).length !== 2) continue;
        const [a, b] = part.nodes.map(String);
        for (const [signalNet, railNet] of [[a, b], [b, a]]) {
          const rail = netVolts.get(railNet);
          if (rail == null) continue;
          for (const pin of pinsOn(graph, signalNet)) {
            const max = MAX_INPUT_VOLTS[pin.kind];
            if (max == null || rail <= max || SUPPLY_PIN_NAMES.has(pin.pinName)) continue;
            found.push(violation(
              'pullup_exceeds_domain', 'error', [part.ref, pin.ref], [signalNet],
              `${part.ref} pulls net "${signalNet}" up to ${rail}V, but ${pin.pinName} of ${pin.ref} (${kindLabel(pin.kind)}) tolerates at most ${max}V — the line idles at a destructive level.`,
              `Reference the pull-up to the ${max >= 3.3 ? '3.3V' : 'lower'} rail instead of "${railNet}", or remove it if both ends are push-pull.`,
            ));
          }
        }
      }
      return found;
    },
  },
```

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat(rules): pullup_exceeds_domain`.

### Task 7: `single_pin_net` (warning)

- [ ] **Step 1: Failing test** — TC2 fixture: Uno with `{'5V': 'VCC5'}` and nothing else on `VCC5` (plus a valid resistor+LED loop elsewhere so the circuit isn't empty); assert warning names `U1` and suggests the `NC_` rename. Silent case: same net with two members.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement:**

```js
  {
    // A net with exactly one member pin carries no current: either a missing
    // connection or a pin that should have been NC_<ref>_<n>. TC2's VCC5
    // claimed an entire power rail for a one-pin net.
    id: 'single_pin_net',
    severity: 'warning',
    check: (graph) => {
      const found = [];
      for (const [net, pins] of graph.netPins) {
        if (net === '0' || pins.length >= 2) continue;
        const pin = pins[0];
        found.push(violation(
          'single_pin_net', 'warning', [pin.ref], [net],
          `Net "${net}" connects only ${pin.pinName} of ${pin.ref} — a one-pin net is either a missing connection or a pin that should be marked unused.`,
          `Connect net "${net}" to its intended destination, or rename the node to NC_${pin.ref}_${pin.pinIndex + 1}.`,
        ));
      }
      return found;
    },
  },
```

- [ ] **Step 4: Run full file** — PASS **and fix any pre-existing fixtures that now trip the warning** by giving their loose ends `NC_` names (warnings don't flip `ok`, so only assertions on exact violation lists need touching). **Step 5: Commit** `feat(rules): single_pin_net`.

### Task 8: `orphan_supply` (warning)

- [ ] **Step 1: Failing test** — TC4 fixture: buck converter + inductor + catch schottky + output cap, output rail feeding nothing; Uno powered from a separate `VIN9` source. Assert `orphan_supply` names the buck. Silent case: add a jumpered load — the Uno's `5V` pin on the post-LC rail.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement:**

```js
  // Kinds that belong to a regulator's own filter, not to its load.
  const SUPPLY_FILTER_KINDS = new Set(['capacitor', 'inductor', 'schottky', 'diode', 'resistor']);
```

```js
  {
    // A complete regulator subcircuit whose output feeds nothing but its own
    // filter passives (TC4's dead LM2596). Conservative: any non-filter pin
    // downstream silences it.
    id: 'orphan_supply',
    severity: 'warning',
    check: (graph, circuit) => {
      const found = [];
      for (const part of circuit.components) {
        if (part.kind !== 'regulator' && part.kind !== 'buck_converter') continue;
        const outIndex = part.kind === 'regulator' ? 2 : 1;
        const outNet = String(part.nodes[outIndex] ?? '');
        if (!outNet || isUnconnectedTerminal(outNet, part.ref, outIndex + 1)) continue;
        const island = graph.reach(outNet, { skipRefs: [part.ref] });
        const consumer = [...island.nets]
          .flatMap((net) => pinsOn(graph, net))
          .find((pin) => pin.ref !== part.ref && !SUPPLY_FILTER_KINDS.has(pin.kind));
        if (!consumer) {
          found.push(violation(
            'orphan_supply', 'warning', [part.ref], [outNet],
            `${part.ref} (${kindLabel(part.kind)}) regulates net "${outNet}" but nothing consumes it — only its own filter parts sit downstream.`,
            `Feed a load from "${outNet}" (for example the MCU's supply input), or remove ${part.ref} and its filter parts.`,
          ));
        }
      }
      return found;
    },
  },
```

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat(rules): orphan_supply`.

### Task 9: `dead_active_device` (warning)

- [ ] **Step 1: Failing test** — TC7 fixture: esp32 with only `3V3`/`GND` wired (rest `NC_`), in a circuit with a working LED loop; assert the warning names `U2`. Silent cases: (a) esp32 with one GPIO on a signal net, (b) esp32 with every node `NC_` (fresh library part — precedent: `stepper_missing_driver`'s all-NC skip).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement:**

```js
  {
    // An MCU or wiring-only module whose only live connections are power and
    // ground: it participates in nothing (TC7's ESP32, TC1's Arduino).
    id: 'dead_active_device',
    severity: 'warning',
    check: (graph, circuit) => {
      const found = [];
      for (const part of circuit.components) {
        if (!MCU_KINDS.has(part.kind) && !WIRING_ONLY_KINDS.has(part.kind)) continue;
        const live = (part.nodes ?? [])
          .map((node, index) => ({ net: String(node), index }))
          .filter(({ net, index }) => net && !isUnconnectedTerminal(net, part.ref, index + 1));
        if (!live.length) continue; // fresh library part: stay silent
        const signals = live.filter(({ net }) => net !== '0' && !graph.supplyNets.has(net));
        if (!signals.length) {
          found.push(violation(
            'dead_active_device', 'warning', [part.ref], live.map(({ net }) => net),
            `${part.ref} (${kindLabel(part.kind)}) connects only to power and ground — no signal pin participates, so it does nothing in this circuit.`,
            `Wire ${part.ref}'s data/control pins into the circuit, or remove it.`,
          ));
        }
      }
      return found;
    },
  },
```

(Requires `WIRING_ONLY_KINDS` added to the import from `./componentKinds.js`.)

- [ ] **Step 4: Run** — PASS (existing fixtures with power-only MCUs may need one GPIO wired or the assertion widened — warnings never flip `ok`). **Step 5: Commit** `feat(rules): dead_active_device`.

### Task 10: `resistor_extreme_value` + `non_standard_resistor` (warnings)

- [ ] **Step 1: Failing tests** — TC6 fixture: `1G` and `0.001` divider → two `resistor_extreme_value` warnings; TC1 fixture: `250` → `non_standard_resistor` naming `240`; silent: `330`, `4.7k`, and an unparseable-but-excluded `fuse` value `1A`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement:**

```js
  const E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1];
```

```js
  {
    // Values the breadboard itself swamps: below contact resistance the board
    // IS the resistor; near insulation leakage the board bypasses it (TC6).
    id: 'resistor_extreme_value',
    severity: 'warning',
    check: (graph, circuit) => {
      const found = [];
      for (const part of circuit.components) {
        if (part.kind !== 'resistor' && part.kind !== 'load') continue;
        const ohms = parseResistance(part.value);
        if (ohms === null) {
          found.push(violation('resistor_extreme_value', 'warning', [part.ref], [],
            `${part.ref} has an unparseable resistance value "${part.value}".`,
            'Use a plain value such as "330", "4.7k", or "1Meg".'));
        } else if (ohms < 1) {
          found.push(violation('resistor_extreme_value', 'warning', [part.ref], [],
            `${part.ref} = ${part.value} is below breadboard contact resistance (~0.05–0.1Ω per contact) — the board dominates the value; milliohm parts need Kelvin connections.`,
            'Use ≥1Ω, or move the shunt off-board (the current_sensor kind models a proper shunt).'));
        } else if (ohms > 1e8) {
          found.push(violation('resistor_extreme_value', 'warning', [part.ref], [],
            `${part.ref} = ${part.value} approaches breadboard insulation leakage (~1e9Ω) — the board leaks more than the part conducts.`,
            'Keep resistances ≤100MΩ on a solderless board, or mount the part off-board with guarding.'));
        }
      }
      return found;
    },
  },
  {
    // Not purchasable: a value off the E24 grid (TC1's 250Ω). Warning only —
    // exact values are sometimes intentional.
    id: 'non_standard_resistor',
    severity: 'warning',
    check: (graph, circuit) => {
      const found = [];
      for (const part of circuit.components) {
        if (part.kind !== 'resistor') continue;
        const ohms = parseResistance(part.value);
        if (ohms === null || ohms < 1 || ohms > 1e8) continue; // resistor_extreme_value owns those
        const decade = 10 ** Math.floor(Math.log10(ohms));
        const mantissa = ohms / decade;
        const nearest = E24.reduce((best, step) => (Math.abs(step - mantissa) < Math.abs(best - mantissa) ? step : best), E24[0]);
        if (Math.abs(nearest - mantissa) / nearest > 0.02) {
          found.push(violation('non_standard_resistor', 'warning', [part.ref], [],
            `${part.ref} = ${part.value} is not an E24 standard value (nearest: ${nearest * decade}).`,
            `Use ${nearest * decade} unless the exact value is intentional.`));
        }
      }
      return found;
    },
  },
```

- [ ] **Step 4: Run** — PASS (existing fixtures use E24 values; adjust any that don't). **Step 5: Commit** `feat(rules): resistor value sanity (extreme + non-E24)`.

### Task 11: `buck_unreal_part_number` (warning)

- [ ] **Step 1: Failing test** — TC4 fixture: `buck_converter` value `LM2596-4.0` → warning listing real variants; silent: `LM2596-5.0`, `LM2596-3.3`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement:**

```js
  {
    // Only fixed LM2596 variants exist (3.3, 5.0, 12); anything else is the
    // ADJ part, which needs a feedback divider this model doesn't carry (TC4
    // generated an "LM2596-4.0").
    id: 'buck_unreal_part_number',
    severity: 'warning',
    check: (graph, circuit) => {
      const found = [];
      for (const part of circuit.components) {
        if (part.kind !== 'buck_converter') continue;
        const volts = buckVolts(part.value);
        if (volts === 3.3 || volts === 5 || volts === 12) continue;
        found.push(violation('buck_unreal_part_number', 'warning', [part.ref], [],
          `${part.ref} is "${part.value}" — LM2596 fixed-output variants are only -3.3, -5.0 and -12; a ${volts}V version is not a real part.`,
          'Pick LM2596-3.3, LM2596-5.0 or LM2596-12, or restate the requirement so a real fixed variant fits.'));
      }
      return found;
    },
  },
```

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat(rules): buck_unreal_part_number`.

### Task 12: `missing_supply_decoupling` (warning)

- [ ] **Step 1: Failing test** — TC1-shaped fixture: two opamps on one supply net, zero caps → warning listing both refs; silent: same plus one `capacitor 100n ['VCC', '0']`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement:**

```js
  const DECOUPLED_IC_KINDS = new Set(['opamp', 'comparator', 'timer_555', 'shift_register', 'adc_module']);
```

```js
  {
    // Two or more ICs sharing a rail with not one capacitor from any supply
    // net to ground (TC1: ten op amps, zero decoupling). One warning for the
    // whole board, not one per IC.
    id: 'missing_supply_decoupling',
    severity: 'warning',
    check: (graph, circuit) => {
      const ics = circuit.components.filter((part) => DECOUPLED_IC_KINDS.has(part.kind));
      if (ics.length < 2) return [];
      const decoupled = circuit.components.some((part) => {
        if (part.kind !== 'capacitor' || (part.nodes ?? []).length !== 2) return false;
        const [a, b] = part.nodes.map(String);
        const railSide = a === '0' ? b : b === '0' ? a : null;
        return railSide !== null && graph.supplyNets.has(railSide);
      });
      if (decoupled) return [];
      return [violation('missing_supply_decoupling', 'warning', ics.map((part) => part.ref), [],
        `${ics.length} ICs (${ics.map((part) => part.ref).join(', ')}) share the supply with no decoupling capacitor anywhere from a supply net to ground.`,
        "Add a 100nF capacitor across each IC's supply and ground pins, plus one 10µF bulk capacitor on the rail.")];
    },
  },
```

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat(rules): missing_supply_decoupling` — and close Phase 2 by updating the rule table in `docs/AI_AND_CIRCUIT_MODEL.md` with all eight new ids in one docs commit if not already staged per-task.

---

## Phase 3 — Physical realizability layer (new checker over the placed model)

### Task 13: Create `physicalChecks.js` — hole occupancy

**Files:**
- Create: `src/features/realisticSchematic/physicalChecks.js`
- Test: `src/features/realisticSchematic/physicalChecks.test.js` (new)

**Interfaces:**
- Consumes: the built model shape from `buildBreadboardModel` — `{ board, rails, nets: [{net, role}], parts: [{ref, kind, body, strip, holes, pinNets, meta}], jumpers: [{net, from, to}], batteries, warnings }`; holes are `{strip, row, column}` (rails use `strip: 'railTopPlus'` etc.).
- Produces: `checkPhysicalModel(model)` → `string[]` of issue messages, each prefixed with a class tag (`OCCUPANCY:`, `GEOMETRY:`, `RAIL-POLICY:`, `LEAD-SPAN:`). Tasks 14–16 extend this same function; Task 17 wires it into the model and report.

- [ ] **Step 1: Failing test** — hand-build a tiny model literal with two conductors on one hole (TC3's exact bug: a part pin and a jumper endpoint sharing `railTopPlus` col 9, same net):

```js
import { describe, expect, it } from 'vitest';
import { checkPhysicalModel } from './physicalChecks.js';

const hole = (strip, row, column) => ({ strip, row, column });

describe('occupancy', () => {
  it('flags two conductors in one hole even on the same net (TC3)', () => {
    const issues = checkPhysicalModel({
      parts: [{ ref: 'U2', kind: 'motor_driver', body: 'dip', strip: 'bottom',
        pinNets: ['VMOT'], holes: [hole('railTopPlus', 0, 9)] }],
      jumpers: [{ net: 'VMOT', from: hole('top', 1, 9), to: hole('railTopPlus', 0, 9) }],
      batteries: [], nets: [], rails: {},
    });
    expect(issues.some((line) => line.startsWith('OCCUPANCY:') && line.includes('U2.pin1'))).toBe(true);
  });
  it('is silent when every hole has one conductor', () => {
    const issues = checkPhysicalModel({
      parts: [{ ref: 'R1', kind: 'resistor', body: 'twoLead', strip: 'top',
        pinNets: ['A', 'B'], holes: [hole('top', 0, 2), hole('top', 0, 4)] }],
      jumpers: [], batteries: [], nets: [], rails: {},
    });
    expect(issues).toEqual([]);
  });
});
```

- [ ] **Step 2: Run** `npm test -- src/features/realisticSchematic/physicalChecks.test.js` — FAIL (module doesn't exist).
- [ ] **Step 3: Implement:**

```js
// Physical-realizability checks over a built breadboard model. Pure and
// standalone (no imports from breadboardModel.js, to stay cycle-free).
// verifyBoardConnectivity asks "does the wiring realize the netlist?"; these
// ask "can the wiring exist on real hardware?" — a distinction the test
// campaign proved matters: same-net collisions pass connectivity (TC3).

const GROUND = '0';
const isRail = (holeOrKey) => String(holeOrKey.strip ?? holeOrKey).startsWith('rail');
const holeKey = (hole) => `${hole.strip}:${hole.row ?? 0}:${hole.column}`;
const holeName = (hole) => (isRail(hole) ? `${hole.strip} col${hole.column}` : `${hole.strip} r${hole.row} c${hole.column}`);

export function checkPhysicalModel(model) {
  const issues = [];
  checkOccupancy(model, issues);
  return issues;
}

function checkOccupancy(model, issues) {
  const occupants = new Map();
  const claim = (holeAddr, label) => {
    if (!holeAddr) return;
    const key = holeKey(holeAddr);
    if (!occupants.has(key)) occupants.set(key, []);
    occupants.get(key).push({ label, holeAddr });
  };
  (model.parts ?? []).forEach((part) =>
    (part.holes ?? []).forEach((holeAddr, index) => claim(holeAddr, `${part.ref}.pin${index + 1}`)));
  (model.jumpers ?? []).forEach((jumper, index) => {
    claim(jumper.from, `jumper#${index + 1}`);
    claim(jumper.to, `jumper#${index + 1}`);
  });
  (model.batteries ?? []).forEach((battery) => {
    claim(battery.plusHole, `${battery.ref}.+`);
    claim(battery.minusHole, `${battery.ref}.-`);
  });
  occupants.forEach((entries) => {
    if (entries.length < 2) return;
    issues.push(`OCCUPANCY: hole ${holeName(entries[0].holeAddr)} holds ${entries.length} conductors (${entries.map((entry) => entry.label).join(', ')}) — one hole seats one lead, even on the same net.`);
  });
}
```

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat(physical): hole-occupancy check (checkPhysicalModel)`.

### Task 14: Rigid-part geometry checks

**Files:** same pair.

- [ ] **Step 1: Failing tests** — (a) TC3's U2: a >2-pin non-off-board part with pins on both a rail and a strip → `GEOMETRY:` issue "a rigid part cannot reach a power rail"; (b) a >2-pin part whose strip-hole columns are non-contiguous (gap) → `GEOMETRY:` issue; (c) silent for a clean 4-column DIP straddle and for any part with `meta.slot` (off-board).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement, called from `checkPhysicalModel`:**

```js
function checkRigidGeometry(model, issues) {
  (model.parts ?? []).forEach((part) => {
    if (part.meta?.slot) return; // off-board module: flying leads may go anywhere
    const holes = (part.holes ?? []).filter(Boolean);
    if (holes.length <= 2) return; // two-lead parts bend; Task 15 bounds their span
    const railHoles = holes.filter(isRail);
    if (railHoles.length) {
      issues.push(`GEOMETRY: ${part.ref} has ${railHoles.length} pin(s) on a power rail (${railHoles.map(holeName).join(', ')}) while its body sits in the terminal strips — a rigid package cannot reach the board edge; those pins need jumpers instead.`);
    }
    const columns = [...new Set(holes.filter((h) => !isRail(h)).map((h) => h.column))].sort((a, b) => a - b);
    if (columns.length && columns[columns.length - 1] - columns[0] + 1 !== columns.length) {
      issues.push(`GEOMETRY: ${part.ref}'s pins occupy non-contiguous columns (${columns.join(', ')}) — a rigid package has consecutive legs.`);
    }
  });
}
```

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat(physical): rigid-part geometry checks (rail reach, contiguity)`.

### Task 15: Two-lead span bound + rail net policy

**Files:** same pair.

- [ ] **Step 1: Failing tests** — (a) two-lead part spanning 6 columns (TC4's stretched electrolytic) → `LEAD-SPAN:` issue; silent at span ≤5; (b) `rails: { railTopPlus: 'SIG' }` with `nets: [{ net: 'SIG', role: 'signal' }]` → `RAIL-POLICY:` issue; silent for a `supply`-role net and for ground.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement:**

```js
const MAX_TWO_LEAD_SPAN_COLUMNS = 5; // ~12.7mm: past any axial body + sane lead bend

function checkTwoLeadSpans(model, issues) {
  (model.parts ?? []).forEach((part) => {
    if (part.meta?.slot) return;
    const holes = (part.holes ?? []).filter(Boolean);
    if (holes.length !== 2 || holes.some(isRail)) return;
    const span = Math.abs(holes[0].column - holes[1].column);
    if (span > MAX_TWO_LEAD_SPAN_COLUMNS) {
      issues.push(`LEAD-SPAN: ${part.ref} (${part.kind}) spans ${span} columns (${holeName(holes[0])} -> ${holeName(holes[1])}) — beyond a real part's lead reach; place the legs closer and bridge with a jumper.`);
    }
  });
}

function checkRailPolicy(model, issues) {
  const roleByNet = new Map((model.nets ?? []).map((entry) => [entry.net, entry.role]));
  Object.entries(model.rails ?? {}).forEach(([railKey, net]) => {
    if (net == null || net === GROUND) return;
    if (roleByNet.get(net) === 'supply') return;
    issues.push(`RAIL-POLICY: ${railKey} carries non-power net "${net}" — power rails are silkscreened red/blue and invite a 5V plug-in; route signals on the terminal strips.`);
  });
}
```

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat(physical): two-lead span bound and rail net policy`.

### Task 16: Board-seam awareness past full size

**Files:** same pair; also Modify `src/features/realisticSchematic/breadboardModel.js` (reuse its exported `FULL_SIZE_COLUMNS` value via a parameter, not an import — pass `model.board.columns`).

- [ ] **Step 1: Failing test** — model with `board: { columns: 190 }` → one `SEAM:` issue listing seam boundaries at columns 63 and 126 and instructing rail bridging; silent at 63.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (and add the `checkBoardSeams(model, issues)` call inside `checkPhysicalModel`, like Tasks 14–15 did for their checks):

```js
const FULL_SIZE_COLUMNS = 63; // mirror of breadboardGeometry's constant (kept literal to stay import-cycle-free)

function checkBoardSeams(model, issues) {
  const columns = model.board?.columns ?? 0;
  if (columns <= FULL_SIZE_COLUMNS) return;
  const seams = [];
  for (let seam = FULL_SIZE_COLUMNS; seam < columns; seam += FULL_SIZE_COLUMNS) seams.push(seam);
  issues.push(`SEAM: this layout is ${columns} columns — ${seams.length + 1} full-size boards butted together with seams after column(s) ${seams.join(', ')}. Every rail must be bridged with a jumper across each seam, and most boards also break their rails mid-board.`);
}
```

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat(physical): board seam warnings with explicit seam columns`.

### Task 17: Wire `checkPhysicalModel` into the model and the report

**Files:**
- Modify: `src/features/realisticSchematic/breadboardModel.js` (end of `buildBreadboardModel`, where the model object is assembled circa line 714)
- Modify: `src/features/realisticSchematic/breadboardDescription.js`
- Test: `src/features/realisticSchematic/breadboardModel.test.js`

- [ ] **Step 1: Failing test** — build a real model whose circuit forces board growth past 63 columns (many two-lead parts); assert `model.warnings` contains a `SEAM:` entry.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** — in `breadboardModel.js`, import `{ checkPhysicalModel }` from `./physicalChecks.js`; after the model object literal is built and before returning, run:

```js
  const physicalIssues = checkPhysicalModel(model);
  model.warnings.push(...physicalIssues);
```

(`physicalChecks.js` imports nothing from `breadboardModel.js`, so no cycle.) The description already prints `model.warnings`, so Task 1's report picks these up with no further change.

- [ ] **Step 4: Run the whole feature suite** — `npm test -- src/features/realisticSchematic` — PASS. Any pre-existing test that now surfaces a genuine physical issue in its fixture is a **finding, not a test bug**: fix the placement code or record it as a known issue in the commit message; do not silence the check.
- [ ] **Step 5: Commit** (update `docs/FRONTEND.md` module list)

```bash
git add src/features/realisticSchematic/physicalChecks.js src/features/realisticSchematic/physicalChecks.test.js src/features/realisticSchematic/breadboardModel.js src/features/realisticSchematic/breadboardModel.test.js src/features/realisticSchematic/breadboardDescription.js docs/FRONTEND.md
git commit -m "feat(physical): run realizability checks on every built model"
```

---

## Phase 4 — Package fidelity

### Task 18: Real LM358 DIP-8 pinout for opamp/comparator

**Files:**
- Modify: `src/features/realisticSchematic/breadboardModel.js:28` (`OPAMP_LEG_LAYOUT`)
- Test: `src/features/realisticSchematic/breadboardModel.test.js`

The current "virtual 741-style" layout puts canonical V+ (index 3) and V− (index 4) on DIP legs 4/5 — on a real LM358, pin 4 is GND and pin 8 is V+, so a literal build applies 5V to the ground pin and kills the chip (TC5's highest-severity finding). The leg-layout format already supports the correct mapping.

- [ ] **Step 1: Failing test** — build a model with one opamp (nodes `[INP, INN, OUT, VCC, 0]`); locate the part's holes and assert: canonical index 2 (OUT) sits at bottom-strip column offset 0 (DIP pin 1), index 4 (V−/GND) at bottom offset 3 (DIP pin 4), index 3 (V+) at top offset 0 (DIP pin 8), matching TC5's corrected placement table.
- [ ] **Step 2: Run** — FAIL (current layout: `bottom: [null, 1, 0, 4], top: [null, 3, 2, null]`).
- [ ] **Step 3: Implement:**

```js
// DIP-8 layout with the REAL LM358/LM393 pinout for the canonical 5-pin
// [IN+, IN-, OUT, V+, V-] contract, using section A: DIP pins 1-4 (OUT1,
// IN1-, IN1+, GND) left-to-right on the bottom strip, pin 8 (V+) at top
// offset 0. Pins 5-7 are the unused second section (see the spare-section
// warning in buildBreadboardModel).
const OPAMP_LEG_LAYOUT = { bottom: [2, 1, 0, 4], top: [3, null, null, null] };
```

Also add a spare-section warning where straddle parts finalize:

```js
    if (component.kind === 'opamp' || component.kind === 'comparator') {
      warnings.push(`${component.ref} uses section A of a dual package — tie the spare section (jumper DIP pin 6 to pin 7, pin 5 to ground) so it cannot oscillate.`);
    }
```

- [ ] **Step 4: Run** `npm test -- src/features/realisticSchematic` — PASS (update any test that asserted the old hole offsets; `partVisuals.js` draws by leg layout so it follows automatically — eyeball one render test snapshot if present).
- [ ] **Step 5: Commit** `fix(physical): real LM358 DIP-8 pinout — pin 4 is GND, pin 8 is V+`

### Task 19: Off-board placement must actually engage for module kinds

**Files:**
- Modify: `src/features/realisticSchematic/breadboardModel.js`
- Test: `src/features/realisticSchematic/breadboardModel.test.js`

`OFFBOARD_SLOT_HEIGHTS` already lists `rfid_reader` and `motor_driver`, yet TC2 shows an RC522 seated in strip holes and TC3 shows an L298N straddling with rail pins. Either the reports predate the table or a code path bypasses it — settle it with regression tests.

- [ ] **Step 1: Write the (possibly already-passing) regression tests** — for each of `rfid_reader`, `motor_driver`, `arduino_uno`: build a model containing the part plus an MCU; assert `part.meta.slot` is defined and **no** hole of the part lands in a terminal strip or rail (all connections via jumpers from the slot).
- [ ] **Step 2: Run.** If PASS: the TC2/TC3 reports predate the off-board table — record that in the commit message and keep the tests as regressions. If FAIL: trace which placement branch (`placeAnchored` / greedy Phase-2 / reserved-column pass, `breadboardModel.js:461-688`) seats the part on-board and make the `OFFBOARD_SLOT_HEIGHTS` lookup the first dispatch in every branch.
- [ ] **Step 3: Reclassify the ESP32 as an off-board module.** A real DevKit is ~0.9–1.0" wide and 15+ columns long — the 6-column e/f straddle is unbuildable (TC3, TC7). Remove `esp32` from `STRADDLE_PACKAGES` and `ESP32_WIDTH_COLUMNS`/`ESP32_LEG_LAYOUT`; add `esp32: MCU_SLOT_HEIGHT` to `OFFBOARD_SLOT_HEIGHTS` and add `'esp32'` to `OFFBOARD_MCU_KINDS`. Placement-only change: no emulation scope revived.
- [ ] **Step 4: Run** `npm test -- src/features/realisticSchematic` — PASS after updating tests that asserted the straddle placement.
- [ ] **Step 5: Commit** `fix(physical): modules and ESP32 DevKit place off-board with flying leads` (note in `docs/FRONTEND.md`).

---

## Phase 5 — Pipeline honesty & configuration

### Task 20: Confess dropped/unsupported parts instead of silently shrinking

**Files:**
- Modify: `server/ai/circuitPipeline.ts` (`validateCircuitResponse` circa line 313, attempt-loop correction handling, reply-stage prompt assembly)
- Test: `server/ai/circuitPipeline.test.ts`

TC4's root cause: unsupported kinds (`gps`, `sim800l`, `nrf24`) fail schema validation, the correction retry says "return a smaller complete response", and the model obliges by dropping them — while the title still promises a communication hub.

- [ ] **Step 1: Failing test** — mock attempt 1 returning a circuit containing `{ kind: 'gps_module' }`, attempt 2 a valid circuit without it. Assert the final result's `circuit.notes` contains a line matching `/gps_module.*not supported.*omitted/i` and the reply-stage request body mentions the dropped kind.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement:**

In `validateCircuitResponse`, name the kind in the error:

```ts
if (!allowedKinds.has(component.kind as string)) errors.push(`${label}.kind "${String(component.kind)}" is not supported`);
```

In the attempt loop, collect them:

```ts
const droppedKinds = new Set<string>();
// when schema_validation correction is composed:
for (const match of correctionErrorText.matchAll(/\.kind "([^"]+)" is not supported/g)) droppedKinds.add(match[1]);
```

After a successful attempt:

```ts
if (droppedKinds.size) {
  circuit.notes = [...(circuit.notes ?? []),
    ...[...droppedKinds].map((kind) => `Requested part "${kind}" is not supported by the component library and was omitted from this design.`)];
}
```

And append to the reply-stage user content: `Unsupported parts that were omitted and MUST be mentioned in the reply: ${[...droppedKinds].join(', ')}.`

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `fix(pipeline): surface unsupported parts dropped during correction retries`

### Task 21: Token budget must survive thinking mode

**Files:**
- Modify: `server/ai/circuitPipeline.ts:689` and `server/ai/ollamaProvider.ts:757`
- Test: `server/ai/ollamaProvider.test.ts` (extend the existing Z.ai request-shape test at circa line 844)

TC1 initially died with `finish_reason: length` because `ZAI_THINKING_TYPE=enabled` shares one 12k budget between reasoning and JSON.

- [ ] **Step 1: Failing test** — with `ZAI_THINKING_TYPE=enabled` and no `AI_MAX_TOKENS`, assert the request body's `max_tokens` is 30000; with thinking disabled, 12000; with explicit `AI_MAX_TOKENS`, that value wins.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** at both sites:

```ts
const zaiThinking = (process.env.ZAI_THINKING_TYPE || 'disabled') !== 'disabled';
// ...
max_tokens: positiveIntegerOption(process.env.AI_MAX_TOKENS, isZaiProvider(config.provider) ? (zaiThinking ? 30000 : 12000) : 4096),
```

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `fix(config): default max_tokens to 30000 when Z.ai thinking is enabled` (document both env vars in `docs/OPERATIONS.md`).

---

## Phase 6 — Future test-case protocol (what makes this generalize)

### Task 22: Campaign README + ledger

**Files:**
- Create: `Test Cases/README.md`

- [ ] **Step 1: Write the protocol file:**

```markdown
# Test Campaign Protocol

Every reviewed build follows the same loop:

1. Paste the app's debug description into the reviewer. Since the report now
   carries DESIGN RULE FINDINGS and physical WARNINGS, the reviewer's job is
   what the rules CANNOT see, not what they already caught.
2. For each new finding, answer one question first: **which deterministic
   check would have caught this?** Record it in the ledger below.
   - Netlist-shaped answer -> new entry in src/core/topologyRules.js
     (fixture pair in topologyRules.test.js).
   - Board-shaped answer -> new check in
     src/features/realisticSchematic/physicalChecks.js.
   - "No deterministic rule can" -> add it to the reviewer-stage checklist in
     server/ai/circuitPipeline.ts and note it as model-quality-bound.
3. A finding is CLOSED only when its fixture pair is committed and the rule
   fires on the bug fixture.

## Ledger

| # | Test case | Finding | Rule that catches it | Status |
|---|-----------|---------|----------------------|--------|
| 1 | TC7 | 5V TX into Pi GPIO | voltage_domain_overdrive | planned |
```

(Seed the ledger with every finding from `Impedo_Test_Cases.md` using the coverage map below.)

- [ ] **Step 2: Commit** `docs: test-campaign protocol and finding ledger`

---

## Coverage map (spec ↔ tasks self-review)

| Test-case finding | Task(s) |
|---|---|
| TC1 empty-warnings report despite known issues | 1 |
| TC1 band 10 duplicates band 6 / fake bandpass / gain clipping / no detector / bypass sizing | 4 (reviewer checklist — deterministic rules can't express these; model-quality-bound) |
| TC1 250Ω non-E24 | 10 |
| TC1 zero decoupling | 12 |
| TC1 dead Arduino / TC7 dead ESP32 | 9 |
| TC1 LM358 unbuildable footprint + wrong supply pins / TC5 pin-4-is-GND | 18 |
| TC1 190-column board, no seam info | 16 |
| TC1/TC4 signal nets on power rails | 15 |
| TC1 bands not tiled | **out of scope this plan** — subcircuit tiling is a placement-quality optimization, not a trust fix; revisit after Phase 4 |
| TC2 modules stacked on the same holes | 13, 19 |
| TC2 shredded header order | 14 (contiguity; strict header-order needs per-package pin maps — noted as the follow-up in Task 19's commit) |
| TC2 degree-1 net VCC5 railed | 7, 15 |
| TC2 no level shifting into RC522 | 5 |
| TC2/TC1 no local decoupling | 12 |
| TC3 same-net hole collisions | 13 |
| TC3 part pins on opposite board edges | 14 |
| TC3 L298N not breadboard-pluggable / wrong ESP32 footprint | 19 |
| TC3 ground return path length / rail continuity | 16 (seams); current-path length deferred with tiling |
| TC4 title promises parts the netlist lacks | 20 |
| TC4 orphan buck subcircuit | 8 |
| TC4 LM2596-4.0 not a real part | 11 |
| TC4 stretched electrolytic lead span | 15 |
| TC5 wrong DIP supply pins (destroys chip) | 18 |
| TC5 floating second section | 18 (warning) |
| TC6 femtovolt divider built without comment | 10 (extreme values) |
| TC7 5V into Pi GPIO + 5V pull-up | 5, 6 |
| TC7 GPIO9 isn't UART | 4 (reviewer checklist; deterministic peripheral-function map is a follow-up once pin-function data exists) |
| TC8 prompt injection — recorded only as "failed" | **blocked on detail from the user**: which direction did it fail? |
| Rules exist but don't gate the live pipeline | 3 |
| Token exhaustion with thinking enabled | 21 |

Execution order = task order; Phases 0–1 are the highest-leverage two days of the plan (they make every existing rule visible and binding before any new rule is written).
