---
kind: comparator
label: "Comparator"
category: analog-ic
pins: 5
pin_order: [IN+, IN-, OUT, V+, V-]
pin_order_source: ROLE_PINS
spice_prefix: X
aliases: [lm393, lm339]
status: core
---

# Comparator

A 5-pin comparator such as the LM393/LM339 family: outputs a clean high or
low depending on which input is higher, rather than amplifying the
difference. Reach for it for threshold detection — light/dark, over/under
voltage, zero-crossing — where an [opamp.md](opamp.md) run open-loop would
also work but a real comparator switches faster and its output stage is
usually open-collector.

## Pin contract

`nodes` must list exactly 5 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `IN+` | Non-inverting input. Output goes high when this exceeds `IN-`. |
| 2 | `IN-` | Inverting input. Often the reference/threshold voltage. |
| 3 | `OUT` | Output — open-collector on the real LM393/LM339 parts, so it needs a pull-up. |
| 4 | `V+` | Positive supply. |
| 5 | `V-` | Negative supply, or ground for a single-supply design. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number, e.g. `"LM393"`, `"LM339"`. It is documentation only —
the SPICE export always models this kind as a fixed `LM393` subcircuit
regardless of the string here.

## Wiring rules

- **The output needs a pull-up resistor to a logic rail.** The real
  LM393/LM339 output stage is open-collector: it can pull low but cannot
  drive high on its own. Without a pull-up the output floats when it should
  read high. 10k to the logic supply is a typical value.
- **Set a real reference on the inverting input** — a resistor divider from
  the supply, a fixed reference part, or a sensor's own bias point. Unlike
  the plain [opamp.md](opamp.md) kind, this repo's `opamp_input_floating`
  check does **not** currently cover `comparator` parts, so a genuinely
  floating input here will not be caught automatically — verify it by
  inspection.
- Both inputs are otherwise wired the same way as an op amp's: `IN+` toward
  the sensed voltage, `IN-` toward the threshold, or swap them if you want
  the output to invert.

## Worked example

Light-threshold detector: LDR/resistor divider into `IN+`, fixed reference
divider into `IN-`, output pulled up to the logic rail:

```json
{ "ref": "XU1", "kind": "comparator", "value": "LM393", "nodes": ["VIN", "VREF", "VOUT", "VCC", "0"] },
{ "ref": "R1", "kind": "resistor", "value": "10k", "nodes": ["VIN", "0"] },
{ "ref": "R2", "kind": "resistor", "value": "10k", "nodes": ["VREF", "0"] },
{ "ref": "R3", "kind": "resistor", "value": "10k", "nodes": ["VOUT", "VCC"] }
```

`R3` is the required output pull-up; without it `VOUT` is not driven high.

## Gotchas

- **A missing output pull-up is the most common silent failure.** The board
  routes and simulates without complaint, but `OUT` reads as a weak or
  indeterminate high in the real circuit.
- **Floating-input protection does not apply here.** Do not rely on
  `opamp_input_floating` to catch a stray comparator input — it only checks
  `opamp` and `ua741` kinds.
- The SPICE behaviour is a fixed `LM393` model regardless of the real part
  number in `value`.
