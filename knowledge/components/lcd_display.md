---
kind: lcd_display
label: "LCD 16x2 (I2C)"
category: display
pins: 4
pin_order: [GND, VCC, SDA, SCL]
pin_order_source: fixedPins
spice_prefix: U
aliases: [lcd, 1602, character lcd]
wiring_only: true
status: core
---

# LCD 16x2 (I2C)

A 16×2 character LCD behind a PCF8574 I2C backpack, reducing what would be a
16-wire parallel display to a 4-wire I2C header. Reach for it for simple
text status/menu output.

## Pin contract

`nodes` must list exactly 4 net names, in this order — this matches the
physical backpack header (`GND` first):

| # | Pin | Role |
|---|-----|------|
| 1 | `GND` | Ground. |
| 2 | `VCC` | Supply, typically 5 V. |
| 3 | `SDA` | I2C data. |
| 4 | `SCL` | I2C clock. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number. Use `"1602"` or `"16x2 LCD (PCF8574)"`.

## Wiring rules

`SDA` and `SCL` are shared I2C bus lines — `i2c_missing_pullups` checks that
each one has a pull-up resistor to the logic supply somewhere on the net (a
4.7 k resistor from `SDA`/`SCL` to `VCC` is the usual fix), since neither this
part nor a bare MCU I2C pin supplies one on its own. If another I2C device
(e.g. [oled_display.md](oled_display.md) or `rtc_module`) already shares the
same `SDA`/`SCL` nets, one shared pull-up pair covers the whole bus.

## Worked example

```json
{ "ref": "U1", "kind": "lcd_display", "value": "1602",
  "nodes": ["0", "5V", "SDA", "SCL"] },
{ "ref": "R1", "kind": "resistor", "value": "4.7k", "nodes": ["SDA", "5V"] },
{ "ref": "R2", "kind": "resistor", "value": "4.7k", "nodes": ["SCL", "5V"] }
```

## Gotchas

- **A wrong pin order still validates.** `fixed_pin_node_count` only checks
  the count. Swap `SDA` and `SCL` and the board routes clean but the display
  never responds on the bus. Copy the order from the table above — note
  `GND` comes first, not `VCC`.
- Many Arduino boards have built-in I2C pull-ups on `SDA`/`SCL`; on those
  boards the explicit resistors are redundant but harmless. On a Raspberry
  Pi or ESP32 they are usually required.
- This part is `wiring_only`: it is not simulated in SPICE, only checked for
  wiring completeness.
