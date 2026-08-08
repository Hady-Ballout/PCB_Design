---
kind: signal_source
label: "Signal source"
category: source
pins: 2
pin_order: null
pin_order_source: none
spice_prefix: V
aliases: [function generator, ac source, waveform]
preferred_values: [SINE(0 1 1k), PULSE(0 5 0 1u 1u 1m 2m)]
status: core
---

# Signal source

A function-generator-style AC or arbitrary source — a sine wave, a pulse
train, or a plain DC level fed into a circuit as a stimulus (an audio input,
a clock replacement, a test signal). For a plain battery/supply rail use
[voltage_source.md](voltage_source.md) instead.

## Pin contract

`nodes` must list exactly 2 net names. **`pin_order` is `null`, but node order
is not actually free** — `topologyRules.js` treats `nodes[0]` as the "hot"
terminal for supply-reachability purposes the same way it does for
`voltage_source`: `signal_source` is included in the check at line ~173
(`part.kind === 'voltage_source' || part.kind === 'signal_source' || …`)
that adds `nodes[0]` to `supplyNets` when it isn't `"0"`. Put the driven net
first and ground/reference second, matching [voltage_source.md](voltage_source.md)'s
convention.

Ground is `"0"`.

## Value

A SPICE-style waveform expression, passed through to the exported netlist
**verbatim** (`toSpice` writes `${value}` with no reformatting):

| Written | Means |
|---------|-------|
| `"SINE(0 1 1k)"` | sine, 0 V offset, 1 V amplitude, 1 kHz |
| `"PULSE(0 5 0 1u 1u 1m 2m)"` | pulse, 0→5V, rise/fall 1µs, 1ms pulse width, 2ms period |
| `"DC 5"` or `"5V"` | a flat DC level |

The live simulator's `parseSourceWaveform` accepts the same three forms
(`SINE(...)`/`PULSE(...)`, `DC <n>`, or a bare number/`<n>V`) — inside the
parentheses it uses ordinary SPICE-style suffixes where `m` means milli
(unlike `parseResistance`, where `m`/`M` means mega). An unparseable value
falls back to a 0 V DC source with a warning rather than failing outright.

## Wiring rules

- One signal source typically drives one input net; the far terminal usually
  goes to `"0"`.
- Because `nodes[0]` is treated as a supply-like net for reachability, a
  signal source can satisfy checks that look for "something powers this net"
  even though it's a stimulus, not a rail — keep that in mind if a topology
  rule seems to accept a signal input as a power source.
- No dedicated rule validates the waveform grammar beyond what the parser
  above accepts; a malformed expression is silently written to the SPICE
  deck and may fail at simulation time rather than at validation time.

## Worked example

1 kHz, 1 Vpp sine test signal into an amplifier's input node:

```json
{ "ref": "V3", "kind": "signal_source", "value": "SINE(0 1 1k)", "nodes": ["AUDIO_IN", "0"] }
```

## Gotchas

- **Node order isn't enforced, but it isn't harmless either.** Reversing the
  two nodes puts the reference/ground terminal into `supplyNets` instead of
  the actual signal net — silent in the JSON, but it can throw off any rule
  that reasons about which net is "powered."
- The waveform string goes straight into the SPICE deck with no validation.
  `parseSourceWaveform`'s pattern (`sine?|pulse`) does tolerate `"SIN(...)"`
  as well as `"SINE(...)"`, but any other malformed call — mismatched
  parentheses, a non-numeric argument — silently produces a 0 V DC source
  with only a runtime warning, not a validation error.
- Inside `SINE(...)`/`PULSE(...)`, `m` means milli (standard SPICE), which is
  the opposite convention from a plain [resistor.md](resistor.md) value where
  bare `m`/`M` means mega. Mixing the two conventions up in your head is an
  easy mistake when both appear in the same circuit file.
