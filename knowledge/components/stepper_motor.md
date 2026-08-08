---
kind: stepper_motor
label: "Stepper motor (28BYJ-48)"
category: actuator
pins: 5
pin_order: [A, B, C, D, COM]
pin_order_source: fixedPins
spice_prefix: U
aliases: [stepper, 28byj-48]
wiring_only: true
status: core
---

# Stepper motor (28BYJ-48)

A 5-wire unipolar stepper: four coil taps plus a shared centre-tap common.
Reach for it when you need precise, repeatable multi-step positioning rather
than a free-spinning [dc_motor.md](dc_motor.md) or an angle-only
[servo.md](servo.md).

## Pin contract

`nodes` must list exactly 5 net names, in this order (the 5-wire JST cable
order — blue, pink, yellow, orange, red):

| # | Pin | Role |
|---|-----|------|
| 1 | `A` | Coil tap A. Drive output only — never a GPIO. |
| 2 | `B` | Coil tap B. Drive output only — never a GPIO. |
| 3 | `C` | Coil tap C. Drive output only — never a GPIO. |
| 4 | `D` | Coil tap D. Drive output only — never a GPIO. |
| 5 | `COM` | Common centre-tap for all four coils. Ties to the +5V supply. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part identification, e.g. `"28BYJ-48"`. This kind is `wiring_only`
— there is no SPICE model, so the value string is not parsed; it is BOM
documentation only.

## Wiring rules

**Each coil draws well over 100 mA — never wire `A`–`D` to a GPIO, directly or
otherwise.** The coils must be switched by a dedicated driver board (ULN2003),
never by the MCU pins themselves. `stepper_missing_driver` enforces this in
two ways: it errors if any of `A`–`D` lands on a GPIO net, and it errors if
none of the connected coil pins is driven by a `stepper_driver`'s `OUTA-OUTD`
outputs at all.

The correct topology: MCU GPIOs → `stepper_driver` `IN1`–`IN4`, driver `VCC`
→ 5V, driver `GND` → `0`, driver `OUTA`–`OUTD` → this motor's `A`–`D`, and
this motor's `COM` → 5V. See [stepper_driver.md](stepper_driver.md).

## Worked example

```json
{ "ref": "U1", "kind": "stepper_motor", "value": "28BYJ-48", "nodes": ["COIL_A", "COIL_B", "COIL_C", "COIL_D", "5V"] },
{ "ref": "U2", "kind": "stepper_driver", "value": "ULN2003",
  "nodes": ["D8", "D9", "D10", "D11", "5V", "0", "COIL_A", "COIL_B", "COIL_C", "COIL_D"] }
```

`U2`'s `OUTA`–`OUTD` (the last four nodes) land on the same `COIL_A`–`COIL_D`
nets as `U1`'s `A`–`D` pins — that shared naming is what makes the motor
driven rather than floating or GPIO-fed.

## Gotchas

- **Wiring a coil pin straight to a GPIO "to test one coil" trips
  `stepper_missing_driver` immediately** — and for good reason: a GPIO pin
  cannot supply a stepper coil's current even briefly.
- Getting the `A`–`D` order swapped between the motor and the driver's
  `OUTA`–`OUTD` validates cleanly (the rule only checks that a driver output
  is present, not which physical coil it maps to) but the motor will step
  the wrong direction or judder instead of turning smoothly.
- `COM` must go to 5V, not to ground — it is the shared supply tap the coils
  pull current from when a driver output pulls a coil low.
