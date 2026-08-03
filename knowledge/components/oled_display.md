---
kind: oled_display
label: "OLED display (I2C)"
category: display
pins: 4
pin_order: [VCC, GND, SCL, SDA]
pin_order_source: fixedPins
spice_prefix: U
aliases: [oled, ssd1306]
wiring_only: true
status: core
---

# OLED display (I2C)

A small SSD1306-driven graphics OLED on an I2C header. Reach for it for
graphics/text output that needs more than a [seven_segment.md](seven_segment.md)
digit but doesn't justify a full parallel display.

## Pin contract

`nodes` must list exactly 4 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `VCC` | Supply, typically 3.3 V. |
| 2 | `GND` | Ground. |
| 3 | `SCL` | I2C clock. |
| 4 | `SDA` | I2C data. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number. Use `"SSD1306"`.

## Wiring rules

`SCL` and `SDA` are shared I2C bus lines — `i2c_missing_pullups` checks that
each one has a pull-up resistor to the logic supply somewhere on the net.
Most breakout boards for this part actually carry their own onboard
pull-ups, in which case the rule's warning is a false alarm you can note and
dismiss rather than a wiring defect — but if you can't confirm the specific
board has them, add explicit 4.7 k pull-ups as shown below.

## Worked example

```json
{ "ref": "U1", "kind": "oled_display", "value": "SSD1306",
  "nodes": ["3V3", "0", "SCL", "SDA"] },
{ "ref": "R1", "kind": "resistor", "value": "4.7k", "nodes": ["SDA", "3V3"] },
{ "ref": "R2", "kind": "resistor", "value": "4.7k", "nodes": ["SCL", "3V3"] }
```

## Gotchas

- **A wrong pin order still validates.** `fixed_pin_node_count` only checks
  the count. Swap `SCL` and `SDA` and the board routes clean but the display
  never initializes. Copy the order from the table above — note this part
  puts `VCC`/`GND` first and `SCL` before `SDA`, the opposite pin order from
  [lcd_display.md](lcd_display.md), which puts `GND`/`VCC` first and `SDA`
  before `SCL`. Do not assume the two displays share a pinout.
- This part is `wiring_only`: it is not simulated in SPICE, only checked for
  wiring completeness.
