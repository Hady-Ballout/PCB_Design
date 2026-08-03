---
kind: current_sensor
label: "Current sensor (ACS712)"
category: sensor
pins: 5
pin_order: [IP+, IP-, VCC, OUT, GND]
pin_order_source: fixedPins
spice_prefix: R
aliases: [acs712, hall current sensor]
status: core
---

# Current sensor (ACS712)

A Hall-effect module that reports load current as an analog voltage. Use it
when you need to measure current in a branch, not just switch it.

## Pin contract

`nodes` must list exactly 5 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `IP+` | High side of the current path. The load's supply current flows in here. |
| 2 | `IP-` | Low side of the current path. Continues on to the load. |
| 3 | `VCC` | Module supply (header pin, not the measured current). |
| 4 | `OUT` | Analog output voltage, proportional to the measured current. |
| 5 | `GND` | Module ground (header pin). |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

Only `IP+`/`IP-` carry the real load current — the engine's conduction model
treats them as a two-terminal shunt path, separate from the `VCC`/`OUT`/`GND`
header pins.

## Value

Free-form part/variant string, e.g. `"ACS712-20A"`. It does not change the
simulated behaviour: the SPICE image is a fixed `${REF}_S` resistor of
0.0012Ω (the ACS712's real internal shunt is ~1.2 mΩ) placed across `IP+`/
`IP-`, regardless of which current-range variant you write. The value is
documentation for the board, not an input to the simulator.

## Wiring rules

- `IP+`/`IP-` must sit **in series** with the load's supply path, the same
  way you'd wire an ammeter — current has to actually flow through the
  sensor, not just tap off a node.
- If either `IP+` or `IP-` is left `NC_...`, the engine emits no shunt line at
  all for this part, and the current path it was supposed to close is simply
  missing — check for a broken series loop rather than expecting a warning
  naming this part.
- `resistor_extreme_value` exists in part to steer people away from rolling
  their own milliohm shunt resistor (a plain [resistor.md](resistor.md) below
  1Ω trips it, since breadboard contact resistance dominates at that scale);
  use this kind instead when you need real current sensing.
- `VCC`/`GND` are ordinary power pins; `OUT` is the analog reading and, like
  any analog sensor output, only means something once you've decided what
  MCU pin reads it (an ADC pin, or an analog-capable GPIO).

## Worked example

Sensing current into a `dc_motor` load fed from a 12V rail:

```json
{ "ref": "R7", "kind": "current_sensor", "value": "ACS712-20A",
  "nodes": ["V12", "MOTOR_HI", "VCC", "AOUT", "0"] },
{ "ref": "M1", "kind": "dc_motor", "value": "10", "nodes": ["MOTOR_HI", "0"] }
```

`ref` starts with `R` — `current_sensor`'s `spice_prefix` is `R`, not `U`,
because the engine models it as a compound resistor image, even though it's
a sensor IC.

## Gotchas

- **A wrong pin order still validates.** Swap `IP+`/`IP-` with `VCC`/`OUT`
  and the board looks clean, but the "shunt" ends up across the module's own
  supply pins instead of the load's current path.
- Because `IP+`/`IP-` are symmetric in the SPICE model, reversing just those
  two doesn't break simulation — but it does reverse the sign of the reading
  on real hardware, which is a silent, not a caught, mistake.
- The value string choosing a different ACS712 current range does not change
  anything in this repo's simulation — don't expect a "-05B" vs "-30A" swap
  to visibly change the modeled output scaling.
