# Frontend (`src/`)

React 19 + Vite 7, no router library — page switching is a tiny hash-based router
(`src/app/routing.js`).

## `src/core` — shared circuit engine

| File | Role |
|---|---|
| `pcbGenerator.js` (~690 ln) | `validateCircuit`, `toSpice`, `toKiCadNetlist`, `toDiagramSvg`, `simulateCircuit` metadata, `addMissingSpiceModels` (injects the built-in `LM358` subcircuit), `buildCircuitDiagram` |
| `schematicLayout.js` (~2000 ln) | Diagram layout engine: `layoutCircuitDiagram` (free + `{ slots: true }` slot-anchored mode), `routeDiagramWire`, `rerouteAffectedNets`, `repairDiagramLayout`, `validateDiagramLayout`, collision/clearance helpers, and the slot-grid primitives (`SCHEMATIC_SLOT_LAYOUT`, `slotGridFor`, `slotCanvasSize`, `slotRects`, `slotCenter`, `assignSlots`, `nextFreeSlot`, `nearestSlot`). Current layout version: `LAYOUT_VERSION = 5` |
| `circuitSync.js` (~815 ln) | Bidirectional sync between the canonical circuit model and each editable view: `parseSpiceNetlist`, `parseKiCadNetlist`, `parseCircuitJson`, `circuitFromDiagram`, `circuitElectricalSignature`, `synchronizeResult`, `preserveDiagramLayout` |
| `lineDiff.js` | `changedLineIndexes` — used to highlight changed SPICE lines in AI-proposal review mode |
| `config.js` | `API_BASE` from `VITE_API_URL` |
| `download.js` | `downloadText` browser download helper |

`core` has no dependency on `app` or `features` — it's pure logic plus `.d.ts` type
declarations for the `.js` files that are consumed from TypeScript on the server side.

### How the layout engine draws a human-readable schematic

`layoutCircuitDiagram(circuit)` turns the topological circuit model (components +
net connectivity, no coordinates) into a fully placed and routed diagram. The AI
never supplies positions; all geometry is deterministic. The pipeline aims to
read like an engineer drew it rather than a machine scattered parts:

1. **Rank into signal-flow columns.** `rankComponents` BFS-walks the net graph
   from the sources; a component's rank (distance in hops) becomes its column,
   giving left-to-right signal flow.
2. **Tidy placement first.** `buildDraft` places each rank's parts in that rank's
   vertical lane using `TIDY_GRID` — a single clean column per rank (ranks with
   several parts fan into a tight aligned block). This is the preferred, most
   hand-drawn-looking layout.
   - **Pin alignment.** Before placing a part, `alignmentRow` looks for an
     already-placed pin on a shared net and lines the part up with the row that
     pin escapes on, so series passives, op-amp inputs, and BJT bases connect in
     one straight run instead of a staircase. Alignment stays within the part's
     own rank band (long chains wrap into serpentine bands and must not collapse
     onto one endless row). Multi-pin side pins (op-amp inputs, BJT C/E) sit a
     grid multiple from the component center so aligned wires meet them without
     an off-grid jog at the pin.
   - **Upright grounded passives.** A grounded 2-pin part that flips vertical
     also swaps its body to portrait so the vertical zigzag glyph fits.
   - **Labels hug their part.** `makeComponentLabels` prefers spots just past
     the body box / pin-escape reach (26px above/below, 40px beside horizontal
     parts, 10px beside vertical ones); the outward ring search is a last
     resort, since text floating away from its part reads as machine layout.
3. **Route + validate.** `routeWithExpansion` runs the grid A\* router and
   `validateDiagramLayout`. The tidy pass gets a small expansion budget
   (`TIDY_EXPANSION_BUDGET`) so it bails quickly on topologies it can't route
   cleanly (e.g. an op-amp whose input parts rank to its right and must wrap
   around).
4. **Spread fallback.** If tidy can't route, retry once with `SPREAD_GRID` — the
   original wider fan-out that interleaves adjacent ranks enough to route dense
   feedback circuits. Only if *that* also fails does the server fall back to
   labeled-net stubs (`buildFallbackCircuitDiagram`).
5. **Local ground rail.** The ground net anchors just below the lowest grounded
   pin, so ground drops are short and clustered under their parts instead of
   routing the full height of the sheet.
6. **Crop to content.** On success, `cropDiagramToContent` trims the canvas to a
   tight box around the drawn geometry (resize-only, never moves a coordinate, so
   a validated layout stays valid) so the schematic fills its frame.

`toDiagramSvg` (in `pcbGenerator.js`) and the canvas (`CircuitDiagram.jsx`)
render pin-number labels only on multi-pin parts that need them (op amps,
generic symbols); two-pin passives are unnumbered the way a schematic normally
is, and BJTs rely on their C/B/E letters. The canvas draws wires, symbols,
junction dots, and bridge arcs in a single ink (`--color-text`), reserving the
accent color for hover/selection; net-label pills are invisible until
hovered/selected so net names read as plain text flags. Layout tuning constants
(`TIDY_GRID`, `SPREAD_GRID`, clearances, `CANVAS_MARGIN`) live at the top of
`schematicLayout.js`.

#### Slot grid and slot-anchored placement

Generated components are placed into a **fixed slot grid** rather than scattered
freely. The grid is the source of truth: `SCHEMATIC_SLOT_LAYOUT` (in
`schematicLayout.js`) fixes the slot size (`slotWidth`/`slotHeight`), `gap`,
`margin`, and column count; `slotCanvasSize(rows, cols)` *derives* the canvas
from the grid (the inverse of the old canvas-drives-slots relationship), and
`slotGridFor(count)` grows the row count so every component gets its own slot
(≥2 rows). All slot geometry lives in **core** (`slotRects`, `slotCenter`,
`assignSlots`, `nextFreeSlot`, `nearestSlot`) so the layout engine and the
renderer share one definition.

`layoutCircuitDiagram(circuit, { slots: true })` is the slot-placement mode:
`buildDraft`'s `slots` branch sizes the canvas from the grid, orders components
by signal-flow rank, assigns them column-major to slot cells (`assignSlots`), and
pins each component **exactly** at its slot center (bypassing the
collision-nudge). The existing A\* router then wires them through the gaps, and
external-terminal **ports** drop as short stubs beside their connected pin
(edge-anchored ports would be unroutable across fixed slots). The returned
diagram carries `slotLayout: { rows, cols }`; `cropDiagramToContent` never shrinks
below the slot-grid extent, so empty trailing slots stay visible. `buildCircuitDiagram`
(hence the server's generated diagram and every edit through `synchronizeResult`)
and the canvas **Auto-layout** button all use `{ slots: true }`.

`geometry.js` `addedComponent` drops a manually-added part into the
`nextFreeSlot`; **dragging stays unrestricted** (`movedComponent` is unchanged) —
snapping a drag into a slot is a later step, as is mapping a component's terminals
onto the slot pins. `preserveDiagramLayout` keeps user-dragged positions and grows
the canvas to contain them, so a part dragged past the grid is not shoved back.

The canvas draws the slots as dashed, numbered rectangles below the wires and
symbols. `schematicSlots(rows, cols)` in `geometry.js` wraps core's `slotRects`
and decorates each with the **fixed pin set** (`SCHEMATIC_SLOT_PINS`: `+`/`−`
signal pins on the left, `V+`/`V−` power rails on top/bottom) — always present so
a component that occupies a slot maps its terminals onto the pins it uses. The
renderer sizes the grid from `diagram.slotLayout` (falling back to
`slotGridFor(components.length)`); the layer is `pointerEvents="none"`.

## `src/app` — app shell

- **`App.jsx`** (~1200 ln) — the integration point. Owns: chat store state, active
  chat/circuit/SPICE/KiCad/JSON editor state, open editor windows + split-pane layout,
  canvas tool/selection state, generation streaming, simulation runs, and every
  synchronization effect that keeps SPICE/canvas/KiCad/JSON in agreement. Imports from
  `core` and every `features/*` module — nothing imports from `App.jsx`.
  - **Editor windows UI** — the workbench has no title/status header; the `editor-launchbar`
    sits flush at the top and renders as a minimalist browser-style tab strip (compact, no
    "Open views" label; open tabs read as connected to the content, the focused tab gets an
    accent underline). Each window titlebar has a **maximize/restore** control
    (`maximizedEditorView` state) alongside close: maximizing renders that window as a
    `position: fixed; inset: 0` overlay filling the **entire viewport** (hiding the split, chat
    panel and top bar), and while maximized, clicking another tab swaps the full-screen view
    (browser-tab behavior). Maximize state is in-memory only (not persisted).
- **`routing.js`** — `pageFromHash`, `AUTH_PAGES`, `PUBLIC_PAGES` (hash-based nav between
  home/login/signup/verify and the main workspace).
- **`generationStream.js`** — `readGenerationStream`, `markSpiceAsProvisional`: consumes the
  NDJSON stream from `/api/generate-circuit`.

## `src/features`

| Chunk | Files | Responsibility |
|---|---|---|
| `auth` | `auth.jsx`, `auth.css` | `AuthProvider`/`useAuth` context, `HomePage`, `LoginPage`, `SignupPage`, `VerifyPage`. Talks directly to `/api/auth/*`; stores JWT in `localStorage` under `pcb_token`. |
| `chat` | `chatStore.js`, `chatFormat.js`, `ChatPanel.jsx` | `loadChatStore`/`saveChatStore` (localStorage-backed, key `prompt-to-pcb-chats-v1`), `createChat`, `chatTitleFromPrompt`, `buildConversationContext`, `migrateChatDiagram` (upgrades saved diagrams to the current layout version) |
| `schematic` | `CircuitDiagram.jsx`, `symbols.jsx`, `geometry.js` | The interactive canvas: rendering, symbols (`DiagramSymbol`, `GroundSymbol`, `PortSymbol`, `BridgeSymbol`), and pure geometry helpers (`addedComponent`, `movedComponent`, `moveWirePath`, `componentPinPoint`, etc.) |
| `blockSchematic` | `BlockSchematic.jsx`, `BusEdge.jsx`, `blockSchematicModel.js`, `blockSymbols.jsx`, `BlockSchematic.css` | The **"new schematic test"** view — a read-only [React Flow](https://reactflow.dev) (`@xyflow/react`) block diagram: one rectangle per component whose header shows the component's **schematic symbol** (SVG glyph keyed by `kind`, from `blockSymbols.jsx` — self-contained so the chunk stays decoupled) instead of a name, with the `ref`/`value` beneath it, pins listed down the right side (labeled Positive/Negative for 2‑pin parts, positional for opamp/BJT and the MCU boards' header pins). Nets connecting ≥2 pins become wires: each net gets its own lane index → contrasting color (`laneColor`) and a dedicated vertical channel, routed by the custom orthogonal `BusEdge` (`laneX = max(sourceX,targetX)+margin+laneIndex*gap`) so wires run parallel instead of overlapping. Clicking a wire selects it — React Flow adds `.selected`, the wrapper gets `.has-selection`, and CSS highlights the active wire while dimming the rest. `blockSchematicModel.js` is a pure `circuit → { nodes, edges }` transform (unit-tested in `blockSchematicModel.test.js`); it re-derives the `isUnconnectedTerminal` predicate locally rather than importing another chunk |
| `realisticSchematic` | `RealisticSchematic.jsx`, `Breadboard.jsx`, `parts.jsx`, `breadboardModel.js`, `breadboardGeometry.js`, `breadboardDescription.js`, `partVisuals.js`, `RealisticSchematic.css` | The **"Realistic schematic"** view — an interactive Fritzing-style breadboard editor rendered entirely in SVG: a half-size solderless breadboard (grows in 10-column steps when a circuit overflows) with photo-style parts (resistors with color bands computed from `value`, electrolytic/ceramic caps, LED lens colors, DIP-8 opamps straddling the trench, TO-92 transistors, TO-220 regulators, a faithful ESP32 DevKit V1 module straddling the trench like a wide DIP — matte-black PCB, gold PCB-antenna meander, ESP-WROOM-32 brushed-metal shield can, gold castellated header pads, CP2102/AMS1117 chips, EN/BOOT buttons, power/user LEDs and a micro-USB) and colored jumper wires. Microcontroller boards that physically can't plug into a breadboard — **Arduino Uno** and **Raspberry Pi** — render **off-board in fixed-height slots below the board** (`mcuSlotRect` in `breadboardGeometry.js`; `MCU_SLOT_HEIGHT` is tall enough for true board aspect ratios). The **Raspberry Pi** is drawn as a faithful **Pi 4 Model B** at a true ~1.5:1 landscape aspect (same reusable primitives as the Uno, plus `RaspberryLogo`/`FpcConnector` and the retuned `rsPartPi` green): a 2-row GPIO header (the functional row is where wires attach), WiFi/BT shield can, Gigabit Ethernet with link LEDs + PoE header, dual USB-3 (blue) / USB-2 (dark) stacks overhanging the right edge, BCM2711 SoC with a metal lid + LPDDR4 RAM + VL805 controller, DISPLAY/CAMERA FPC ribbon connectors, USB-C power + 2× micro-HDMI + AV jack overhanging the bottom edge, a scattered SMD-passive field, PWR/ACT status LEDs, four mounting holes, and the raspberry logo + "Raspberry Pi 4 Model B" silkscreen. The Uno is drawn as a faithful top-down Arduino Uno R3 at a true ~1.285:1 aspect ratio (the MCU slot was made taller — `MCU_SLOT_HEIGHT` in `breadboardGeometry.js` — so the board isn't a stretched bar; the board is sized to contain its functional top header and left-anchored under the header pads, all detail placed in board-fraction coordinates). It composes reusable flat board-realism primitives in `parts.jsx` (`Silk`/`SilkLine`, `GoldPad`, `SmdLed`, `TactButton`, `MetalConnector`, `Chip`, `MountHole`, `Crystal`, `IcspHeader`, `ElectroCap`, `ArduinoLogo` + `rsGoldPad`/`rsBlackPlastic`/`rsBrushedShield`/`rsCopperRing` gradients): authentic teal soldermask with an inset bevel (no drop shadow/gloss), the ATmega328P DIP-28 in a socket (legs + pin-1 notch), USB-B and DC barrel-jack overhanging the left edge, SOT-223 regulator, 16 MHz crystal, two electrolytic cans, ATmega16U2 + two ICSP headers, reset button, ON/L/TX/RX LEDs, four mounting holes, the infinity logo with `ARDUINO`/`UNO` wordmarks, and silkscreen section labels (`DIGITAL (PWM~)`, `POWER`, `ANALOG IN`). The functional top header (`McuHeader`, a black-plastic strip with square gold pads) is where jumper wires attach; the bottom power/analog headers are decorative. The on-board ESP32 (`Esp32Body`) reuses these same primitives within its compact trench-straddling footprint. their header pads fan jumper wires up to the bottom strip left-to-right without crossing (the wires paint above the board body so they visibly terminate on the gold pads, with plug-end dots at both ends; power pins land directly on rail holes; a rail pre-pass puts an MCU's 5V/3V3 net on a free `+` rail so MCU-powered circuits still tap clean rails; `MCU_PINS` in `breadboardModel.js` holds the canonical positional pin lists). `breadboardModel.js` is a pure `circuit → placement` transform (`circuitToBreadboard`, unit-tested): ground/supply nets map to the rails, other nets get 5-hole tie groups via a greedy left-to-right column allocator with series-chain reuse; voltage sources render as off-board battery packs feeding the rails. Jumper wires are cubic curves; same-column jumpers bow sideways instead of lifting (a vertical lift would render a straight line overshooting the rails) — rail-to-strip stubs bow gently right, rail-to-rail bridges bow left into the board so they clear the right-edge rail net labels. `partVisuals.js` holds the value-parsing heuristics (`resistorColorBands`, `capStyle`, `ledColor`, unit-tested). Interactive: clicking a part or wire highlights its electrical neighborhood — the part, its nets' jumpers, tie-group columns, rail stripes, and feeding battery — and dims everything else (hover previews the same more gently); a movable part's selection resolves on pointer release inside `endPointer` (not its `onClick`) because the part-drag pointer capture retargets the ending click to the SVG in real browsers, with `suppressClickRef` swallowing the duplicate click on paths without capture; `selectionModel.js` is the pure `highlightFor`/`readoutFor`/`pinLabelsFor` logic (unit-tested). **Navigation** is a pan/zoom canvas: the whole board sits in one `translate/scale` world `<g>` (fixed `viewBox` + `preserveAspectRatio`), dragging empty board pans, wheel/pinch zoom stays anchored under the cursor, two-finger trackpad pans, and gestures come through Pointer Events with `touch-action:none` (view transform is rAF-coalesced; the memoized `Breadboard` hole grid never re-renders during a gesture). `clientToViewBox`/`viewBoxToBoard` (in `breadboardGeometry.js`, mirroring `schematic/geometry.js`'s `svgPointer`) map pointer→board space. **Editing** (only when `App.jsx` passes the callbacks): with a part selected, its pins become drag handles — dragging a pin to another hole rewires it (resolved via `holeAt`+`netAtHole`, an empty hole disconnects to an `NC_*` placeholder), emitted as a targeted `component.nodes` edit through `onCircuitChange`→`applyCircuitChange`→`synchronizeResult` so SPICE/KiCad/JSON/schematic stay consistent; dragging a part body repositions it, persisted as an anchor in the `editedBreadboard` layer via `onLayoutChange`. `circuitToBreadboard(circuit, overrides)` honors those anchors in a two-phase placement (pinned parts first, greedy-around them second — byte-identical to pure auto-placement when no overrides), and `reconcileOverrides` drops anchors for removed parts. Also: clickable net legend chips, pin labels on selection (opamp IN±/OUT, BJT C/B/E, MOSFET D/G/S, LED A/K, MCU header names like D13/GPIO17), toolbar readout, +/−/Fit zoom controls, and SVG export via `downloadText`. A **"Copy description"** toolbar button (debug aid) copies a plain-text dump of the build — via `describeBreadboard(circuit, model)` in `breadboardDescription.js` (pure, unit-tested): intended netlist, per-net pin lists, physical placement (rails/batteries/parts/jumpers with breadboard hole addresses like `a5`), a reconstructed-connectivity check that flags any `SPLIT` (net across ≥2 nodes) or `SHORT` (node mixing nets), and warnings — so it can be pasted into an AI to verify the generated schematic (falls back to a downloadable `.txt` when the clipboard is unavailable). All four model files re-derive `isUnconnectedTerminal` locally rather than importing another chunk |
| `editors` | `editorConfig.js`, `firmwareInfo.js` | Editor window labels/keys and split-pane persistence (`EDITOR_SPLIT_STORAGE_KEY`, `loadEditorSplit`) — the editor windows themselves render inside `App.jsx`. Views: `spice`, `json`, `code` ("Code") — an editable firmware tab fed by the AI response's optional `code` field, with Reset/Download (`firmwareInfo.js` maps the circuit's first MCU board to language/filename: Uno/ESP32 → `sketch.ino` Arduino C++, Pi → `gpio_script.py` gpiozero; a no-MCU circuit shows a placeholder; revision changes show the same diff + accept/reject flow as SPICE via `pendingCodeChange`) — `canvas`, `blockSchematic` ("new schematic test") — a scaffold tab for an alternate block-based schematic (rectangle-per-component with pins on one side) — and `realisticSchematic` ("Realistic schematic") — an interactive breadboard editor (pan/zoom, pin-drag rewiring, part-drag placement) with photo-style parts |
| `waveform` | `WaveformChart.jsx` | Custom SVG chart: trace toggles, zoom/pan, hover readout, CSV export, collapsible Ngspice log |

## Persistence model

Everything user-facing is `localStorage`-backed (no server-side chat storage): the chat
store (`prompt-to-pcb-chats-v1`) and the editor split layout
(`prompt-to-pcb-editor-split-v1`). Per-chat persisted geometry lives on the chat record:
`editedDiagram` (schematic edits) and `editedBreadboard` (breadboard part-placement anchors,
`{ version, parts: { [ref]: { strip, column } } }`) — both survive reloads and are reconciled
against the circuit when topology changes. Only auth accounts live server-side (Postgres/Neon or an
in-memory fallback — see `docs/BACKEND.md`).
