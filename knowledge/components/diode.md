---
kind: diode
label: "Diode"
category: diode
pins: 2
pin_order: [anode, cathode]
pin_order_source: ROLE_PINS
spice_prefix: D
aliases: [rectifier diode, 1n4148, 1n4007]
status: core
---

# Diode

A general-purpose rectifier diode. Reach for it for one-way current paths that
aren't about light: reverse-polarity protection, flyback/freewheeling across an
inductive load, or half-wave rectification. For visible indication use
[led.md](led.md); for a low-drop or high-speed rectifier use
[schottky.md](schottky.md); for voltage clamping/reference use
[zener.md](zener.md).

## Pin contract

`nodes` must list exactly 2 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `anode` | Positive side. Current flows in here when forward biased. |
| 2 | `cathode` | Negative side, marked with a band on the physical part. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number, e.g. `"1N4007"` or `"1N4148"`. It is documentation only:
the SPICE export always uses a single generic `DGEN` model for this kind
regardless of the string.

## Wiring rules

As a forward rectifier, the anode must face the source and the cathode must
face the load/ground; a diode wired backwards simply never conducts. The
`led_polarity` topology rule checks this — it flags a diode whose anode reaches
only ground and whose cathode reaches only the supply, the unambiguous reversed
case.

As a **flyback diode** across an inductive load (a motor or relay coil
switched by a transistor), the polarity is intentionally the opposite of
forward-conduction: cathode to the supply side, anode to the switched side, so
it stays reverse-biased (and non-conducting) during normal operation and only
conducts the inductive kick at turn-off. The `missing_flyback_diode` rule
checks for *some* diode-kind part (this one, `zener`, or `schottky`) wired
across a transistor-switched motor/relay/solenoid — it does not itself check
the diode's polarity.

## Worked example

Flyback diode across a transistor-driven DC motor:

```json
{ "ref": "Q1", "kind": "bjt_npn", "value": "2N2222", "nodes": ["MLOW", "BASE", "0"] },
{ "ref": "M1", "kind": "dc_motor", "value": "10", "nodes": ["VCC", "MLOW"] },
{ "ref": "D1", "kind": "diode", "value": "1N4007", "nodes": ["MLOW", "VCC"] }
```

`D1`'s cathode (`VCC`, the supply side) and anode (`MLOW`, the switched side)
are the reverse of the LED convention — that reversal is what keeps it silent
under normal operation and clamps the spike when `Q1` turns off.

## Gotchas

- **The flyback orientation looks backwards next to an LED.** Anode toward the
  switch, cathode toward the supply — the opposite of "anode toward the
  source." Get this wrong and the diode does nothing (or worse, shorts the
  supply through the transistor at turn-off).
- `led_polarity` only flags a diode when its anode reaches ground *exclusively*
  and its cathode reaches the supply *exclusively*. In a flyback loop the
  anode reaches the switched node, not ground, so a truly backwards flyback
  diode will not be caught by that rule — verify polarity by hand.
- The value string does not affect simulation at all; every plain diode shares
  the same `DGEN` model, so `"1N4148"` and `"1N4007"` behave identically here
  even though the real parts have different current/voltage ratings.
