---
kind: stepper_driver
label: "Stepper driver (ULN2003)"
category: driver-ic
pins: 10
pin_order: [IN1, IN2, IN3, IN4, VCC, GND, OUTA, OUTB, OUTC, OUTD]
pin_order_source: fixedPins
spice_prefix: U
aliases: [uln2003, darlington array, driver board]
wiring_only: true
status: core
---

# Stepper driver (ULN2003)

A Darlington-array breakout that buffers four MCU GPIOs up to the current a
28BYJ-48 stepper motor's coils need. This is the only part allowed between a
stepper motor and an MCU — the coils cannot be driven from GPIOs directly.

## Pin contract

`nodes` must list exactly 10 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `IN1` | Coil A control, from an MCU GPIO. |
| 2 | `IN2` | Coil B control, from an MCU GPIO. |
| 3 | `IN3` | Coil C control, from an MCU GPIO. |
| 4 | `IN4` | Coil D control, from an MCU GPIO. |
| 5 | `VCC` | Logic supply for the driver board. |
| 6 | `GND` | Ground. |
| 7 | `OUTA` | Coil A output, to the stepper motor's A pin. |
| 8 | `OUTB` | Coil B output, to the stepper motor's B pin. |
| 9 | `OUTC` | Coil C output, to the stepper motor's C pin. |
| 10 | `OUTD` | Coil D output, to the stepper motor's D pin. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number. Use `"ULN2003"`.

## Wiring rules

`IN1`–`IN4` connect straight to MCU GPIOs — no base resistor needed, the
Darlington array's inputs handle that. `OUTA`–`OUTD` must go to the stepper
motor's four coil pins (`A`–`D`), and the motor's `COM` pin ties to the
motor supply (typically 5 V), not to this board's `VCC`.

The `stepper_missing_driver` rule requires every connected coil pin of a
`stepper_motor` part to land on this board's `OUTA`–`OUTD` pins rather than
directly on a GPIO net — each coil can draw over 100 mA, far beyond what a
GPIO can source. `missing_flyback_diode` skips motors switched through
`OUTA`–`OUTD`: the ULN2003 has built-in flyback diodes on every output, so
no discrete diode is needed (same exemption as
[motor_driver.md](motor_driver.md)).

## Worked example

```json
{ "ref": "U1", "kind": "stepper_driver", "value": "ULN2003",
  "nodes": ["GPIO17", "GPIO18", "GPIO27", "GPIO22", "5V", "0",
            "COIL_A", "COIL_B", "COIL_C", "COIL_D"] },
{ "ref": "M1", "kind": "stepper_motor", "value": "28BYJ-48",
  "nodes": ["COIL_A", "COIL_B", "COIL_C", "COIL_D", "5V"] }
```

`M1`'s `COM` pin (last) ties to the same 5 V rail as the driver's `VCC`, not
to a GPIO.

## Gotchas

- **A wrong pin order still validates.** `fixed_pin_node_count` only checks
  the count. Swap `OUTA` and `OUTC` and the board routes clean but the motor
  steps out of sequence or not at all. Copy the order from the table above,
  and make sure `OUTA`–`OUTD` line up with the motor's `A`–`D` pins in the
  same order.
- The stepper motor's `COM` pin needs its own connection to the motor
  supply — it does not come from this driver board at all.
- This part is `wiring_only`: it is not simulated in SPICE, only checked for
  wiring completeness.
