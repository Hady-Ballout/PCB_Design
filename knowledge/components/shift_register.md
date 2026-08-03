---
kind: shift_register
label: "Shift register (74HC595)"
category: driver-ic
pins: 16
pin_order: [QB, QC, QD, QE, QF, QG, QH, GND, QH2, SRCLR, SRCLK, RCLK, OE, SER, QA, VCC]
pin_order_source: fixedPins
spice_prefix: U
aliases: [74hc595, shift reg]
wiring_only: true
status: core
---

# Shift register (74HC595)

> **STUB** — the frontmatter above is generated and authoritative. The prose
> below is not written yet. Fill it in when you use this part, then delete this
> callout: that is what flips the part to "written" in the index.

TODO: one sentence on what this part is and when to reach for it.

## Pin contract

`nodes` must list exactly 16 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `QB` | TODO |
| 2 | `QC` | TODO |
| 3 | `QD` | TODO |
| 4 | `QE` | TODO |
| 5 | `QF` | TODO |
| 6 | `QG` | TODO |
| 7 | `QH` | TODO |
| 8 | `GND` | TODO |
| 9 | `QH2` | TODO |
| 10 | `SRCLR` | TODO |
| 11 | `SRCLK` | TODO |
| 12 | `RCLK` | TODO |
| 13 | `OE` | TODO |
| 14 | `SER` | TODO |
| 15 | `QA` | TODO |
| 16 | `VCC` | TODO |

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
