---
kind: esp32_s3_wroom
label: "ESP32-S3-WROOM-1"
category: microcontroller
pins: 41
pin_order: [GND, 3V3, EN, IO4, IO5, IO6, IO7, IO15, IO16, IO17, IO18, IO8, IO19, IO20, IO3, IO46, IO9, IO10, IO11, IO12, IO13, IO14, IO21, IO47, IO48, IO45, IO0, IO35, IO36, IO37, IO38, IO39, IO40, IO41, IO42, RXD0, TXD0, IO2, IO1, GND, EPAD]
pin_order_source: fixedPins
spice_prefix: U
aliases: [esp32-s3, esp32s3, s3 wroom, wroom-1]
mcu: true
wiring_only: true
status: core
---

# ESP32-S3-WROOM-1

The bare castellated ESP32-S3 module — 3.3V logic, WiFi + BLE 5, native USB —
wired as a schematic/PCB symbol rather than simulated; like the other
`mcu: true` boards it is outside SPICE and appears in the netlist as a comment
line. Unlike the [`esp32`](esp32.md) kind (a devkit with onboard regulator and
USB-UART), this is the module alone: **you** supply regulated 3.3V, the EN
pull-up, and the boot strapping. Reach for it when designing a real product
board rather than wiring around a devkit.

## Pin contract

`nodes` must list exactly 41 net names. The order is pins 1–41 of the
Espressif ESP32-S3-WROOM-1 datasheet, exactly as the castellations are
numbered (counter-clockwise from the top-left corner, EPAD last):

| # | Pin | Role |
|---|-----|------|
| 1 | `GND` | Ground. |
| 2 | `3V3` | 3.3V supply in, 3.0–3.6V. Budget ~500 mA peaks during WiFi TX; decouple close to the pin. |
| 3 | `EN` | Chip enable, active high. Pull to `3V3` (10k, plus ~1 µF to ground for a clean power-on ramp). Floating or low holds the chip in reset. |
| 4 | `IO4` | GPIO / ADC1_CH3. |
| 5 | `IO5` | GPIO / ADC1_CH4. |
| 6 | `IO6` | GPIO / ADC1_CH5. |
| 7 | `IO7` | GPIO / ADC1_CH6. |
| 8 | `IO15` | GPIO / ADC2_CH4. Optional 32 kHz crystal (XTAL_32K_P). |
| 9 | `IO16` | GPIO / ADC2_CH5. Optional 32 kHz crystal (XTAL_32K_N). |
| 10 | `IO17` | GPIO / ADC2_CH6. |
| 11 | `IO18` | GPIO / ADC2_CH7. |
| 12 | `IO8` | GPIO / ADC1_CH7. Arduino-ESP32 default I2C SDA. |
| 13 | `IO19` | GPIO / USB D−. Wire to a USB-C connector for native USB. |
| 14 | `IO20` | GPIO / USB D+. Pairs with `IO19`. |
| 15 | `IO3` | GPIO. Strapping pin (JTAG signal source) — leave unloaded at boot. |
| 16 | `IO46` | GPIO. Strapping pin (boot mode / ROM log) — do not pull high at boot. |
| 17 | `IO9` | GPIO / ADC1_CH8. Arduino-ESP32 default I2C SCL. |
| 18 | `IO10` | GPIO / ADC1_CH9. Conventional SPI CS. |
| 19 | `IO11` | GPIO / ADC2_CH0. Conventional SPI MOSI. |
| 20 | `IO12` | GPIO / ADC2_CH1. Conventional SPI SCK. |
| 21 | `IO13` | GPIO / ADC2_CH2. Conventional SPI MISO. |
| 22 | `IO14` | GPIO / ADC2_CH3. |
| 23 | `IO21` | GPIO. |
| 24 | `IO47` | GPIO. |
| 25 | `IO48` | GPIO. Drives the RGB LED on most S3 devkits. |
| 26 | `IO45` | GPIO. Strapping pin (VDD_SPI voltage) — do not pull high at boot. |
| 27 | `IO0` | GPIO. **BOOT strapping pin**: pull up 10k to `3V3`; a pushbutton to ground enters the serial bootloader. |
| 28 | `IO35` | GPIO. **Unavailable on octal-PSRAM (R8) variants** — the PSRAM claims it. |
| 29 | `IO36` | GPIO. Unavailable on R8 variants. |
| 30 | `IO37` | GPIO. Unavailable on R8 variants. |
| 31 | `IO38` | GPIO. |
| 32 | `IO39` | GPIO / JTAG MTCK. |
| 33 | `IO40` | GPIO / JTAG MTDO. |
| 34 | `IO41` | GPIO / JTAG MTDI. |
| 35 | `IO42` | GPIO / JTAG MTMS. |
| 36 | `RXD0` | UART0 receive (GPIO44). Serial console / flashing via an external USB-UART bridge. |
| 37 | `TXD0` | UART0 transmit (GPIO43). Pairs with `RXD0`. |
| 38 | `IO2` | GPIO / ADC1_CH1. |
| 39 | `IO1` | GPIO / ADC1_CH0. |
| 40 | `GND` | Ground (second ground castellation). |
| 41 | `EPAD` | Bottom thermal pad. Solder to the ground pour — required for thermal relief and EMC, not optional. |

Ground is `"0"`. Every unused pin still needs an entry, as
`"NC_<REF>_<pinNumber>"`. Pins matching `/^IO\d+$/` are treated as GPIO nets
by the topology checker; `3V3` and `EN` mark supply-side pins. `RXD0`/`TXD0`
do **not** match the GPIO pattern, so GPIO-level rules skip them — treat them
as the UART they are.

IO22–IO34 (minus 35–37) are not missing from this file; the module itself
does not expose them — those pads serve the internal flash/PSRAM.

## Value

Free-form: the ordering code, e.g. `"ESP32-S3-WROOM-1-N16R8"`. Not parsed —
the kind alone selects the wiring-only symbol.

## Footprint / package

Resolves to the hand-authored `RF_Module:ESP32-S3-WROOM-1` record — the real
castellated SMD land pattern, not a synthesized header:

- 18 × 25.5 mm body; the top ~7 mm is the PCB antenna keep-out, hatched on
  silkscreen with no pads or copper.
- 40 perimeter pads (1.5 × 0.9 mm) at 1.27 mm pitch on three edges — left
  pins 1–14 top-to-bottom, bottom 15–26 left-to-right, right 27–40
  bottom-to-top, the datasheet's counter-clockwise numbering — plus the
  3.9 × 3.9 mm `EPAD` under the body as pad 41. Pin 1 gets a silkscreen dot.
- All pads are top-layer SMD (drill 0); the KiCad and Gerber exports emit
  them as `smd` pads and the paste layer covers the EPAD as **one solid
  aperture** — a production stencil would window-pane it to ~65% coverage,
  so tell your fab or edit the stencil if you reflow this.

## Wiring rules

- **There is no VIN and no onboard regulator.** Feed `3V3` from a real 3.3V
  rail (an LDO or buck — see [regulator.md](regulator.md) /
  [buck_converter.md](buck_converter.md)) sized for ~500 mA WiFi bursts, with
  local decoupling (10 µF + 100 nF is the datasheet's minimum).
- `EN` must reach `3V3` — 10k pull-up, ideally with ~1 µF to ground so the
  chip releases from reset after the rail is stable.
- `IO0` wants a 10k pull-up for normal boot; add a pushbutton to ground if
  the board must be flashable without USB.
- Logic is 3.3V, absolute max ~3.6V in (`MAX_INPUT_VOLTS.esp32_s3_wroom =
  3.6`); `voltage_domain_overdrive` catches a 5V MCU driving these pins, but
  only when the driver is another MCU — a 5V module output passes silently.
- A GPIO sources/sinks only a few mA; `gpio_direct_load` and
  `gpio_current_budget` fire on heavy loads wired straight to a pin. Route
  anything heavier through a transistor or driver.
- Both `GND` pins **and** `EPAD` go to `"0"` — three entries, same net.

## Worked example

Minimal bootable wiring — regulated 3.3V, EN and BOOT pull-ups, an LED on
`IO48`, everything else deliberately `NC_`:

```json
{ "ref": "U1", "kind": "esp32_s3_wroom", "value": "ESP32-S3-WROOM-1-N8",
  "nodes": ["0", "3V3", "EN",
            "NC_U1_4", "NC_U1_5", "NC_U1_6", "NC_U1_7", "NC_U1_8",
            "NC_U1_9", "NC_U1_10", "NC_U1_11", "NC_U1_12", "NC_U1_13",
            "NC_U1_14", "NC_U1_15", "NC_U1_16", "NC_U1_17", "NC_U1_18",
            "NC_U1_19", "NC_U1_20", "NC_U1_21", "NC_U1_22", "NC_U1_23",
            "NC_U1_24", "LED1", "NC_U1_26", "BOOT",
            "NC_U1_28", "NC_U1_29", "NC_U1_30", "NC_U1_31", "NC_U1_32",
            "NC_U1_33", "NC_U1_34", "NC_U1_35", "NC_U1_36", "NC_U1_37",
            "NC_U1_38", "NC_U1_39", "0", "0"] },
{ "ref": "R1", "kind": "resistor", "value": "10k", "nodes": ["EN", "3V3"] },
{ "ref": "R2", "kind": "resistor", "value": "10k", "nodes": ["BOOT", "3V3"] },
{ "ref": "R3", "kind": "resistor", "value": "330", "nodes": ["LED1", "LED1K"] },
{ "ref": "D1", "kind": "led", "value": "red", "nodes": ["LED1K", "0"] }
```

`LED1` sits at position 25 (`IO48`) and `BOOT` at position 27 (`IO0`) —
counted from the pin table, not from the IO number. Getting that mapping
wrong validates cleanly, which is exactly why step 8 of the procedure says to
assert pad → net against the table after layout.

## Gotchas

- **A wrong pin order validates cleanly.** `fixed_pin_node_count` checks the
  count (41), not the order — and with 41 positional entries this kind is the
  easiest place in the whole catalog to shift an array by one. After layout,
  print pad → net against the pin table and check every named signal.
- **The pin names are the datasheet's `IOn`, not `GPIOn`.** The IO number is
  not the pin number: `IO15` is pin 8, `IO8` is pin 12. Always index by pin
  position, never by IO number.
- **Strapping pins** `IO0`, `IO3`, `IO45`, `IO46` change boot behaviour if
  loaded at reset; no topology rule checks this.
- **R8 (octal PSRAM) variants lose `IO35`–`IO37`.** Nothing validates the
  `value` ordering code against pin use — if the BOM says `R8`, those three
  nets are silently dead.
- **No USB-UART bridge on board.** Flash over native USB (`IO19`/`IO20`) or
  wire `RXD0`/`TXD0` to an external bridge; a design with neither cannot be
  programmed after assembly.
- Older saved circuits with fewer than 41 nodes are padded with `NC_`
  placeholders on load (`padMcuNodes`), but always write the full 41 for a
  new part.
