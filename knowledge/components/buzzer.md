---
kind: buzzer
label: "Buzzer"
category: actuator
pins: 2
pin_order: null
pin_order_source: none
spice_prefix: R
aliases: [piezo, beeper]
status: core
---

# Buzzer

A piezo or magnetic sound element. Reach for it for alarms, alerts, and 555-
driven tones — anything that needs a beep rather than analog audio.

## Pin contract

`nodes` must list exactly 2 net names. Order does not matter — the buzzer is
simulated as a plain resistive load, like [resistor.md](resistor.md), not a
polarised part.

Ground is `"0"`.

## Value

Free-form. If it parses as a resistance (`"1k"`, `"330"` — same rules as
[resistor.md](resistor.md)) it is used directly as the buzzer's simulated
winding/element resistance. Anything that does not parse (`"Piezo"`, `"5V
active"`) falls back to a default of 1 kΩ. Either way the string is mostly
documentation — describe the part (`"Piezo"`, `"Magnetic 5V"`), you do not
need to fabricate a resistance.

## Wiring rules

A buzzer counts as a heavy load, so wiring it straight onto a GPIO net that
also reaches a supply or ground trips `gpio_direct_load` (or the more
specific `divider_powered_load` if there's a resistor from that same GPIO net
to ground) — a GPIO pin cannot source the current a buzzer draws. Drive it
through a transistor: GPIO → base resistor → BJT base, buzzer between the
supply and the collector, emitter to ground. `driver_missing_base_resistor`
enforces the base resistor.

Unlike a motor, a buzzer is not meaningfully inductive, so it is **not**
covered by `missing_flyback_diode` — no flyback diode needed.

For a direct 555-output tone (no transistor, low current draw at the
frequencies a 555 produces) the buzzer can sit straight on `OUT`; see
[timer_555.md](timer_555.md).

## Worked example

Transistor-driven buzzer from a GPIO:

```json
{ "ref": "Q1", "kind": "bjt_npn", "value": "2N2222", "nodes": ["VCC_BUZZ", "BASE", "0"] },
{ "ref": "R1", "kind": "resistor", "value": "1k", "nodes": ["D5", "BASE"] },
{ "ref": "R2", "kind": "buzzer", "value": "Piezo", "nodes": ["5V", "VCC_BUZZ"] }
```

`R2`, not `BZ1` — the buzzer's `spice_prefix` is `R` (it is simulated as a
resistive load), same as [resistor.md](resistor.md), so its ref shares that
prefix even though it is not literally a resistor.

`D5` is the GPIO, `R1` is the required base resistor, `BZ1` sits between the
5V rail and the transistor's collector.

## Gotchas

- **A buzzer straight on a GPIO looks fine in the diagram and fails on the
  bench** — GPIOs source a few mA, buzzers want tens of mA at audible volume.
  `gpio_direct_load` exists specifically for this.
- The frequency you hear off a 555 astable depends on the oscillator's RC
  values, not on the buzzer's `value` string — see [timer_555.md](timer_555.md)
  for the duty-cycle equations.
- Piezo buzzers with a built-in oscillator only need DC to sound; magnetic
  buzzers without one need an actual AC/PWM drive. This repo's model treats
  both the same (a resistive load), so it will not catch a piezo-only part
  wired for a magnetic buzzer's drive scheme.
