---
kind: load
label: "Load"
category: passive
pins: 2
pin_order: null
pin_order_source: none
spice_prefix: R
aliases: [resistive load, dummy load]
status: core
---

# Load

A generic resistive load — stand-in for "whatever consumes power here" when a
circuit needs a plausible current sink but no specific part matters, e.g.
proving out a supply or a divider. Electrically it is a resistor; semantically
it says "this is the thing being powered," not "this sets a ratio."

## Pin contract

`nodes` must list exactly 2 net names. Order does not matter — `pin_order` is
`null` and `load` has no `ROLE_PINS` entry.

Ground is `"0"`.

## Value

Ohms, exactly like [resistor.md](resistor.md) — same `parseResistance` parser,
same suffixes (`k`, `meg`/`m`, `g`), same case-insensitivity:

| Written | Parses as |
|---------|-----------|
| `"100"` | 100 Ω |
| `"1k"` | 1 000 Ω |
| `"1M"` | 1 000 000 Ω |

## Wiring rules

- Treated identically to a resistor by the topology graph: it is in
  `RESISTIVE_KINDS`, so it always conducts under the default reachability
  rules the way a resistor does.
- `resistor_extreme_value` (`id: 'resistor_extreme_value'`) checks `load`
  values too — below ~1 Ω it warns that breadboard contact resistance
  dominates; above 1e8 Ω it warns that board leakage dominates.
- Unlike a resistor, **`non_standard_resistor` does not check `load`** — that
  rule's `check` filters strictly on `part.kind !== 'resistor'`. Any value
  passes as far as E24 purchasability is concerned; a `load` is documentation
  of intent, not a part you're expected to buy off a specific value.
- On a regulator or buck converter's output, a `load` counts as a real
  consumer for the `orphan_supply` check — it is not in `SUPPLY_FILTER_KINDS`
  (which only excludes `capacitor`, `inductor`, `schottky`, `diode`,
  `resistor`), so wiring one to a regulated rail is a valid, minimal way to
  silence "nothing consumes this supply."

## Worked example

```json
{ "ref": "R9", "kind": "load", "value": "100", "nodes": ["VOUT", "0"] }
```

## Gotchas

- **A `load` is exempt from `non_standard_resistor` but not from
  `resistor_extreme_value`** — an odd split worth remembering if a value
  warning does or doesn't appear.
- It shares `spice_prefix` `R` with [resistor.md](resistor.md), so its
  reference numbering can collide with actual resistors in the BOM if you're
  not careful.
- It has no polarity and no special role — using it in place of a real
  component (e.g. an LED, a motor) will simulate fine but says nothing true
  about the physical board.
