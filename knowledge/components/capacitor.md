---
kind: capacitor
label: "Capacitor"
category: passive
pins: 2
pin_order: null
pin_order_source: none
spice_prefix: C
aliases: [cap, c]
preferred_values: [1nF, 10nF, 100nF, 1uF, 10uF, 100uF, 470uF]
status: core
---

# Capacitor

Stores charge. Used for timing, filtering, decoupling and coupling. This kind is
non-polarised — for an electrolytic, see the polarity note below.

## Pin contract

`nodes` must list exactly 2 net names. Order does not matter for this kind.

Ground is `"0"`.

## Value

Farads, as a string with a unit suffix. Always include the unit:

| Written | Means |
|---------|-------|
| `"100nF"` | 100 nanofarads |
| `"10uF"` | 10 microfarads |
| `"470pF"` | 470 picofarads |

Write micro as `u`, not `µ`. A bare number with no unit is ambiguous and should
be avoided.

## Wiring rules

Common roles and the value that usually fits:

| Role | Typical |
|------|---------|
| Supply decoupling (per IC) | 100 nF |
| Bulk supply reservoir | 10 µF – 470 µF |
| 555 / RC timing | 1 nF – 100 µF |
| 555 `CTRL` decoupling | 10 nF |
| Audio coupling | 1 µF – 10 µF |

`missing_supply_decoupling` warns when an IC has no 100 nF near its supply pin.

## Worked example

Timing capacitor for a 1 Hz 555 astable, plus the `CTRL` decoupling cap:

```json
{ "ref": "C1", "kind": "capacitor", "value": "10uF", "nodes": ["CT", "0"] },
{ "ref": "C2", "kind": "capacitor", "value": "10nF", "nodes": ["CTRL", "0"] }
```

## Gotchas

- **Electrolytics are polarised, and this kind is not.** Above roughly 1 µF the
  real part is almost certainly electrolytic, and the
  `electrolytic_cap_polarity` rule expects the first node to be the positive
  side. Order your nodes positive-first for large values even though the kind
  itself does not enforce it.
- Include the unit. `"100"` is not 100 nF to any reader or parser.
- The 555 `CTRL` cap is optional electrically but currently defeats the
  schematic router — see [timer_555.md](timer_555.md).
