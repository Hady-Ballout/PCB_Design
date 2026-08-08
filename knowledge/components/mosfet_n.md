---
kind: mosfet_n
label: "N-channel MOSFET"
category: transistor
pins: 3
pin_order: [drain, gate, source]
pin_order_source: ROLE_PINS
spice_prefix: M
aliases: [nmos, n-mosfet, n-fet, irfz44]
status: core
---

# N-channel MOSFET

A voltage-controlled low-side switch. Reach for it instead of a
[bjt_npn.md](bjt_npn.md) when you need near-zero gate current draw or a lower
on-resistance for a heavier load — motors, high-current LED strips, relay
coils.

## Pin contract

`nodes` must list exactly 3 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `drain` | The switched node. Ties to the load, which ties to the supply. |
| 2 | `gate` | Control input. High-impedance — needs a pull-down, not a series resistor, to be safe. |
| 3 | `source` | Almost always ground (`"0"`) in a low-side switch. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number, e.g. `"IRLZ44N"`, `"2N7000"`. It is documentation
only — the SPICE export always models an N-MOSFET as a fixed generic
`MNMOS` (`LEVEL=1 KP=20u VTO=2`), body tied to source, regardless of the
string here. Note the model's 2 V threshold: it does not distinguish a
logic-level part like the IRLZ44N from one that needs a 10 V gate drive, so
the simulation will happily "switch on" at a 3.3 V gate even for parts that
would not in real life.

## Wiring rules

Low-side switch: source to ground, load between the supply and the drain,
gate driven by the control signal.

- **The gate must never float.** `driver_control_floating` flags a gate net
  with nothing else on it. Unlike a BJT base, the gate draws essentially no
  DC current, so a floating gate picks up noise and can partially turn the
  MOSFET on unpredictably.
- **Add a pull-down resistor on the gate.** `driver_missing_base_resistor`
  (the mosfet branch reports as `mosfet_gate_no_pulldown`, a warning) flags a
  gate net with no resistor to ground — without it the MOSFET state is
  undefined while the driving MCU pin is high-impedance during reset/boot.
  100k to ground is the standard value.
- A gate connected straight to a GPIO net is fine electrically (unlike a BJT
  base, no series resistor is required to limit current), but a small series
  resistor (e.g. 100 Ω) is still good practice to damp ringing — this repo's
  rules do not enforce it.
- **Switching an inductive load needs a flyback diode** across the load.
  `missing_flyback_diode` applies the same as for a BJT.

## Worked example

DC motor switched low-side from a GPIO, with gate pull-down and flyback diode:

```json
{ "ref": "M1", "kind": "mosfet_n",  "value": "IRLZ44N", "nodes": ["MOTOR_LO", "GATE", "0"] },
{ "ref": "R1", "kind": "resistor",  "value": "100k", "nodes": ["GATE", "0"] },
{ "ref": "D1", "kind": "diode",     "value": "1N4007", "nodes": ["MOTOR_HI", "MOTOR_LO"] },
{ "ref": "MOT1", "kind": "dc_motor", "value": "", "nodes": ["MOTOR_HI", "MOTOR_LO"] }
```

`GATE` connects onward to the GPIO's own series resistor (not shown). `D1`'s
cathode faces the supply side of the motor (`MOTOR_HI`), anode toward the
switched node — reversed relative to normal current flow, which is what makes
it a flyback (freewheeling) diode.

## Gotchas

- **N-channel and P-channel share the same pin order**
  (`drain, gate, source`) but opposite gate-drive polarity — see
  [mosfet_p.md](mosfet_p.md). Placing the wrong kind produces a board that
  routes and passes DRC but never switches.
- The fixed `VTO=2` SPICE model means simulation results do not reflect real
  gate-threshold differences between parts; do not use this simulator to
  validate whether a specific MOSFET is "logic level."
- A missing gate pull-down is only a `warning`, not an `error` — it is easy to
  ship a board where the load flickers on during MCU reset because the gate
  floated briefly high.
