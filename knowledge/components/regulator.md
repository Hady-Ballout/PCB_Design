---
kind: regulator
label: "Voltage regulator"
category: power
pins: 3
pin_order: [IN, GND, OUT]
pin_order_source: fixedPins
spice_prefix: V
aliases: [ldo, linear regulator, 7805, lm7805, ams1117]
status: core
---

# Voltage regulator

A linear regulator (7805-style, LDO, AMS1117, …) that turns an unregulated
input into a fixed, clean output rail. Simpler and quieter than a
[buck_converter.md](buck_converter.md), but wastes the voltage difference as
heat — reach for this when the input-to-output drop is small.

## Pin contract

`nodes` must list exactly 3 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `IN` | Unregulated input. |
| 2 | `GND` | Ground. Almost always `"0"`. |
| 3 | `OUT` | Regulated output rail. |

This is a `fixedPins` contract (`pin_order_source: fixedPins`,
`FIXED_PIN_NAMES.regulator` in `componentKinds.js`). `nodes[2]` specifically
is read as the regulated rail by `topologyRules.js` (it's added to
`supplyNets` and its voltage is claimed in `buildNetVolts`), so getting the
order right matters even though the part only has three physical legs.

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number or a bare voltage. The engine special-cases three
substrings, then falls back to "first number found in the string":

| Written | Parses as |
|---------|-----------|
| `"7805"`, `"LM7805"` | 5 V |
| `"7812"` | 12 V |
| `"7905"` | −5 V |
| `"3.3V"` | 3.3 V |

Everything else — including `"AMS1117-3.3"` — goes through
`firstNumber(value)`, which returns the **first digit run in the string**,
not the voltage after a dash. Verified directly against `regulatorVolts` in
`sim/simValues.js`:

```
regulatorVolts('AMS1117-3.3') === 1117   // NOT 3.3
regulatorVolts('7805')        === 5
regulatorVolts('3.3V')        === 3.3
```

The SPICE exporter's `regulatorVoltage` in `pcbGenerator.js` has the same
behavior. Unlike `buck_converter`'s value parser (which explicitly strips the
`LM25xx` part-number prefix first), the regulator parser has no such guard —
see Gotchas.

## Wiring rules

- `orphan_supply` (`id: 'orphan_supply'`, warning) applies to regulators too:
  if nothing but the regulator's own filter parts (capacitor, inductor,
  schottky/diode, resistor) sits downstream of `OUT`, it warns that the rail
  feeds nothing.
- No dedicated rule enforces input/output headroom for a linear regulator
  (unlike `buck_insufficient_headroom` for buck converters) — you are
  expected to know a linear regulator needs some minimum dropout voltage;
  nothing here checks it.
- Standard practice — not separately enforced by a rule, but sound
  engineering — is a small decoupling capacitor on both `IN` and `OUT`; see
  [capacitor.md](capacitor.md).

## Worked example

```json
{ "ref": "V2", "kind": "regulator", "value": "7805", "nodes": ["VIN", "0", "VOUT"] },
{ "ref": "C4", "kind": "capacitor", "value": "100nF", "nodes": ["VIN", "0"] },
{ "ref": "C5", "kind": "capacitor", "value": "100nF", "nodes": ["VOUT", "0"] }
```

## Gotchas

- **Use `"7805"`/`"LM7805"`/`"7812"`/`"7905"`, or a bare voltage like
  `"3.3V"`. Do not use a part-number-with-dash form like `"AMS1117-3.3"`** —
  it silently parses to 1117 V, not 3.3 V, because `firstNumber` matches the
  part-number digits before it ever reaches the digits after the dash. This
  is real, verified behavior in `regulatorVolts`/`regulatorVoltage`, not a
  hypothetical edge case — `ams1117` is even one of this kind's own aliases,
  making the trap easy to walk into.
- **`spice_prefix` is `V`**, not `U`, even though this is conceptually a
  3-pin IC — the SPICE image is one ideal DC source on `OUT`, so `ref` must
  start with `V`.
- No input-headroom check exists for a linear regulator the way it does for
  a buck converter — a regulator whose `IN` never actually exceeds its `OUT`
  voltage will simulate as a clean rail anyway, because `OUT` is an ideal
  source, not a real IN-minus-dropout calculation.
