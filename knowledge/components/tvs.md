---
kind: tvs
label: "TVS diode"
category: diode
pins: 2
pin_order: [anode, cathode]
pin_order_source: ROLE_PINS
spice_prefix: D
aliases: [tvs diode, transient suppressor, esd diode, surge suppressor]
preferred_values: [5V, 12V, 24V]
status: core
---

# TVS diode

A transient-voltage suppressor: a diode built to absorb short overvoltage
events (ESD, inductive spikes, hot-plug surges) by clamping hard once the
line exceeds its standoff voltage. Reach for it across a power input or an
exposed signal line — anywhere the outside world can inject a spike. This
kind models the **unidirectional** part; bidirectional TVS parts are out of
scope (see Gotchas).

## Pin contract

`nodes` must list exactly 2 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `anode` | Ties toward ground. |
| 2 | `cathode` | Ties to the protected line. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

The standoff/clamp voltage as a string with a `V` suffix: `"5V"`, `"12V"`,
`"24V"` (the `preferred_values` above). The exporter reads the leading number
with a simple regex and falls back to `5` if nothing parses — keep the number
first. It feeds a per-voltage SPICE model named `DTVS_<voltage>` (dot
replaced with `R`, e.g. `DTVS_6R8`), shared by every TVS at that voltage.
Pick a standoff comfortably above the rail's normal voltage: a `"5V"` TVS on
a 5 V rail sits at the edge of conduction; on a 3.3 V rail it is pure
protection.

## Wiring rules

Like a zener, a TVS works **reverse biased**: cathode to the protected line,
anode to ground. It sits in parallel with what it protects — never in series
with the load — and wants to be electrically close to the connector the
transient arrives through. `led_polarity` does not check the `tvs` kind (same
deliberate exclusion as `zener`), so the reverse orientation is never flagged
as a mistake, and `orphan_supply` does not count a TVS as a rail's load —
a clamp across a supply is filter, not consumer.

Unlike a zener reference, a TVS needs **no series resistor**: the source
impedance of the transient is the limit, and in normal operation the part
conducts nothing.

## Worked example

Clamping a 12 V barrel-jack input before a regulator:

```json
{ "ref": "J1", "kind": "barrel_jack", "value": "12V in",  "nodes": ["VIN_RAW", "0"] },
{ "ref": "D1", "kind": "tvs",         "value": "24V",     "nodes": ["0", "VIN_RAW"] },
{ "ref": "V1", "kind": "regulator",   "value": "5V",      "nodes": ["VIN_RAW", "0", "VCC"] }
```

`D1`'s anode is `"0"` and its cathode is `VIN_RAW`: invisible at 12 V,
clamping hard if the input spikes past 24 V.

## Gotchas

- **Unidirectional only.** A bidirectional TVS (for AC or negative-going
  lines) has no polarity and is not representable by this kind — using this
  one on a line that swings negative forward-conducts at −0.7 V.
- **Not a fuse.** A TVS clamps voltage; it does not interrupt current. A
  sustained overvoltage (not a transient) will burn it open — pair it with a
  `fuse` upstream if the fault can persist.
- Forward-wired (cathode to ground) it becomes a 0.7 V clamp on the line —
  the same silent failure as a backwards zener, and nothing flags it.
- The value must parse as a leading number; a non-parsing value silently
  becomes a 5 V part, which on a 12 V rail conducts continuously.
