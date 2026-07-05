# Frontend (`src/`)

React 19 + Vite 7, no router library — page switching is a tiny hash-based router
(`src/app/routing.js`).

## `src/core` — shared circuit engine

| File | Role |
|---|---|
| `pcbGenerator.js` (~690 ln) | `validateCircuit`, `toSpice`, `toKiCadNetlist`, `toDiagramSvg`, `simulateCircuit` metadata, `addMissingSpiceModels` (injects the built-in `LM358` subcircuit), `buildCircuitDiagram` |
| `schematicLayout.js` (~1900 ln) | Diagram layout engine: `layoutCircuitDiagram`, `routeDiagramWire`, `rerouteAffectedNets`, `repairDiagramLayout`, `validateDiagramLayout`, collision/clearance helpers. Current layout version: `LAYOUT_VERSION = 5` |
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
| `blockSchematic` | `BlockSchematic.jsx`, `BusEdge.jsx`, `blockSchematicModel.js`, `blockSymbols.jsx`, `BlockSchematic.css` | The **"new schematic test"** view — a read-only [React Flow](https://reactflow.dev) (`@xyflow/react`) block diagram: one rectangle per component whose header shows the component's **schematic symbol** (SVG glyph keyed by `kind`, from `blockSymbols.jsx` — self-contained so the chunk stays decoupled) instead of a name, with the `ref`/`value` beneath it, pins listed down the right side (labeled Positive/Negative for 2‑pin parts, positional for opamp/BJT). Nets connecting ≥2 pins become wires: each net gets its own lane index → contrasting color (`laneColor`) and a dedicated vertical channel, routed by the custom orthogonal `BusEdge` (`laneX = max(sourceX,targetX)+margin+laneIndex*gap`) so wires run parallel instead of overlapping. Clicking a wire selects it — React Flow adds `.selected`, the wrapper gets `.has-selection`, and CSS highlights the active wire while dimming the rest. `blockSchematicModel.js` is a pure `circuit → { nodes, edges }` transform (unit-tested in `blockSchematicModel.test.js`); it re-derives the `isUnconnectedTerminal` predicate locally rather than importing another chunk |
| `editors` | `editorConfig.js` | Editor window labels/keys and split-pane persistence (`EDITOR_SPLIT_STORAGE_KEY`, `loadEditorSplit`) — the editor windows themselves render inside `App.jsx`. Views: `spice`, `json`, `canvas`, and `blockSchematic` ("new schematic test") — a scaffold tab for an alternate block-based schematic (rectangle-per-component with pins on one side) |
| `waveform` | `WaveformChart.jsx` | Custom SVG chart: trace toggles, zoom/pan, hover readout, CSV export, collapsible Ngspice log |

## Persistence model

Everything user-facing is `localStorage`-backed (no server-side chat storage): the chat
store (`prompt-to-pcb-chats-v1`) and the editor split layout
(`prompt-to-pcb-editor-split-v1`). Only auth accounts live server-side (Postgres/Neon or an
in-memory fallback — see `docs/BACKEND.md`).
