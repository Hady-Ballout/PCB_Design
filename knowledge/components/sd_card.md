---
kind: sd_card
label: "SD card module (SPI)"
category: module
pins: 6
pin_order: [VCC, GND, MISO, MOSI, SCK, CS]
pin_order_source: fixedPins
spice_prefix: U
aliases: [micro sd, sd module, card reader]
wiring_only: true
status: core
---

# SD card module (SPI)

A microSD breakout that exposes the card over SPI. Reach for it for data
logging, config storage, or anything that needs more nonvolatile storage
than an MCU's onboard flash.

## Pin contract

`nodes` must list exactly 6 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `VCC` | Module supply. Most breakouts carry an onboard 3.3V regulator and level shifters so they accept 5V here, but bare/level-shifter-less boards do not — check your specific module. |
| 2 | `GND` | Ground. |
| 3 | `MISO` | SPI data out (card → MCU). |
| 4 | `MOSI` | SPI data in (MCU → card). |
| 5 | `SCK` | SPI clock. |
| 6 | `CS` | SPI chip select. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"` — in practice all six pins are almost always wired.

## Value

Free-form part note, e.g. `"MicroSD SPI"`. Not parsed — the kind alone
selects the wiring-only symbol.

## Wiring rules

- All four SPI lines (`MISO`/`MOSI`/`SCK`/`CS`) go to the host's SPI pins (or
  bit-banged GPIOs). `CS` must be a dedicated net if other SPI devices share
  the bus — see [rfid_reader.md](rfid_reader.md) for a bus-sharing example.
- Like [rtc_module.md](rtc_module.md), this kind is **not** in the checker's
  `MAX_INPUT_VOLTS` list, so `voltage_domain_overdrive` won't flag a 5V MCU
  driving it — most breakout boards genuinely are 5V-tolerant thanks to
  onboard level shifting, but that's a property of the breakout, not
  something this checker verifies for you.
- No pull-up/pull-down rules apply to SPI lines the way `i2c_missing_pullups`
  applies to I2C — SPI is push-pull, not open-drain.

## Worked example

MicroSD module on a Raspberry Pi's hardware SPI0 bus:

```json
{ "ref": "U2", "kind": "sd_card", "value": "MicroSD SPI", "footprint": "",
  "nodes": ["3V3", "0", "SD_MISO", "SD_MOSI", "SD_SCK", "SD_CS"] },
{ "ref": "U1", "kind": "raspberry_pi", "value": "Pi 4", "footprint": "",
  "nodes": ["NC_U1_1", "3V3", "0",
            "NC_U1_4", "NC_U1_5", "NC_U1_6", "NC_U1_7", "NC_U1_8", "NC_U1_9", "NC_U1_10",
            "SD_CS", "SD_MISO", "SD_MOSI", "SD_SCK"] }
```

The Pi's `GPIO8`–`GPIO11` (positions 11–14) are its hardware SPI0 pins —
full pin table in [raspberry_pi.md](raspberry_pi.md).

## Gotchas

- **A wrong pin order validates cleanly.** `fixed_pin_node_count` only checks
  that you listed 6 nodes. Swap `MISO` and `MOSI` and the board still passes
  every check while the card never mounts.
- SD cards draw current spikes during writes; a marginal 3.3V rail that's
  fine at idle can brown out during a write burst. Nothing in this checker
  models supply headroom for this kind — it's a hardware consideration, not
  a validated rule.
- `CS` idling low (rather than high) when unused holds the card selected and
  can prevent other SPI devices on the same bus from being read reliably.
