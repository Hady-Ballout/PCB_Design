---
kind: bjt_npn
label: "NPN transistor"
category: transistor
pins: 3
pin_order: [collector, base, emitter]
pin_order_source: ROLE_PINS
spice_prefix: Q
aliases: [npn, transistor, 2n2222, bc547]
status: core
---

# NPN transistor

A bipolar switch/amplifier. Reach for it to let a low-current GPIO pin (or a
small signal) control a heavier load — an LED strip's ground return, a motor
through a driver stage, a relay coil — by switching the load's return path to
ground.

## Pin contract

`nodes` must list exactly 3 net names, in this order:

| # | Pin | Role |
|---|-----|------|
| 1 | `collector` | The switched node. Ties to the load, which ties to the supply. |
| 2 | `base` | Control input. Drive it through a series resistor. |
| 3 | `emitter` | Almost always ground (`"0"`) in a low-side switch. |

Ground is `"0"`. For a pin you deliberately leave unconnected use
`"NC_<REF>_<pinNumber>"`.

## Value

Free-form part number, e.g. `"2N2222"`, `"2N3904"`, `"BC547"`. It is
documentation only — the SPICE export always models an NPN as a fixed generic
`Q2N2222` (`IS=1e-14 BF=200 VAF=100`) regardless of the string you put here.

## Wiring rules

This is the classic **low-side switch** (common-emitter): emitter to ground,
load between the supply and the collector, base driven through a resistor.

- **The base always needs a series resistor**, never a direct GPIO connection.
  `driver_missing_base_resistor` flags a BJT base wired straight to a GPIO net
  as an error — the pin would dump uncontrolled current into the base-emitter
  junction. 1k is a safe default for a logic-level drive into a small signal
  transistor.
- **The base cannot float.** `driver_control_floating` flags a base net with
  nothing else on it — the transistor's state is then undefined.
- **Switching an inductive load (motor, relay, solenoid) needs a flyback
  diode** across the load, cathode to the supply side. `missing_flyback_diode`
  flags a motor/vibration-motor kind switched by a transistor with no diode in
  parallel — without it, the turn-off voltage spike destroys the transistor.
- For a heavier load or lower voltage drop use a [mosfet_n.md](mosfet_n.md)
  instead; a BJT's base current draw and ~0.2 V saturation drop matter more as
  currents rise.

## Worked example

Driving an LED's cathode-side return from a GPIO pin at 5 V, 330 Ω LED
resistor, 10 k base resistor:

```json
{ "ref": "R1", "kind": "resistor", "value": "330", "nodes": ["VCC", "LEDA"] },
{ "ref": "D1", "kind": "led",      "value": "Red", "nodes": ["LEDA", "LEDK"] },
{ "ref": "Q1", "kind": "bjt_npn",  "value": "2N2222", "nodes": ["LEDK", "BASE", "0"] },
{ "ref": "R2", "kind": "resistor", "value": "10k", "nodes": ["BASE", "0"] }
```

`R2` is a pull-down so the base sits definitively low (transistor off) when
the driving GPIO is high-impedance; the GPIO net itself connects to `BASE`
through its own series resistor, not shown here.

## Gotchas

- **PNP and NPN share the same pin order** (`collector, base, emitter`) but
  opposite polarity — an NPN low-side switch wired as if it were a
  [bjt_pnp.md](bjt_pnp.md) high-side switch will never turn on. Check which
  kind you actually placed.
- The SPICE model is a generic small-signal NPN no matter what part number you
  write in `value` — do not expect a simulation difference between "2N2222"
  and "BC547".
- A base resistor sized for 5 V logic is oversized for 3.3 V logic and
  undersized the other way around; 1k–4.7k covers most hobby cases either way,
  but check `driver_missing_base_resistor` fires only on GPIO nets — a base
  fed from another transistor's collector or an op-amp output is not checked.
