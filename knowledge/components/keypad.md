---
kind: keypad
label: "Keypad (4x4 membrane)"
category: input
pins: 8
pin_order: [R1, R2, R3, R4, C1, C2, C3, C4]
pin_order_source: fixedPins
spice_prefix: U
aliases: [membrane keypad, matrix keypad, 4x4 keypad]
wiring_only: true
status: core
---

# Keypad (4x4 membrane)

A 4x4 matrix of momentary contacts (16 keys) exposed as an 8-pin ribbon: four
row lines and four column lines. Reach for it for numeric/alphanumeric entry
— PIN pads, menu selection — without spending 16 individual GPIOs.

## Pin contract

`nodes` must list exactly 8 net names, in this order (physical ribbon order,
rows then columns):

| # | Pin | Role |
|---|-----|------|
| 1 | `R1` | Row 1. |
| 2 | `R2` | Row 2. |
| 3 | `R3` | Row 3. |
| 4 | `R4` | Row 4. |
| 5 | `C1` | Column 1. |
| 6 | `C2` | Column 2. |
| 7 | `C3` | Column 3. |
| 8 | `C4` | Column 4. |

There is no `GND`/`VCC` pin — the matrix is a passive grid of switch
contacts, powered entirely by the MCU pins driving it. Ground is `"0"` where
relevant elsewhere on the board. For a pin you deliberately leave
unconnected use `"NC_<REF>_<pinNumber>"`.

## Value

Free-form part identification, e.g. `"4x4 membrane"`. This kind is
`wiring_only` — no SPICE model — so the value string carries no simulated
behaviour.

## Wiring rules

All 8 pins (`R1`–`C4`) must connect **directly to MCU GPIO pins**, not
through a resistor or any intermediate component — the firmware scanning
routine that reads the matrix relies on identifying which net ties to which
Uno pin directly; a series resistor breaks that identification in the
simulator (and gains nothing on real hardware either, since the matrix has
no analog behaviour to protect against).

Standard scanning approach: firmware drives each row low in turn (others
high-Z or high) and reads the columns to see which key, if any, is pressed on
that row.

## Worked example

```json
{ "ref": "U1", "kind": "keypad", "value": "4x4 membrane",
  "nodes": ["D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9"] }
```

All eight rows/columns land on distinct GPIO pins of the same MCU.

## Gotchas

- **This part only comes alive in the interactive simulator when firmware
  runs on a connected Arduino Uno and the ribbon pins are wired straight to
  its pins** — no adapter resistors, no shared nets with anything else. Route
  it any other way and it silently falls back to "wiring-only, not
  simulated."
- 8 GPIOs is a lot to dedicate to one input device — before committing pins,
  check whether the project can spare four rows and four columns, or whether
  a smaller keypad / an I/O expander fits better.
- Rows and columns are physically interchangeable in the sense that swapping
  a row net for a column net still scans *something* — but firmware written
  against the documented `R1`–`C4` order will read the wrong keys if the
  physical pinout doesn't match, and nothing here validates that mapping.
