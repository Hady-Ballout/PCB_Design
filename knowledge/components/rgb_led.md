---
kind: rgb_led
label: "RGB LED"
category: diode
pins: 4
pin_order: [red, green, blue, common]
pin_order_source: ROLE_PINS
spice_prefix: D
aliases: [rgb, tri-color led]
status: core
---

# RGB LED

A single package containing three LED dies (red, green, blue) sharing one
common lead. Reach for it for colour-mixing indicators. This kind models only
the **common-cathode** wiring: the `common` pin is always the cathode side for
all three colours, never the anode.

## Pin contract

`nodes` must list exactly 4 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `red` | Anode of the red die. |
| 2 | `green` | Anode of the green die. |
| 3 | `blue` | Anode of the blue die. |
| 4 | `common` | Shared cathode for all three dies. Ties toward ground. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form; there is no parsed meaning (unlike `led`'s colour value, colour here
is which of the three anode pins you drive, not the `value` string). Use it for
a part number or package note if you want one, e.g. `"5mm common cathode"`.

## Wiring rules

**Each colour needs its own series resistor**, exactly like a discrete LED.
`led_no_series_resistor` checks all three legs independently
(`red`↔`common`, `green`↔`common`, `blue`↔`common`) and flags any colour that
conducts straight from a source to ground with no resistor in that leg's loop.
Reusing one shared resistor ahead of all three anodes does not work as a
current limiter per colour — each colour has a different forward voltage, so
they'd draw unequal (and for the lowest-Vf colour, excessive) current. Give
each colour its own resistor.

The SPICE export uses three separate diode models — `DRED`, `DGRN`, `DBLU` —
one per colour, each from its anode pin to the shared `common` node.

**This kind is common-cathode only.** A common-*anode* RGB LED (where the
shared pin is the positive supply and each colour is switched low) does not
fit this pin contract — model it as three discrete [led.md](led.md) parts
instead if that's the package you have.

## Worked example

```json
{ "ref": "R5", "kind": "resistor", "value": "330", "nodes": ["VCC", "LED_R"] },
{ "ref": "R6", "kind": "resistor", "value": "220", "nodes": ["VCC", "LED_G"] },
{ "ref": "R7", "kind": "resistor", "value": "150", "nodes": ["VCC", "LED_B"] },
{ "ref": "D2", "kind": "rgb_led", "value": "", "nodes": ["LED_R", "LED_G", "LED_B", "0"] }
```

Each colour gets its own resistor sized for its own forward voltage; `common`
goes straight to ground.

## Gotchas

- **`common` in the wrong place is a silent short-to-supply, not a silent
  no-light.** If you wire `common` to the supply rail instead of ground
  (assuming common-anode when the part is common-cathode), every colour you
  drive high tries to source current backwards through the intended supply —
  don't guess the package type, check the datasheet.
- One shared series resistor ahead of all three anodes will not balance
  colours — size a resistor per colour as in the worked example.
- `led_no_series_resistor` checks each colour leg independently, so it is
  possible to add a resistor for red and blue and forget green; the rule will
  still catch that missing leg on its own.
