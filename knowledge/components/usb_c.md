---
kind: usb_c
label: "USB-C connector (USB 2.0)"
category: connector
pins: 17
pin_order: [GND_A1, VBUS_A4, CC1, DP_A6, DM_A7, SBU1, VBUS_A9, GND_A12, GND_B12, VBUS_B9, SBU2, DM_B7, DP_B6, CC2, VBUS_B4, GND_B1, SHIELD]
pin_order_source: fixedPins
spice_prefix: J
aliases: [usb-c, type-c, usb c, type c receptacle, usb connector]
wiring_only: true
status: core
---

# USB-C connector (USB 2.0)

The full 16-pin USB 2.0 Type-C receptacle (the kind on every dev board),
plus its shield, wired as a connector — copper and a mating face, never a
SPICE element. Reach for it as the 5 V power entry and/or USB 2.0 data port
of a modern design; it pairs naturally with
[`charge_controller`](charge_controller.md) and the
[`esp32_s3_wroom`](esp32_s3_wroom.md)'s native USB on `IO19`/`IO20`.

## Pin contract

`nodes` must list exactly 17 net names. The order is the receptacle's
physical pad order — A1→A12 across the top row, then B12→B1 back across the
bottom, then the shell. Repeated roles carry their pin position in the name
(`VBUS_A4`); `CC1`/`CC2`/`SBU1`/`SBU2` appear once each and keep bare names.

| # | Pin | Role |
|---|-----|------|
| 1 | `GND_A1` | Ground. |
| 2 | `VBUS_A4` | 5 V bus. All four VBUS pads carry the same rail — tie them to one net. |
| 3 | `CC1` | Configuration channel 1. A power-sink board pulls this down with 5.1 kΩ. |
| 4 | `DP_A6` | USB 2.0 D+ (A orientation). |
| 5 | `DM_A7` | USB 2.0 D− (A orientation). |
| 6 | `SBU1` | Sideband use — `NC_` in USB 2.0 designs. |
| 7 | `VBUS_A9` | 5 V bus. |
| 8 | `GND_A12` | Ground. |
| 9 | `GND_B12` | Ground. |
| 10 | `VBUS_B9` | 5 V bus. |
| 11 | `SBU2` | Sideband use — `NC_` in USB 2.0 designs. |
| 12 | `DM_B7` | USB 2.0 D− (B orientation). Tie to the same net as `DM_A7`. |
| 13 | `DP_B6` | USB 2.0 D+ (B orientation). Tie to the same net as `DP_A6`. |
| 14 | `CC2` | Configuration channel 2. Needs its **own** 5.1 kΩ pull-down (never share one resistor with CC1). |
| 15 | `VBUS_B4` | 5 V bus. |
| 16 | `GND_B1` | Ground. |
| 17 | `SHIELD` | Shell. Conventionally tied to ground on small boards. |

Ground is `"0"`. Every unused pin still needs an entry, as
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part note, e.g. `"USB-C 16-pin"` or a manufacturer number
(`"GCT USB4085"`). Not parsed — the kind alone selects the wiring-only
connector.

## Wiring rules

- **Power-only sink** (the common case): all four `VBUS_*` to one 5 V net,
  all four `GND_*` plus `SHIELD` to `"0"`, and a 5.1 kΩ resistor from each of
  `CC1` and `CC2` to ground — without both pull-downs a USB-C source never
  turns VBUS on. Everything else `NC_`. **No topology rule checks the CC
  pull-downs**; this table is the only guard.
- **USB 2.0 data**: bridge the orientation pairs — `DP_A6` with `DP_B6` on
  one net, `DM_A7` with `DM_B7` on another — then to the MCU (e.g.
  `esp32_s3_wroom` `IO19`/`IO20`).
- As a `category: connector` kind it is exempt from `dead_active_device`:
  wired to nothing but power and ground is its normal state.

## Worked example

Power-only USB-C input feeding a TP4056 charger:

```json
{ "ref": "J1", "kind": "usb_c", "value": "USB-C 16-pin",
  "nodes": ["0", "VBUS", "CC1", "NC_J1_4", "NC_J1_5", "NC_J1_6", "VBUS", "0",
            "0", "VBUS", "NC_J1_11", "NC_J1_12", "NC_J1_13", "CC2", "VBUS", "0", "0"] },
{ "ref": "R1", "kind": "resistor", "value": "5.1k", "nodes": ["CC1", "0"] },
{ "ref": "R2", "kind": "resistor", "value": "5.1k", "nodes": ["CC2", "0"] }
```

`CC1` is position 3 and `CC2` position 14 — count from the pin table, not
from intuition; the A row and B row run in opposite directions.

## Gotchas

- **A wrong pin order validates cleanly.** `fixed_pin_node_count` checks 17,
  not the order — and the B row running B12→B1 makes off-by-one shifts easy.
  Assert pad → net against the table after layout (procedure step 8).
- **Missing CC pull-downs is the classic dead board.** With a USB-C-to-C
  cable the source supplies no VBUS until it sees the 5.1 kΩ sink
  advertisement. A USB-A-to-C cable masks the bug by supplying VBUS anyway.
- One shared pull-down across both CC pins breaks orientation detection —
  one resistor per pin.
- The board footprint is a synthesized dual-row header, not a real
  castellated receptacle — buildable for prototyping, but swap in a vendored
  USB-C footprint before ordering boards (follow-up in the tracker).
