---
kind: soil_moisture
label: "Soil moisture sensor (capacitive)"
category: sensor
pins: 3
pin_order: [VCC, GND, AOUT]
pin_order_source: fixedPins
spice_prefix: U
aliases: [soil sensor, moisture sensor]
wiring_only: true
status: core
---

# Soil moisture sensor (capacitive)

A capacitive probe module that outputs an analog voltage inversely related to
soil moisture (drier soil → higher voltage on most boards). Reach for it for
plant-watering and garden-monitoring projects — the capacitive design avoids
the corrosion problem of the older resistive (two-bare-electrode) soil
sensors.

## Pin contract

`nodes` must list exactly 3 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `VCC` | Supply, typically 3.3–5 V. |
| 2 | `GND` | Ground. Almost always `"0"`. |
| 3 | `AOUT` | Analog moisture output. Goes to an ADC input. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number, e.g. `"Capacitive v1.2"`. This kind is `wiring_only`:
the value documents the part but doesn't drive a SPICE model.

## Wiring rules

`AOUT` goes directly to an ADC pin — no divider needed, it's already a driven
analog output. `VCC` and `GND` go to supply and ground.

## Worked example

```json
{ "ref": "U1", "kind": "soil_moisture", "value": "Capacitive v1.2", "nodes": ["VCC", "0", "SOIL"] }
```

## Gotchas

- **A wrong pin order still validates.** Swap `GND` and `AOUT` and the board
  routes clean but the ADC reads a ground short instead of moisture. Copy the
  order from the table above.
- These probes drift and corrode faster than the label promises when left
  powered continuously in wet soil; many designs gate `VCC` through a GPIO or
  transistor so the probe is only powered for the moment of a reading — that's
  a firmware/driver concern, not something this topology model checks.
- `AOUT` on a single-pin net trips `single_pin_net` — it must actually reach
  an ADC.
