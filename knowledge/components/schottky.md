---
kind: schottky
label: "Schottky diode"
category: diode
pins: 2
pin_order: [anode, cathode]
pin_order_source: ROLE_PINS
spice_prefix: D
aliases: [schottky diode, 1n5819]
status: core
---

# Schottky diode

A rectifier diode with a much lower forward drop and faster switching than a
regular [diode.md](diode.md). Reach for it as a buck-converter catch/freewheel
diode, a flyback diode, or reverse-polarity protection where the extra 0.3–0.4 V
headroom over a silicon diode's ~0.7 V actually matters.

## Pin contract

`nodes` must list exactly 2 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `anode` | Positive side. Current flows in here when forward biased. |
| 2 | `cathode` | Negative side, marked with a band on the physical part. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number, e.g. `"1N5819"`. It is documentation only: every
schottky in a circuit shares one `DSCH` SPICE model
(`IS=1e-8 RS=0.5 N=1.05 BV=40 IBV=1u`) regardless of the string.

## Wiring rules

Forward orientation follows the normal diode rule — anode toward the source,
cathode toward the load — and `led_polarity` flags an unambiguously reversed
schottky exactly like a plain diode.

**Buck converter catch diode.** When a [buck_converter](buck_converter.md)-kind
part has an inductor on its `OUT` (switch) node, `buck_missing_catch_diode`
requires a schottky (or plain diode) from ground to that same switch node,
**cathode at the switch node**: `nodes: ["0", "<switch net>"]`. That looks
"reversed" by the normal forward-conduction rule, and `led_polarity` has an
explicit exemption for exactly this shape (rectifier kind, cathode on a
`buck_converter` OUT pin) so it does not false-positive on a correctly wired
catch diode.

It can also stand in for a plain [diode.md](diode.md) as a flyback diode across
a transistor-switched motor/relay — `missing_flyback_diode` accepts any
diode-kind part there.

## Worked example

Catch diode on a buck converter's switch node:

```json
{ "ref": "U1", "kind": "buck_converter", "value": "LM2596-5.0",
  "nodes": ["VIN", "SW", "0", "FB", "0"] },
{ "ref": "L1", "kind": "inductor",  "value": "33uH", "nodes": ["SW", "VOUT"] },
{ "ref": "D1", "kind": "schottky",  "value": "1N5819", "nodes": ["0", "SW"] },
{ "ref": "C1", "kind": "capacitor", "value": "100uF", "nodes": ["VOUT", "0"] }
```

## Gotchas

- **The catch-diode orientation is the one case where "cathode toward ground"
  is correct**, not reversed — it needs to block current from `SW` to ground
  during the on-phase and only conduct the freewheel current when the internal
  switch turns off. Wiring it the intuitive "anode up, cathode down" way
  (`["SW", "0"]`) shorts the switch node to ground every cycle.
- Confusing this with a plain flyback diode: a motor flyback diode goes
  *across the load* (cathode to supply, anode to the switched node); a buck
  catch diode goes *from ground to the switch node*. They look similar but
  serve different nets.
- Like [diode.md](diode.md), the value string does not change simulated
  behaviour — swapping `"1N5819"` for another schottky part number has no
  effect here.
