---
kind: motor_driver
label: "Motor driver (L298N)"
category: driver-ic
pins: 12
pin_order: [VS, GND, ENA, IN1, IN2, ENB, IN3, IN4, OUT1, OUT2, OUT3, OUT4]
pin_order_source: fixedPins
spice_prefix: U
aliases: [l298n, h-bridge, motor shield]
wiring_only: true
status: core
---

# Motor driver (L298N)

> **STUB** — the frontmatter above is generated and authoritative. The prose
> below is not written yet. Fill it in when you use this part, then delete this
> callout: that is what flips the part to "written" in the index.

TODO: one sentence on what this part is and when to reach for it.

## Pin contract

`nodes` must list exactly 12 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `VS` | TODO |
| 2 | `GND` | TODO |
| 3 | `ENA` | TODO |
| 4 | `IN1` | TODO |
| 5 | `IN2` | TODO |
| 6 | `ENB` | TODO |
| 7 | `IN3` | TODO |
| 8 | `IN4` | TODO |
| 9 | `OUT1` | TODO |
| 10 | `OUT2` | TODO |
| 11 | `OUT3` | TODO |
| 12 | `OUT4` | TODO |

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
