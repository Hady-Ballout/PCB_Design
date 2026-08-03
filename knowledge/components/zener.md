---
kind: zener
label: "Zener diode"
category: diode
pins: 2
pin_order: [anode, cathode]
pin_order_source: ROLE_PINS
spice_prefix: D
aliases: [zener diode]
preferred_values: [3.3V, 5.1V, 9.1V, 12V]
status: core
---

# Zener diode

A diode designed to break down at a known reverse voltage instead of being
destroyed by it. Reach for it as a cheap voltage reference or clamp — holding a
node near a fixed voltage — not as a series rectifier.

## Pin contract

`nodes` must list exactly 2 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `anode` | Ties toward ground (the low side of the reverse-bias path). |
| 2 | `cathode` | Ties toward the supply, through a series resistor. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

The breakdown (Zener) voltage, as a string with a `V` suffix: `"3.3V"`,
`"5.1V"`, `"9.1V"`, `"12V"` (the `preferred_values` in the frontmatter above).
The exporter reads the leading number with a simple regex and falls back to
`5.1` if nothing parses, so keep the number first — `"5.1V"`, not `"V5.1"`. It
feeds a per-voltage SPICE model named `DZEN_<voltage>` (e.g. `DZEN_5R1`, dot
replaced with `R`), shared by every zener at that voltage in the circuit.

## Wiring rules

A zener does its job **reverse biased**: cathode toward the supply, anode
toward ground, with a series resistor from the supply to the cathode to limit
current once it breaks down. Unlike a forward diode, this orientation is
correct on purpose, which is why `led_polarity` explicitly excludes the
`zener` kind from its reversed-diode check — it would otherwise flag every
correctly wired zener clamp.

Size the series resistor so current stays in the diode's rated range even at
the highest expected supply voltage:

```
R = (V_supply_max − V_zener) / I_zener      with I_zener a few mA
```

Too small a resistor and fault current at the supply rail's peak can exceed
the zener's rating; too large and it may not reach breakdown at all under
light load, leaving the clamped node unregulated.

## Worked example

5.1 V reference off a 9 V rail, biased through 1 k (about 3.9 mA at breakdown):

```json
{ "ref": "R1", "kind": "resistor", "value": "1k",  "nodes": ["VCC", "ZREF"] },
{ "ref": "D1", "kind": "zener",    "value": "5.1V", "nodes": ["0", "ZREF"] }
```

`D1`'s anode is `"0"` (ground) and its cathode is `ZREF`, the node being held
near 5.1 V.

## Gotchas

- **Wiring it like a forward rectifier defeats the whole point.** Anode to
  supply, cathode to ground looks "normal" next to a plain diode but never
  reaches breakdown — the node just gets clamped ~0.7 V below the supply
  through forward conduction instead of held at the Zener voltage.
- No series resistor means no current limit once breakdown starts, and no
  topology rule catches this the way `led_no_series_resistor` does for LEDs —
  the zener-specific loop isn't checked. Add the resistor yourself.
- The value must parse as a leading number; if it doesn't, the exporter
  silently substitutes 5.1 V rather than erroring, so a badly formatted value
  produces a working-looking board clamped to the wrong voltage.
