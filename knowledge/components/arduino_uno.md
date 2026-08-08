---
kind: arduino_uno
label: "Arduino Uno"
category: microcontroller
pins: 24
pin_order: [5V, 3V3, GND, VIN, D0, D1, D2, D3, D4, D5, D6, D7, D8, D9, D10, D11, D12, D13, A0, A1, A2, A3, A4, A5]
pin_order_source: fixedPins
spice_prefix: U
aliases: [arduino, uno, atmega328]
mcu: true
wiring_only: true
status: core
---

# Arduino Uno

A 5V-logic ATmega328 board, wired as a schematic/PCB symbol rather than
simulated — it and every other `mcu: true` kind sits outside SPICE, and the
netlist writer emits it as a comment (`* U1 arduino_uno (microcontroller
board, not simulated)`) instead of a device line. Reach for it when the
project needs firmware driving GPIOs at 5V logic, or when the design brief
just says "Arduino".

## Pin contract

`nodes` must list exactly 24 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `5V` | Regulated 5V rail out (or in, if powering via USB/barrel jack elsewhere). Logic level for every `D`/`A` pin below. |
| 2 | `3V3` | Onboard regulator's 3.3V rail. Low current budget (~50 mA) — don't power modules that draw more from it. |
| 3 | `GND` | Ground. |
| 4 | `VIN` | Unregulated input to the onboard 5V regulator, 7–12 V. Leave `NC_` unless you're feeding raw DC in. |
| 5 | `D0` | Digital I/O. Also UART RX — avoid using it if you need Serial. |
| 6 | `D1` | Digital I/O. Also UART TX — avoid using it if you need Serial. |
| 7 | `D2` | Digital I/O. |
| 8 | `D3` | Digital I/O (PWM-capable). |
| 9 | `D4` | Digital I/O. |
| 10 | `D5` | Digital I/O (PWM-capable). |
| 11 | `D6` | Digital I/O (PWM-capable). |
| 12 | `D7` | Digital I/O. |
| 13 | `D8` | Digital I/O. |
| 14 | `D9` | Digital I/O (PWM-capable). |
| 15 | `D10` | Digital I/O (PWM-capable). Also SPI SS. |
| 16 | `D11` | Digital I/O (PWM-capable). Also SPI MOSI. |
| 17 | `D12` | Digital I/O. Also SPI MISO. |
| 18 | `D13` | Digital I/O. Also SPI SCK. Driven high briefly at boot (onboard LED). |
| 19 | `A0` | Analog input, or digital I/O. |
| 20 | `A1` | Analog input, or digital I/O. |
| 21 | `A2` | Analog input, or digital I/O. |
| 22 | `A3` | Analog input, or digital I/O. |
| 23 | `A4` | Analog input, or digital I/O. Also I2C SDA. |
| 24 | `A5` | Analog input, or digital I/O. Also I2C SCL. |

Ground is `"0"`. With 24 pins, most designs only use a handful — every
pin you're not wiring still needs an entry, as `"NC_<REF>_<pinNumber>"`.
Every `D`/`A` pin matching `/^(D\d+|A\d+)$/` is treated as a GPIO net by the
topology checker; `5V`/`3V3`/`VIN` mark the supply rails it reasons about.

## Value

Free-form: a board note like `"Uno R3"`. It isn't parsed by anything — the
kind alone selects the wiring-only symbol.

## Wiring rules

- Logic level is 5V on every GPIO (`MCU_LOGIC_VOLTS.arduino_uno = 5`). Feeding
  a 5V Uno output into a 3.3V-only part (Raspberry Pi, ESP32, RFID reader,
  or anything else in the checker's 3.3V-max list) trips
  `voltage_domain_overdrive` — put a level shifter or divider in between.
- A GPIO can source/sink only a few mA before damage; `gpio_direct_load`
  flags a heavy load (motor, buzzer, low-ohm load) wired straight to a pin,
  and `gpio_current_budget` warns past ~12 mA estimated on one pin (errors
  above ~40 mA). Anything heavier needs a transistor or driver board between
  the pin and the load — see [led.md](led.md) for the simple case and
  [timer_555.md](timer_555.md) for a non-GPIO alternative.
- I2C devices on `A4`/`A5` need pull-ups to a supply rail or
  `i2c_missing_pullups` warns — see [rtc_module.md](rtc_module.md).
- `RESET`, oscillator and USB circuitry aren't part of this pin set; the
  board is drawn as a single symbol, not laid out at the component level.

## Worked example

Blinking an LED on `D9` with a series resistor, everything else unused:

```json
{ "ref": "U1", "kind": "arduino_uno", "value": "Uno R3", "footprint": "",
  "nodes": ["NC_U1_1", "NC_U1_2", "0", "NC_U1_4",
            "NC_U1_5", "NC_U1_6", "NC_U1_7", "NC_U1_8",
            "NC_U1_9", "NC_U1_10", "NC_U1_11", "NC_U1_12",
            "NC_U1_13", "LED_SIG", "NC_U1_15", "NC_U1_16",
            "NC_U1_17", "NC_U1_18", "NC_U1_19", "NC_U1_20",
            "NC_U1_21", "NC_U1_22", "NC_U1_23", "NC_U1_24"] },
{ "ref": "R1", "kind": "resistor", "value": "330", "nodes": ["LED_SIG", "LED_A"] },
{ "ref": "D1", "kind": "led", "value": "Red", "nodes": ["LED_A", "0"] }
```

`D9` is index 14, so `LED_SIG` sits at position 14 in the array — count
carefully, this board has the longest pin list of any kind here.

## Gotchas

- **A wrong pin order validates cleanly.** `fixed_pin_node_count` only checks
  that you listed 24 nodes, not that they're in the right slots. Swap two
  entries and you get a clean board for a circuit where firmware is talking
  to the wrong physical pin. Copy the order from the table above.
- **`D0`/`D1` double as Serial.** Wiring something permanent there breaks
  `Serial.begin()` / uploading over USB — most designs leave them `NC_`.
- Older saved circuits with fewer than 24 nodes get silently padded with
  `NC_` placeholders on load (`padMcuNodes`), so a stale 18-node Uno won't
  error — but you should still write the full 24 yourself for a new part.
- `dead_active_device` warns if the only nets touching `U1` are power and
  ground — a board with nothing wired to its GPIOs does nothing in the
  circuit and is usually a forgotten connection, not a finished design.
