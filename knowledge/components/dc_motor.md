---
kind: dc_motor
label: "DC motor"
category: actuator
pins: 2
pin_order: null
pin_order_source: none
spice_prefix: R
aliases: [motor, brushed motor]
status: core
---

# DC motor

A brushed DC motor, driven from a switched supply rail. Reach for it for
continuous rotation — wheels, fans, pumps — as opposed to [servo.md](servo.md)
(positioned) or [stepper_motor.md](stepper_motor.md) (precise steps).

## Pin contract

`nodes` must list exactly 2 net names. Order does not matter — like a
resistor, both leads are electrically interchangeable; reversing them just
reverses the motor's spin direction.

Ground is `"0"`.

## Value

Free-form. If it parses as a resistance (same grammar as
[resistor.md](resistor.md): `"10"`, `"22"`) it is used as the motor's
simulated winding resistance, which sets the current draw. A non-parsing
string (`"130-size brushed"`) falls back to a default of 10 Ω. The simulated
"speed" observable assumes a 6 V-rated motor regardless of what you write
here.

## Wiring rules

A DC motor is a heavy load and inductive, so two rules apply together:

- `gpio_direct_load` / `divider_powered_load`: never wire the motor directly
  to a GPIO net that also reaches supply or ground — a GPIO cannot source the
  current. Switch it with a transistor or motor driver instead.
- `missing_flyback_diode`: once it *is* switched by a transistor, add a diode
  across the motor (cathode to the supply side) to absorb the inductive
  kick when the transistor turns off — without it the turn-off spike destroys
  the transistor. `driver_missing_base_resistor` also applies to the switching
  transistor's base.

For direction control or higher current, use a `motor_driver` (L298N) module
instead of a single transistor — its `OUT1-OUT4` pins already switch the load
and are exempt from the flyback-diode rule because the driver board integrates
its own protection.

## Worked example

Transistor-switched motor with flyback protection:

```json
{ "ref": "Q1", "kind": "bjt_npn", "value": "TIP120", "nodes": ["MOTOR_HI", "BASE", "0"] },
{ "ref": "R1", "kind": "resistor", "value": "1k", "nodes": ["D6", "BASE"] },
{ "ref": "R2", "kind": "dc_motor", "value": "10", "nodes": ["12V", "MOTOR_HI"] },
{ "ref": "D1", "kind": "diode", "value": "1N4007", "nodes": ["MOTOR_HI", "12V"] }
```

`R2` (not `M1`) — `dc_motor`'s `spice_prefix` is `R`, because it is simulated
as a resistive winding load. `D1`'s cathode faces the supply (`12V`), anode
faces the switched node — reversed relative to current flow, which is how a
flyback diode sits.

## Gotchas

- **The ref prefix is `R`, not `M`.** A ref like `M1` will not match the
  kind's `spice_prefix` contract.
- Skipping the flyback diode is the classic failure: the board looks correct,
  simulates fine under DC, and then the transistor dies the first time the
  motor is switched off in real life — the topology rule exists because this
  is easy to miss.
- Driving a motor from a motor driver's `OUT` pins rather than a single
  transistor gets you both directions (forward/reverse) and skips the need
  for a separate flyback diode; see [motor_driver.md](motor_driver.md).
