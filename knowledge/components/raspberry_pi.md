---
kind: raspberry_pi
label: "Raspberry Pi"
category: microcontroller
pins: 14
pin_order: [5V, 3V3, GND, GPIO2, GPIO3, GPIO4, GPIO17, GPIO18, GPIO27, GPIO22, GPIO8, GPIO9, GPIO10, GPIO11]
pin_order_source: fixedPins
spice_prefix: U
aliases: [pi, rpi, raspberry]
mcu: true
wiring_only: true
status: core
---

# Raspberry Pi

> **STUB** — the frontmatter above is generated and authoritative. The prose
> below is not written yet. Fill it in when you use this part, then delete this
> callout: that is what flips the part to "written" in the index.

TODO: one sentence on what this part is and when to reach for it.

## Pin contract

`nodes` must list exactly 14 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `5V` | TODO |
| 2 | `3V3` | TODO |
| 3 | `GND` | TODO |
| 4 | `GPIO2` | TODO |
| 5 | `GPIO3` | TODO |
| 6 | `GPIO4` | TODO |
| 7 | `GPIO17` | TODO |
| 8 | `GPIO18` | TODO |
| 9 | `GPIO27` | TODO |
| 10 | `GPIO22` | TODO |
| 11 | `GPIO8` | TODO |
| 12 | `GPIO9` | TODO |
| 13 | `GPIO10` | TODO |
| 14 | `GPIO11` | TODO |

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
