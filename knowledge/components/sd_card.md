---
kind: sd_card
label: "SD card module (SPI)"
category: module
pins: 6
pin_order: [VCC, GND, MISO, MOSI, SCK, CS]
pin_order_source: fixedPins
spice_prefix: U
aliases: [micro sd, sd module, card reader]
wiring_only: true
status: core
---

# SD card module (SPI)

> **STUB** — the frontmatter above is generated and authoritative. The prose
> below is not written yet. Fill it in when you use this part, then delete this
> callout: that is what flips the part to "written" in the index.

TODO: one sentence on what this part is and when to reach for it.

## Pin contract

`nodes` must list exactly 6 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `VCC` | TODO |
| 2 | `GND` | TODO |
| 3 | `MISO` | TODO |
| 4 | `MOSI` | TODO |
| 5 | `SCK` | TODO |
| 6 | `CS` | TODO |

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
