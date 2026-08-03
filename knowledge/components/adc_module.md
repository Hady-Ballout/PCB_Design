---
kind: adc_module
label: "ADC (MCP3008)"
category: driver-ic
pins: 16
pin_order: [CH0, CH1, CH2, CH3, CH4, CH5, CH6, CH7, DGND, CS, DIN, DOUT, CLK, AGND, VREF, VDD]
pin_order_source: fixedPins
spice_prefix: U
aliases: [mcp3008, adc]
wiring_only: true
status: core
---

# ADC (MCP3008)

> **STUB** — the frontmatter above is generated and authoritative. The prose
> below is not written yet. Fill it in when you use this part, then delete this
> callout: that is what flips the part to "written" in the index.

TODO: one sentence on what this part is and when to reach for it.

## Pin contract

`nodes` must list exactly 16 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `CH0` | TODO |
| 2 | `CH1` | TODO |
| 3 | `CH2` | TODO |
| 4 | `CH3` | TODO |
| 5 | `CH4` | TODO |
| 6 | `CH5` | TODO |
| 7 | `CH6` | TODO |
| 8 | `CH7` | TODO |
| 9 | `DGND` | TODO |
| 10 | `CS` | TODO |
| 11 | `DIN` | TODO |
| 12 | `DOUT` | TODO |
| 13 | `CLK` | TODO |
| 14 | `AGND` | TODO |
| 15 | `VREF` | TODO |
| 16 | `VDD` | TODO |

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
