---
kind: rgb_led
label: "RGB LED"
category: diode
pins: 4
pin_order: [red, green, blue, common]
pin_order_source: ROLE_PINS
spice_prefix: D
aliases: [rgb, tri-color led]
status: core
---

# RGB LED

> **STUB** — the frontmatter above is generated and authoritative. The prose
> below is not written yet. Fill it in when you use this part, then delete this
> callout: that is what flips the part to "written" in the index.

TODO: one sentence on what this part is and when to reach for it.

## Pin contract

`nodes` must list exactly 4 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `red` | TODO |
| 2 | `green` | TODO |
| 3 | `blue` | TODO |
| 4 | `common` | TODO |

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
