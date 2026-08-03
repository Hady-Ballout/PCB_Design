---
kind: vibration_motor
label: "Vibration motor"
category: actuator
pins: 2
pin_order: [+, −]
pin_order_source: ROLE_PINS
spice_prefix: R
aliases: [vibrator, coin motor, pager motor]
status: core
---

# Vibration motor

A small coin or pager-style eccentric motor used for haptic feedback. Same
electrical model as [dc_motor.md](dc_motor.md) — a low-voltage inductive
winding — just smaller and lower current.

## Pin contract

`nodes` must list exactly 2 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `+` | Positive lead. |
| 2 | `−` | Negative lead. |

Electrically the two leads are interchangeable — reversing them just reverses
spin direction — but the frontmatter's `pin_order_source` is `ROLE_PINS`, so
list `+` first for consistency with other parts that document a polarity.

Ground is `"0"`.

## Value

Free-form. If it parses as a resistance (same grammar as
[resistor.md](resistor.md)) it is used as the motor's simulated winding
resistance; a non-parsing string falls back to a default of 27 Ω. The
simulated "speed" observable assumes a 3 V-rated motor.

## Wiring rules

Same rules as [dc_motor.md](dc_motor.md), just at smaller scale:

- Never tie it directly to a GPIO net that reaches supply or ground —
  `gpio_direct_load` / `divider_powered_load` catch it. Switch it with a
  transistor.
- Once switched by a transistor, add a flyback diode across it —
  `missing_flyback_diode` enforces this for `vibration_motor` exactly as it
  does for `dc_motor`. `driver_missing_base_resistor` covers the switching
  transistor's base resistor.

Vibration motors run on lower current than a drive motor, but they are still
a heavy inductive load by this repo's rules — do not assume "small" means
"safe to skip the driver and diode."

## Worked example

```json
{ "ref": "Q1", "kind": "bjt_npn", "value": "2N2222", "nodes": ["VIB_HI", "BASE", "0"] },
{ "ref": "R1", "kind": "resistor", "value": "1k", "nodes": ["D9", "BASE"] },
{ "ref": "R2", "kind": "vibration_motor", "value": "27", "nodes": ["3V3", "VIB_HI"] },
{ "ref": "D1", "kind": "diode", "value": "1N4148", "nodes": ["VIB_HI", "3V3"] }
```

`R2` (not `M1` or `VM1`) — `vibration_motor`'s `spice_prefix` is `R`, same as
[dc_motor.md](dc_motor.md), because it too is simulated as a resistive
winding load.

## Gotchas

- **The ref prefix is `R`, not `M` or `VM`** — easy to get wrong by analogy
  with a "motor" naming instinct.
- Skipping the flyback diode is the most common miss; a coin motor's coil is
  small but still inductive enough to spike the switching transistor.
- Don't reuse the `dc_motor`'s 6 V-rated speed assumption for this part in
  your head — the simulated speed observable here assumes 3 V.
