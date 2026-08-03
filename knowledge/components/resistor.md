---
kind: resistor
label: "Resistor"
category: passive
pins: 2
pin_order: null
pin_order_source: none
spice_prefix: R
aliases: [r, res]
preferred_values: [100, 220, 330, 470, 1k, 2.2k, 4.7k, 10k, 47k, 100k, 1M]
status: core
---

# Resistor

Limits current or sets a voltage ratio. Not polarised — the two nodes are
interchangeable, which is why `pin_order` is `null`.

## Pin contract

`nodes` must list exactly 2 net names. Order does not matter.

Ground is `"0"`.

## Value

Ohms, as a string, with an optional multiplier suffix:

| Written | Parses as |
|---------|-----------|
| `"330"` | 330 Ω |
| `"4.7k"` | 4 700 Ω |
| `"1M"`, `"1m"`, `"1meg"` | 1 000 000 Ω |
| `"1G"` | 1 000 000 000 Ω |

`parseResistance` in `topologyRules.js` is more forgiving than it looks: a
trailing `Ω`, `ohm` or `ohms` is stripped first, so `"330R"`, `"330 ohm"` and
`"330Ω"` all give 330. Prefer the bare form (`"330"`, `"4.7k"`) for consistency.

## Wiring rules

Stick to E24 values (the `preferred_values` list above covers the common ones).
`non_standard_resistor` warns on values you cannot actually buy, and
`resistor_extreme_value` warns below ~1 Ω or above ~10 MΩ.

Common roles and the value that usually fits:

| Role | Typical |
|------|---------|
| LED series resistor | 220 Ω – 1 k |
| Pull-up / pull-down | 4.7 k – 10 k |
| I²C pull-up | 4.7 k |
| BJT base resistor | 1 k – 10 k |
| MOSFET gate pull-down | 10 k – 100 k |
| 555 timing | 1 k – 1 M |

## Worked example

```json
{ "ref": "R1", "kind": "resistor", "value": "10k", "nodes": ["VCC", "DISCH"] }
```

## Gotchas

- **`"1m"` is one megohm, not one milliohm.** The suffix match is
  case-insensitive, so `m` and `M` both mean 1e6. There is no milli suffix.
- **European notation does not parse.** `"1k5"` returns `null`, and a value that
  fails to parse is silently skipped by every value-checking rule rather than
  flagged. Write `"1.5k"`.
- Two resistors sharing both nets are in parallel, which is rarely intended —
  check net names when a divider behaves at half the expected ratio.
