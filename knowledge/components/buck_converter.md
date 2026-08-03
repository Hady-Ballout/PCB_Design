---
kind: buck_converter
label: "Buck converter (LM2596)"
category: power
pins: 5
pin_order: [VIN, OUT, GND, FB, ON_OFF]
pin_order_source: fixedPins
spice_prefix: V
aliases: [buck, step-down, lm2596, dc-dc]
status: core
---

# Buck converter (LM2596)

> **STUB** — the frontmatter above is generated and authoritative. The prose
> below is not written yet. Fill it in when you use this part, then delete this
> callout: that is what flips the part to "written" in the index.

TODO: one sentence on what this part is and when to reach for it.

## Pin contract

`nodes` must list exactly 5 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `VIN` | TODO |
| 2 | `OUT` | TODO |
| 3 | `GND` | TODO |
| 4 | `FB` | TODO |
| 5 | `ON_OFF` | TODO |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

TODO: what the `value` string means for this kind.

## Wiring rules

TODO: what must be true for this part to work.

## Worked example

TODO: a minimal component entry, copy-pasteable.

## Gotchas

TODO: what goes wrong most often.
