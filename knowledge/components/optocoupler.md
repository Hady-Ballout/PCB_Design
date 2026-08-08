---
kind: optocoupler
label: "Optocoupler (PC817)"
category: driver-ic
pins: 4
pin_order: [A, K, E, C]
pin_order_source: fixedPins
spice_prefix: X
aliases: [opto, pc817, optoisolator]
status: core
---

# Optocoupler (PC817)

A phototransistor optocoupler: an internal LED optically drives an isolated
output phototransistor, with no electrical connection between the two sides.
Reach for it to let a low-voltage MCU switch or sense a separate, electrically
isolated circuit (mains-adjacent loads, ground-loop-prone sensors) safely.

## Pin contract

`nodes` must list exactly 4 net names, in this order — this is the physical
DIP-4 pinout:

| # | Pin | Role |
|---|-----|------|
| 1 | `A` | Anode of the input LED. |
| 2 | `K` | Cathode of the input LED. |
| 3 | `E` | Emitter of the output phototransistor. |
| 4 | `C` | Collector of the output phototransistor. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number. Use `"PC817"`. It selects the `PC817` SPICE
subcircuit (an on/off switch model — CTR is not simulated), so the string is
documentation, not behaviour, exactly like [timer_555.md](timer_555.md)'s
`"NE555"`.

## Wiring rules

The input LED (`A`↔`K`) behaves exactly like a discrete LED and needs its own
series resistor — `led_no_series_resistor` checks this leg the same way it
checks a bare [led.md](led.md). The output side (`E`↔`C`) is a floating
switch: `E` and `C` never connect to the input side, so give the output its
own pull-up or pull-down as you would for an open-collector output.

## Worked example

An MCU GPIO driving the input LED through a resistor, with the output side
pulling a separate 12 V-domain net low when the LED is lit:

```json
{ "ref": "R1", "kind": "resistor",    "value": "330", "nodes": ["GPIO17", "OPTO_A"] },
{ "ref": "X1", "kind": "optocoupler", "value": "PC817", "nodes": ["OPTO_A", "0", "0", "SIG_OUT"] },
{ "ref": "R2", "kind": "resistor",    "value": "10k",  "nodes": ["12V", "SIG_OUT"] }
```

`E` ties to the isolated side's ground and `C` pulls up through R2 to the
isolated 12 V rail — `SIG_OUT` reads low when the input LED is on.

## Gotchas

- **A wrong pin order still validates.** `fixed_pin_node_count` only checks
  that you listed 4 nodes. Swap `A`/`K` or `E`/`C` and the board routes clean
  but the coupler never turns on (LED reversed) or the output reads
  backwards. Copy the order from the table above.
- **The output side has no built-in flyback protection.** Unlike
  [motor_driver.md](motor_driver.md) or [stepper_driver.md](stepper_driver.md),
  this part is not exempted from `missing_flyback_diode` — if you switch an
  inductive load (a motor) across `E`/`C`, add a discrete flyback diode
  across the load yourself.
- `E`/`C` are floating (isolated) until something biases them — a phototransistor
  with no pull resistor on the collector reads an undefined logic level when
  the LED is off.
