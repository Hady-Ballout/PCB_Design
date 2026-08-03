---
kind: seven_segment
label: "7-segment display"
category: display
pins: 9
pin_order: [A, B, C, D, E, F, G, DP, COM]
pin_order_source: fixedPins
spice_prefix: D
aliases: [7 segment, seven segment display, 7-seg]
status: core
---

# 7-segment display

A single common-cathode 7-segment digit: seven segment LEDs (A–G) plus a
decimal point, all sharing one cathode. Reach for it to show a single digit
without pulling in a full [lcd_display.md](lcd_display.md) or
[oled_display.md](oled_display.md).

## Pin contract

`nodes` must list exactly 9 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1–7 | `A`–`G` | Segment anodes, top-left-going-clockwise standard labeling. |
| 8 | `DP` | Decimal point anode. |
| 9 | `COM` | Common cathode. Almost always `"0"`. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number, e.g. `"common cathode"` or a specific part like
`"5161AS"`.

## Wiring rules

Each connected segment is simulated as its own diode from that segment's pin
to `COM` (common-cathode orientation: `COM` is the shared cathode, not an
anode). Driving a segment high without a series resistor overdrives that LED
exactly as with a bare [led.md](led.md) — but note the topology checker's
`led_no_series_resistor` rule only inspects `led`/`ir_led`/`rgb_led` legs and
the [optocoupler.md](optocoupler.md) input LED; it does **not** walk this
part's segment legs, so a missing series resistor here will not be flagged
automatically. Size and add one per segment anyway.

## Worked example

Segments A, B, and C lit (drawing the left edge of a "7"), each through its
own 220 Ω resistor from an MCU GPIO, common cathode to ground:

```json
{ "ref": "R1", "kind": "resistor", "value": "220", "nodes": ["GPIO2", "SEG_A"] },
{ "ref": "R2", "kind": "resistor", "value": "220", "nodes": ["GPIO3", "SEG_B"] },
{ "ref": "R3", "kind": "resistor", "value": "220", "nodes": ["GPIO4", "SEG_C"] },
{ "ref": "D1", "kind": "seven_segment", "value": "common cathode",
  "nodes": ["SEG_A", "SEG_B", "SEG_C", "NC_D1_4", "NC_D1_5", "NC_D1_6", "NC_D1_7", "NC_D1_8", "0"] }
```

## Gotchas

- **A wrong pin order still validates.** `fixed_pin_node_count` only checks
  that you listed 9 nodes. Swap two segment nets and the board routes clean
  and DRC passes, but the digit displays wrong shapes for every value you
  send it. Copy the order from the table above.
- **This is common-cathode, not common-anode.** `COM` is the shared cathode
  (ties to ground); each segment pin is an anode driven high to light it. A
  common-anode module wired the same way lights every segment except the one
  you intended.
- No rule enforces series resistors on the segment pins (see Wiring rules
  above) — an unlimited-current segment will not be caught by the topology
  checker the way a bare LED would be. Verify manually.
- `ref` for this kind starts with `D` (it's simulated as diodes, like
  [led.md](led.md)), not `U`, even though it behaves like a display module.
