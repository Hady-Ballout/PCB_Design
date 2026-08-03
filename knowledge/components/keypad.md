---
kind: keypad
label: "Keypad (4x4 membrane)"
category: input
pins: 8
pin_order: [R1, R2, R3, R4, C1, C2, C3, C4]
pin_order_source: fixedPins
spice_prefix: U
aliases: [membrane keypad, matrix keypad, 4x4 keypad]
wiring_only: true
status: core
---

# Keypad (4x4 membrane)

> **STUB** — the frontmatter above is generated and authoritative. The prose
> below is not written yet. Fill it in when you use this part, then delete this
> callout: that is what flips the part to "written" in the index.

TODO: one sentence on what this part is and when to reach for it.

## Pin contract

`nodes` must list exactly 8 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `R1` | TODO |
| 2 | `R2` | TODO |
| 3 | `R3` | TODO |
| 4 | `R4` | TODO |
| 5 | `C1` | TODO |
| 6 | `C2` | TODO |
| 7 | `C3` | TODO |
| 8 | `C4` | TODO |

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
