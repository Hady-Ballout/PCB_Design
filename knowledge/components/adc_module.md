---
kind: adc_module
label: "ADC (MCP3008)"
category: driver-ic
pins: 16
pin_order: [CH0, CH1, CH2, CH3, CH4, CH5, CH6, CH7, DGND, CS, DIN, DOUT, CLK, AGND, VREF, VDD]
pin_order_source: fixedPins
spice_prefix: U
aliases: [mcp3008, adc]
wiring_only: true
status: core
---

# ADC (MCP3008)

An 8-channel, 10-bit SPI analog-to-digital converter. Reach for it whenever a
digital-only MCU (a Raspberry Pi, which has no analog pins at all) needs to
read a potentiometer, thermistor, or any other analog sensor.

## Pin contract

`nodes` must list exactly 16 net names, in this order — this is the physical
DIP-16 pinout, so it doubles as the datasheet reference:

| # | Pin | Role |
|---|-----|------|
| 1–8 | `CH0`–`CH7` | Analog inputs, 0–VREF. Unused channels can float or be tied to `AGND`. |
| 9 | `DGND` | Digital ground. |
| 10 | `CS` | Chip select (active low), from an MCU GPIO. |
| 11 | `DIN` | SPI data in (MOSI), from the MCU. |
| 12 | `DOUT` | SPI data out (MISO), to the MCU. |
| 13 | `CLK` | SPI clock, from the MCU. |
| 14 | `AGND` | Analog ground. Tie to the same ground as `DGND`. |
| 15 | `VREF` | Reference voltage — sets the top of the input range. Usually tied to `VDD`. |
| 16 | `VDD` | Digital/analog supply, 2.7–5.5 V. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number. Use `"MCP3008"`.

## Wiring rules

`CS`, `DIN`, `DOUT`, and `CLK` go to four separate MCU GPIO/SPI pins — never
share a net between them. `VREF` is normally tied straight to `VDD` so the
full 0–VDD range maps to the 10-bit code; a lower `VREF` shrinks the input
range without changing resolution.

The `missing_supply_decoupling` rule treats `adc_module` as one of the ICs
that needs a bypass cap: with two or more decoupled-IC-kind parts on the
board and no capacitor from any supply net to ground, it fires a
board-wide warning. Add 100 nF from `VDD` to `0` close to the chip.

## Worked example

```json
{ "ref": "U1", "kind": "adc_module", "value": "MCP3008",
  "nodes": ["POT_WIPER", "NC_U1_2", "NC_U1_3", "NC_U1_4", "NC_U1_5", "NC_U1_6", "NC_U1_7", "NC_U1_8",
            "0", "GPIO8", "GPIO10", "GPIO9", "GPIO11", "0", "3V3", "3V3"] }
```

A single potentiometer wiper on `CH0`; the other seven channels are left
unconnected. `VREF` and `VDD` share the 3.3 V rail (typical on a Raspberry
Pi, whose SPI0 lines this example uses).

## Gotchas

- **A wrong pin order still validates.** `fixed_pin_node_count` only checks
  that you listed 16 nodes, not which signal landed where. Swap `DIN` and
  `DOUT` and the board routes clean but the Pi never reads a byte back. Copy
  the order from the table above.
- `AGND` and `DGND` are separate pins on the chip but should land on the same
  ground net (`"0"`) in a simple board — do not invent two ground nets.
- An input above `VREF` just clips to full-scale; it will not damage the
  chip, but the reading is meaningless. Confirm the sensor's output range
  fits under `VREF` before wiring it to a `CH*` pin.
- This part is `wiring_only` — it is not simulated in SPICE, only checked for
  wiring completeness. See [shift_register.md](shift_register.md) for the
  sibling 16-pin DIP part that shares the same "physical pin order = node
  order" convention.
