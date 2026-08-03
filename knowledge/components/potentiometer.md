---
kind: potentiometer
label: "Potentiometer"
category: passive
pins: 3
pin_order: [end A, wiper, end B]
pin_order_source: ROLE_PINS
spice_prefix: R
aliases: [pot, variable resistor, trimmer]
preferred_values: [1k, 10k, 100k]
status: core
---

# Potentiometer

> **STUB** — the frontmatter above is generated and authoritative. The prose
> below is not written yet. Fill it in when you use this part, then delete this
> callout: that is what flips the part to "written" in the index.

TODO: one sentence on what this part is and when to reach for it.

## Pin contract

`nodes` must list exactly 3 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `end A` | TODO |
| 2 | `wiper` | TODO |
| 3 | `end B` | TODO |

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
