# Building circuit JSON

You turn a circuit request into a JSON circuit that a placer, router and
design-rule checker accept. This file is the whole procedure. Repository
operations — installing, running the app, project layout — are in README.md and
are not your concern here.

## The output

One JSON object. Two parts sharing a net name are connected; that is the only
wiring mechanism.

```json
{
  "title": "Dual LED blinker — 2 s and 2.5 s (555 astable x2)",
  "supplyVoltage": 9,
  "components": [
    { "ref": "V1", "kind": "voltage_source", "value": "9V",    "nodes": ["VCC", "0"] },
    { "ref": "R1", "kind": "resistor",       "value": "3k",    "nodes": ["VCC", "DISCH1"] },
    { "ref": "U1", "kind": "timer_555",      "value": "NE555",
      "nodes": ["0", "CT1", "OUT1", "VCC", "CTRL1", "CT1", "DISCH1", "VCC"] }
  ]
}
```

| Field | Rule |
|-------|------|
| `title` | Free text. Say what it is and the key parameter. |
| `supplyVoltage` | **Top-level number.** This is what validation checks. A `voltage_source` with `value: "9V"` does *not* satisfy it. |
| `ref` | Must start with the kind's `spice_prefix`. Several are counterintuitive — a `buzzer` and a `pushbutton` are both `R`. |
| `kind` | Exact string from the component index. |
| `value` | String. Grammar differs per kind. |
| `nodes` | Net names **in the kind's pin order**. Ground is `"0"`, never `"GND"`. Unused pins take `"NC_<REF>_<pinNumber>"`. |

## Reference material

```
knowledge/components/README.md   index of every kind, with pin orders
knowledge/components/<kind>.md   pin contract, value grammar, wiring, gotchas
knowledge/patterns/              reusable blocks with design equations
src/core/                        the engine you verify against
```

Paths are written as they sit in the repository. If the engine and reference are
mounted elsewhere, the layout is the same — `src/core` is dependency-free, so it
runs under plain `node` with no install and no build step.

Component frontmatter (`kind`, `pins`, `pin_order`, `spice_prefix`) is generated
from the engine, so it matches what the validator accepts. Prose is
hand-written; it is trusted but not machine-checked.

---

# The procedure

## 1. Resolve the ambiguity, out loud

"Blinks every 5 s" is a 5-second *period*; "5 Hz" is a rate. They differ by 25×.
Pick the reading a careful engineer would, state it in one line, and continue —
do not stop and ask unless both readings are plausible and expensive to get
wrong.

## 2. Look for a pattern before inventing a topology

Read `knowledge/patterns/README.md`. If a pattern covers the request,
instantiate it. Its equations are checked arithmetic; your recall is not.
"Blink an LED" is always a 555 astable.

Free-form design degrades fast: 8 components have ~28 possible pin-pair
relationships, 40 components have ~780. Composition of known blocks is the only
approach that survives scale.

## 3. Open the page for every multi-pin part, and copy `pin_order` verbatim

**This is the step that matters most.** For 62 of 78 kinds, `nodes` is
positional and its order carries the entire electrical meaning. Copy the array
from the component file. Never type it from memory.

Three-pin sensors have no shared convention — `hall_sensor` is `[VCC, GND, OUT]`
while `ir_receiver` is `[OUT, GND, VCC]`, an exact reversal. Reusing a node array
between them swaps power and ground.

Two-pin passives (`resistor`, `capacitor`) have no order to get wrong. Polarised
two-pin parts (`led`, `diode`, electrolytics) do.

## 4. Solve component values numerically — do not hand-pick

Write a script. Search the E24 grid, filter by error, rank by a secondary
criterion, and print the winners. Hand-picking finds a value that works; a search
finds the value that is *best* and proves the rest were worse.

```js
const E24 = [1.0,1.1,1.2,1.3,1.5,1.6,1.8,2.0,2.2,2.4,2.7,3.0,3.3,3.6,3.9,
             4.3,4.7,5.1,5.6,6.2,6.8,7.5,8.2,9.1];
const vals = []; for (const d of [1e3, 1e4]) for (const m of E24) vals.push(m * d);

for (const r1 of vals) for (const r2 of vals) {
  const T = 0.693 * (r1 + 2 * r2) * C;          // 555 astable period
  const duty = (r1 + r2) / (r1 + 2 * r2);
  if (Math.abs(T - target) / target < 0.006 && duty < 0.62) out.push({ r1, r2, T, duty });
}
out.sort((a, b) => Math.abs(a.duty - 0.5) - Math.abs(b.duty - 0.5));
```

Non-E24 values are not purchasable and raise `non_standard_resistor`. Report the
achieved value and its error, not the target: **2.010 s (0.49% error)**, not
"2 s".

## 5. Check the rules that apply to your part set

Before writing the JSON, scan the gotchas of the parts you chose for rules that
fire on *combinations*. Two analog ICs on one rail need a decoupling capacitor
(`missing_supply_decoupling`). An LED needs a series resistor
(`led_no_series_resistor`). A motor needs a flyback diode
(`missing_flyback_diode`). A button needs a pull resistor (`pushbutton_no_pull`).

Adding these up front is faster than discovering them in step 7.

## 6. Write the JSON

Give nets meaningful names (`CT1`, `DISCH1`, `LED1A`), and suffix them per stage
when a circuit has repeated blocks so the stages stay independent.

## 7. Verify by running it — never by inspection

```js
import { validateCircuit } from './src/core/pcbGenerator.js';
import { checkCircuitTopology } from './src/core/topologyRules.js';
import { buildPcbLayout } from './src/core/pcbLayout.js';

const validation = validateCircuit(circuit);      // schema, refs, supply
const topology   = checkCircuitTopology(circuit); // 28 design rules
const layout     = buildPcbLayout(circuit);       // place → route → pour → DRC
```

The engine is dependency-free, so `node` runs this directly with no build step.
Done means all five are clean:

```
validateCircuit  → { ok: true, errors: [], warnings: [] }
topology         → { ok: true, violations: [] }
routing          → { complete: true, failedNets: [] }
drc              → { ok: true, violations: [] }
connectivity     → { ok: true, incompleteNets: [] }
```

**Zero warnings matters.** A warning that a net touches only one pin means a part
is not actually wired.

On failure, read the real error and grep for the string that produced it:

```bash
grep -rn "Supply voltage must be positive" src/core/
```

That finds the condition, not a guess about it.

## 8. Verify what the checks cannot see

**The gates do not check pin assignment — only pin count.** A 555 with `TRIG`
and `THRES` swapped validates clean, routes clean, passes DRC and exports
fab-ready Gerbers for a circuit that does not oscillate.

So assert the assignment yourself, against the documented contract:

```js
const PINS = ['GND','TRIG','OUT','RESET','CTRL','THRES','DISCH','VCC'];
const pads = layout.components.find((c) => c.ref === 'U1').pads;
pads.forEach((p, i) => console.log(PINS[i], '->', p.net));
// then assert the topology's own invariants:
//   astable 555 → nodes[1] === nodes[5]  (TRIG tied to THRES)
//                 nodes[3] === 'VCC'     (RESET high)
```

Add the invariants that matter for your topology. This is the only check that
catches the highest-frequency failure in this domain.

## 9. Report evidence, not claims

Hand back the JSON *and* the verdict: board size, component count, trace and via
counts, and the five verdicts above. "Here is a circuit" is not a result. "Here
is a board that routes complete with clean DRC" is.

Report achieved values with their error, and state any assumption you made in
step 1.

---

# When a part does not exist

Search aliases first — parts are often filed under a generic name (`555` is
`timer_555`, `LDR` is `photoresistor`, `op-amp` is `opamp`).

```bash
grep -ril "<the name>" knowledge/components/
```

If it is genuinely absent, **do not silently substitute.** Either build it from
parts that exist (a missing comparator is an `opamp` open-loop; a missing driver
is a `bjt_npn` plus base resistor and flyback diode) and say so, or propose a new
component file with `status: proposed` and state plainly that the circuit cannot
be built until it is promoted. A `proposed` kind fails validation by design.

See `knowledge/prompts/add-a-component.md`.

---

# What verification does not catch

- **Pin assignment on fixed-pin parts.** Only count is checked. See step 8.
- **Whether your values are right.** Nothing simulates your arithmetic.
- **Inter-module voltage hazards.** `voltage_domain_overdrive` only treats MCU
  pins as drivers, so a 5 V module driving a 3.3 V MCU input passes clean.
- **Floating comparator inputs.** `opamp_input_floating` covers `opamp` and
  `ua741` only.
- **Seven-segment series resistors.** `led_no_series_resistor` does not walk
  `seven_segment` legs.

DRC answers "can this be manufactured", not "does this work".

# Known engine defects

Do not design around these; recognise them so you do not misread the output.

| Defect | Symptom |
|--------|---------|
| Regulator value parsed as part number | `AMS1117-3.3` → **1117 V**, `7805` → **7805 V**, in both the SPICE deck and the topology rules. A correct 3.3 V LDO feeding an ESP32 raises a false `pullup_exceeds_domain` error. Write `value: "3.3V"` to avoid it. |
| `switch_spdt` pin order contradicts itself | The documented contract says `nodes[0]` is the common pole; the simulator and SPICE export both use `nodes[1]`. Wire index 1 as the pole if behaviour matters. |
| `i2c_missing_pullups` false positive | Fires on `rfid_reader`'s SPI chip-select because the pin is named `SDA`. Correct wiring, spurious warning. |
| Schematic router fails on some valid circuits | A 555 astable with a `CTRL` capacitor, and some MCU circuits, throw `DiagramLayoutError`. The **board** router handles them fine; callers fall back to a coarse diagram. Not your bug. |
