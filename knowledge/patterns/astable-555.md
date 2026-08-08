---
pattern: astable-555
provides: square-wave
uses: [timer_555, resistor, capacitor, voltage_source]
params: [frequency, supply]
status: written
---

# 555 astable oscillator

A free-running square wave from a 555. This is what almost every "blink an LED",
"make a tone", or "1 Hz clock" request resolves to.

## When to use it

- Blinking an indicator
- An audible tone into a buzzer (set frequency in the kHz range)
- A slow clock for another chip

Not for: precise timing (use a crystal oscillator), exact 50% duty (needs a
diode across R2), or anything a microcontroller is already in the circuit for.

## Design equations

With `R1` from `VCC` to `DISCH` and `R2` from `DISCH` to the timing node `CT`:

```
frequency = 1.44 / ((R1 + 2·R2) · C1)
t_high    = 0.693 · (R1 + R2) · C1
t_low     = 0.693 · R2 · C1
duty      = (R1 + R2) / (R1 + 2·R2)          always > 50%
```

Work backwards: pick `C1` from the timescale (µF for hertz, nF for kilohertz),
pick `R2` for the bulk of the period, then `R1` for duty. Round both to E24.

## Parts

| Ref | Kind | Role |
|-----|------|------|
| `V1` | voltage_source | Supply, 4.5–15 V |
| `U1` | timer_555 | The timer |
| `R1` | resistor | `VCC` → `DISCH` |
| `R2` | resistor | `DISCH` → `CT` |
| `C1` | capacitor | `CT` → ground, sets the timescale |
| `C2` | capacitor | 10 nF on `CTRL` (optional, see gotcha) |

## Worked example — 1 Hz, 9 V

`R1 = 10k`, `R2 = 68k`, `C1 = 10µF` → `1.44 / (146k · 10µF)` = **0.99 Hz**,
53% duty. Verified: routes complete, DRC clean, connectivity clean.

```json
{
  "title": "1 Hz LED blinker (555 astable)",
  "supplyVoltage": 9,
  "components": [
    { "ref": "V1", "kind": "voltage_source", "value": "9V",    "nodes": ["VCC", "0"] },
    { "ref": "U1", "kind": "timer_555",      "value": "NE555", "nodes": ["0", "CT", "OUT", "VCC", "CTRL", "CT", "DISCH", "VCC"] },
    { "ref": "R1", "kind": "resistor",       "value": "10k",   "nodes": ["VCC", "DISCH"] },
    { "ref": "R2", "kind": "resistor",       "value": "68k",   "nodes": ["DISCH", "CT"] },
    { "ref": "C1", "kind": "capacitor",      "value": "10uF",  "nodes": ["CT", "0"] },
    { "ref": "C2", "kind": "capacitor",      "value": "10nF",  "nodes": ["CTRL", "0"] },
    { "ref": "R3", "kind": "resistor",       "value": "330",   "nodes": ["OUT", "LED_A"] },
    { "ref": "D1", "kind": "led",            "value": "Red",   "nodes": ["LED_A", "0"] }
  ]
}
```

## Scaling the frequency

Keep `R1`/`R2` and swap `C1`:

| C1 | Frequency |
|----|-----------|
| 10 µF | ~1 Hz |
| 1 µF | ~10 Hz |
| 100 nF | ~100 Hz |
| 1 nF | ~10 kHz (audible tone) |

## Gotchas

- `TRIG` (pin 2) and `THRES` (pin 6) **must share the net** `CT`. That tie is
  what makes it astable rather than monostable, and nothing validates it.
- `RESET` (pin 4) must go to `VCC`.
- Including `C2` on `CTRL` currently defeats the schematic router — the board
  still routes fine and the import path falls back to a coarse diagram. Drop
  `C2` if you need a clean schematic more than you need the decoupling.
