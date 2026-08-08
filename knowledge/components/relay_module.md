---
kind: relay_module
label: "Relay module"
category: driver-ic
pins: 6
pin_order: [VCC, GND, IN, COM, NO, NC]
pin_order_source: fixedPins
spice_prefix: U
aliases: [relay, relay board]
wiring_only: true
status: core
---

# Relay module

An electromechanical relay on a breakout board: a low-current GPIO signal
switches a mechanical contact that can carry a completely separate,
higher-power (even mains) circuit. Reach for it to switch a load a transistor
can't safely isolate — high voltage, AC, or anything you want galvanically
separated from the MCU.

## Pin contract

`nodes` must list exactly 6 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `VCC` | Module logic/coil supply, typically 5 V. |
| 2 | `GND` | Ground. |
| 3 | `IN` | Control input, from an MCU GPIO. Most boards are active-low. |
| 4 | `COM` | Common contact — the pole the switched circuit's supply feeds. |
| 5 | `NO` | Normally-open contact — connects to `COM` when the relay is energized. |
| 6 | `NC` | Normally-closed contact — connects to `COM` when the relay is de-energized. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number. Use `"SRD-05VDC-SL-C"` or similar.

## Wiring rules

`IN` connects straight to an MCU GPIO — no base resistor needed, the board's
own opto-isolation and driver transistor handle that. The switched load goes
across `COM` and whichever of `NO`/`NC` matches the behavior you want
(energized-closed vs. energized-open); the switched circuit's own supply and
ground are independent of the module's `VCC`/`GND`.

Unlike [motor_driver.md](motor_driver.md) and
[stepper_driver.md](stepper_driver.md), `missing_flyback_diode` does **not**
exempt this part: a motor switched across `COM`/`NO` still needs its own
discrete flyback diode, because a bare mechanical relay module integrates no
protection for the load side.

## Worked example

GPIO switching a 12 V fan through the normally-open contact, with a flyback
diode across the fan since it's an inductive load:

```json
{ "ref": "U1", "kind": "relay_module", "value": "SRD-05VDC-SL-C",
  "nodes": ["5V", "0", "GPIO17", "FAN_12V", "FAN_SW", "NC_U1_6"] },
{ "ref": "M1", "kind": "dc_motor", "value": "fan", "nodes": ["FAN_SW", "0"] },
{ "ref": "D1", "kind": "diode", "value": "1N4007", "nodes": ["0", "FAN_SW"] }
```

`COM` ties to the 12 V rail, `NO` feeds the fan, and `NC` is left
unconnected because this design only needs the energized-on behavior.

## Gotchas

- **A wrong pin order still validates.** `fixed_pin_node_count` only checks
  the count. Swap `NO` and `NC` and the board routes clean but the load runs
  exactly backwards from what the firmware expects — on when it should be
  off. Copy the order from the table above.
- Most cheap relay boards are **active-low**: driving `IN` high de-energizes
  the coil. Check the specific board before assuming active-high logic.
- `COM`/`NO`/`NC` carry the switched circuit's own supply, not `VCC` — do
  not wire the load's power through the module's `VCC` pin.
- Forgetting the flyback diode on an inductive load switched through this
  part is the single most common mistake — see the wiring rule above.
