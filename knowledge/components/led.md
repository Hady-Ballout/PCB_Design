---
kind: led
label: "LED"
category: diode
pins: 2
pin_order: [anode, cathode]
pin_order_source: ROLE_PINS
spice_prefix: D
aliases: [light emitting diode]
status: core
---

# LED

A light-emitting diode. Polarised: current flows anode → cathode and only in
that direction.

## Pin contract

`nodes` must list exactly 2 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `anode` | Positive side. Connects toward the supply or a driving output. |
| 2 | `cathode` | Negative side. Connects toward ground. |

Ground is `"0"`.

## Value

The colour, as a free-form string: `"Red"`, `"Green"`, `"Blue"`, `"White"`.
Colour implies forward voltage, which is what sizes the series resistor:

| Colour | Vf (typical) |
|--------|--------------|
| Red | 1.8–2.0 V |
| Yellow / amber | 2.0–2.2 V |
| Green | 2.0–3.2 V |
| Blue / white | 3.0–3.4 V |

## Wiring rules

**An LED always needs a series resistor.** Wired straight across a supply it
draws unlimited current and burns out. The `led_no_series_resistor` topology rule
catches this, and `led_polarity` catches a backwards LED.

Size the resistor from the driving voltage:

```
R = (V_drive − Vf) / I      with I ≈ 10–20 mA
```

At 20 mA an LED is bright; at 10 mA it is clearly visible and runs cooler. Round
up to the nearest E24 value — see [resistor.md](resistor.md).

## Worked example

Red LED driven from a 555 output on a 9 V rail. The output reaches about
VCC − 1.7 = 7.3 V, so `(7.3 − 2.0) / 330 ≈ 16 mA`:

```json
{ "ref": "R3", "kind": "resistor", "value": "330",  "nodes": ["OUT", "LED_A"] },
{ "ref": "D1", "kind": "led",      "value": "Red",  "nodes": ["LED_A", "0"] }
```

The resistor may sit on either side of the LED — series current is the same
either way. Anode-side reads more naturally.

## Gotchas

- **Reversing the nodes is silent in the JSON but wrong on the board.** The
  footprint is polarised and the part will not light.
- A driving IC output is not the supply rail. A 555 at 9 V delivers about 7.3 V;
  sizing the resistor against 9 V under-drives the LED slightly.
- Blue and white need ~3.2 V, so they will not light at all from a 3.3 V rail
  once a resistor drop is added.
