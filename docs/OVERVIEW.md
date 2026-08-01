# Overview

PCB Pilot (package name `prompt-to-pcb-generator`) is a React/Vite + Node app that turns a
natural-language electronics prompt into a structured circuit model, a SPICE deck, a
KiCad-style netlist, and (optionally) simulated waveform data.

## Data flow

```text
User prompt (chat UI, composer mode: Plan | Ask | Implement)
  Plan/Ask -> POST /api/assist-circuit (streamed NDJSON) — one conversational AI
     reply, no clarify round, no artifacts; a Plan reply carries a "Build this"
     button that feeds the plan into the Implement pipeline below
  Implement (default)
  -> POST /api/clarify-circuit (streamed NDJSON) — AI asks up to 3 multiple-choice
     clarifying questions; user answers via chips (falls through on failure)
  -> POST /api/generate-circuit (streamed NDJSON, prompt + clarification answers)
  (all three streams carry live "thinking" events — the model's reasoning tokens,
   shown ephemerally in the chat while the request runs, discarded on completion)
  -> Ollama (or an OpenAI-compatible provider) generates circuit JSON + SPICE
  -> server validates schema/SPICE AND gates on the topology rule engine
     (src/core/topologyRules.js): functional errors (e.g. a GPIO driving a buzzer
     with no transistor) are fed back for up to 3 corrective attempts; the best
     candidate always ships, with surviving issues surfaced in the UI
  -> server normalizes the circuit and reconciles it against the prior design
  -> frontend synchronizes SPICE <-> canvas schematic <-> KiCad netlist
     (plus read-only block-schematic and realistic-breadboard views of the same circuit)
  -> POST /api/simulate-circuit runs Ngspice on the current SPICE deck
  -> waveform data is parsed and charted in the frontend
  -> the realistic-breadboard view can also simulate the circuit LIVE in the
     browser (src/core/sim — a small MNA engine, no Ngspice/server round-trip):
     LEDs glow with real currents, buttons/switches/pots are interactive
```

The AI's only job is to produce a structured circuit model (+ matching SPICE). Everything
else — validation, diagram layout, SPICE/KiCad export, simulation, waveform parsing — is
deterministic code in `src/core` and `server/`.

## Run it

```bash
npm install
npm run dev      # starts Vite (127.0.0.1:5174) and the API server (127.0.0.1:8787) together
npm test         # vitest
npm run build    # production build to dist/
```

Ollama must be running locally (`ollama serve`) with a pulled model, or `AI_PROVIDER` must
point at an OpenAI-compatible endpoint (see `docs/OPERATIONS.md`). Ngspice must be on PATH
for simulation to work.

## Use it from Claude (MCP)

`mcp/` is an MCP stdio server that exposes the deterministic engine — validation, the
topology rule engine, SPICE/KiCad export, Ngspice simulation, schematic SVG and PCB
layout — as tools for Claude Desktop or Claude Code. There is no AI in that path: Claude
authors the circuit JSON itself and the tools check/run/export it, calling `src/core`
directly with no HTTP hop and no provider. See `mcp/README.md` for the install snippet.

## Where to look next

- `docs/ARCHITECTURE.md` — repo/module layout and the feature-chunk rule
- `mcp/README.md` — the MCP server: tools, install, artifacts
- `docs/FRONTEND.md` — `src/app`, `src/core`, `src/features` breakdown
- `docs/BACKEND.md` — `server/` breakdown and API endpoints
- `docs/AI_AND_CIRCUIT_MODEL.md` — circuit JSON schema, AI prompting, SPICE/KiCad/canvas sync
- `docs/OPERATIONS.md` — env vars, scripts, Docker/Firebase deploy, testing

## Existing session notes

`HANDOFF_SUMMARY.md` and `SESSION_SUMMARY.md` at the repo root are point-in-time developer
handoff notes from earlier sessions (pre-dating the `refactor/feature-chunks` restructuring
into `src/core` / `src/app` / `src/features` and the server's `server/ai`, `server/auth`,
`server/circuit`, `server/simulation` split, and the TypeScript server migration). They're
useful for history but some file paths in them are stale — the docs in this folder describe
the current layout.
