# Prompt-to-PCB Generator MVP

A React-based prototype that turns electronics prompts into an AI-generated structured circuit model, validates it, generates a SPICE deck, runs Ngspice for waveform data, and exports a KiCad-compatible netlist.

## Run

```bash
npm install
npm run dev
```

`npm run dev` starts both the React frontend and the local API server.

Frontend:

```text
http://127.0.0.1:5174
```

API:

```text
http://127.0.0.1:8787
```

## Repository structure

The code is organized into independent **feature chunks** so different areas can be
worked on in parallel. Each chunk lives in its own folder and depends only on the
shared `core` (never on another feature chunk).

```
src/
  core/        Shared circuit engine + shared config/utils (schematicLayout ->
               pcbGenerator -> circuitSync, lineDiff, config.js, download.js).
               Depended on by everything; change only when the circuit model changes.
  app/         App shell: App.jsx (layout + page routing + workspace state),
               routing.js, generationStream.js. The integration point.
  features/
    auth/      auth.jsx + auth.css (self-contained; talks to /api/auth/*)
    chat/      chatStore.js, chatFormat.js, ChatPanel.jsx
    schematic/ CircuitDiagram.jsx, symbols.jsx, geometry.js
    editors/   editorConfig.js (SPICE/JSON/Canvas editor windows live in app/App.jsx)
    waveform/  WaveformChart.jsx

server/
  index.ts     HTTP hub (routes) + env.ts + types.ts (shared foundation)
  auth/        auth.ts, db.ts, brevo.ts
  ai/          ollamaProvider.ts, chatMemory.ts, circuitKnowledge.ts
  circuit/     circuitResponse.ts, streamingCircuit.ts   (imports ../../src/core)
  simulation/  simulator.ts
```

**Rule:** a feature chunk may import from `core` (frontend) / `types` (backend) but
not from another feature chunk — cross-feature wiring goes through `app/App.jsx`
(frontend) or `server/index.ts` (backend).

## Ollama setup

Copy `.env.example` to `.env.local` and adjust the model if needed:

```env
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2:latest
OLLAMA_API_KEY=
```

Local Ollama usually does not require an API key. The key exists for hosted Ollama-compatible APIs and is intentionally read only by the Node API server, never by browser code. Real `.env` files are ignored by git.

Start Ollama separately before generating AI circuits:

```bash
ollama serve
ollama pull llama3.2
```

If Ollama is not reachable or returns invalid JSON, generation fails with a visible error. The app does not substitute a local hardcoded circuit.

## Ngspice simulation

The AI generates the circuit model, but waveform simulation is handled by the local program through Ngspice.

Install Ngspice and make sure `ngspice` is available on PATH. After generating a circuit, open the Simulation tab and click `Run simulation`.

The backend writes the current SPICE deck to a temporary folder, runs:

```bash
ngspice -b simulation.cir
```

Then it parses the waveform output and returns chart-ready data to the frontend. If Ngspice is missing or the generated SPICE deck cannot be simulated, the UI shows the simulator error without replacing the AI-generated circuit.

## AI circuit model

The API asks Ollama for a JSON circuit object with:

- `title`
- `type`
- `supplyVoltage`
- `nodes`
- `components`
- `notes`

Each component includes `ref`, `kind`, `value`, `nodes`, and `footprint`. The app validates this model and uses it to generate SPICE and KiCad netlist exports.

## Exported files

- `generated.cir`: Ngspice-ready SPICE deck
- `generated.net`: KiCad XML netlist
- `circuit.json`: structured intermediate circuit model
- `README-export.json`: export manifest and instructions

The MVP now supports waveform simulation from the generated SPICE deck, but KiCad remains the place to inspect footprints, edit the schematic, place parts, route the board, and run design-rule checks.

## Test

```bash
npm test
```
