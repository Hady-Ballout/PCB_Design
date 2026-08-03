---
kind: pushbutton
label: "Pushbutton"
category: switch
pins: 2
pin_order: [terminal 1, terminal 2]
pin_order_source: ROLE_PINS
spice_prefix: R
aliases: [button, momentary switch, tactile switch]
status: core
---

# Pushbutton

A momentary switch: connected while held, open otherwise. Reach for it for
any single momentary input — reset, trigger, mode-select — as opposed to
[switch_spdt.md](switch_spdt.md) (latching, selects between two paths).

## Pin contract

`nodes` must list exactly 2 net names. Both terminals are electrically
identical — a 2-pin tactile button has no polarity — so order does not
matter in practice, but the documented positional order (`terminal 1`,
`terminal 2`, from `ROLE_PINS`) is what other rules reference by name.

Ground is `"0"`.

## Value

Free-form, e.g. `"Tactile"` or `"6x6mm"`. Simulated as an open circuit
(very large resistance) when unpressed; the value string itself is not
parsed by the simulator.

## Wiring rules

**A button feeding a GPIO needs a pull resistor**, or the input floats when
the button is open and reads noise. `pushbutton_no_pull` warns whenever one
of the button's nodes lands on a GPIO net with no resistor anywhere on that
net.

Two equally valid patterns:

- **Pull-up**: resistor from the GPIO net to the logic supply, button from
  the GPIO net to ground. Pressed reads low.
- **Pull-down**: resistor from the GPIO net to ground, button from the GPIO
  net to the logic supply. Pressed reads high.

Using `pinMode(pin, INPUT_PULLUP)` in firmware (relying on the MCU's internal
pull-up, with no external resistor) also resolves the electrical problem, but
the rule cannot see firmware — it will still warn, so note the internal
pull-up choice if you go that route.

## Worked example

Pull-up pattern:

```json
{ "ref": "R1", "kind": "resistor",   "value": "10k", "nodes": ["BTN", "5V"] },
{ "ref": "R2", "kind": "pushbutton", "value": "Tactile", "nodes": ["BTN", "0"] }
```

`R2` (not `SW1` or `BTN1`) — `pushbutton`'s `spice_prefix` is `R`, because it
is simulated as a resistive element (open when unpressed).

## Gotchas

- **The ref prefix is `R`, not `SW`** — check `spice_prefix` before assuming.
- A button with both terminals wired but neither reaching a GPIO net (e.g.
  used purely as a mechanical short between two fixed rails) is outside
  `pushbutton_no_pull`'s scope — the rule only checks button-to-GPIO nets.
- Floating inputs read as random noise, not a clean 0 or 1 — a board that
  "mostly works but glitches" is the classic symptom of a missing pull
  resistor, worth checking before suspecting firmware debounce logic.
