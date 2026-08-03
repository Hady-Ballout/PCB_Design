---
kind: mosfet_p
label: "P-channel MOSFET"
category: transistor
pins: 3
pin_order: [drain, gate, source]
pin_order_source: ROLE_PINS
spice_prefix: M
aliases: [pmos, p-mosfet, p-fet]
status: core
---

# P-channel MOSFET

> **STUB** — the frontmatter above is generated and authoritative. The prose
> below is not written yet. Fill it in when you use this part, then delete this
> callout: that is what flips the part to "written" in the index.

TODO: one sentence on what this part is and when to reach for it.

## Pin contract

`nodes` must list exactly 3 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `drain` | TODO |
| 2 | `gate` | TODO |
| 3 | `source` | TODO |

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
