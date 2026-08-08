---
kind: switch_spdt
label: "SPDT switch"
category: switch
pins: 3
pin_order: [common, throw A, throw B]
pin_order_source: ROLE_PINS
spice_prefix: R
aliases: [spdt, toggle switch, selector]
status: core
---

# SPDT switch

A single-pole double-throw toggle or slide switch: `common` connects to
exactly one of two throws at a time. Reach for it for a latching two-way
selection — power source select, mode select — as opposed to
[pushbutton.md](pushbutton.md) (momentary, always returns to one state).

## Pin contract

`nodes` must list exactly 3 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `common` | The pole. Always connected to whichever throw is selected. |
| 2 | `throw A` | One selectable position. |
| 3 | `throw B` | The other selectable position. |

This order comes from `ROLE_PINS`, not a physical `fixedPins` contract. **Read
the Gotchas section below before wiring one of these** — the simulator's
actual node mapping does not match this documented order.

Ground is `"0"`.

## Value

Free-form, e.g. `"SPDT"` or `"Slide switch"`. Simulated as a compound part:
internally modelled as two resistors, one per throw — `throw A` closed
(~1 mΩ) and `throw B` open (~10 MΩ), or vice versa depending on switch state.
The `value` string itself is not parsed.

## Wiring rules

Because it is a compound simulated part (two internal legs), current can flow
`common` → `throw A` OR `common` → `throw B`, never both at once. Wire the
common to the shared node (e.g. the load or the input being routed), and put
the two alternatives on the throws.

There is no dedicated topology rule for `switch_spdt` beyond the general
node-count check (`fixed_pin_node_count`) — a stray or swapped throw will not
be flagged, so get the pin order right at entry time.

## Worked example

Selecting between two power sources for a load, in the documented pin order:

```json
{ "ref": "R1", "kind": "switch_spdt", "value": "SPDT", "nodes": ["LOAD_IN", "BATTERY_5V", "USB_5V"] }
```

`R1` (not `SW1`) — `switch_spdt`'s `spice_prefix` is `R`, matching its
resistive-pair simulation model.

## Gotchas

- **The ref prefix is `R`, not `SW`.**
- **The documented pin order and the simulator's actual node order disagree,
  verified in source.** The pin contract above (and `ROLE_PINS` in
  `topologyRules.js`, which generates it) lists `common` at index 0. But the
  SPICE build in `pcbGenerator.js` and the interactive simulator in
  `simNetlist.js` both hard-code index **1** as the common pole:
  `${ref}_A ${b} ${a} 1m` / `${ref}_B ${b} ${c} 10Meg`, where `a,b,c` are
  `nodes[0], nodes[1], nodes[2]`. A dedicated test
  (`simEngine.test.js`, "routes through an SPDT switch") confirms it:
  `nodes: ['VA', 'VCC', 'VB']` behaves as common = `VCC` (index 1), default
  path closed to `VA` (index 0). So in the worked example above, the *doc*
  reading is "common = `LOAD_IN`", but the *simulated* behaviour treats
  `BATTERY_5V` (index 1) as the common pole instead. If you rely on the
  simulator or the exported SPICE netlist to validate behaviour rather than
  just the diagram, wire index 1 as the pole to get the result you expect,
  and treat the pin-contract table as aspirational until this is reconciled
  in source.
- Swapping `throw A` and `throw B` (whichever index convention you're
  targeting) validates cleanly and simulates a working circuit — it just
  selects the opposite of what you intended. No rule catches this.
- Don't confuse this with [pushbutton.md](pushbutton.md): a pushbutton always
  releases to one state, an SPDT switch stays wherever it was last set.
