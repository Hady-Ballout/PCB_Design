---
kind: esp32
label: "ESP32"
category: microcontroller
pins: 12
pin_order: [3V3, GND, VIN, EN, GPIO2, GPIO4, GPIO5, GPIO13, GPIO18, GPIO19, GPIO21, GPIO22]
pin_order_source: fixedPins
spice_prefix: U
aliases: [esp, wroom, devkit]
mcu: true
wiring_only: true
status: core
---

# ESP32

A 3.3V-logic WiFi/Bluetooth MCU devkit, wired as a schematic/PCB symbol
rather than simulated — like the other `mcu: true` boards it's outside SPICE
and shows up in the netlist as a comment line. Reach for it over the Arduino
Uno whenever the project needs wireless connectivity, or is explicitly
3.3V-logic.

## Pin contract

`nodes` must list exactly 12 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `3V3` | Regulated 3.3V logic rail. Every GPIO below runs at this level and tolerates at most ~3.6V in (`MAX_INPUT_VOLTS.esp32 = 3.6`). |
| 2 | `GND` | Ground. |
| 3 | `VIN` | Raw supply input to the onboard regulator (5V typical over USB). Leave `NC_` unless powering from a raw 5V/battery rail directly. |
| 4 | `EN` | Enable/reset, active high. Must be pulled to `3V3` to run — leaving it floating or low holds the chip in reset. |
| 5 | `GPIO2` | Digital I/O. Also a strapping pin (must not be held low at boot if you need normal boot mode). |
| 6 | `GPIO4` | Digital I/O. |
| 7 | `GPIO5` | Digital I/O. Strapping pin (SPI boot mode) — avoid loading it low at boot. |
| 8 | `GPIO13` | Digital I/O. |
| 9 | `GPIO18` | Digital I/O. |
| 10 | `GPIO19` | Digital I/O. |
| 11 | `GPIO21` | Digital I/O. Conventional default I2C SDA on Arduino-ESP32 boards. |
| 12 | `GPIO22` | Digital I/O. Conventional default I2C SCL on Arduino-ESP32 boards. |

Ground is `"0"`. This kind exposes only 12 of the devkit's ~30 physical
pins — the ones not in this list simply aren't representable, so pick real
boot-safe GPIOs for anything sensitive. Every unused pin here still needs an
entry, as `"NC_<REF>_<pinNumber>"`. Pins matching `/^GPIO\d+$/` are treated
as GPIO nets by the topology checker; `3V3`/`VIN` mark supply rails.

## Value

Free-form: a board note like `"ESP32-DevKitC"`. Not parsed — the kind alone
selects the wiring-only symbol.

## Wiring rules

- Logic is 3.3V and the chip is rated to at most 3.6V in
  (`MAX_INPUT_VOLTS.esp32 = 3.6`). Driving a GPIO from a 5V source (an
  Arduino Uno output, or a `pullup_exceeds_domain`-flagged pull-up to a 5V
  rail) is destructive; `voltage_domain_overdrive` and
  `pullup_exceeds_domain` both catch this pattern when the 5V source is
  another MCU on the same net.
- `EN` must reach `3V3`, directly or through the devkit's own reset button —
  otherwise the board never boots.
- A GPIO sources/sinks only a few mA; `gpio_direct_load` catches a heavy load
  wired straight to a pin, `gpio_current_budget` warns past ~12 mA estimated
  and errors past ~40 mA. Route anything heavier through a transistor or
  driver board.
- I2C on `GPIO21`/`GPIO22` needs pull-ups referenced to `3V3`, or
  `i2c_missing_pullups` warns — see [rtc_module.md](rtc_module.md).

## Worked example

DS3231 RTC on I2C, both boards on the 3.3V rail, with pull-ups to `3V3`:

```json
{ "ref": "U1", "kind": "esp32", "value": "ESP32-DevKitC", "footprint": "",
  "nodes": ["3V3", "0", "NC_U1_3", "3V3",
            "NC_U1_5", "NC_U1_6", "NC_U1_7", "NC_U1_8",
            "NC_U1_9", "NC_U1_10", "SDA", "SCL"] },
{ "ref": "U2", "kind": "rtc_module", "value": "DS3231", "footprint": "",
  "nodes": ["0", "3V3", "SDA", "SCL"] },
{ "ref": "R1", "kind": "resistor", "value": "4.7k", "nodes": ["SDA", "3V3"] },
{ "ref": "R2", "kind": "resistor", "value": "4.7k", "nodes": ["SCL", "3V3"] }
```

`GPIO21`/`GPIO22` sit at positions 11 and 12 in the ESP32's node array.
Both pull-ups are required or `i2c_missing_pullups` warns on `U2`. Full RTC
pin roles are in [rtc_module.md](rtc_module.md).

## Gotchas

- **A wrong pin order validates cleanly.** `fixed_pin_node_count` checks the
  count (12), not the order. Swap `GPIO18` and `GPIO19` and the board still
  passes every check while firmware talks to the wrong signal.
- **This part is 3.3V, not 5V-tolerant.** Wiring it next to an Arduino Uno on
  a shared signal net (say, both driving the same I2C bus) is a common way
  to overdrive it — check `voltage_domain_overdrive` output carefully
  whenever an Uno and an ESP32 share a net.
- `GPIO2` and `GPIO5` are strapping pins with boot-mode side effects; the
  pin table flags this but the checker does not — no rule here catches a
  strapping pin loaded low at boot.
- Older saved circuits with fewer than 12 nodes are padded with `NC_`
  placeholders automatically on load (`padMcuNodes`), but always write the
  full 12 for a new part.
