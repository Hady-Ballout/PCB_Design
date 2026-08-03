---
kind: mouse_sensor
label: "Mouse sensor (PMW3360, SPI)"
category: sensor
pins: 8
pin_order: [RST, GND, MOT, NCS, SCK, MOSI, MISO, VCC]
pin_order_source: fixedPins
spice_prefix: U
aliases: [pmw3360, optical sensor]
wiring_only: true
status: core
---

# Mouse sensor (PMW3360, SPI)

> **STUB** — the frontmatter above is generated and authoritative. The prose
> below is not written yet. Fill it in when you use this part, then delete this
> callout: that is what flips the part to "written" in the index.

TODO: one sentence on what this part is and when to reach for it.

## Pin contract

`nodes` must list exactly 8 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `RST` | TODO |
| 2 | `GND` | TODO |
| 3 | `MOT` | TODO |
| 4 | `NCS` | TODO |
| 5 | `SCK` | TODO |
| 6 | `MOSI` | TODO |
| 7 | `MISO` | TODO |
| 8 | `VCC` | TODO |

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
