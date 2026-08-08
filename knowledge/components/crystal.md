---
kind: crystal
label: "Crystal"
category: passive
pins: 2
pin_order: null
pin_order_source: none
spice_prefix: C
aliases: [xtal, quartz, oscillator]
status: core
---

# Crystal

A quartz resonator that sets a precise clock frequency for an MCU or timing
circuit. Reach for it when a design calls out an exact frequency (`16MHz`,
`32.768kHz`) rather than the loose RC timing a [resistor.md](resistor.md) +
[capacitor.md](capacitor.md) pair gives a 555.

## Pin contract

`nodes` must list exactly 2 net names. Order does not matter — `pin_order` is
`null`, and nothing in the engine reads one leg differently from the other:
the crystal has no `ROLE_PINS` entry and no positional check anywhere in
`topologyRules.js`.

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form resonant frequency, e.g. `"16MHz"`, `"32.768kHz"`, `"20MHz"`. This is
documentation only — **the SPICE and live-simulator models both ignore it.**
Every crystal is emitted as a fixed 20 pF capacitor (`toSpice` writes `20p`;
the interactive sim uses `20e-12` farads) regardless of what `value` says. A
crystal never actually oscillates in this simulator; it is a placeholder
component for schematic/BOM purposes.

## Wiring rules

There is no dedicated topology rule for crystals — no check verifies load
capacitors are present, no check verifies the part sits between the right MCU
pins. Treat the wiring itself as a hint for the fab, not something the
validator will catch if you get it wrong:

- A real crystal circuit needs two load capacitors (typically 10–22 pF) from
  each leg to ground, and drives an oscillator/XTAL pin pair on the MCU.
- Because `spice_prefix` is `C` (it shares the exporter's fixed 20 pF model
  with a capacitor internally), `ref` must start with `C` — the same letter a
  real [capacitor.md](capacitor.md) uses, so keep your reference numbering
  distinct to avoid confusing the BOM.

## Worked example

```json
{ "ref": "C10", "kind": "crystal", "value": "16MHz", "nodes": ["XTAL1", "XTAL2"] },
{ "ref": "C11", "kind": "capacitor", "value": "22pF", "nodes": ["XTAL1", "0"] },
{ "ref": "C12", "kind": "capacitor", "value": "22pF", "nodes": ["XTAL2", "0"] }
```

## Gotchas

- **The `value` string does nothing electrically.** Typing `"16MHz"` versus
  `"32.768kHz"` produces an identical 20 pF SPICE model either way — do not
  expect the simulator to reflect a different clock rate.
- No rule flags a crystal with no load capacitors, and none flags one wired to
  nothing. It will pass validation and DRC while doing nothing on the board.
- `spice_prefix` is `C`, not a distinct crystal letter (`Y` on many real
  schematics) — this codebase does not use `Y` refs.
