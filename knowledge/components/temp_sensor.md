---
kind: temp_sensor
label: "Temperature sensor"
category: sensor
pins: 3
pin_order: [VCC, OUT, GND]
pin_order_source: fixedPins
spice_prefix: U
aliases: [lm35, tmp36]
wiring_only: true
status: core
---

# Temperature sensor

An analog IC temperature sensor (LM35, TMP36, and equivalents) that outputs a
voltage proportional to temperature on a single pin. Reach for it when you
want a calibrated, linear temperature reading without the divider math and
lookup curve a bare [thermistor.md](thermistor.md) requires.

## Pin contract

`nodes` must list exactly 3 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `VCC` | Supply. |
| 2 | `OUT` | Analog voltage output proportional to temperature. Goes to an ADC input. |
| 3 | `GND` | Ground. Almost always `"0"`. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number, e.g. `"LM35"` or `"TMP36"`. This kind is `wiring_only`:
the value documents the part but doesn't drive a SPICE model. It matters in
practice though, because LM35 and TMP36 have different scale factors and
zero points — check the datasheet for the part you actually name here.

## Wiring rules

`OUT` goes directly to an ADC pin — it's already a buffered analog voltage, no
divider needed. `VCC` and `GND` go to supply and ground. Keep the supply
voltage within the part's rated range (an LM35 typically runs 4–20 V; a TMP36
runs 2.7–5.5 V) since that's a hard limit the sim can't check for a
`wiring_only` part.

## Worked example

```json
{ "ref": "U1", "kind": "temp_sensor", "value": "TMP36", "nodes": ["VCC", "TEMP", "0"] }
```

## Gotchas

- **A wrong pin order still validates.** Swap `OUT` and `VCC` and the board
  routes cleanly but reads garbage (or damages the part, since `OUT` is not
  meant to see supply voltage). Copy the order from the table above.
- LM35 and TMP36 have different zero points (LM35 reads 0 V at 0°C; TMP36
  reads 0.5 V at 0°C) — naming the wrong one in `value` doesn't break the
  board but will produce a wrong reading in firmware.
- `OUT` left on a single-pin net trips `single_pin_net` — it must actually
  reach an ADC.
