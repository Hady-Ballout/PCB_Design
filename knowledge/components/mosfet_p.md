---
kind: mosfet_p
label: "P-channel MOSFET"
category: transistor
pins: 3
pin_order: [drain, gate, source]
pin_order_source: ROLE_PINS
spice_prefix: M
aliases: [pmos, p-mosfet, p-fet]
status: core
---

# P-channel MOSFET

A voltage-controlled high-side switch. Reach for it when the load's low side
must stay grounded and you want a low-resistance, low-gate-current switch on
the supply feed — the MOSFET counterpart to [bjt_pnp.md](bjt_pnp.md).

## Pin contract

`nodes` must list exactly 3 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `drain` | The switched node. Ties to the load, which returns to ground. |
| 2 | `gate` | Control input. Turns on when pulled low relative to the source (the supply rail). |
| 3 | `source` | Almost always the supply rail in a high-side switch. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number, e.g. `"IRF9540"`, `"2N7002P"`. It is documentation
only — the SPICE export always models a P-MOSFET as a fixed generic `MPMOS`
(`LEVEL=1 KP=10u VTO=-2`), body tied to source, regardless of the string here.

## Wiring rules

High-side switch: source to the supply rail, load between the drain and
ground, gate pulled toward the supply rail (off) or toward ground (on).

- **The gate must never float**, same as the N-channel case —
  `driver_control_floating` applies identically.
- **A pull-up to the supply rail keeps the switch off by default.** The
  `mosfet_gate_no_pulldown` check (raised from inside the
  `driver_missing_base_resistor` rule) only checks for a resistor to ground
  on the gate net; for a P-channel high-side switch the safe default state is
  a resistor to the *supply* rail instead, so treat that warning as a
  reminder to add a defined-off resistor, not literally a ground pull-down.
- **A GPIO cannot pull the gate to a rail above its own logic level.** As with
  the PNP case, a P-channel high-side switch on a rail above the GPIO's logic
  voltage is normally driven by another transistor stage, not the GPIO pin
  directly.
- **Switching an inductive load still needs a flyback diode** across it —
  `missing_flyback_diode` applies the same as for the other three driver
  kinds.

## Worked example

High-side switch on a 12 V rail, gate pulled high by default and pulled low
through an NPN driven from a GPIO:

```json
{ "ref": "M1", "kind": "mosfet_p",  "value": "IRF9540", "nodes": ["LOAD_HI", "PGATE", "VCC"] },
{ "ref": "R1", "kind": "resistor",  "value": "10k", "nodes": ["VCC", "PGATE"] },
{ "ref": "Q1", "kind": "bjt_npn",   "value": "2N2222", "nodes": ["PGATE", "NBASE", "0"] },
{ "ref": "R2", "kind": "resistor",  "value": "10k", "nodes": ["NBASE", "0"] }
```

`R1` holds the P-MOSFET off by default; `Q1` pulling `PGATE` toward ground
turns it on. `NBASE` is where the GPIO's own series-resistored drive attaches.

## Gotchas

- **Pin order is identical to [mosfet_n.md](mosfet_n.md)**
  (`drain, gate, source`) but the on/off gate polarity is reversed — wiring a
  P-channel part as if it switches on with a high gate produces a board that
  never conducts.
- The fixed `VTO=-2` SPICE model does not reflect any specific real part's
  threshold — do not use the simulator to validate gate-drive margin.
- A resistor from gate to ground (the pattern the automated check looks for)
  is the *wrong* default for a P-channel high-side switch; it holds the gate
  near the drain/load potential, not definitively off. Use a pull-up to the
  source/supply rail instead, and treat any `mosfet_gate_no_pulldown` warning
  on a P-channel part as a prompt to check you have the right kind of
  resistor, not just any resistor.
