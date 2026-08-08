---
kind: ir_receiver
label: "IR receiver (TSOP38xx)"
category: sensor
pins: 3
pin_order: [OUT, GND, VCC]
pin_order_source: fixedPins
spice_prefix: U
aliases: [tsop, ir sensor, remote receiver]
wiring_only: true
status: core
---

# IR receiver (TSOP38xx)

A demodulating IR remote-control receiver: it filters a specific carrier
frequency and outputs the decoded digital pulse train directly. Use it for
reading remote-control signals; for a raw, undemodulated IR sensor use
[ir_phototransistor.md](ir_phototransistor.md) instead. It is `wiring_only` —
the engine places and wires it but does not simulate it.

## Pin contract

`nodes` must list exactly 3 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `OUT` | Digital output — decoded pulse train, active-low. |
| 2 | `GND` | Ground. Almost always `"0"`. |
| 3 | `VCC` | Supply. |

Ground is `"0"`. **Note the order** — this is `[OUT, GND, VCC]`, matching the
TSOP38xx's physical pin order facing the lens; it is not the `[VCC, GND,
OUT]` order used by [hall_sensor.md](hall_sensor.md).

## Value

Free-form part number, e.g. `"TSOP38238"`. Since this kind is `wiring_only`,
the value has no effect on simulation — the netlist emits only a comment line
for this part.

## Wiring rules

- `OUT` goes to a digital MCU pin capable of catching short pulses.
- The TSOP38xx's output stage already includes an internal pull-up, so `OUT`
  idles high without an external pull-up resistor — unlike
  [hall_sensor.md](hall_sensor.md)'s open-collector output.
- `VCC`/`GND` are power pins; `OUT` must be wired to a real signal, or the
  part does nothing — see the `dead_active_device` gotcha below.

## Worked example

```json
{ "ref": "U7", "kind": "ir_receiver", "value": "TSOP38238", "nodes": ["D7", "0", "VCC"] }
```

## Gotchas

- **A wrong pin order still validates.** This part's `[OUT, GND, VCC]` order
  is the reverse-feeling one in this catalog — copy it from the table above
  rather than assuming `VCC` comes first like it does on most other 3-pin
  sensors here.
- If `OUT` is left `NC_...` while `VCC`/`GND` are wired, the
  `dead_active_device` rule fires: a `wiring_only` part with no live signal
  pin "does nothing in this circuit."
- Carrier frequency (typically 38 kHz) must match the transmitting remote;
  picking the wrong TSOP38xx variant for the source is a real-world failure
  mode this repo's rules cannot see, since carrier frequency isn't part of
  the component model.
