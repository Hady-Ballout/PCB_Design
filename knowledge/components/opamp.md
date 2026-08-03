---
kind: opamp
label: "Op amp"
category: analog-ic
pins: 5
pin_order: [IN+, IN-, OUT, V+, V-]
pin_order_source: ROLE_PINS
spice_prefix: X
aliases: [op-amp, operational amplifier, lm358, lm324]
status: core
---

# Op amp

> **STUB** — the frontmatter above is generated and authoritative. The prose
> below is not written yet. Fill it in when you use this part, then delete this
> callout: that is what flips the part to "written" in the index.

TODO: one sentence on what this part is and when to reach for it.

## Pin contract

`nodes` must list exactly 5 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `IN+` | TODO |
| 2 | `IN-` | TODO |
| 3 | `OUT` | TODO |
| 4 | `V+` | TODO |
| 5 | `V-` | TODO |

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
