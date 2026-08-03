---
kind: hall_sensor
label: "Hall sensor (A3144)"
category: sensor
pins: 3
pin_order: [VCC, GND, OUT]
pin_order_source: fixedPins
spice_prefix: U
aliases: [a3144, hall effect]
wiring_only: true
status: core
---

# Hall sensor (A3144)

A digital magnetic-field detector: `OUT` switches when a magnet passes near
it. Use it for speed sensing, door/lid detection, or RPM counting. It is
`wiring_only` — the engine places and wires it but does not simulate it.

## Pin contract

`nodes` must list exactly 3 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `VCC` | Supply. |
| 2 | `GND` | Ground. Almost always `"0"`. |
| 3 | `OUT` | Digital output, active on magnet presence. |

Ground is `"0"`. **Note the order** — this is `[VCC, GND, OUT]`. Other
3-pin sensors in this catalog use different orders (e.g.
[ir_receiver.md](ir_receiver.md) is `[OUT, GND, VCC]`); don't carry over
another sensor's order by habit.

## Value

Free-form part number, e.g. `"A3144"`. Since this kind is `wiring_only`, the
value has no effect on simulation — the netlist emits only a comment line for
this part.

## Wiring rules

- `OUT` on the A3144 is open-collector: it pulls low when triggered and
  otherwise floats. It needs a pull-up to `VCC` (or the MCU's logic supply)
  to read a clean high — most breakout modules include one onboard, but a
  bare A3144 does not. Nothing in this repo's rule set checks for this pull-up
  specifically, so get it right by hand.
- The A3144 datasheet's operating range starts at 4.5V — it will not run
  reliably at 3.3V. `hall_sensor` isn't in the engine's `MAX_INPUT_VOLTS`
  table (that table is about overvoltage, not undervoltage), so nothing
  flags a 3.3V supply as wrong; verify the rail yourself.
- `OUT` must be wired to a digital MCU pin, or the part does nothing — see
  the `dead_active_device` gotcha below.

## Worked example

```json
{ "ref": "U5", "kind": "hall_sensor", "value": "A3144", "nodes": ["VCC", "0", "D5"] }
```

## Gotchas

- **A wrong pin order still validates.** Confusing this part's `[VCC, GND,
  OUT]` order with the more common `[VCC, OUT, GND]` pattern used elsewhere
  in this catalog wires the MCU pin to ground and ground to the sensor's
  output — a clean-looking board that never triggers.
- If `OUT` is left `NC_...` while `VCC`/`GND` are wired, the
  `dead_active_device` rule fires: a `wiring_only` part with no live signal
  pin "does nothing in this circuit."
- Without a pull-up, `OUT` floats between triggers and can read either level
  at random — a classic "works on the bench, flaky on the shelf" bug.
