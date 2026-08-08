---
kind: rotary_encoder
label: "Rotary encoder (KY-040)"
category: input
pins: 5
pin_order: [CLK, DT, SW, VCC, GND]
pin_order_source: fixedPins
spice_prefix: U
aliases: [encoder, ky-040]
wiring_only: true
status: core
---

# Rotary encoder (KY-040)

A quadrature knob with an integrated push switch. Reach for it for
open-ended value adjustment (volume, menu scrolling) where a
[potentiometer.md](potentiometer.md)'s fixed travel range doesn't fit, plus a
free click action.

## Pin contract

`nodes` must list exactly 5 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `CLK` | Quadrature channel A. To an MCU GPIO — required. |
| 2 | `DT` | Quadrature channel B. To an MCU GPIO — required. |
| 3 | `SW` | Integrated push switch, active-low. To an MCU GPIO. |
| 4 | `VCC` | Supply, typically 5 V or 3.3 V. |
| 5 | `GND` | Ground. Almost always `"0"`. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part identification, e.g. `"KY-040"`. This kind is `wiring_only` —
no SPICE model — so the value string carries no simulated electrical
behaviour by itself.

## Wiring rules

`CLK` and `DT` must connect **directly to MCU GPIO pins**, with no series
resistor in between — like the keypad, the firmware-bridge simulation (and
most real quadrature-decode libraries, which use pin-change interrupts)
depends on a direct net identity between the module and the MCU pin.

`SW` is the integrated click switch; it needs the same pull-up handling as
any bare button — internal `INPUT_PULLUP` in firmware, or an external
resistor. No topology rule enforces this for `rotary_encoder`
(`pushbutton_no_pull` only checks the `pushbutton` kind), so a floating `SW`
line will not be flagged.

## Worked example

```json
{ "ref": "U1", "kind": "rotary_encoder", "value": "KY-040",
  "nodes": ["D2", "D3", "D4", "5V", "0"] }
```

`D2`/`D3` are the interrupt-capable pins a quadrature library typically wants
for `CLK`/`DT`; `D4` is the click switch.

## Gotchas

- **`CLK`/`DT` behind a series resistor or a level shifter breaks the
  simulator's ability to identify the net as belonging to this module** — it
  silently falls back to unsimulated wiring-only behaviour rather than
  erroring.
- The knob's direction (clockwise = increment vs decrement) depends on
  whether `CLK` and `DT` are swapped relative to what the firmware library
  expects — this validates and boards cleanly either way; only testing the
  physical knob catches a reversed pair.
- `SW`'s missing pull-up is a silent floating input exactly like an
  unprotected pushbutton, but no rule warns about it here — check it by hand.
