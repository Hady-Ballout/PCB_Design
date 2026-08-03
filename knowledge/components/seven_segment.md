---
kind: seven_segment
label: "7-segment display"
category: display
pins: 9
pin_order: [A, B, C, D, E, F, G, DP, COM]
pin_order_source: fixedPins
spice_prefix: D
aliases: [7 segment, seven segment display, 7-seg]
status: core
---

# 7-segment display

> **STUB** — the frontmatter above is generated and authoritative. The prose
> below is not written yet. Fill it in when you use this part, then delete this
> callout: that is what flips the part to "written" in the index.

TODO: one sentence on what this part is and when to reach for it.

## Pin contract

`nodes` must list exactly 9 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `A` | TODO |
| 2 | `B` | TODO |
| 3 | `C` | TODO |
| 4 | `D` | TODO |
| 5 | `E` | TODO |
| 6 | `F` | TODO |
| 7 | `G` | TODO |
| 8 | `DP` | TODO |
| 9 | `COM` | TODO |

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
