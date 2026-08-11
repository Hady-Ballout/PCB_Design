---
kind: charge_controller
label: "Li-ion charger (TP4056)"
category: power
pins: 6
pin_order: [IN+, IN-, B+, B-, OUT+, OUT-]
pin_order_source: fixedPins
spice_prefix: V
aliases: [tp4056, lipo charger, battery charger, charging module]
status: core
---

# Li-ion charger (TP4056)

The ubiquitous TP4056 charging breakout **with onboard DW01 protection**:
5 V in, one Li-ion/LiPo cell managed, protected output to the load. Reach for
it whenever a design charges a single cell from USB — it is the module hobby
builds actually use, and the protection (over-discharge, over-current) is
already on the board.

## Pin contract

`nodes` must list exactly 6 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `IN+` | 5 V charge input (USB VBUS or any 4.5–5.5 V source). |
| 2 | `IN-` | Charge input return. Normally `"0"`. |
| 3 | `B+` | Battery positive — to the cell, e.g. a [`battery_connector`](battery_connector.md) `BAT+`. |
| 4 | `B-` | Battery negative. |
| 5 | `OUT+` | Protected output to the load. Follows the battery voltage (3.0–4.2 V). |
| 6 | `OUT-` | Load return. Normally `"0"`. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`. The pin order is positional and only the count is
validated — assert the assignment yourself (procedure step 8).

## Value

Free-form part note, e.g. `"TP4056"`. If the string contains a voltage it is
read as the full-charge output voltage; both parsers (`chargeVoltage` in
`pcbGenerator.js`, `chargeVolts` in `sim/simValues.js`) **strip the TP4056
part number first so its digits never parse as 4056 volts** (the same trap as
`LM2596`), then fall back to `4.2`. Plain `"TP4056"` is the normal, correct
value.

## Wiring rules

- `IN+`/`IN-` come from a 5 V source — typically a [`usb_c`](usb_c.md)
  VBUS/GND pair or a `voltage_source` in a bench setup.
- `B+`/`B-` go **only** to the cell. Loads hang off `OUT+`/`OUT-`, never off
  `B+` — the DW01 protection is between B and OUT, and bypassing it defeats
  the module.
- The engine claims `OUT+`'s net at the full-charge voltage (4.2 V by
  default) for the voltage-domain rules, exactly as `buck_converter` claims
  its output.
- SPICE/simulation image: **one ideal DC source on `OUT+`** at the
  full-charge voltage. Charging behaviour (CC/CV, termination) is not
  simulated; the sim answers "what does the load see", not "how does the
  cell charge". There is deliberately no dropout sensing: a protected
  module's output follows the *battery*, so an unpowered `IN+` does not
  collapse `OUT+`.

## Worked example

USB-C powered single-cell charger with a protected 3.7 V load rail:

```json
{ "ref": "V1", "kind": "charge_controller", "value": "TP4056",
  "nodes": ["VBUS", "0", "BATP", "0", "VLOAD", "0"] },
{ "ref": "J2", "kind": "battery_connector", "value": "JST-PH", "nodes": ["BATP", "0"] },
{ "ref": "R1", "kind": "resistor", "value": "1k", "nodes": ["VLOAD", "0"] }
```

Note the ref is `V1`, not `U1` — the kind's `spice_prefix` is `V` because its
SPICE image is an ideal source, like `regulator` and `buck_converter`.

## Gotchas

- **The ref must start with `V`.** Writing `U1` for a charger module fails
  ref validation — same counterintuitive prefix as the regulator.
- **A load on `B+` bypasses the protection.** It validates and routes
  cleanly; only the pin-role table says it is wrong.
- On a hand-edited SPICE deck round-trip the V-line degrades to a
  `voltage_source` (the sync layer keeps only 2-pin V kinds) — the same
  accepted limitation as `regulator` and `buck_converter`.
- Charge current on the real module is set by its onboard PROG resistor
  (1.2 kΩ → ~1 A). This kind models the stock module; nothing in the engine
  checks the source can actually supply it.
