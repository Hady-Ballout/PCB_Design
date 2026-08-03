---
kind: rfid_reader
label: "RFID reader (RC522)"
category: module
pins: 8
pin_order: [3V3, RST, GND, IRQ, MISO, MOSI, SCK, SDA]
pin_order_source: fixedPins
spice_prefix: U
aliases: [rfid, rc522, nfc reader]
wiring_only: true
status: core
---

# RFID reader (RC522)

> **STUB** — the frontmatter above is generated and authoritative. The prose
> below is not written yet. Fill it in when you use this part, then delete this
> callout: that is what flips the part to "written" in the index.

TODO: one sentence on what this part is and when to reach for it.

## Pin contract

`nodes` must list exactly 8 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `3V3` | TODO |
| 2 | `RST` | TODO |
| 3 | `GND` | TODO |
| 4 | `IRQ` | TODO |
| 5 | `MISO` | TODO |
| 6 | `MOSI` | TODO |
| 7 | `SCK` | TODO |
| 8 | `SDA` | TODO |

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
