---
kind: stepper_driver
label: "Stepper driver (ULN2003)"
category: driver-ic
pins: 10
pin_order: [IN1, IN2, IN3, IN4, VCC, GND, OUTA, OUTB, OUTC, OUTD]
pin_order_source: fixedPins
spice_prefix: U
aliases: [uln2003, darlington array, driver board]
wiring_only: true
status: core
---

# Stepper driver (ULN2003)

> **STUB** — the frontmatter above is generated and authoritative. The prose
> below is not written yet. Fill it in when you use this part, then delete this
> callout: that is what flips the part to "written" in the index.

TODO: one sentence on what this part is and when to reach for it.

## Pin contract

`nodes` must list exactly 10 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `IN1` | TODO |
| 2 | `IN2` | TODO |
| 3 | `IN3` | TODO |
| 4 | `IN4` | TODO |
| 5 | `VCC` | TODO |
| 6 | `GND` | TODO |
| 7 | `OUTA` | TODO |
| 8 | `OUTB` | TODO |
| 9 | `OUTC` | TODO |
| 10 | `OUTD` | TODO |

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
