---
kind: solar_panel
label: "Solar panel"
category: source
pins: 2
pin_order: [+, −]
pin_order_source: ROLE_PINS
spice_prefix: V
aliases: [pv panel, photovoltaic]
status: core
---

# Solar panel

A photovoltaic DC source — a battery substitute for panel-powered or
renewable-energy circuits. Electrically it behaves like
[voltage_source.md](voltage_source.md) with one difference: the live
simulator gives it internal resistance so it sags under load, the way a real
small panel does.

## Pin contract

`nodes` must list exactly 2 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `+` | Positive terminal. The net this part energises. |
| 2 | `−` | Negative terminal. Almost always `"0"`. |

This order comes from `ROLE_PINS.solar_panel` (`['+', '−']`) in
`topologyRules.js` — `pin_order_source` is `ROLE_PINS`. It matters for the
same reason it matters on `voltage_source`: `nodes[0]` is specifically what
`topologyRules.js` reads as the energized net (both for `supplyNets`
membership and for the voltage claimed in `buildNetVolts`).

Ground is `"0"`.

## Value

The panel's open-circuit voltage, as a string with a unit: `"5V"`, `"12V"`.
Parsed the same way as [voltage_source.md](voltage_source.md) — first number
found, with an optional trailing `v`/`volts`.

## Wiring rules

- The positive net (`nodes[0]`) must reach at least one other part, or
  `orphan_supply`-style reasoning (via `supplyNets`/reachability) treats the
  rail as unused; more directly, an ungrounded, unconnected panel is a
  circuit with no working supply.
- `solar_panel` counts toward `buck_insufficient_headroom`'s search for a
  source on a buck converter's `VIN` — a solar panel can power a
  [buck_converter.md](buck_converter.md) exactly like a
  [voltage_source.md](voltage_source.md) can, and the rule checks both kinds
  equally when computing available headroom.
- The negative terminal should go to `"0"`; a circuit with no `"0"` node
  anywhere fails validation with `No ground node was generated.`

## Worked example

```json
{ "ref": "V4", "kind": "solar_panel", "value": "6V", "nodes": ["PV_POS", "0"] }
```

## Gotchas

- **The static SPICE export is an ideal source; only the live interactive
  simulator adds sag.** `toSpice` emits `DC <value>` with no series
  resistance at all, while the browser simulator inserts a ~5 Ω internal
  resistor between an internal node and the `+` terminal. Expect the two
  simulation paths to diverge under load — this is a deliberate, documented
  divergence in `simNetlist.js`, not a bug.
- Reversing the two nodes is silent in the JSON (nothing rejects it) but
  changes which net the topology graph treats as the supply — the same trap
  as [voltage_source.md](voltage_source.md).
- `spice_prefix` is `V`, same as `voltage_source` and `buck_converter` —
  don't expect a distinguishing ref letter on the exported netlist.
