# Build a circuit

The loop for turning a request into verified circuit JSON.

## 1. Orient before designing

Read [../components/README.md](../components/README.md) — one scan tells you
which parts exist and which have a written page. Then check
[../patterns/README.md](../patterns/README.md): if a pattern covers the request,
instantiate it instead of inventing a topology. Its equations are checked
arithmetic; your recall is not.

If the part you want is not in the index, read
[add-a-component.md](add-a-component.md) before substituting something else.

## 2. Open the page for every multi-pin part you use

**Copy `pin_order` from the component's file. Do not recall it.** For 62 of the
78 kinds, `nodes` is a positional array whose order carries the entire meaning,
and a wrong order produces a circuit that validates clean, routes clean, passes
DRC, and does not work. This is the single highest-frequency failure.

Two-pin passives (`resistor`, `capacitor`) have no order to get wrong. Polarised
two-pin parts (`led`, `diode`, electrolytics) do.

## 3. Write the circuit

```json
{
  "title": "...",
  "supplyVoltage": 9,
  "components": [
    { "ref": "R1", "kind": "resistor", "value": "10k", "nodes": ["VCC", "OUT"] }
  ]
}
```

- `ref` must start with the kind's `spice_prefix` — `R1`, `C3`, `D1`, `U1`.
- `kind` is the exact string from the index.
- Ground is `"0"`. Not `"GND"`.
- `supplyVoltage` is a **top-level number** and is what validation checks. A
  `voltage_source` with `value: "9V"` does not satisfy it.
- Unused pins take `"NC_<REF>_<pinNumber>"`.
- Two parts sharing a net name are connected. That is the only wiring mechanism.

## 4. Verify by running it — never by inspection

```js
import { validateCircuit } from './src/core/pcbGenerator.js';
import { checkCircuitTopology } from './src/core/topologyRules.js';
import { buildPcbLayout } from './src/core/pcbLayout.js';

console.log(validateCircuit(circuit));        // schema + refs + supply
console.log(checkCircuitTopology(circuit));   // 28 design rules
const layout = buildPcbLayout(circuit);       // place → route → pour → DRC
console.log(layout.routing, layout.drc, layout.connectivity);
```

Write a throwaway script and run it. `src/core` is dependency-free, so `node`
runs it directly with no build step.

Done means all four are clean:

```
validateCircuit  → { ok: true, errors: [], warnings: [] }
topology         → { ok: true, violations: [] }
routing          → { complete: true, failedNets: [] }
drc              → { ok: true, violations: [] }
connectivity     → { ok: true, incompleteNets: [] }
```

**Zero warnings matters.** A warning that a net touches only one pin means a part
is not actually wired.

## 5. Report the evidence, not the claim

Hand back the JSON *and* the verdict — board size, component count, trace and via
counts, and the four verdicts above. "Here is a circuit" is not a result. "Here
is a board that routes complete with clean DRC" is.

## What the checks will not catch

- **Wrong pin assignment on a fixed-pin part.** Only node *count* is validated.
- **Values that are plausible but wrong.** Nothing simulates your maths.
- Getting these right is on you, which is why steps 1 and 2 exist.

## Known gaps

- The schematic router fails on some circuits the board router handles (a 555
  astable with a `CTRL` cap; some MCU circuits). Callers fall back to a coarse
  diagram. Not your bug — do not redesign around it.
