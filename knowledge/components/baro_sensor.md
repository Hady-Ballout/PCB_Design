---
kind: baro_sensor
label: "Barometric sensor (BMP280, I2C)"
category: sensor
pins: 4
pin_order: [VCC, GND, SCL, SDA]
pin_order_source: fixedPins
spice_prefix: U
aliases: [bmp280, barometer, pressure sensor]
wiring_only: true
status: core
---

# Barometric sensor (BMP280, I2C)

Reads barometric pressure (and temperature) over I2C; use it for altitude
estimation or weather logging. It is `wiring_only` — the engine places and
wires it but does not simulate it in SPICE.

## Pin contract

`nodes` must list exactly 4 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `VCC` | Supply. |
| 2 | `GND` | Ground. Almost always `"0"`. |
| 3 | `SCL` | I2C clock. |
| 4 | `SDA` | I2C data. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part/module string, e.g. `"BMP280"`. Since this kind is
`wiring_only`, the value has no effect on simulation — the SPICE netlist emits
only a comment line for this part, never a subcircuit.

## Wiring rules

- `SCL`/`SDA` must land on the MCU's I2C bus. The `i2c_missing_pullups`
  topology rule looks for `SDA`/`SCL` by name in this part's `fixedPins` and
  warns if it can't find a [resistor.md](resistor.md) from that net to a
  supply net — add a 4.7k pull-up on each line, or note the MCU/module already
  has one onboard.
- `baro_sensor` is not in the engine's `MAX_INPUT_VOLTS` table, so nothing
  flags it for overvoltage the way `rfid_reader` gets flagged on a 5V bus.
  That does not mean the bare BMP280 die is 5V tolerant — it isn't (native
  supply is 1.71–3.6V). It means the docs assume you're using a breakout board
  with an onboard regulator, as most BMP280 modules are. Check your specific
  module before wiring `VCC` to a 5V rail.
- `SCL`/`SDA` are also the only two pins that count as "signal" here — see the
  `dead_active_device` gotcha below.

## Worked example

```json
{ "ref": "U2", "kind": "baro_sensor", "value": "BMP280", "nodes": ["VCC", "0", "SCL", "SDA"] },
{ "ref": "R1", "kind": "resistor", "value": "4.7k", "nodes": ["SCL", "VCC"] },
{ "ref": "R2", "kind": "resistor", "value": "4.7k", "nodes": ["SDA", "VCC"] }
```

## Gotchas

- **A wrong pin order still validates.** Nothing checks that position 3 is
  really `SCL` and not `SDA` — swap them and you get a clean board that never
  answers on the bus. Copy the order from the table above.
- If `VCC`/`GND` are wired but `SCL`/`SDA` are left `NC_`, the
  `dead_active_device` rule fires: a `wiring_only` part with no live signal
  pin "does nothing in this circuit."
- Two I2C devices sharing a bus need distinct addresses; nothing in this repo
  checks for an address collision, since addresses aren't part of the
  component model.
