---
kind: bridge_rectifier
label: "Bridge rectifier"
category: diode
pins: 4
pin_order: [AC1, AC2, V+, V-]
pin_order_source: fixedPins
spice_prefix: D
aliases: [full bridge, diode bridge, graetz]
status: core
---

# Bridge rectifier

A four-diode package (Graetz bridge) that turns an AC waveform into pulsating
DC, regardless of which AC input is momentarily positive. Reach for it at the
front of a mains or transformer-fed power supply, ahead of the smoothing
capacitor.

## Pin contract

`nodes` must list exactly 4 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `AC1` | One AC input leg. Interchangeable with `AC2`. |
| 2 | `AC2` | The other AC input leg. Interchangeable with `AC1`. |
| 3 | `V+` | Rectified positive DC output. |
| 4 | `V-` | Rectified negative/return DC output. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

Internally this exports as four diodes in the standard bridge topology: `AC1`
and `AC2` each feed a diode into `V+` (anode at the AC pin, cathode at `V+`),
and `V-` feeds a diode into each of `AC1`/`AC2` (anode at `V-`, cathode at the
AC pin). `AC1`/`AC2` are symmetric and can be swapped freely; `V+`/`V-` cannot
— reversing them inverts the whole bridge and shorts the AC source through two
forward-biased diodes instead of rectifying it.

## Value

Free-form part number, e.g. `"DB107"`. It's documentation only — the exporter
always uses the same generic `DGEN` diode model for all four internal diodes,
regardless of the string.

## Wiring rules

- `AC1`/`AC2` connect to the transformer secondary or other AC source, in
  either order.
- `V+` is the positive DC rail after rectification; `V-` is the return/negative
  rail (commonly tied to `0` in a single-supply design, giving a rectified
  positive-only output).
- A smoothing capacitor across `V+`/`V-` is what turns the rectified pulses
  into usable DC — the bridge alone only removes the negative half-cycles, it
  does not filter.
- Downstream of `V+`/`V-`, treat this like any other DC source when applying
  the rest of the topology rules (series resistors for LEDs off the rectified
  rail, a regulator if a fixed voltage is needed, etc).

## Worked example

Mains-transformer secondary rectified and smoothed for a downstream 12 V
regulator input:

```json
{ "ref": "T1",  "kind": "signal_source",  "value": "SINE(0 17 60)", "nodes": ["ACL", "ACN"] },
{ "ref": "DB1", "kind": "bridge_rectifier", "value": "DB107",       "nodes": ["ACL", "ACN", "RAW", "0"] },
{ "ref": "C1",  "kind": "capacitor",       "value": "1000uF",       "nodes": ["RAW", "0"] },
{ "ref": "U1",  "kind": "regulator",       "value": "7812",         "nodes": ["RAW", "0", "V12"] }
```

## Gotchas

- **Swapping `V+` and `V-` is not the same mistake as swapping `AC1`/`AC2`.**
  The AC pins are genuinely interchangeable; the DC pins are not — reversing
  them puts two of the internal diodes in a direct short path across the AC
  source.
- The `fixed_pin_node_count` rule only checks that you supplied exactly 4
  nodes, not which physical net is which — a `V+`/`V-` swap still validates
  cleanly and produces a board that looks correct until it's powered.
- There is no smoothing built in. A bridge feeding a load directly (no
  capacitor across `V+`/`V-`) delivers 120 Hz (or 100 Hz) pulsating DC, not a
  steady rail.
