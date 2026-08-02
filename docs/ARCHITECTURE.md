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
    connect/   ConnectPanel.jsx — the MCP connection URL + install instructions

server/
  index.ts     HTTP hub (routing) + env.ts + types.ts — shared foundation
  auth/        auth.ts, db.ts, brevo.ts
  ai/          ollamaProvider.ts, chatMemory.ts, circuitKnowledge.ts
  circuit/     circuitResponse.ts, streamingCircuit.ts (imports src/core)
  simulation/  simulator.ts
  mcp/         httpServer.ts (streamable HTTP transport), resourceServer.ts
               (OAuth 2.1 resource server: RFC 9728 metadata, token validation)

mcp/
  registerTools.ts  the six-tool surface, shared by BOTH transports
  server.ts         stdio entry point (local)
  schemas.ts        zod circuit contract + component-count cap
  artifactSink.ts   fileSink (writes to disk) / ArtifactStore (short-lived URLs);
                    content is string | Uint8Array (the Gerber archive is bytes)
  limits.ts         per-subject simulation concurrency
  tools/            componentKinds, validate, export, simulate, render, layout, diagram
```

The hosted transport lives in `server/mcp/` and the local one in `mcp/server.ts`;
both call `mcp/registerTools.ts`, so the tool surface cannot drift between them.

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

```text
mcp/server.ts   server/mcp/    two transports: stdio (local) and streamable
                httpServer.ts   HTTP (hosted, mounted at /api/mcp)
        \             /
      mcp/registerTools.ts     one tool surface, registered once
             |
mcp/tools/*                    one module per tool, each a plain async function
             |
src/core/*  +                  no AI provider and no HTTP hop: the MCP tools call
server/simulation               the engine directly, so an MCP result and an in-app
                                result for the same circuit are the same computation
```

The MCP server is a peer of the frontend and the backend, not a layer above them: it
consumes `src/core` on the same terms and adds no circuit logic of its own.

## The PCB pipeline

One direction, five independent stages, then two writers. Every stage is plain
deterministic `src/core` JavaScript — no KiCad install, no RNG, no clock — and each hands
the next one a finished artifact rather than a shared mutable state.

```text
circuit JSON
   |
pcbFootprints.js   real vendored KiCad THT geometry per part (part.footprint
   |               honoured as an exact override, else resolved from the kind)
pcbPlace.js        netlist-aware placement, courtyard clearance
   |
pcbRoute.js        two-layer clearance-aware A* maze routing with neck-down
   |
pcbPour.js         bottom-copper ground pour over what routing left
   |
pcbDrc.js          an INDEPENDENT measurement of the finished copper +
   |               connectivity — the verdict the layout carries with it
   |
   +--> kicadPcb.js      .kicad_pcb — writes even a dirty board (a half-routed
   |                     board is still worth opening and finishing)
   +--> gerberExport.js  RS-274X + Excellon + README, zipped by zipStore.js —
                         REFUSES unless routing, DRC and connectivity are all
                         clean, because a Gerber package is an order
```

`pcbLayout.js` is the orchestrator: it runs the ladder (re-place and re-route on a roomier
board when routing fails) and keeps the best attempt by a DRC-first ranking. The same
result object drives the 3D viewer, the Board view, the download buttons and the MCP
`pcb_layout` / `export_netlist` tools, so all four agree by construction.
`scripts/kicad-drc-oracle.mjs` (and its optional, non-gating CI job) is the outside
opinion: KiCad's own DRC over boards this pipeline produced.

Two routing constraints in `server/index.ts` are load-bearing:

- `/api/mcp` is registered **above** the JWT gate. MCP clients authenticate as OAuth
  clients against an external authorization server and have no app session token, so
  mounting it below the gate 401s every call.
- `/.well-known/oauth-protected-resource` is unauthenticated by design — it is how a
  client discovers *where* to authenticate.

`scripts/mcp-live-check.mjs` boots the real server and asserts both, because neither
is visible to a test that imports the handlers directly.

## Size at a glance

`src/core` is the largest and most load-bearing module (`schematicLayout.js` ~1750 lines,
`circuitSync.js` ~815 lines, `pcbGenerator.js` ~690 lines) — it owns diagram layout,
routing, and every export format. `server/ai/ollamaProvider.ts` (~730 lines) is the largest
backend file, owning the AI system prompt, JSON schema, and response validation/repair.
