# AI provider and the circuit model

## The circuit JSON contract

Every AI response must be a single JSON object with `reply`, `circuit`, and `spice`. The
`circuit` object:

```json
{
  "title": "Circuit title",
  "type": "circuit_type",
  "supplyVoltage": 5,
  "nodes": ["VCC", "VOUT", "0"],
  "components": [
    { "ref": "R1", "kind": "resistor", "value": "1k", "nodes": ["VCC", "VOUT"], "footprint": "..." }
  ],
  "notes": ["Short useful note."]
}
```

Allowed `kind` values: `resistor`, `capacitor`, `inductor`, `diode`, `led`, `bjt_npn`,
`bjt_pnp`, `mosfet_n`, `mosfet_p`, `opamp`, `regulator`, `voltage_source`,
`signal_source`, `load`.

Rules baked into the system prompt (`server/ai/ollamaProvider.ts`) and
`ai-context/pcb-circuit-expert.md`:

- Component refs must be SPICE-safe by kind: `R`=resistor/load, `C`=capacitor, `L`=inductor,
  `D`=diode/LED (never `LED1` — SPICE would parse the leading `L` as an inductor), `V`=DC or
  signal source, `Q`=BJT, `M`=MOSFET, `X`=opamp/subcircuit.
- `"0"` is the only ground node; never `"GND"`.
- Opamps must use `LM358` as both the JSON value and the SPICE subcircuit name — the app
  ships a built-in 5-pin `LM358` model (`LM358_SUBCIRCUIT` in `src/core/pcbGenerator.js`)
  that `addMissingSpiceModels` injects into any deck that references it without defining it.
- `voltage_source` = DC/fixed bias; `signal_source` = waveform (`SINE`, `PULSE`, `PWL`,
  `EXP`, `AC`).
- Never omit an LED current-limiting resistor or required biasing/feedback components.
- Optional compact `schematic` metadata can mark external terminals or an opamp's
  `primaryRef` — visual-only, must not add SPICE components.

The exporter (`src/core/pcbGenerator.js`) also normalizes refs during SPICE export as a
safety net even if the AI produces an imperfect ref (e.g. an LED-kind component with a
non-`D` ref still exports as `D_<ref>`).

## Reliability pipeline

1. Ollama (or the OpenAI-compatible provider under `AI_PROVIDER`) is called with the JSON
   schema as structured-output format (`CIRCUIT_SCHEMA`/`AI_RESPONSE_SCHEMA`).
2. `parseCircuitResponse` repairs malformed/truncated JSON where possible.
3. `validateCircuitResponse` / `validateCircuit` (frontend) check schema conformance.
4. One automatic corrective retry is triggered on invalid/malformed output.
5. `reconcileCircuitRevision` merges the new circuit against the previous confirmed design
   (a revision, not a fresh generation, when `currentDesign` is present).
6. Streamed SPICE is marked `provisional`/`correcting` until the full circuit validates.
7. On failure, the previous confirmed SPICE/circuit is restored — the UI never silently
   replaces a working design with a broken one.

## Chat memory / context window

`server/ai/chatMemory.ts` keeps a persisted, per-chat summary of confirmed requirements and
decisions (`updateChatMemory`), rather than replaying the full conversation every time.
Requests to Ollama combine: that memory summary + the canonical current circuit + recent
turns (`sanitizeConversationHistory`) + the newest prompt, inside a server-controlled
context window (`OLLAMA_NUM_CTX` / `OLLAMA_NUM_PREDICT`).

## Synchronization: SPICE <-> canvas <-> KiCad <-> JSON

`src/core/circuitSync.js` is the single synchronization layer all four editable views go
through. The canonical electrical representation is: component ref, kind, value, ordered
pin nodes, footprint. Canvas (x/y) layout is visual-only and never affects
`circuitElectricalSignature`.

- **Canvas -> circuit**: `circuitFromDiagram`. New components start with `NC_...`
  placeholder nodes (unconnected) until wired.
- **SPICE -> canvas**: parsing supports `R`/`C`/`L`/`V`/`D`/`Q` lines and the 5-node `X`
  opamp form used by this app; `.model`/`.tran`/`.op`/`.end`/comments and `.subckt`/`.ends`
  bodies are ignored for canvas sync. `+` continuation lines are **not** supported.
  Incomplete/unsupported lines pause sync and show an error rather than corrupting the
  diagram.
- **KiCad -> canvas**: XML netlist edits (values, footprints, kinds, net names, pin
  assignments, add/remove) sync back the same way; malformed XML pauses sync.
- **Layout preservation**: `preserveDiagramLayout` keeps existing component positions (by
  ref) and net-label positions (by stable pin label ID) across edits; only new components
  get freshly generated positions. Layout format is versioned
  (`LAYOUT_VERSION` in `schematicLayout.js`, currently 4) with migration for older saved
  diagrams (`migrateChatDiagram` in `chatStore.js`).
- **Routing**: `schematicLayout.js` treats components, labels, and existing wires as hard
  obstacles — auto-routed wires cannot cross/touch/come within `WIRE_CLEARANCE` (16px) of
  another wire. Interactive dragging is unconstrained (no snapping/collision correction while
  the user drags).

## Known limitations (carried over from `SESSION_SUMMARY.md`)

- The SPICE parser handles only this app's generated syntax, not arbitrary SPICE dialects.
- MOSFET and general subcircuit parsing from hand-edited SPICE/KiCad is not implemented.
- KiCad export is an XML netlist, not a full `.kicad_sch`/PCB project.
- Ngspice validates that the deck *runs*, not that the circuit is electrically correct.
