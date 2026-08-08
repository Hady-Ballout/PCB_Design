---
kind: inductor
label: "Inductor"
category: passive
pins: 2
pin_order: null
pin_order_source: none
spice_prefix: L
aliases: [coil, choke, l]
preferred_values: [10uH, 100uH, 1mH, 10mH]
status: core
---

# Inductor

Stores energy in a magnetic field. In this knowledge base its main job is the
output filter of a [buck_converter.md](buck_converter.md), though it also
shows up in generic LC filtering.

## Pin contract

`nodes` must list exactly 2 net names. Order does not matter — `pin_order` is
`null` and an inductor has no `ROLE_PINS` entry.

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Henries, as a string with a unit suffix:

| Written | Means |
|---------|-------|
| `"10uH"` | 10 microhenries |
| `"100uH"` | 100 microhenries |
| `"1mH"` | 1 millihenry |
| `"10mH"` | 10 millihenries |

The SPICE exporter strips a trailing `h`/`H` and writes the rest verbatim
(`"100uH"` → `100u`), so keep the unit lowercase-friendly and do not add
stray spaces.

## Wiring rules

- The topology graph treats an inductor as an unconditional DC conductor —
  `crossings()` in `topologyRules.js` always lets current pass through it (the
  same treatment a fuse gets). This is what lets `buck_missing_inductor`
  reach through the inductor to find the filtered output rail on the far
  side, and it also means the inductor never blocks a series-loop check.
- On a [buck_converter.md](buck_converter.md), the `buck_missing_inductor`
  rule (`id: 'buck_missing_inductor'`) requires an inductor directly on the
  converter's `OUT` (switch) net — without one, nothing turns the switching
  waveform into a DC rail. Once it's present, `buck_missing_catch_diode`
  additionally requires a schottky or diode from `"0"` to that same `OUT`
  net (cathode at `OUT`) so the inductor current has a freewheel path when
  the internal switch turns off.

## Worked example

Buck converter output filter — inductor plus catch diode on the switch node:

```json
{ "ref": "L1", "kind": "inductor", "value": "33uH", "nodes": ["SW", "VOUT"] },
{ "ref": "D1", "kind": "schottky", "value": "1N5819", "nodes": ["0", "SW"] }
```

## Gotchas

- **An inductor with no catch diode is a silent simulation pass but a real
  hardware failure** on a buck converter — `buck_missing_catch_diode` only
  fires once an inductor is already present, so add both together, not one
  at a time.
- Because the topology graph always crosses an inductor, two separate supply
  rails bridged only by an inductor will read as the same reachable net —
  don't rely on an inductor alone to electrically separate two domains in
  your own reasoning about the circuit.
- The live simulator does model inductor dynamics (`henries` from
  `parseHenries`, default 1 mH if unparseable); the static SPICE export just
  strips the unit and passes the number through, so double-check the value
  string actually parses if you rely on simulated ripple behavior.
