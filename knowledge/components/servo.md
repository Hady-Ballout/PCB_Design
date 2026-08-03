---
kind: servo
label: "Servo motor"
category: actuator
pins: 3
pin_order: [VCC, GND, SIG]
pin_order_source: fixedPins
spice_prefix: U
aliases: [servo motor, sg90, mg996r]
wiring_only: true
status: core
---

# Servo motor

A position-controlled hobby servo (SG90, MG996R). Reach for it whenever you
need a fixed angle rather than continuous rotation — pan/tilt mounts, arms,
latches — as opposed to [dc_motor.md](dc_motor.md) (spins) or
[stepper_motor.md](stepper_motor.md) (multi-step positioning).

## Pin contract

`nodes` must list exactly 3 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `VCC` | Supply, typically 5 V. |
| 2 | `GND` | Ground. Almost always `"0"`. |
| 3 | `SIG` | PWM position signal, direct from an MCU GPIO. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part identification, e.g. `"SG90"` or `"MG996R"`. This kind is
`wiring_only` — there is no SPICE model, so nothing in the value string is
parsed or simulated; it is documentation for the fabricator/BOM only.

## Wiring rules

Unlike a DC motor or vibration motor, `SIG` connects **straight to an MCU
GPIO** — that is correct, not a violation. A servo's internal circuitry reads
a PWM pulse width and moves its own motor and gearbox; the GPIO never
switches motor current directly, so `gpio_direct_load` does not apply here.

What does matter:

- `VCC` should come from the 5 V rail, not from the MCU's 3.3 V logic supply
  or from a GPIO — a servo's motor draws real current under load (stall
  current can spike well past what a logic regulator can supply).
- A servo under load can pull enough current to brown out the MCU if they
  share a supply with no separate regulation; a beefier servo (MG996R) is
  worth its own power rail.
- Multiple servos moving together add up fast — budget the 5 V supply for the
  sum of their stall currents, not just their idle draw.

## Worked example

```json
{ "ref": "U1", "kind": "servo", "value": "SG90", "nodes": ["5V", "0", "D9"] }
```

`D9` is the GPIO driving the PWM signal directly — no transistor needed.

## Gotchas

- **This part has no SPICE model** (`wiring_only: true`) — it appears on the
  board and in the wiring diagram but contributes nothing to the simulated
  waveform. Do not expect a sim run to show servo motion or current draw.
- Powering `SIG` instead of `VCC` from 5 V, or the reverse, is a silent pin
  swap: the board still routes and the connector still mates, but the servo
  never moves and nothing in this repo's rules currently catches it — the
  order in the table above is the only defense.
- A servo's angle range and pulse-width-to-angle mapping vary by model; that
  detail lives in firmware, not in this component's netlist entry.
