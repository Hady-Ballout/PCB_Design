---
kind: ir_phototransistor
label: "IR phototransistor (raw receiver)"
category: sensor
pins: 2
pin_order: null
pin_order_source: none
spice_prefix: R
aliases: [photodiode, ir receiver diode]
status: core
---

# IR phototransistor (raw receiver)

A raw, undemodulated infrared light sensor: its conductance changes with IR
light level, the same way a photoresistor's does with visible light. Use it
for line-following / reflectance sensing, not for decoding a remote-control
signal — for that, use [ir_receiver.md](ir_receiver.md) instead. Not
polarised — the two nodes are interchangeable, which is why `pin_order` is
`null`.

## Pin contract

`nodes` must list exactly 2 net names. Order does not matter.

Ground is `"0"`.

## Value

A resistance string, exactly like [resistor.md](resistor.md)'s value grammar
(`"10k"`, `"4.7k"`, etc. — parsed by the same `resistiveValue` helper). It is
simulated as a fixed resistor of that value; if the value doesn't parse, the
engine falls back to `10k`.

## Wiring rules

This part is one leg of a resistor divider, exactly like a
[photoresistor.md](photoresistor.md). It always needs a second resistor (to
the supply, or to ground) so the shared node's voltage actually moves — wired
alone across a rail it just draws current with no readable signal.

```
divider_output = V_supply * R_other / (R_ir_phototransistor + R_other)
```

Feed the shared node into an analog-capable MCU pin.

## Worked example

```json
{ "ref": "R6", "kind": "resistor",            "value": "10k", "nodes": ["VCC", "IR_SENSE"] },
{ "ref": "R7", "kind": "ir_phototransistor",  "value": "10k", "nodes": ["IR_SENSE", "0"] }
```

`ref` starts with `R` — `spice_prefix` is `R`, since the engine treats this
kind exactly like a variable resistor.

## Gotchas

- Because `pin_order` is `null`, there's no "wrong order" mistake to make
  here — swapping the two nodes changes nothing.
- Used alone (no second resistor), the divider node never varies with light
  level; nothing in this repo's rule set names this part specifically to
  catch that, so double-check the divider is actually built.
- The `value` you write is a static resistance, not a live light-dependent
  simulation — the engine does not vary it in response to anything.
