---
kind: bjt_pnp
label: "PNP transistor"
category: transistor
pins: 3
pin_order: [collector, base, emitter]
pin_order_source: ROLE_PINS
spice_prefix: Q
aliases: [pnp, 2n2907, bc557]
status: core
---

# PNP transistor

A bipolar switch used for **high-side switching** — turning on the supply
side of a load rather than its ground return. Reach for it when the load's
low side must stay at a fixed ground reference (e.g. shared with other
grounded circuitry) and only the supply feed can be interrupted.

## Pin contract

`nodes` must list exactly 3 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `collector` | The switched node. Ties to the load, which returns to ground. |
| 2 | `base` | Control input. Drive it through a series resistor, referenced near the supply rail to turn on. |
| 3 | `emitter` | Almost always the supply rail in a high-side switch. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number, e.g. `"2N3906"`, `"2N2907"`, `"BC557"`. It is
documentation only — the SPICE export always models a PNP as a fixed generic
`Q2N3906` (`IS=1e-14 BF=200 VAF=100`) regardless of the string you put here.

## Wiring rules

High-side switch: emitter to the supply rail, load between the collector and
ground, base pulled low (relative to the emitter) through a resistor to turn
on.

- **The base needs a series resistor.** `driver_missing_base_resistor` only
  checks a bare GPIO tied straight to a BJT base (which this topology usually
  avoids, since the base sits near the supply rail, not at GPIO level) — but a
  floating or under-resistored base is still bad practice. Use the same 1k–10k
  guidance as [bjt_npn.md](bjt_npn.md).
- **The base cannot float.** `driver_control_floating` flags a base net with
  nothing else on it.
- **A GPIO cannot drive a PNP base directly at the supply rail.** A GPIO
  output swings 0–3.3 V/5 V, not up near the supply the emitter sits at, so a
  PNP high-side switch is almost always driven by another transistor stage
  (an NPN pulling the base low) rather than a GPIO pin directly. No topology
  rule currently checks this voltage-domain mismatch, so verify the resulting
  on/off logic by hand before trusting the board.
- **Switching an inductive load still needs a flyback diode** across it.
  `missing_flyback_diode` applies exactly as it does for the NPN case.

## Worked example

High-side switch enabling a load from a 9 V rail, driven low by an NPN which
is itself driven from a GPIO:

```json
{ "ref": "Q1", "kind": "bjt_pnp", "value": "2N3906", "nodes": ["LOAD_HI", "PBASE", "VCC"] },
{ "ref": "R1", "kind": "resistor", "value": "4.7k", "nodes": ["VCC", "PBASE"] },
{ "ref": "Q2", "kind": "bjt_npn", "value": "2N2222", "nodes": ["PBASE", "NBASE", "0"] },
{ "ref": "R2", "kind": "resistor", "value": "10k", "nodes": ["NBASE", "0"] }
```

`R1` pulls the PNP base to `VCC` (off) by default; `Q2` pulling `PBASE` toward
ground turns the PNP on. `NBASE` is where a GPIO pin (through its own series
resistor) would attach.

## Gotchas

- **Pin order is identical to [bjt_npn.md](bjt_npn.md)** (`collector, base,
  emitter`), so a kind mix-up is easy to make and easy to miss — the schematic
  will draw fine either way, but the polarity is backwards and the switch
  never conducts.
- The SPICE model is fixed to a generic small-signal PNP no matter the
  `value` string.
- Driving a PNP base directly from a 3.3 V/5 V GPIO net referenced to a higher
  supply rail typically fails to turn it fully off or on — the level mismatch
  is not something any topology rule currently catches, so double-check the
  voltages by hand.
