---
kind: ir_led
label: "IR emitter LED"
category: diode
pins: 2
pin_order: [anode, cathode]
pin_order_source: ROLE_PINS
spice_prefix: D
aliases: [infrared led, ir emitter]
status: core
---

# IR emitter LED

An infrared-emitting LED — invisibly lit, used to drive remote-control
transmitters and reflective/break-beam IR sensing pairs. Electrically it
behaves like a regular [led.md](led.md); the difference is wavelength (~940 nm)
and a lower forward voltage.

## Pin contract

`nodes` must list exactly 2 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `anode` | Positive side. Connects toward the supply or a driving output. |
| 2 | `cathode` | Negative side. Connects toward ground. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form, conventionally the wavelength: `"940nm"`. It's documentation only —
every `ir_led` in a circuit shares one `DIR` SPICE model
(`IS=1e-18 N=1.4 RS=6 CJO=2p BV=5 IBV=10u`), which is tuned for a lower forward
drop than the visible-LED `DRED` model rather than parsed from the string.

## Wiring rules

Same rules as a visible LED: it needs a series resistor, and it needs correct
polarity.

- `led_no_series_resistor` traces the anode→cathode leg for `ir_led` exactly
  like `led`, and flags it if it conducts straight from a supply/GPIO to
  ground with no resistor anywhere in the loop.
- `led_polarity` also covers `ir_led`, flagging the unambiguous reversed case
  (anode reaching only ground, cathode reaching only the supply).

Because the forward voltage is lower than a visible LED's (the `DIR` model
breaks down/conducts around a smaller drop), the same series resistor a red
LED uses will run an IR emitter at somewhat higher current — err toward a
larger resistor if you're driving it from a 5 V rail at full duty.

## Worked example

IR emitter driven from a GPIO through a 220 Ω resistor:

```json
{ "ref": "R4",   "kind": "resistor", "value": "220",  "nodes": ["GPIO5", "IR_A"] },
{ "ref": "DIR1", "kind": "ir_led",   "value": "940nm", "nodes": ["IR_A", "0"] }
```

## Gotchas

- **You cannot see whether it's actually lit.** Bench-test with a phone
  camera (most phone camera sensors show IR emitters as a visible glow) rather
  than trusting the schematic.
- Same silent-reversal risk as any polarised diode: swap the nodes and it
  simply never conducts, with no other visible symptom.
- Pairing it with an [ir_phototransistor](ir_phototransistor.md) receiver
  needs adequate drive current for the expected sensing distance — a resistor
  sized only to avoid burning out the LED may be too dim to be reliably
  detected across the gap you need.
