---
kind: potentiometer
label: "Potentiometer"
category: passive
pins: 3
pin_order: [end A, wiper, end B]
pin_order_source: ROLE_PINS
spice_prefix: R
aliases: [pot, variable resistor, trimmer]
preferred_values: [1k, 10k, 100k]
status: core
---

# Potentiometer

A three-terminal variable resistor: a fixed track between the two ends, and a
wiper that taps it at an adjustable point. Use it for volume controls, trim
adjustments, or a manual analog input.

## Pin contract

`nodes` must list exactly 3 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `end A` | One end of the resistive track. |
| 2 | `wiper` | The adjustable tap. Read this as the analog output/input node. |
| 3 | `end B` | The other end of the resistive track. |

This order comes from `ROLE_PINS.potentiometer` in `topologyRules.js`
(`['end A', 'wiper', 'end B']`) — `pin_order_source` is `ROLE_PINS`, so it is
enforced the same way a `fixedPins` contract is: get the order right or the
wiper ends up wired as an end of the track.

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

The end-to-end (track) resistance, written like a plain resistor value —
`"1k"`, `"10k"`, `"100k"`:

| Written | End-to-end resistance |
|---------|------------------------|
| `"1k"` | 1 000 Ω |
| `"10k"` | 10 000 Ω |
| `"100k"` | 100 000 Ω |

## Wiring rules

The SPICE/live-sim model is a **fixed 50% wiper position**, always — this is
not a live-adjustable component in simulation. `toSpice` emits it as two
derived resistors, each half the track value:

```
<REF>_A  end-A  wiper  <half the value>
<REF>_B  wiper  end-B  <half the value>
```

(`potentiometer` is one of the `COMPOUND_SPICE_KINDS`, so the SPICE parser
recognizes the `_A`/`_B` suffix pattern and reconstructs the single
potentiometer part rather than treating it as two independent resistors.)

- Used as a voltage divider: connect `end A` to a rail, `end B` to ground, and
  read the divided voltage off `wiper`.
- Used as a rheostat (variable series resistance): connect `wiper` and one end
  in series; leave the far end open or tie it to `wiper` as well.
- `potentiometer` is in `RESISTIVE_KINDS`, so the topology graph treats it as
  an ordinary conductor for reachability purposes (divider/GPIO-load checks
  see straight through it).

## Worked example

10k volume-style divider, wiper feeding an analog input net:

```json
{ "ref": "R7", "kind": "potentiometer", "value": "10k", "nodes": ["VCC", "WIPER_OUT", "0"] }
```

## Gotchas

- **The simulator always models 50% wiper position.** Turning the value up or
  down changes the total track resistance, not where the wiper sits — there
  is no way to express "wiper at 20%" in this schema. Do not expect a divider
  ratio other than 1:1 from the simulated part.
- Getting `end A` and `end B` backwards is invisible in simulation (the
  divider is symmetric at 50%) but flips the physical sweep direction on the
  board.
- `spice_prefix` is `R`; the exported refs for the two internal resistors are
  `<REF>_A` and `<REF>_B`, so a potentiometer `R7` shows up as `R7_A` and
  `R7_B` in the raw SPICE deck, not as a single `R7` line.
