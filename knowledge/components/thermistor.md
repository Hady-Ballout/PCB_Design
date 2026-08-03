---
kind: thermistor
label: "Thermistor"
category: sensor
pins: 2
pin_order: null
pin_order_source: none
spice_prefix: R
aliases: [ntc, ptc thermistor]
preferred_values: [10k]
status: core
---

# Thermistor

An NTC (or PTC) resistive temperature sensor: resistance changes with
temperature. Reach for it for a cheap analog temperature input where you don't
need the linear, calibrated output of a [temp_sensor.md](temp_sensor.md) module.

## Pin contract

`nodes` must list exactly 2 net names. Order does not matter — `pin_order` is
`null`, same as [resistor.md](resistor.md): a thermistor is a symmetric
two-terminal part with no polarity.

Ground is `"0"`.

## Value

Ohms, parsed exactly like a resistor's (`parseResistance` in
`topologyRules.js`; also consumed by `resistiveValue` in `pcbGenerator.js`).
`preferred_values` in this file's frontmatter is `["10k"]` — a common NTC
nominal resistance at 25°C, and the value this kind is simulated with is a
**fixed** resistance, not a temperature-dependent model. If the string fails
to parse, `pcbGenerator.js` falls back to 10k.

## Wiring rules

Like the photoresistor, a thermistor has no output pin — pair it with a fixed
resistor in a divider and sample the midpoint with an ADC. For a common 10 k
NTC, a 10 k fixed resistor centers the divider near room temperature so the
reading has headroom in both directions. Thermistor on the ground side gives a
voltage that *falls* as it heats up (NTC resistance drops with heat); on the
supply side it *rises* with heat.

## Worked example

10 k NTC on the ground side of a 10 k fixed resistor:

```json
{ "ref": "R1", "kind": "resistor",   "value": "10k", "nodes": ["VCC", "SENSE"] },
{ "ref": "R2", "kind": "thermistor", "value": "10k", "nodes": ["SENSE", "0"] }
```

## Gotchas

- **No output pin.** Left unpaired, a thermistor just sits on one net;
  `single_pin_net` flags that.
- The simulated resistance is fixed, not temperature-varying — good for
  checking divider math and range, not for testing thermal response.
- NTC vs PTC matters for which direction the voltage moves with heat — check
  the aliases/datasheet before assuming NTC behavior.
- Two thermistors (or a thermistor and a resistor) sharing both nets sit in
  parallel, not in series — a flat reading despite temperature swings usually
  means a net-naming mistake, not a bad part.
