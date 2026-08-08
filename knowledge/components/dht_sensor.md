---
kind: dht_sensor
label: "DHT temperature/humidity sensor"
category: sensor
pins: 3
pin_order: [VCC, DATA, GND]
pin_order_source: fixedPins
spice_prefix: U
aliases: [dht11, dht22, am2302]
wiring_only: true
status: core
---

# DHT temperature/humidity sensor

A single-wire digital sensor for ambient temperature and relative humidity.
Reach for it for climate logging or simple environmental triggers. It is
`wiring_only` — the engine places and wires it but does not simulate it.

## Pin contract

`nodes` must list exactly 3 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `VCC` | Supply. |
| 2 | `DATA` | Single-wire digital data line to an MCU pin. |
| 3 | `GND` | Ground. Almost always `"0"`. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number: `"DHT11"`, `"DHT22"`, or `"AM2302"` (the aliases this
kind matches on). Since this kind is `wiring_only`, the value has no effect on
simulation — the netlist emits only a comment line for this part.

## Wiring rules

- `DATA` must go to a digital MCU pin — it's a single-wire protocol, not
  analog.
- The DHT11/22 protocol expects `DATA` idling high; the bare sensor needs a
  pull-up to `VCC` (commonly 4.7k–10k) if the breakout board you're modelling
  doesn't already include one on its 3-pin header. Most breakout modules do.
- `VCC`/`DATA`/`GND` are the only three pins, and only `DATA` counts as a
  signal — see the `dead_active_device` gotcha below.

## Worked example

```json
{ "ref": "U1", "kind": "dht_sensor", "value": "DHT22", "nodes": ["VCC", "D2", "0"] }
```

## Gotchas

- **A wrong pin order still validates.** This part's pin order is `[VCC,
  DATA, GND]`; some other three-pin sensors in this catalog (e.g.
  [ir_receiver.md](ir_receiver.md)) use a different order. Copying the wrong
  neighbour's order wires power into the data line and validates clean.
- If `VCC`/`GND` are connected but `DATA` is left `NC_...`, the
  `dead_active_device` rule fires: a `wiring_only` part with no live signal
  pin "does nothing in this circuit."
- Reading faster than the sensor's minimum sample interval (real hardware:
  ~1–2 s) returns stale or garbage data — a firmware concern, not something
  this repo's rules check.
