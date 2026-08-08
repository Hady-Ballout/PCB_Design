---
kind: sound_sensor
label: "Sound sensor (KY-038)"
category: sensor
pins: 4
pin_order: [VCC, GND, DO, AO]
pin_order_source: fixedPins
spice_prefix: U
aliases: [ky-038, microphone module, mic]
wiring_only: true
status: core
---

# Sound sensor (KY-038)

An electret-microphone breakout with an onboard comparator, giving both a
digital "loud enough" flag (`DO`, threshold set by the board's trim pot) and a
raw analog envelope (`AO`). Reach for it for clap detectors, noise-triggered
alarms, or anywhere you want a simple loudness gate without doing audio ADC
sampling yourself.

## Pin contract

`nodes` must list exactly 4 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `VCC` | Supply, typically 3.3–5 V. |
| 2 | `GND` | Ground. Almost always `"0"`. |
| 3 | `DO` | Digital output, high (or low, depending on board) when sound exceeds the trim-pot threshold. |
| 4 | `AO` | Analog output, the raw microphone envelope. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number, e.g. `"KY-038"`. This kind is `wiring_only`: the value
documents the part but doesn't drive a SPICE model.

## Wiring rules

Both `DO` and `AO` are already-driven outputs — wire whichever one you need to
a GPIO or ADC pin respectively; the one you don't use can be left as
`"NC_<REF>_<pinNumber>"`. `VCC` and `GND` go to supply and ground.

## Worked example

Using only the digital threshold output:

```json
{ "ref": "U1", "kind": "sound_sensor", "value": "KY-038",
  "nodes": ["VCC", "0", "LOUD", "NC_U1_4"] }
```

## Gotchas

- **A wrong pin order still validates.** Swap `DO` and `AO` and you'll read a
  digital high/low on what firmware expects to be a smoothly varying analog
  signal, or vice versa — the board still routes and simulates clean. Copy the
  order from the table above.
- The digital threshold is set by a physical trim pot on the module itself;
  nothing in this component model represents that pot, so "it never triggers"
  is usually a hardware trim issue, not a wiring one.
- Leaving both `DO` and `AO` unconnected (or on single-pin nets) means the
  sensor reads nothing useful — `single_pin_net` flags a used-but-dangling pin.
