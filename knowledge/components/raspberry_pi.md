---
kind: raspberry_pi
label: "Raspberry Pi"
category: microcontroller
pins: 14
pin_order: [5V, 3V3, GND, GPIO2, GPIO3, GPIO4, GPIO17, GPIO18, GPIO27, GPIO22, GPIO8, GPIO9, GPIO10, GPIO11]
pin_order_source: fixedPins
spice_prefix: U
aliases: [pi, rpi, raspberry]
mcu: true
wiring_only: true
status: core
---

# Raspberry Pi

A 3.3V-logic single-board computer, wired as a schematic/PCB symbol rather
than simulated — like the other `mcu: true` boards it's outside SPICE and
appears in the netlist as a comment line. Reach for it when the design needs
a Linux-capable brain (camera, network, file storage) rather than a bare
microcontroller.

## Pin contract

`nodes` must list exactly 14 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `5V` | 5V rail. High current available — used for powering peripherals, not as a GPIO. |
| 2 | `3V3` | Regulated 3.3V logic rail. Every GPIO below runs at this level and tolerates at most ~3.6V in (`MAX_INPUT_VOLTS.raspberry_pi = 3.6`). |
| 3 | `GND` | Ground. |
| 4 | `GPIO2` | Digital I/O. Hardware I2C1 SDA. |
| 5 | `GPIO3` | Digital I/O. Hardware I2C1 SCL. |
| 6 | `GPIO4` | Digital I/O. |
| 7 | `GPIO17` | Digital I/O. |
| 8 | `GPIO18` | Digital I/O. |
| 9 | `GPIO27` | Digital I/O. |
| 10 | `GPIO22` | Digital I/O. |
| 11 | `GPIO8` | Digital I/O. Hardware SPI0 CE0 (chip select). |
| 12 | `GPIO9` | Digital I/O. Hardware SPI0 MISO. |
| 13 | `GPIO10` | Digital I/O. Hardware SPI0 MOSI. |
| 14 | `GPIO11` | Digital I/O. Hardware SPI0 SCLK. |

Ground is `"0"`. `GPIO8`–`GPIO11` (SPI0) were appended after the first three
GPIOs — new MCU pins are only ever appended so old saved circuits keep their
existing indices valid. Every unused pin still needs an entry, as
`"NC_<REF>_<pinNumber>"`. Pins matching `/^GPIO\d+$/` are GPIO nets to the
topology checker; `5V`/`3V3` mark supply rails.

## Value

Free-form: a board note like `"Pi 4"` or `"Pi Zero 2 W"`. Not parsed — the
kind alone selects the wiring-only symbol.

## Wiring rules

- Logic is 3.3V and every GPIO tolerates at most 3.6V
  (`MAX_INPUT_VOLTS.raspberry_pi = 3.6`) — **the Pi's GPIO header has no
  built-in 5V tolerance.** Driving a pin from an Arduino Uno's 5V output, or
  referencing a shared pull-up to a 5V rail, is destructive;
  `voltage_domain_overdrive` and `pullup_exceeds_domain` both catch this when
  the overdriving source is another MCU on the same net.
- A GPIO sources/sinks only a few mA; `gpio_direct_load` catches a heavy load
  wired straight to a pin and `gpio_current_budget` warns past ~12 mA
  estimated (errors past ~40 mA). Route motors, buzzers, and relay coils
  through a transistor or driver board instead.
- I2C on `GPIO2`/`GPIO3` and SPI on `GPIO8`–`GPIO11` need the usual support:
  I2C pull-ups referenced to `3V3` (`i2c_missing_pullups` warns without
  them), SPI needs its own CE/CS pin per device sharing the bus.

## Worked example

MicroSD module over the hardware SPI0 bus:

```json
{ "ref": "U1", "kind": "raspberry_pi", "value": "Pi 4", "footprint": "",
  "nodes": ["NC_U1_1", "3V3", "0",
            "NC_U1_4", "NC_U1_5", "NC_U1_6", "NC_U1_7", "NC_U1_8", "NC_U1_9", "NC_U1_10",
            "SD_CS", "SD_MISO", "SD_MOSI", "SD_SCK"] },
{ "ref": "U2", "kind": "sd_card", "value": "MicroSD SPI", "footprint": "",
  "nodes": ["3V3", "0", "SD_MISO", "SD_MOSI", "SD_SCK", "SD_CS"] }
```

`GPIO8`–`GPIO11` sit at positions 11–14 in the Pi's array — that's where
`SD_CS`/`SD_MISO`/`SD_MOSI`/`SD_SCK` land above. Full SD module pin roles
are in [sd_card.md](sd_card.md).

## Gotchas

- **A wrong pin order validates cleanly.** `fixed_pin_node_count` only checks
  that you listed 14 nodes, not which pin is which. Swap `GPIO9` and
  `GPIO10` (MISO/MOSI) and the board still passes every check while the SPI
  bus is wired backwards.
- **This part is not 5V tolerant on any pin.** A wrong-generation shield or a
  jumper meant for an Arduino will damage a Pi GPIO — always check
  `voltage_domain_overdrive` output when a Pi shares a net with a 5V board.
- Older saved circuits with fewer than 14 nodes (from before SPI0 was added
  to this kind) are padded automatically with `NC_` on load
  (`padMcuNodes`), but always write the full 14 for a new part.
