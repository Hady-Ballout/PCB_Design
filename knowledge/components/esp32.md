---
kind: esp32
label: "ESP32"
category: microcontroller
pins: 12
pin_order: [3V3, GND, VIN, EN, GPIO2, GPIO4, GPIO5, GPIO13, GPIO18, GPIO19, GPIO21, GPIO22]
pin_order_source: fixedPins
spice_prefix: U
aliases: [esp, wroom, devkit]
mcu: true
wiring_only: true
status: core
---

# ESP32

> **STUB** — the frontmatter above is generated and authoritative. The prose
> below is not written yet. Fill it in when you use this part, then delete this
> callout: that is what flips the part to "written" in the index.

TODO: one sentence on what this part is and when to reach for it.

## Pin contract

`nodes` must list exactly 12 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `3V3` | TODO |
| 2 | `GND` | TODO |
| 3 | `VIN` | TODO |
| 4 | `EN` | TODO |
| 5 | `GPIO2` | TODO |
| 6 | `GPIO4` | TODO |
| 7 | `GPIO5` | TODO |
| 8 | `GPIO13` | TODO |
| 9 | `GPIO18` | TODO |
| 10 | `GPIO19` | TODO |
| 11 | `GPIO21` | TODO |
| 12 | `GPIO22` | TODO |

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
