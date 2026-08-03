---
kind: joystick
label: "Joystick (KY-023)"
category: input
pins: 5
pin_order: [GND, VCC, VRX, VRY, SW]
pin_order_source: fixedPins
spice_prefix: U
aliases: [ky-023, thumbstick]
wiring_only: true
status: core
---

# Joystick (KY-023)

A 2-axis analog thumbstick module with a click switch, built on two
potentiometers. Reach for it for analog XY input — menu navigation, game
control, pan/tilt aiming.

## Pin contract

`nodes` must list exactly 5 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `GND` | Ground. Almost always `"0"`. |
| 2 | `VCC` | Supply, typically 5 V or 3.3 V — this also sets the top of each axis's potentiometer swing. |
| 3 | `VRX` | Analog output for the X axis. Wire to an MCU analog input (`A0`, etc). |
| 4 | `VRY` | Analog output for the Y axis. Wire to an MCU analog input. |
| 5 | `SW` | Click switch, active-low. Bare switch to `GND` — needs a pull-up (internal `INPUT_PULLUP` or an external resistor). |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part identification, e.g. `"KY-023"`. This kind is `wiring_only`
for netlist/board purposes, but it does carry a live behavioral model in the
interactive simulator: `VRX`/`VRY` are stimulus-driven voltage sources whose
output tracks `VCC` scaled by the X/Y slider (centered near half of `VCC`,
matching an `analogRead()` of roughly 512 at rest), and `SW` is a variable
resistor to `GND` that closes when clicked.

## Wiring rules

`SW` is a bare switch to ground with no pull built into the module — same
requirement as [pushbutton.md](pushbutton.md): use the MCU's internal pull-up
in firmware, or add an external pull-up resistor from `SW` to the logic
supply. `pushbutton_no_pull` does not cover this kind (it only checks
`pushbutton` parts), so nothing will warn you here — you have to remember it
yourself.

`VRX`/`VRY` are analog outputs, not switched loads, so they connect straight
to MCU analog input pins with no series resistor or driver needed.

## Worked example

```json
{ "ref": "U1", "kind": "joystick", "value": "KY-023", "nodes": ["0", "5V", "A0", "A1", "D2"] }
```

`A0`/`A1` are analog reads for X/Y; `D2` is the click switch, expected to use
`INPUT_PULLUP` in firmware.

## Gotchas

- **No topology rule checks the `SW` pull-up on this part.** It is easy to
  wire `SW` straight to a GPIO, exactly like an unprotected pushbutton, and
  get no warning at all — the joystick's click line floats until you add the
  pull-up yourself.
- `VRX`/`VRY` idle near mid-scale, not at 0 or `VCC` — a firmware routine
  that expects a rest-state reading of 0 will misbehave; treat the centre as
  ~512 on a 10-bit ADC and calibrate deadzones around it.
- Powering `VCC` from 3.3 V instead of 5 V (or the reverse) does not break
  wiring or simulation, but it changes the analog voltage range the MCU's ADC
  sees — make sure the MCU's reference voltage matches.
