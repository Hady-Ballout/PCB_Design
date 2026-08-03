---
kind: rotary_encoder
label: "Rotary encoder (KY-040)"
category: input
pins: 5
pin_order: [CLK, DT, SW, VCC, GND]
pin_order_source: fixedPins
spice_prefix: U
aliases: [encoder, ky-040]
wiring_only: true
status: core
---

# Rotary encoder (KY-040)

> **STUB** — the frontmatter above is generated and authoritative. The prose
> below is not written yet. Fill it in when you use this part, then delete this
> callout: that is what flips the part to "written" in the index.

TODO: one sentence on what this part is and when to reach for it.

## Pin contract

`nodes` must list exactly 5 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `CLK` | TODO |
| 2 | `DT` | TODO |
| 3 | `SW` | TODO |
| 4 | `VCC` | TODO |
| 5 | `GND` | TODO |

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
