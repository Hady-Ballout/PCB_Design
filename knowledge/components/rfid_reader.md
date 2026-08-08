---
kind: rfid_reader
label: "RFID reader (RC522)"
category: module
pins: 8
pin_order: [3V3, RST, GND, IRQ, MISO, MOSI, SCK, SDA]
pin_order_source: fixedPins
spice_prefix: U
aliases: [rfid, rc522, nfc reader]
wiring_only: true
status: core
---

# RFID reader (RC522)

A 13.56 MHz RFID/NFC reader breakout, talking to a host MCU over SPI. Reach
for it for badge/tag access-control projects and card-read demos.

## Pin contract

`nodes` must list exactly 8 net names, in this order (the RC522 breakout's
physical header order):

| # | Pin | Role |
|---|-----|------|
| 1 | `3V3` | Logic and module supply. **3.3V only** — the chip is not 5V tolerant. |
| 2 | `RST` | Active-low reset. Wire to an MCU GPIO to reset the module in software, or tie to `3V3` to leave it always out of reset. |
| 3 | `GND` | Ground. |
| 4 | `IRQ` | Interrupt request, active low. Optional — leave `NC_` unless firmware polls it instead of the reset pin. |
| 5 | `MISO` | SPI data out (module → MCU). |
| 6 | `MOSI` | SPI data in (MCU → module). |
| 7 | `SCK` | SPI clock. |
| 8 | `SDA` | SPI chip select (labelled SDA on the silkscreen, but it's the SPI slave-select line, not I2C). |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part note, e.g. `"RC522"` or `"MFRC522"`. Not parsed — the kind
alone selects the wiring-only symbol.

## Wiring rules

- **This is a 3.3V-only part** (`MAX_INPUT_VOLTS.rfid_reader = 3.6`) with no
  onboard level shifting. Driving any of its pins from a 5V MCU (an Arduino
  Uno's SPI or GPIO output) is destructive; `voltage_domain_overdrive`
  flags a 5V driver on a net that also touches this module, and
  `pullup_exceeds_domain` catches a pull-up referenced to a 5V rail on the
  same net. Pair it with a 3.3V MCU — [esp32.md](esp32.md) or
  [raspberry_pi.md](raspberry_pi.md) — or add a level shifter to use it with
  an [arduino_uno.md](arduino_uno.md).
- All four SPI lines (`MISO`/`MOSI`/`SCK`/`SDA`) need to land on the host's
  SPI pins (or any GPIOs, if bit-banging); `SDA`/CS can be shared with other
  SPI devices on the same bus as long as each has its own chip-select net.

## Worked example

RC522 wired to an ESP32 (3.3V logic both sides, no level shifting needed):

```json
{ "ref": "U2", "kind": "rfid_reader", "value": "RC522", "footprint": "",
  "nodes": ["3V3", "RST", "0", "NC_U2_4", "MISO", "MOSI", "SCK", "SDA"] },
{ "ref": "U1", "kind": "esp32", "value": "ESP32-DevKitC", "footprint": "",
  "nodes": ["3V3", "0", "NC_U1_3", "3V3",
            "RST", "SDA", "MISO", "MOSI",
            "SCK", "NC_U1_10", "NC_U1_11", "NC_U1_12"] }
```

`IRQ` (position 4) is left `NC_` — most designs poll the module over SPI
rather than wire the interrupt line.

## Gotchas

- **A wrong pin order validates cleanly.** `fixed_pin_node_count` checks that
  you listed 8 nodes, not which physical pin each one is. Swap `MISO` and
  `MOSI` and the board looks fine right up until the SPI transaction fails.
- **`SDA` is not I2C.** The silkscreen label is inherited from the RC522's
  own datasheet naming and is easy to misread as an I2C signal — it is the
  SPI chip-select line, position 8.
- 5V is the single most common way to kill this module. There is no
  power-only "it'll probably survive" — anything over ~3.6V on any pin is
  out of spec.
