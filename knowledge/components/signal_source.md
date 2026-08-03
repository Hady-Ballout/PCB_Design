---
kind: signal_source
label: "Signal source"
category: source
pins: 2
pin_order: null
pin_order_source: none
spice_prefix: V
aliases: [function generator, ac source, waveform]
preferred_values: [SINE(0 1 1k), PULSE(0 5 0 1u 1u 1m 2m)]
status: core
---

# Signal source

> **STUB** — the frontmatter above is generated and authoritative. The prose
> below is not written yet. Fill it in when you use this part, then delete this
> callout: that is what flips the part to "written" in the index.

TODO: one sentence on what this part is and when to reach for it.

## Pin contract

`nodes` must list exactly 2 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | pin 1 | TODO |
| 2 | pin 2 | TODO |

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
