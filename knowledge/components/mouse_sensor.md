---
kind: mouse_sensor
label: "Mouse sensor (PMW3360, SPI)"
category: sensor
pins: 8
pin_order: [RST, GND, MOT, NCS, SCK, MOSI, MISO, VCC]
pin_order_source: fixedPins
spice_prefix: U
aliases: [pmw3360, optical sensor]
wiring_only: true
status: core
---

# Mouse sensor (PMW3360, SPI)

An optical motion-tracking sensor (the sensor used in high-end gaming mice)
that reports X/Y displacement over SPI. Reach for it for optical mice,
DIY trackballs, or surface-motion measurement — anything that needs precise
2D relative motion rather than a simple on/off or analog reading.

## Pin contract

`nodes` must list exactly 8 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `RST` | Active-low reset. |
| 2 | `GND` | Ground. Almost always `"0"`. |
| 3 | `MOT` | Active-low motion interrupt — goes low when new motion data is ready. |
| 4 | `NCS` | SPI chip select, active low. |
| 5 | `SCK` | SPI clock. |
| 6 | `MOSI` | SPI data in (controller → sensor). |
| 7 | `MISO` | SPI data out (sensor → controller). |
| 8 | `VCC` | Supply, 3.3 V. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number, e.g. `"PMW3360"`. This kind is `wiring_only`: the
value documents the part but doesn't drive a SPICE model — the SPI protocol
and motion data aren't simulated.

## Wiring rules

This is a standard SPI peripheral: `SCK`, `MOSI`, `MISO` share the MCU's SPI
bus, `NCS` gets its own GPIO for chip select, and `MOT` gets a GPIO configured
as an interrupt input (or is polled) so you know when new motion data is
ready. `RST` can go to a GPIO for a controlled reset, or be tied to `VCC` if
you never need to reset it in software.

**This part is 3.3 V only** — its kind appears in `MAX_INPUT_VOLTS` in
`topologyRules.js` with a 3.6 V ceiling. Power it from a 3.3 V rail and drive
its SPI lines from a 3.3 V-logic MCU (ESP32, Raspberry Pi). Driving any of its
pins from a 5 V MCU (Arduino Uno) trips `voltage_domain_overdrive`.

## Worked example

Wired to an ESP32's SPI bus with `RST` tied high:

```json
{ "ref": "U1", "kind": "mouse_sensor", "value": "PMW3360",
  "nodes": ["VCC", "0", "MOTION_INT", "CS", "SCK", "MOSI", "MISO", "VCC"] }
```

## Gotchas

- **A wrong pin order still validates.** This is an 8-pin part with a
  physical-header pin order that does not match the usual SPI-signal grouping
  (`RST, GND, MOT` come before the SPI lines, and `VCC` is last, not first) —
  swap two pins and you get a clean board that never talks to the sensor.
  Copy the order from the table above; do not guess from habit.
- **It is 3.3 V only.** Wiring it to an Arduino Uno's 5 V SPI bus is a real
  and destructive mistake that `voltage_domain_overdrive` will catch — do not
  suppress or route around that error.
- `MOT` is active-low and easy to mis-treat as active-high in firmware; that's
  a software bug the topology checker cannot see.
