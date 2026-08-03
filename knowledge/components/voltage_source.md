---
kind: voltage_source
label: "Voltage source"
category: source
pins: 2
pin_order: null
pin_order_source: none
spice_prefix: V
aliases: [battery, dc source, power supply, vcc]
preferred_values: [3.3V, 5V, 9V, 12V]
status: core
---

# Voltage source

The DC supply for the circuit — a battery, a bench supply, a wall adapter. Every
circuit needs one unless you are deliberately building multiple rails.

## Pin contract

Two nodes. **The order is significant even though `pin_order` is `null` above:**

| # | Pin | Role |
|---|-----|------|
| 1 | positive | The rail. Name it `VCC`, `VIN`, `+5V` — whatever the circuit calls it. |
| 2 | negative | Ground. Almost always `"0"`. |

This ordering is in neither `fixedPins` nor `ROLE_PINS`, so nothing regenerates
it and no validation rule enforces it. It is real regardless: `topologyRules.js`
reads `nodes[0]` as the net this part energises when working out which nets are
supply rails. Reverse them and the voltage-domain rules silently reason about
the wrong net.

## Value

The rail voltage as a string with a unit: `"5V"`, `"9V"`, `"3.3V"`.

**This is not the same as the circuit's `supplyVoltage` field.** `value` is
documentation on the part; `supplyVoltage` is a top-level number on the circuit
and is what `validateCircuit` actually checks. Omitting it fails validation:

```
{"ok":false,"errors":["Supply voltage must be positive."]}
```

Set both, and keep them consistent.

## Wiring rules

- One per circuit, in the ordinary case.
- The negative terminal goes to `"0"`. A circuit with no `"0"` node anywhere
  fails validation with `No ground node was generated.`
- The positive net must reach at least one other part, or you get an
  `orphan_supply` topology violation.

## Worked example

```json
{ "ref": "V1", "kind": "voltage_source", "value": "9V", "nodes": ["VCC", "0"] }
```

with `"supplyVoltage": 9` set on the circuit object.

## Gotchas

- **`supplyVoltage` is the field that validates, not `value`.** Setting only
  `value: "9V"` is the likeliest reason a well-formed circuit gets rejected.
- Ground is the string `"0"`, not `"GND"`. `"GND"` is treated as an ordinary net
  name and will not connect to anything expecting ground.
