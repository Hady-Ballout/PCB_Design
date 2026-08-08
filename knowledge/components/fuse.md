---
kind: fuse
label: "Fuse"
category: passive
pins: 2
pin_order: null
pin_order_source: none
spice_prefix: R
aliases: [ptc]
status: core
---

# Fuse

An in-line overcurrent protection device (or PTC resettable fuse). Put one in
series with a supply input so a fault downstream opens the circuit instead of
cooking a trace or a part.

## Pin contract

`nodes` must list exactly 2 net names. Order does not matter — `pin_order` is
`null` and a fuse has no `ROLE_PINS` entry.

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

The current rating, as a string with a unit: `"1A"`, `"500mA"`, `"2A"`.
`parseAmps` (the live simulator's parser) strips an optional `m`/`u`/`µ`
prefix and a trailing `a`, so `"1A"` → 1 A and `"500mA"` → 0.5 A.

For SPICE/DC purposes a fuse is modeled as a small series resistance, **not**
as its rated current. `resistiveValue` in `pcbGenerator.js` tries to parse
`value` as a plain resistance first (`"0.05"`, `"1"`); a rating like `"1A"`
fails that resistance regex and silently falls back to a fixed **0.05 Ω**.
Write a plain ohm value only if you actually want to model a specific
resistance — for a rating, just write `"1A"`-style text and let the fallback
apply.

| Written | SPICE / live-sim resistance |
|---------|------------------------------|
| `"1A"` | 0.05 Ω (fallback — does not parse as ohms) |
| `"0.1"` | 0.1 Ω (parses directly) |

## Wiring rules

No dedicated topology rule enforces fuse placement. Unlike a resistor, a fuse
(like an inductor) is treated as an unconditional conductor by the topology
graph — `crossings()` in `topologyRules.js` always lets current pass through
it, specifically so it never blocks series-loop rules such as
`led_no_series_resistor` from seeing through it.

- Put the fuse on the supply input, before anything else on that rail.
- In the interactive simulator only, a fuse tracks an i²t "blown" state driven
  by its rating (`ratingAmps`) — this is live-sim-only behavior, not part of
  the static SPICE export or any `topologyRules.js` check.

## Worked example

```json
{ "ref": "R5", "kind": "fuse", "value": "1A", "nodes": ["VIN_RAW", "VIN"] }
```

`ref` starts with `R` — `spice_prefix` for `fuse` is `R`, the same as
[resistor.md](resistor.md), because it is simulated as one.

## Gotchas

- **A current rating like `"1A"` is not a resistance in the model** — it
  always becomes a fixed 0.05 Ω stand-in for DC/SPICE purposes. Do not expect
  a "2A" fuse to model differently from a "1A" fuse electrically; only the
  live simulator's blow logic reads the rating number.
- No rule checks that a fuse is actually present on a supply rail, or that its
  rating suits the load current — that judgment is entirely on you.
- Placement order relative to other supply-path parts is not validated;
  putting it after a load it is meant to protect will pass silently.
