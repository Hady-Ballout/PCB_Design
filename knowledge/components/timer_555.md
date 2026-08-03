---
kind: timer_555
label: "555 timer"
category: analog-ic
pins: 8
pin_order: [GND, TRIG, OUT, RESET, CTRL, THRES, DISCH, VCC]
pin_order_source: fixedPins
spice_prefix: X
aliases: [555, ne555, 555 timer ic]
status: core
---

# 555 timer

An 8-pin timer IC that turns a resistor–capacitor charge/discharge cycle into a
square wave. Reach for it for blinkers, tone generators, clocks, PWM, and
one-shot pulses — anything periodic that does not justify a microcontroller.

## Pin contract

`nodes` must list exactly 8 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `GND` | Ground. Almost always `"0"`. |
| 2 | `TRIG` | Trigger. Output goes high when this falls below ⅓·VCC. |
| 3 | `OUT` | Output. Swings to roughly VCC−1.7 V high, near 0 V low. |
| 4 | `RESET` | Active-low reset. **Tie to VCC** unless you are actually using it. |
| 5 | `CTRL` | Control voltage. Decouple to ground with 10 nF, or leave `NC_`. |
| 6 | `THRES` | Threshold. Output goes low when this rises above ⅔·VCC. |
| 7 | `DISCH` | Discharge. Open-collector to ground while the output is low. |
| 8 | `VCC` | Supply, 4.5–15 V. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number. Use `"NE555"`. It selects the `TIMER555` SPICE subcircuit
regardless, so the string is documentation, not behaviour.

## Wiring rules

Two configurations account for nearly every use:

**Astable** (free-running oscillator — this is what "blink an LED" means):
- `TRIG` and `THRES` share one net, the timing-capacitor node.
- A resistor from `VCC` to `DISCH`, a second from `DISCH` to that shared node.
- The timing capacitor from the shared node to ground.
- `RESET` to `VCC`.

**Monostable** (one pulse per trigger):
- One resistor from `VCC` to `THRES`, timing cap from `THRES` to ground.
- `DISCH` ties to `THRES`. `TRIG` is your input, idling high.

Astable design equations, with R1 = VCC→DISCH and R2 = DISCH→timing node:

```
frequency = 1.44 / ((R1 + 2·R2) · C)
t_high    = 0.693 · (R1 + R2) · C
t_low     = 0.693 · R2 · C
```

Duty cycle always exceeds 50% in this topology, because charging goes through
both resistors and discharging through only R2. Getting to exactly 50% needs a
diode across R2, so do not promise 50% duty without one.

## Worked example

1 Hz blinker, 9 V supply. R1 = 10k, R2 = 68k, C1 = 10 µF gives
`1.44 / (146k · 10µF)` = **0.99 Hz** at 53% duty.

```json
{ "ref": "U1", "kind": "timer_555", "value": "NE555",
  "nodes": ["0", "CT", "OUT", "VCC", "CTRL", "CT", "DISCH", "VCC"] }
```

`CT` appears at positions 2 and 6 — that shared net is what makes it astable.
`VCC` appears at 4 and 8 — that is RESET tied high. Full circuit in
[../patterns/astable-555.md](../patterns/astable-555.md).

## Gotchas

- **A wrong pin order still validates.** The `fixed_pin_node_count` rule checks
  that you listed 8 nodes; nothing checks *which*. Swap `TRIG` and `THRES` and
  you get a clean board, clean DRC and fab-ready Gerbers — for a circuit that
  does not oscillate. Copy the order from the table above; do not recall it.
- **Floating `RESET` is the most common failure.** It must go to `VCC`.
- The output sources real current, so an LED still needs a series resistor —
  see [led.md](led.md).
- The schematic router currently cannot lay out a 555 astable that includes the
  `CTRL` decoupling capacitor; the board router handles it fine. The import path
  falls back to a coarse diagram. Known gap, not your mistake.
