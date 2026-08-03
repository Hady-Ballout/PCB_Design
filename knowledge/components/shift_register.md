---
kind: shift_register
label: "Shift register (74HC595)"
category: driver-ic
pins: 16
pin_order: [QB, QC, QD, QE, QF, QG, QH, GND, QH2, SRCLR, SRCLK, RCLK, OE, SER, QA, VCC]
pin_order_source: fixedPins
spice_prefix: U
aliases: [74hc595, shift reg]
wiring_only: true
status: core
---

# Shift register (74HC595)

An 8-bit serial-in, parallel-out shift register. Reach for it to drive many
outputs (LEDs, a 7-segment display) from just three MCU pins instead of one
GPIO per output.

## Pin contract

`nodes` must list exactly 16 net names, in this order — this is the physical
DIP-16 pinout:

| # | Pin | Role |
|---|-----|------|
| 1–7 | `QB`–`QH` | Parallel outputs 1–7. |
| 8 | `GND` | Ground. |
| 9 | `QH2` | Serial output (QH′) — chain into the next register's `SER` for cascading. |
| 10 | `SRCLR` | Shift-register clear, active low. **Tie to VCC** unless actually used. |
| 11 | `SRCLK` | Shift clock, from an MCU GPIO. |
| 12 | `RCLK` | Storage/latch clock, from an MCU GPIO. |
| 13 | `OE` | Output enable, active low. **Tie to GND** to keep outputs always active. |
| 14 | `SER` | Serial data input, from an MCU GPIO. |
| 15 | `QA` | Parallel output 0. |
| 16 | `VCC` | Supply, 2–6 V. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number. Use `"74HC595"`.

## Wiring rules

Three control lines — `SER`, `SRCLK`, `RCLK` — go to MCU GPIOs. `SRCLR` must
be tied to `VCC` (not left floating) or the register clears itself; `OE`
must be tied to `GND` to keep the outputs driving continuously. Any `Q*`
output driving an LED still needs its own series resistor — see
[led.md](led.md); the register's outputs source only a few mA each, so do
not drive a motor or relay coil straight from a `Q` pin — go through a
[bjt_npn.md](bjt_npn.md) or [mosfet_n.md](mosfet_n.md) instead.

`missing_supply_decoupling` includes `shift_register` among the IC kinds
that need a bypass cap: with two or more such ICs on the board and none
found, it warns board-wide.

## Worked example

Driving 8 LEDs, MSB-first, from three GPIOs, with `SRCLR` tied high and `OE`
tied low:

```json
{ "ref": "U1", "kind": "shift_register", "value": "74HC595",
  "nodes": ["LED_B", "LED_C", "LED_D", "LED_E", "LED_F", "LED_G", "LED_H", "0",
            "NC_U1_9", "5V", "GPIO18", "GPIO23", "0", "GPIO24", "LED_A", "5V"] }
```

Each `LED_*` net feeds a 330 Ω resistor into an LED's anode, cathode to
ground, exactly as in [led.md](led.md)'s worked example.

## Gotchas

- **A wrong pin order still validates.** `fixed_pin_node_count` only checks
  that you listed 16 nodes. Swap `SRCLK` and `RCLK` and the board routes
  clean but bits never latch correctly. Copy the order from the table above
  — note the pinout is *not* alphabetical (`QB`...`QH` then `GND`, `QH2`,
  control pins, `QA` last).
- A floating `SRCLR` intermittently clears the register — always tie it to
  `VCC` unless firmware actually pulses it.
- `QH2` (pin 9) is the cascade-out pin, not an eighth output — the eight
  data outputs are `QA`–`QH`, split across positions 15 and 1–7.
