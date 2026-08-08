---
kind: led_strip
label: "LED strip (WS2812 NeoPixel)"
category: display
pins: 3
pin_order: [VCC, DIN, GND]
pin_order_source: fixedPins
spice_prefix: U
aliases: [neopixel, ws2812, addressable led]
wiring_only: true
status: core
---

# LED strip (WS2812 NeoPixel)

An addressable RGB LED (or the head end of a strip of them), individually
controlled over a single-wire serial protocol. Reach for it for full-color,
individually addressable lighting rather than a single fixed-color
[led.md](led.md).

## Pin contract

`nodes` must list exactly 3 net names, in this order. This is the head-end
only (no `DOUT` — chaining further pixels is out of scope here):

| # | Pin | Role |
|---|-----|------|
| 1 | `VCC` | Pixel supply — **must** be the 5 V rail, not a GPIO. |
| 2 | `DIN` | Data in, from an MCU GPIO. |
| 3 | `GND` | Ground. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number. Use `"WS2812B"` or `"NeoPixel"`.

## Wiring rules

Each pixel can draw up to 60 mA — the `led_strip_power_from_gpio` rule
specifically checks the `VCC` pin (index 1) and errors if it lands on a GPIO
net; a GPIO simply cannot source that much current. `DIN`, in contrast, is
correctly a GPIO net — only the power pin is checked.

## Worked example

```json
{ "ref": "U1", "kind": "led_strip", "value": "WS2812B",
  "nodes": ["5V", "GPIO18", "0"] }
```

## Gotchas

- **`VCC` on a GPIO net is the one mistake this part exists to catch** — it
  looks harmless (LEDs do work from GPIO current in tiny test circuits) until
  more than one or two pixels are lit, at which point the GPIO pin
  brownouts or the MCU resets.
- A wrong pin order still validates against `fixed_pin_node_count` (which
  only checks the count of 3), but here it also matters for
  `led_strip_power_from_gpio` — get `VCC` and `DIN` backwards and the rule
  checks the wrong pin.
- A long strip (many pixels chained past this head end) needs bulk
  capacitance and sometimes a level-shifter on `DIN` from a 3.3 V MCU;
  neither is modeled here since this part represents the head pixel only.
