---
kind: gas_sensor
label: "Gas sensor (MQ-2)"
category: sensor
pins: 4
pin_order: [VCC, GND, DO, AO]
pin_order_source: fixedPins
spice_prefix: U
aliases: [mq-2, mq2, smoke sensor]
wiring_only: true
status: core
---

# Gas sensor (MQ-2)

A combustible-gas/smoke breakout module with both a digital threshold output
and an analog output. Reach for it for smoke or LPG/propane/methane
detection. It is `wiring_only` — the engine places and wires it but does not
simulate it.

## Pin contract

`nodes` must list exactly 4 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `VCC` | Supply. |
| 2 | `GND` | Ground. Almost always `"0"`. |
| 3 | `DO` | Digital output — trips high/low past an onboard trim-pot threshold. |
| 4 | `AO` | Analog output — proportional to gas concentration. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number, e.g. `"MQ-2"`. Since this kind is `wiring_only`, the
value has no effect on simulation — the netlist emits only a comment line for
this part.

## Wiring rules

- `DO` goes to a digital MCU pin, `AO` to an analog-capable one. Wire
  whichever output your circuit actually reads — you don't need both.
- The MQ-2's sensing element is a heated resistive film; real modules draw
  meaningfully more current at `VCC` than a typical breakout, and the heater
  needs 5V to reach operating temperature — do not expect it to work at
  3.3V. `gas_sensor` isn't in the engine's `MAX_INPUT_VOLTS` table, so no
  topology rule enforces this; get the supply right by hand.
- `VCC`/`GND` are power pins; at least one of `DO`/`AO` must be wired to a
  real signal, or the part does nothing — see the `dead_active_device`
  gotcha below.

## Worked example

```json
{ "ref": "U4", "kind": "gas_sensor", "value": "MQ-2", "nodes": ["VCC", "0", "D3", "NC_U4_4"] }
```

Here only the digital threshold output is used; the analog pin is
deliberately left unconnected.

## Gotchas

- **A wrong pin order still validates.** Swap `DO` and `AO` and you'll read
  the wrong signal type on the wrong MCU pin type — a clean board that
  behaves nothing like intended.
- If both `DO` and `AO` are left `NC_...`, the `dead_active_device` rule
  fires: a `wiring_only` part with no live signal pin "does nothing in this
  circuit."
- Real MQ-2 modules need tens of seconds to minutes of warm-up before
  readings stabilize — not something this repo models or checks.
