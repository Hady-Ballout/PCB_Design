---
kind: photoresistor
label: "Photoresistor (LDR)"
category: sensor
pins: 2
pin_order: null
pin_order_source: none
spice_prefix: R
aliases: [ldr, light dependent resistor, photocell]
status: core
---

# Photoresistor (LDR)

A light-dependent resistor: resistance drops as ambient light rises. Reach for
it for a cheap analog "is it light or dark" input — nightlights, light-seeking
robots, exposure triggers.

## Pin contract

`nodes` must list exactly 2 net names. Order does not matter — `pin_order` is
`null` because, like [resistor.md](resistor.md), this is a symmetric two-terminal
part with no anode/cathode distinction.

Ground is `"0"`.

## Value

Ohms, parsed exactly like a resistor's (`parseResistance` in `topologyRules.js`,
also used directly by `resistiveValue` in `pcbGenerator.js` for the SPICE
model) — `"330"`, `"4.7k"`, `"1M"`. It is simulated as a **fixed** resistance at
that value; there is no dynamic light-level model, so it stands in for the
LDR's resistance at whatever lighting condition you're designing around.
Typical LDRs run roughly 200 Ω–1 kΩ in bright light and hundreds of kΩ to
several MΩ in darkness — `"10k"` is a reasonable mid-light placeholder. If the
string fails to parse, `pcbGenerator.js` silently falls back to 10k, so use a
plain numeric form.

## Wiring rules

A photoresistor has no output pin of its own — you read light level as a
voltage by pairing it with a fixed resistor in a divider, then sampling the
midpoint with an ADC. Put the fixed resistor at roughly the LDR's
mid-brightness resistance (often ~10 k) so the midpoint swings through a
useful range instead of pinning near one rail. Which leg carries the LDR
decides polarity: LDR on top (supply side) gives a rising voltage with more
light; LDR on bottom (ground side) gives a falling voltage with more light.

## Worked example

LDR on the ground side of a 10 k fixed resistor, midpoint to an ADC pin —
voltage rises as it gets darker:

```json
{ "ref": "R1", "kind": "resistor",      "value": "10k", "nodes": ["VCC", "SENSE"] },
{ "ref": "R2", "kind": "photoresistor", "value": "10k", "nodes": ["SENSE", "0"] }
```

## Gotchas

- **It is not a sensor module** — there's no VCC/GND/OUT triple. Without the
  divider partner it just sits there; `single_pin_net` will flag a photoresistor
  left with only one net connected.
- Two LDRs (or an LDR and a resistor) sharing both nets end up in parallel, not
  in series in a divider — check net names if the reading looks flat.
- The simulated value is static, so the schematic simulator will never show a
  changing reading — it's only useful for verifying the divider math, not for
  testing light response.
