---
kind: motor_driver
label: "Motor driver (L298N)"
category: driver-ic
pins: 12
pin_order: [VS, GND, ENA, IN1, IN2, ENB, IN3, IN4, OUT1, OUT2, OUT3, OUT4]
pin_order_source: fixedPins
spice_prefix: U
aliases: [l298n, h-bridge, motor shield]
wiring_only: true
status: core
---

# Motor driver (L298N)

A dual H-bridge module: two independently switched output channels that can
each drive a DC motor forward, backward, or brake from GPIO-level control
signals. Reach for it any time a motor draws more current than a GPIO pin can
source — which is always.

## Pin contract

`nodes` must list exactly 12 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `VS` | Motor supply, 5–35 V. Separate from logic power. |
| 2 | `GND` | Ground, shared between motor and logic sides. |
| 3 | `ENA` | Enable channel A (PWM speed control for channel A). Tie high for full speed if unused. |
| 4 | `IN1` | Channel A direction input 1, from an MCU GPIO. |
| 5 | `IN2` | Channel A direction input 2, from an MCU GPIO. |
| 6 | `ENB` | Enable channel B (PWM speed control for channel B). |
| 7 | `IN3` | Channel B direction input 1, from an MCU GPIO. |
| 8 | `IN4` | Channel B direction input 2, from an MCU GPIO. |
| 9 | `OUT1` | Channel A output +, to one motor terminal. |
| 10 | `OUT2` | Channel A output −, to the other motor terminal. |
| 11 | `OUT3` | Channel B output +, to one motor terminal. |
| 12 | `OUT4` | Channel B output −, to the other motor terminal. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number. Use `"L298N"`.

## Wiring rules

A [dc_motor.md](dc_motor.md) (or vibration motor) belongs across a channel's
two `OUT` pins, never straight on a GPIO net. `IN1`–`IN4` and `ENA`/`ENB`
connect directly to MCU GPIOs with no series resistor needed — the module's
own input buffering handles that.

`missing_flyback_diode` skips motors on `OUT1`–`OUT4`: the L298N integrates
its own protection diodes on every output, so you do not add a discrete
flyback diode across a motor wired to this part (unlike a bare
[bjt_npn.md](bjt_npn.md) or [mosfet_n.md](mosfet_n.md) switch — see
[relay_module.md](relay_module.md) for a driver kind that does *not* get
this exemption).

## Worked example

Two motors, one per channel, both run at full speed (enables tied to the 5 V
logic rail) with direction set by GPIOs:

```json
{ "ref": "U1", "kind": "motor_driver", "value": "L298N",
  "nodes": ["VMOTOR", "0", "5V", "GPIO17", "GPIO18", "5V", "GPIO27", "GPIO22",
            "MOTOR_A_1", "MOTOR_A_2", "MOTOR_B_1", "MOTOR_B_2"] },
{ "ref": "M1", "kind": "dc_motor", "value": "130", "nodes": ["MOTOR_A_1", "MOTOR_A_2"] },
{ "ref": "M2", "kind": "dc_motor", "value": "130", "nodes": ["MOTOR_B_1", "MOTOR_B_2"] }
```

## Gotchas

- **A wrong pin order still validates.** `fixed_pin_node_count` only checks
  the count. Swap `IN1` and `IN2` and the board routes and passes DRC — the
  motor just spins the wrong direction, or channel A ends up wired to
  channel B's enable. Copy the order from the table above.
- `VS` is the motor supply, not the logic supply — do not tie it to the same
  3.3 V/5 V rail the MCU runs on unless the motor genuinely wants that
  voltage; most small motors want 6–12 V here.
- Leaving `ENA`/`ENB` floating leaves the channel disabled (or in an
  undefined PWM state depending on the board's pull resistors) — always tie
  them high or drive them from a GPIO/PWM pin.
