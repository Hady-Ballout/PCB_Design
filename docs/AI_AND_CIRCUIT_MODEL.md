# AI provider and the circuit model

## Two-phase prompt flow: clarify, then generate

Every user prompt runs two AI calls, orchestrated deterministically by the client
(`beginPrompt` in `src/app/App.jsx`):

1. **Clarify** — `POST /api/clarify-circuit` → `generateClarifyingQuestions`
   (`server/ai/clarifyProvider.ts`). A cheap, non-streaming call with its own small
   grammar-constrained schema (`CLARIFY_SCHEMA`: 1–3 questions, 2–4 short options each) and
   a standalone system prompt (no knowledge base). The server sanitizes the model output
   (`sanitizeClarifyQuestions`: caps, dedupe, `q1..q3` ids) and always appends the
   canonical `'No preference (you decide)'` option to every question. The chat UI renders
   the questions as clickable chips; unanswered questions default to "No preference".
2. **Generate** — the existing `/api/generate-circuit` pipeline, unchanged, with the
   answers folded into the prompt by `composeClarifiedPrompt`
   (`Original request: …\nUser clarifications:\n- Q → A…`). The generation call itself must
   still never ask questions (see `ai-context/pcb-circuit-expert.md`).

Failure semantics: **any** clarify failure (network, non-OK, zero usable questions) makes
the client silently fall back to direct generation with the original prompt — the round can
never block a prompt. There is no correction retry on the clarify call.

Clarification assistant messages carry no `circuit`, so `buildConversationContext`
(client) and `sanitizeConversationHistory` (server) exclude them from model history; the
user's answers reach future turns via the compact `Clarifications: …` user message instead.

## The circuit JSON contract

Every AI response must be a single JSON object with `reply`, `circuit`, and `spice`, plus
an optional fourth field `code` — firmware source for the circuit's microcontroller board
(Arduino C++ sketch for `arduino_uno`/`esp32`, Python gpiozero for `raspberry_pi`; empty
string when the circuit has no board). `code` validation is soft: a missing or empty value
never fails or retries a generation, and `parseCircuitResponse` defensively strips
accidental Markdown fences. Unlike `spice`/`kicadNetlist`, firmware is not derivable from
the circuit, so it is never regenerated server-side — after manual circuit edits the stored
code can go stale until the next AI generation (known limitation). The
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

Allowed `kind` values are the single source of truth in `src/core/componentKinds.js`
(`ALLOWED_KINDS`). The AI schema `enum` and the "Allowed component kinds" / fixed-pin
guidance in the system prompt (`server/ai/ollamaProvider.ts`) are **generated from it**, so
adding a kind to the registry automatically offers it to the model. The current 37 kinds:

- **Core (14):** `resistor`, `capacitor`, `inductor`, `diode`, `led`, `bjt_npn`, `bjt_pnp`,
  `mosfet_n`, `mosfet_p`, `opamp`, `regulator`, `voltage_source`, `signal_source`, `load`.
- **Extended (20):** `zener`, `photoresistor`, `thermistor`, `buzzer`, `crystal`,
  `temp_sensor`, `comparator`, `pushbutton`, `potentiometer`, `switch_spdt`, `rgb_led`,
  `seven_segment`, `timer_555`, `ultrasonic_sensor`, `dht_sensor`, `oled_display`,
  `pir_sensor`, `servo`, `dc_motor`, `relay_module`.
- **Microcontroller boards (3):** `arduino_uno`, `raspberry_pi`, `esp32`.

Microcontroller boards (`arduino_uno`, `raspberry_pi`, `esp32`) use fixed positional pin
lists (24/10/12 pins — see `MCU_PINS` in
`src/features/realisticSchematic/breadboardModel.js` and `MCU_PIN_COUNTS` in
`src/core/componentKinds.js`); unused pins carry `NC_<REF>_<pinNumber>` placeholder nets.
Sensor/module parts (`temp_sensor`, `ultrasonic_sensor`, `dht_sensor`, `oled_display`,
`pir_sensor`, `servo`, `relay_module`) are likewise **wiring-only** and use fixed pin lists
(`FIXED_PIN_NAMES` in `src/core/componentKinds.js`), exported to SPICE only as a comment.
They use `U` refs, are **wiring-only** — exported to SPICE as a comment (`* U1
arduino_uno ...`), never as an element line — and `parseSpiceNetlist` carries them over
from the base circuit during SPICE sync so editing the deck does not drop them.

On the realistic-schematic breadboard, per-kind placement is table-driven
(`STRADDLE_PACKAGES` / `INLINE_BODY_BY_KIND` / `OFFBOARD_SLOT_HEIGHTS` in
`src/features/realisticSchematic/breadboardModel.js`): `comparator` (5-pin opamp contract)
and `timer_555` (canonical pins = NE555 DIP 1-8) straddle the trench as DIP-8s like the
opamp, `pushbutton` straddles with both pins on the bottom strip (top legs decorative),
`seven_segment` straddles as a 5161AS DIP-10 (second COM leg decorative),
`temp_sensor` gets a TO-92 can, and `servo`/`dc_motor`/`relay_module` sit in compact
off-board slots below the board (variable-height slot stack shared with the MCU boards;
MCU boards always claim the first slots). Kind-specific artwork dispatches via
`KIND_RENDERERS` in `parts.jsx` (zener/photoresistor/thermistor/buzzer/crystal/
potentiometer/switch_spdt/rgb_led/ultrasonic_sensor/dht_sensor/oled_display/pir_sensor)
plus dedicated straddle and slot bodies;
selection pin labels come from the registry's `FIXED_PIN_NAMES` plus manual canonical
orders in `selectionModel.js`.

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
3. `validateCircuitResponse` / `validateCircuit` (frontend) check schema conformance,
   including exact node counts for every positional kind (`POSITIONAL_NODE_KINDS`): all
   `fixedPins` kinds, the compound kinds (`potentiometer` 3, `switch_spdt` 3, `rgb_led` 4,
   `seven_segment` 9), plus `opamp`/`comparator`/`pushbutton`/BJTs/MOSFETs — everything
   whose pins are mapped by index downstream (breadboard leg layouts, SPICE expansion).
4. A parseable circuit is then gated on the **topology rule engine**
   (`checkCircuitTopology`, `src/core/topologyRules.js`) — functional design rules that
   net-continuity checks cannot see: GPIO driving a heavy load with no transistor stage,
   the divider-powered-load pattern, LEDs without series resistors, reversed polarity,
   floating bases/gates, missing flyback diodes, missing pull-ups, GPIO current budgets,
   floating op-amp inputs. Error-severity violations become a corrective message
   (`composeTopologyCorrection`) fed back to the model.
5. Up to `MAX_GENERATION_ATTEMPTS` (3) attempts run in `parseWithCorrectionRetry`:
   structural failures (bad JSON/schema/SPICE) retry with the parser error; topology
   errors retry with the rule violations. Compound-part SPICE mismatches (e.g. one bare
   `DLED1` diode line instead of derived `DLED1_R/_G/_B` lines) produce a correction
   message that spells out the expected derived-line names.
6. If the final attempt still fails only the SPICE-vs-JSON consistency check
   (`spice_validation`), the deck is regenerated deterministically from the canonical
   JSON via `toSpice` instead of failing the chat turn.
7. **Never a terminal failure once anything parsed**: after the retry budget, the
   best-scoring candidate (fewest error violations; later attempt wins ties) is accepted
   with `generation.degraded: true`, safe additive auto-fixes are applied
   (`applySafeAutoFixes`: MOSFET gate pull-down, flyback diode — marked `autoFixed`), and
   the surviving violations ship in the response `issues` for the UI to surface. A hard
   throw only happens when all three attempts failed structurally.
8. `reconcileCircuitRevision` merges the new circuit against the previous confirmed design
   (a revision, not a fresh generation, when `currentDesign` is present); the server
   re-runs the topology check on the reconciled circuit before responding.
9. Streamed SPICE is marked `provisional`/`correcting` until the full circuit validates.
10. On structural failure, the previous confirmed SPICE/circuit is restored — the UI never
    silently replaces a working design with a broken one.

## Topology rule engine (`src/core/topologyRules.js`)

A pure, shared module (plain JS + `.d.ts`, imported by both the server retry loop and the
frontend) that checks *functional* correctness on top of schema/continuity validation. It
exists because a circuit can have perfect net continuity and still be wrong — the canonical
case: a buzzer on an ESP32 GPIO net fed from 3V3 with a resistor divider to ground and no
transistor anywhere. Every net checks out; the GPIO cannot switch the load.

- `buildCircuitGraph(circuit)` — net→pins index, GPIO/supply net detection, and a
  `reach(net, opts)` BFS through conductive parts (options select which kinds conduct:
  resistors, switches, diodes, driver channels).
- `checkCircuitTopology(circuit)` → `{ ok, violations }`. Violations are
  `{ id, severity: 'error'|'warning', refs, nets, message, fix, autoFixed }` — `fix` is a
  concrete recipe with real refs, reused verbatim in the AI correction message and the UI.
- `TOPOLOGY_RULES` is a flat array; adding a rule = one entry + one fixture pair in
  `topologyRules.test.js`. A rule may declare `supersedes` so a specific finding (e.g.
  `divider_powered_load`) silences the generic one (`gpio_direct_load`) for the same refs.
- Rules are deliberately conservative (skip ambiguous topologies): a false positive burns
  a retry and erodes trust. The test suite pins a zero-error known-good corpus.
- `applySafeAutoFixes(circuit, violations)` applies additive-only repairs (100k gate
  pull-down, 1N4007 flyback diode) in the degraded path and marks them `autoFixed`;
  anything that would rearrange existing parts stays a surfaced violation.

## Chat memory / context window

`server/ai/chatMemory.ts` keeps a persisted, per-chat summary of confirmed requirements and
decisions (`updateChatMemory`), rather than replaying the full conversation every time.
Requests to Ollama combine: that memory summary + the canonical current circuit + recent
turns (`sanitizeConversationHistory`) + the newest prompt, inside a server-controlled
context window (`OLLAMA_NUM_CTX` / `OLLAMA_NUM_PREDICT`).

## Synchronization: SPICE <-> canvas <-> KiCad <-> JSON

`src/core/circuitSync.js` is the single synchronization layer all editable views go
through. The canonical electrical representation is: component ref, kind, value, ordered
pin nodes, footprint. Visual layout — canvas (x/y) and breadboard part-placement anchors
(`editedBreadboard`) — is never part of `circuitElectricalSignature`.

- **Canvas -> circuit**: `circuitFromDiagram`. New components start with `NC_...`
  placeholder nodes (unconnected) until wired.
- **Breadboard -> circuit**: the realistic-schematic editor rewires by dragging a pin to a
  new hole, which is a targeted edit of one `component.nodes[i]` (the net on the dropped
  tie group via `netAtHole`, or an `NC_<ref>_<pin>` placeholder when unplugged). `App.jsx`'s
  `applyCircuitChange` gates on `circuitElectricalSignature` and runs the same
  `synchronizeResult` spine — no diagram inverse needed since the next circuit is already in
  hand. Breadboard placement itself is visual-only (see `editedBreadboard` below).
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
  (`LAYOUT_VERSION` in `schematicLayout.js`, currently 5) with migration for older saved
  diagrams (`migrateChatDiagram` in `chatStore.js`).
- **Breadboard placement (`editedBreadboard`)**: a persisted `{ version, parts: { [ref]:
  { strip, column } } }` layer on the chat record pinning parts the user dragged.
  `circuitToBreadboard(circuit, overrides)` places pinned parts first, then greedy-places the
  rest around them (byte-identical to pure auto-placement when empty). `reconcileOverrides`
  drops anchors whose part is gone when topology changes; added parts have no anchor and fall
  to auto-placement — the breadboard analogue of `preserveDiagramLayout`.
- **Routing**: `schematicLayout.js` treats components, labels, and existing wires as hard
  obstacles — auto-routed wires cannot cross/touch/come within `WIRE_CLEARANCE` (16px) of
  another wire. Interactive dragging is unconstrained (no snapping/collision correction while
  the user drags).

## Known limitations (carried over from `SESSION_SUMMARY.md`)

- The SPICE parser handles only this app's generated syntax, not arbitrary SPICE dialects.
- MOSFET and general subcircuit parsing from hand-edited SPICE/KiCad is not implemented.
- KiCad export is an XML netlist, not a full `.kicad_sch`/PCB project.
- Ngspice validates that the deck *runs*, not that the circuit is electrically correct;
  functional correctness is checked by the topology rule engine above, whose rules are
  heuristics — a clean report is strong evidence, not proof, of a working circuit.
