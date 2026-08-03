---
kind: opamp
label: "Op amp"
category: analog-ic
pins: 5
pin_order: [IN+, IN-, OUT, V+, V-]
pin_order_source: ROLE_PINS
spice_prefix: X
aliases: [op-amp, operational amplifier, lm358, lm324]
status: core
---

# Op amp

A generic 5-pin operational amplifier symbol (drawn as a single package, not a
physical DIP footprint). Reach for it for buffers, inverting/non-inverting
gain stages, and comparators built from an amplifier rather than a dedicated
comparator IC. For the classic 8-pin DIP uA741 specifically, use
[ua741.md](ua741.md) instead — it carries a fixed physical pinout.

## Pin contract

`nodes` must list exactly 5 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `IN+` | Non-inverting input. Must connect to something — see Wiring rules. |
| 2 | `IN-` | Inverting input. Almost always part of a feedback network. |
| 3 | `OUT` | Output. |
| 4 | `V+` | Positive supply. |
| 5 | `V-` | Negative supply, or ground for a single-supply design. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number, e.g. `"LM358"`, `"LM324"`. It is documentation only —
the SPICE export always models this kind as a fixed `LM358` subcircuit
regardless of the string here.

## Wiring rules

- **Both inputs must connect to something other than the op amp itself.**
  `opamp_input_floating` flags an `IN+` or `IN-` node (other than `"0"`) that
  no other component touches — a floating high-impedance input makes the
  simulation singular and the real circuit's output undefined. Tie `IN+` to a
  reference (ground or a bias divider) and `IN-` into a feedback/summing
  network, even if that network is just a direct wire back to `OUT`.
- **A gain stage needs a feedback path.** A non-inverting buffer ties `OUT`
  straight back to `IN-`; an inverting or non-inverting gain stage adds a
  resistor divider in that feedback path.
- **Supply pins must actually be powered.** `V+`/`V-` floating or on the
  wrong rail produces an amplifier that cannot output anything — for a
  single-supply design tie `V-` to `"0"` and bias the inputs mid-rail rather
  than around 0 V, since the output cannot swing negative.

## Worked example

Non-inverting buffer (unity-gain follower) on a single 5 V supply:

```json
{ "ref": "XU1", "kind": "opamp", "value": "LM358", "nodes": ["VIN", "VOUT", "VOUT", "VCC", "0"] }
```

`IN-` and `OUT` share the `VOUT` net — that direct feedback connection is what
makes it a buffer and is also what satisfies `opamp_input_floating` for the
inverting input.

## Gotchas

- **A feedback wire is not optional decoration.** An op amp with `IN-` on its
  own isolated net (not even looped back to `OUT`) is the single most common
  broken circuit this rule catches — it looks complete in the schematic but
  the simulation cannot solve it.
- The SPICE behaviour is always the generic `LM358` model no matter which
  real part number you write in `value`; do not expect rail-to-rail or
  precision behaviour that a specific chip promises but LM358 does not have.
- `V-` tied to `"0"` is correct for single-supply designs but means the
  output cannot go below ground — an input signal that swings negative (e.g.
  raw AC from a microphone) needs level-shifting first, not a symptom this
  rule set checks for.
