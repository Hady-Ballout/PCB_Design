---
kind: buck_converter
label: "Buck converter (LM2596)"
category: power
pins: 5
pin_order: [VIN, OUT, GND, FB, ON_OFF]
pin_order_source: fixedPins
spice_prefix: V
aliases: [buck, step-down, lm2596, dc-dc]
status: core
---

# Buck converter (LM2596)

A switching step-down regulator (modeled on the LM2596, TO-220-5). Reach for
this instead of a [regulator.md](regulator.md) when the input-to-output
voltage drop is large enough that a linear regulator would waste too much
power as heat — a buck converter switches instead of dissipating the
difference.

## Pin contract

`nodes` must list exactly 5 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `VIN` | Unregulated input supply. |
| 2 | `OUT` | The internal switch node — **not** a clean DC rail by itself; it needs an external LC filter (see Wiring rules). |
| 3 | `GND` | Ground. Almost always `"0"`. |
| 4 | `FB` | Feedback. Must reach the *filtered* output rail, not `OUT` directly. |
| 5 | `ON_OFF` | Enable. Active states depend on the real part; leave connected per your design intent. |

This is a `fixedPins` contract (`pin_order_source: fixedPins`), so a wrong
order is not just cosmetic — `FIXED_PIN_NAMES.buck_converter` in
`componentKinds.js` fixes this exact sequence and several rules key off
specific indices: `nodes[0]` is VIN, `nodes[1]` is the switch node, `nodes[3]`
is FB.

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

The part number, encoding a fixed output voltage: `"LM2596-3.3"`,
`"LM2596-5.0"`, `"LM2596-12"`. `buckVolts` in `sim/simValues.js` strips the
`lm25\d\d` part-number prefix before hunting for digits, so `"LM2596-5.0"`
parses as 5 V — the part number itself never gets mistaken for the voltage.
Anything unparseable falls back to 5 V.

The `buck_unreal_part_number` rule (`id: 'buck_unreal_part_number'`, warning)
flags any value whose parsed voltage isn't exactly 3.3, 5, or 12 — those are
the only real fixed-output LM2596 variants this model supports; an
adjustable/ADJ variant would need a feedback resistor divider this engine
doesn't model.

## Wiring rules

Several dedicated rules gate a working buck converter:

- **`buck_missing_inductor`** (error) — `OUT` needs an inductor to turn the
  switching waveform into a DC rail. No inductor on `OUT` fails immediately.
- **`buck_missing_catch_diode`** (error, only checked once an inductor is
  present) — `OUT` also needs a schottky or diode from `"0"` to `OUT`
  (cathode at `OUT`) so inductor current has somewhere to go when the
  internal switch turns off.
- **`buck_fb_misrouted`** (warning) — `FB` unconnected, or `FB` tied straight
  to the raw `OUT` switch node instead of the filtered output rail past the
  inductor, both get flagged (the rule cannot verify a real feedback divider,
  so these are the two unambiguous cases it checks).
- **`buck_insufficient_headroom`** (warning) — looks at every
  [voltage_source.md](voltage_source.md)/[solar_panel.md](solar_panel.md)
  reachable from `VIN`, takes the highest voltage found, and requires it to
  be at least `output + 2V`. Below that, the converter can't stay in
  regulation.
- **`orphan_supply`** (warning) — if nothing but the converter's own filter
  parts (capacitor, inductor, schottky/diode, resistor) sit downstream of
  `OUT`, it warns that the regulated rail feeds nothing.

## Worked example

5 V output from a 12 V input, with the required LC filter and catch diode:

```json
{ "ref": "V1", "kind": "buck_converter", "value": "LM2596-5.0",
  "nodes": ["VIN", "SW", "0", "VOUT", "ON"] },
{ "ref": "L1", "kind": "inductor", "value": "33uH", "nodes": ["SW", "VOUT"] },
{ "ref": "D1", "kind": "schottky", "value": "1N5819", "nodes": ["0", "SW"] },
{ "ref": "C1", "kind": "capacitor", "value": "100uF", "nodes": ["VOUT", "0"] }
```

Here `FB` (`nodes[3]`) is wired to `VOUT` — the filtered rail after the
inductor — not to `SW`.

## Gotchas

- **`OUT` is a switch node, not a rail.** The SPICE image places an ideal DC
  source right on it (`toSpice` writes `DC <buckVoltage>` at `nodes[1]`), so
  the simulated voltage looks clean even before you add the inductor — the
  topology rules, not the simulator's output, are what catch a missing LC
  filter.
- **Feeding `FB` from `OUT` directly** looks like a smaller mistake than
  leaving it unconnected, but it's arguably worse: the converter regulates
  against the raw switching waveform instead of the actual output, and
  `buck_fb_misrouted` is the only thing that catches it.
- **`spice_prefix` is `V`**, not `U`, despite this being an IC-like part — the
  SPICE image is one ideal source, so `ref` must start with `V` (e.g. `V1`,
  not `U1`).
- Only `-3.3`, `-5.0`, and `-12` are real LM2596 fixed variants — anything
  else silently simulates (falls back to whatever number parses) but
  `buck_unreal_part_number` will flag it as not a purchasable part.
