# Architecture

## Repository layout

```text
src/
  core/        Shared circuit engine + shared config/utils. Depended on by
               everything; change only when the circuit model itself changes.
  app/         App shell: App.jsx (layout, page routing, workspace state),
               routing.js, generationStream.js. The integration point that
               wires feature chunks together.
  features/
    landing/   LandingPage.jsx + landing.css — public landing page + app chrome styles
    chat/      chatStore.js, chatFormat.js, ChatPanel.jsx
    schematic/ CircuitDiagram.jsx, symbols.jsx, geometry.js
    blockSchematic/ BlockSchematic.jsx (React Flow block view) + model/css
    realisticSchematic/ RealisticSchematic.jsx (SVG breadboard-build view)
               + breadboardModel.js / breadboardGeometry.js / breadboardDescription.js / partVisuals.js / parts.jsx / css
    editors/   editorConfig.js (the SPICE/JSON/Canvas/block-schematic/
               realistic-schematic editor *windows* themselves live in app/App.jsx)
    waveform/  WaveformChart.jsx

server/
  index.ts     HTTP hub (routing) + env.ts + types.ts — shared foundation
  auth/        auth.ts, db.ts, brevo.ts
  ai/          ollamaProvider.ts, chatMemory.ts, circuitKnowledge.ts
  circuit/     circuitResponse.ts, streamingCircuit.ts (imports src/core)
  simulation/  simulator.ts
```

## The feature-chunk rule

A feature chunk may import from `core` (frontend) / `types` (backend), but never from
another feature chunk. Cross-feature wiring goes through `src/app/App.jsx` on the frontend
or `server/index.ts` on the backend. This lets each chunk (auth, chat, schematic, editors,
waveform; auth, ai, circuit, simulation) be worked on independently without hidden coupling.

This structure was introduced across four commits on `refactor/feature-chunks` (merged into
`main`):

1. `4f7b35e` — extract the shared circuit engine into `src/core`
2. `1f16bb7` — group the backend into `server/ai`, `server/auth`, `server/circuit`,
   `server/simulation`
3. `1f89b42` / `53ab747` — extract pure UI into `src/features/*` and relocate the app shell
   into `src/app`
4. `9734311` — document the structure in the README

Before this, the app was a monolithic `src/App.jsx` + `src/lib/*` + `server/*.js` (see the
older `HANDOFF_SUMMARY.md` / `SESSION_SUMMARY.md`, which predate the split and reference
`src/lib/pcbGenerator.js` and `server/index.js` paths that no longer exist).

## Layering, top to bottom

```text
src/app/App.jsx           orchestrates everything: chat state, editor windows,
                           canvas tool state, simulation controls, sync effects
        |
src/features/*            presentational + self-contained feature logic
        |
src/core/*                circuit model: validation, layout, SPICE/KiCad/canvas
                           sync, export — the single source of electrical truth
```

```text
server/index.ts            plain node:http router, no framework
        |
server/auth, ai, circuit,  request handlers per concern
       simulation
        |
src/core/circuitSync.ts    the server imports the frontend's circuit engine
                           directly (server/ai/ollamaProvider.ts imports
                           ../../src/core/circuitSync.js) — core is the one
                           module shared across the frontend/backend boundary
```

## Size at a glance

`src/core` is the largest and most load-bearing module (`schematicLayout.js` ~1750 lines,
`circuitSync.js` ~815 lines, `pcbGenerator.js` ~690 lines) — it owns diagram layout,
routing, and every export format. `server/ai/ollamaProvider.ts` (~730 lines) is the largest
backend file, owning the AI system prompt, JSON schema, and response validation/repair.
