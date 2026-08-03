---
kind: pir_sensor
label: "PIR motion sensor"
category: sensor
pins: 3
pin_order: [VCC, OUT, GND]
pin_order_source: fixedPins
spice_prefix: U
aliases: [pir, motion sensor, hc-sr501]
wiring_only: true
status: core
---

# PIR motion sensor

A passive-infrared module (HC-SR501 and equivalents) that outputs a digital
high while it sees a warm body moving in its field of view. Reach for it for
motion-triggered lighting, alarms, or wake-up logic — it needs no MCU logic of
its own to detect motion, just a GPIO to read `OUT`.

## Pin contract

`nodes` must list exactly 3 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `VCC` | Supply, typically 5 V. |
| 2 | `OUT` | Digital output, high while motion is detected. Goes to a GPIO input. |
| 3 | `GND` | Ground. Almost always `"0"`. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number, e.g. `"HC-SR501"`. This kind is `wiring_only`: the
value is documentation and does not select a SPICE model — the module's
behaviour isn't simulated.

## Wiring rules

`OUT` connects straight to a GPIO input — it's an already-buffered digital
signal, not a raw sensor element, so it needs no divider or pull resistor of
its own. `VCC` and `GND` go to the supply rail and ground respectively.

## Worked example

```json
{ "ref": "U1", "kind": "pir_sensor", "value": "HC-SR501", "nodes": ["VCC", "MOTION", "0"] }
```

## Gotchas

- **A wrong pin order still validates.** Nothing checks that `nodes[1]` is
  actually the output — swap `OUT` and `GND` in the array and you get a clean
  board that never triggers. Copy the order from the table above.
- Most PIR boards have an onboard delay/sensitivity trim and take several
  seconds to settle after power-up; a "no trigger" complaint is often just
  read too early, not a wiring fault.
- Leaving `OUT` on a floating, single-connection net trips the `single_pin_net`
  warning — it must actually reach a GPIO.
