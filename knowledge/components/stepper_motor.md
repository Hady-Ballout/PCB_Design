---
kind: stepper_motor
label: "Stepper motor (28BYJ-48)"
category: actuator
pins: 5
pin_order: [A, B, C, D, COM]
pin_order_source: fixedPins
spice_prefix: U
aliases: [stepper, 28byj-48]
wiring_only: true
status: core
---

# Stepper motor (28BYJ-48)

> **STUB** — the frontmatter above is generated and authoritative. The prose
> below is not written yet. Fill it in when you use this part, then delete this
> callout: that is what flips the part to "written" in the index.

TODO: one sentence on what this part is and when to reach for it.

## Pin contract

`nodes` must list exactly 5 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `A` | TODO |
| 2 | `B` | TODO |
| 3 | `C` | TODO |
| 4 | `D` | TODO |
| 5 | `COM` | TODO |

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
