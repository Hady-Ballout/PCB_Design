---
kind: ultrasonic_sensor
label: "Ultrasonic sensor (HC-SR04)"
category: sensor
pins: 4
pin_order: [VCC, TRIG, ECHO, GND]
pin_order_source: fixedPins
spice_prefix: U
aliases: [hc-sr04, ultrasonic, sonar]
wiring_only: true
status: core
---

# Ultrasonic sensor (HC-SR04)

A distance-ranging module: a `TRIG` pulse fires a chirp, and `ECHO` goes high
for a duration proportional to the round-trip time. Reach for it for
obstacle-avoidance robots, parking sensors, and non-contact level/proximity
measurement.

## Pin contract

`nodes` must list exactly 4 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `VCC` | Supply, 5 V. |
| 2 | `TRIG` | Trigger input from a GPIO — pulse it high to start a ranging cycle. |
| 3 | `ECHO` | Echo output back to a GPIO — high for the round-trip duration, at 5 V logic level. |
| 4 | `GND` | Ground. Almost always `"0"`. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number, e.g. `"HC-SR04"`. This kind is `wiring_only`: the value
documents the part but doesn't drive a SPICE model — the ranging behaviour
isn't simulated.

## Wiring rules

`TRIG` and `ECHO` are two separate GPIO connections, not a single bus — do not
tie them together. The HC-SR04 runs its logic at 5 V (this part's `VCC` is
5 V, not 3.3 V), so **`ECHO` driving a 3.3 V-only MCU input (Raspberry Pi,
ESP32) needs a level shifter or a resistor divider** dropping it to a safe
voltage before the MCU pin. Note the `voltage_domain_overdrive` rule only
checks voltage flowing *from* an MCU's GPIO pin into another part — it does
not model a module like this one driving 5 V back into an MCU input, so the
board will validate clean even without the level shifter. Do not rely on the
checker here; an Arduino Uno's 5 V logic tolerates `ECHO` directly, but a
3.3 V MCU does not.

## Worked example

Wired to an MCU that tolerates 5 V logic (e.g. Arduino Uno):

```json
{ "ref": "U1", "kind": "ultrasonic_sensor", "value": "HC-SR04",
  "nodes": ["VCC", "TRIG", "ECHO", "0"] }
```

For a 3.3 V-logic MCU, insert a divider between `ECHO` and the MCU input —
see [resistor.md](resistor.md) — rather than wiring `ECHO` straight to the pin.

## Gotchas

- **A wrong pin order still validates.** Swap `TRIG` and `ECHO` and the board
  routes and looks fine, but the trigger pulse goes nowhere and the "echo"
  input is actually driving the sensor's trigger. Copy the order from the
  table above.
- Driving `ECHO` directly into a 3.3 V-only MCU is the single most common
  real-world HC-SR04 mistake — it works intermittently and then damages the
  input pin. The topology checker will not catch it for you (see above), so
  double-check this one by hand.
- `TRIG` and `ECHO` must be genuinely separate GPIO nets; some four-pin
  "ultrasonic" breakouts use a single shared I/O pin, but the HC-SR04 modeled
  here does not.
