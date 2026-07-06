# Overview

PCB Pilot (package name `prompt-to-pcb-generator`) is a React/Vite + Node app that turns a
natural-language electronics prompt into a structured circuit model, a SPICE deck, a
KiCad-style netlist, and (optionally) simulated waveform data.

## Data flow

```text
User prompt (chat UI)
  -> POST /api/generate-circuit (streamed NDJSON)
  -> Ollama (or an OpenAI-compatible provider) generates circuit JSON + SPICE
  -> server validates/normalizes the circuit and reconciles it against the prior design
  -> frontend synchronizes SPICE <-> canvas schematic <-> KiCad netlist
     (plus read-only block-schematic and realistic-breadboard views of the same circuit)
  -> POST /api/simulate-circuit runs Ngspice on the current SPICE deck
  -> waveform data is parsed and charted in the frontend
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

## Where to look next

- `docs/ARCHITECTURE.md` — repo/module layout and the feature-chunk rule
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
