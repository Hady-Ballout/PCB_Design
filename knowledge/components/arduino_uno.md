---
kind: arduino_uno
label: "Arduino Uno"
category: microcontroller
pins: 24
pin_order: [5V, 3V3, GND, VIN, D0, D1, D2, D3, D4, D5, D6, D7, D8, D9, D10, D11, D12, D13, A0, A1, A2, A3, A4, A5]
pin_order_source: fixedPins
spice_prefix: U
aliases: [arduino, uno, atmega328]
mcu: true
wiring_only: true
status: core
---

# Arduino Uno

> **STUB** — the frontmatter above is generated and authoritative. The prose
> below is not written yet. Fill it in when you use this part, then delete this
> callout: that is what flips the part to "written" in the index.

TODO: one sentence on what this part is and when to reach for it.

## Pin contract

`nodes` must list exactly 24 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `5V` | TODO |
| 2 | `3V3` | TODO |
| 3 | `GND` | TODO |
| 4 | `VIN` | TODO |
| 5 | `D0` | TODO |
| 6 | `D1` | TODO |
| 7 | `D2` | TODO |
| 8 | `D3` | TODO |
| 9 | `D4` | TODO |
| 10 | `D5` | TODO |
| 11 | `D6` | TODO |
| 12 | `D7` | TODO |
| 13 | `D8` | TODO |
| 14 | `D9` | TODO |
| 15 | `D10` | TODO |
| 16 | `D11` | TODO |
| 17 | `D12` | TODO |
| 18 | `D13` | TODO |
| 19 | `A0` | TODO |
| 20 | `A1` | TODO |
| 21 | `A2` | TODO |
| 22 | `A3` | TODO |
| 23 | `A4` | TODO |
| 24 | `A5` | TODO |

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
