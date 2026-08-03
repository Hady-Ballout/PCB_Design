---
kind: rtc_module
label: "RTC (DS3231, I2C)"
category: module
pins: 4
pin_order: [GND, VCC, SDA, SCL]
pin_order_source: fixedPins
spice_prefix: U
aliases: [rtc, ds3231, ds1307, real time clock]
wiring_only: true
status: core
---

# RTC (DS3231, I2C)

A battery-backed real-time clock module talking I2C. Reach for it whenever a
project needs to keep wall-clock time across power cycles — data logging
with timestamps, alarms, scheduling — without relying on network time.

## Pin contract

`nodes` must list exactly 4 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `GND` | Ground. |
| 2 | `VCC` | Module supply. DS3231 breakouts commonly carry an onboard regulator/level circuitry and are not in the checker's 3.3V-max list, so wiring either 3.3V or 5V boards to it is unflagged — check your specific breakout's datasheet. |
| 3 | `SDA` | I2C data. |
| 4 | `SCL` | I2C clock. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"` — in practice all four pins on this module are
almost always wired.

## Value

Free-form part note, e.g. `"DS3231"` or `"DS1307"`. Not parsed — the kind
alone selects the wiring-only symbol.

## Wiring rules

- I2C needs pull-ups on `SDA` and `SCL` to a supply rail (4.7k is typical),
  or `i2c_missing_pullups` warns. Many DS3231 breakouts carry these
  onboard — if you're relying on that, note it rather than silently
  skipping the resistors.
- `SDA`/`SCL` can share the bus with any other I2C device (an
  [rtc_module.md](rtc_module.md) alongside an OLED, an IMU, etc.) as long as
  addresses don't collide — this checker doesn't verify addresses, only
  wiring.
- Unlike the RFID reader, this kind is **not** in the checker's
  `MAX_INPUT_VOLTS` list, so `voltage_domain_overdrive` will not flag a 5V
  MCU driving it — that reflects DS3231 breakouts commonly being
  5V-tolerant with onboard regulation, not a guarantee for every board.

## Worked example

DS3231 on an Arduino Uno's hardware I2C pins (`A4`/`A5`), with pull-ups to
`5V`:

```json
{ "ref": "U2", "kind": "rtc_module", "value": "DS3231", "footprint": "",
  "nodes": ["0", "5V", "SDA", "SCL"] },
{ "ref": "U1", "kind": "arduino_uno", "value": "Uno R3", "footprint": "",
  "nodes": ["5V", "NC_U1_2", "0", "NC_U1_4",
            "NC_U1_5", "NC_U1_6", "NC_U1_7", "NC_U1_8",
            "NC_U1_9", "NC_U1_10", "NC_U1_11", "NC_U1_12",
            "NC_U1_13", "NC_U1_14", "NC_U1_15", "NC_U1_16",
            "NC_U1_17", "NC_U1_18", "NC_U1_19", "NC_U1_20",
            "NC_U1_21", "NC_U1_22", "SDA", "SCL"] },
{ "ref": "R1", "kind": "resistor", "value": "4.7k", "nodes": ["SDA", "5V"] },
{ "ref": "R2", "kind": "resistor", "value": "4.7k", "nodes": ["SCL", "5V"] }
```

`A4`/`A5` sit at positions 23/24 in the Uno's node array — see
[arduino_uno.md](arduino_uno.md) for the full pin table.

## Gotchas

- **A wrong pin order validates cleanly.** `fixed_pin_node_count` only checks
  that you listed 4 nodes. Swap `SDA` and `SCL` and the board still passes
  every check while the I2C bus never enumerates the device.
- Missing pull-ups are a warning, not an error (`i2c_missing_pullups`), so a
  board with a floating I2C bus will still pass DRC — it just won't talk to
  the RTC on real hardware unless the module supplies its own pull-ups.
- This is the smallest fixed-pin part in the library at 4 pins — easy to
  assume `pin_order` doesn't matter here the way it wouldn't for a 2-pin
  passive. It still does; `GND`/`VCC` reversed is a short, not a no-op.
