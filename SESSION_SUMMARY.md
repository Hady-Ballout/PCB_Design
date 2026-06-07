# Prompt-to-PCB Generator Session Summary

## Current State

This repo now contains a React/Vite MVP for a prompt-to-PCB workflow.

The app lets a user enter a natural-language circuit prompt, generate a structured circuit model, validate it, run Ngspice simulation for waveform data, export SPICE, and export a KiCad-style XML netlist.

The current generation flow is:

```text
React frontend
-> local Node API server
-> Ollama
-> structured circuit JSON
-> validation
-> SPICE export
-> optional Ngspice waveform simulation
-> KiCad netlist export
```

If Ollama fails or returns unusable JSON, generation now fails with a visible error instead of substituting a local hardcoded circuit.

## Important Files

- `src/App.jsx`: main React UI.
- `src/lib/pcbGenerator.js`: validation, SPICE export, KiCad netlist export, and generic simulation/export metadata for AI-generated circuits.
- `server/index.js`: local Node API server on `127.0.0.1:8787`.
- `server/ollamaProvider.js`: Ollama request logic, JSON prompting, and JSON repair/extraction.
- `server/circuitResponse.js`: normalizes AI circuit output and builds the response consumed by the frontend.
- `server/simulator.js`: writes temporary Ngspice batch decks, runs Ngspice, and parses waveform output.
- `scripts/dev.mjs`: starts both the API server and Vite frontend.
- `vite.config.js`: enables React plugin and proxies `/api` to `127.0.0.1:8787`.
- `.env.example`: safe example environment config.
- `.env.local`: real local config, ignored by git.

## Current Environment Setup

`.env.local` should look like this:

```env
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2:latest
OLLAMA_API_KEY=
```

Local Ollama usually does not need an API key. Keep `OLLAMA_API_KEY` empty unless using a hosted Ollama-compatible endpoint.

Secrets are protected by `.gitignore`:

```text
.env
.env.local
.env.*.local
```

## Run Commands

Install dependencies:

```bash
npm install
```

Start frontend and backend:

```bash
npm run dev
```

Frontend:

```text
http://127.0.0.1:5173
```

Backend health:

```text
http://127.0.0.1:8787/api/health
```

Simulation endpoint:

```text
http://127.0.0.1:8787/api/simulate-circuit
```

Run checks:

```bash
npm test
npm run build
```

## Ollama Notes

Ollama is running locally at:

```text
http://127.0.0.1:11434
```

Useful commands:

```powershell
ollama list
ollama ps
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:11434/api/tags
```

Installed models observed during the session included:

```text
llama3:latest
qwen2.5:latest
llama3.2:latest
qwen3-coder:480b-cloud
gpt-oss:120b-cloud
```

`llama3:latest` failed because it needed more memory than available. The app was changed to use `llama3.2:latest`.

The Ollama request also uses smaller generation options:

```js
num_ctx: 2048
num_predict: 1400
temperature: 0.2
```

## UI Behavior

The app now starts with an empty prompt and no pre-generated circuit. After clicking `Generate`, the prompt is sent to the backend and then to Ollama.

The source strip only appears after successful generation:

```text
Generator: Ollama AI
```

## What Works

- React app renders correctly.
- Vite frontend runs on port `5173`.
- Node API runs on port `8787`.
- API calls Ollama through `localhost:11434`.
- AI-generated circuit JSON is normalized and validated.
- Malformed Ollama JSON is partially repaired by `server/ollamaProvider.js`.
- SPICE and KiCad netlist exports are generated from the structured circuit model.
- The Simulation tab can call the backend to run Ngspice and render waveform data.
- Build and tests passed after the latest changes.

## Known Limitations

- Ngspice must be installed and available on PATH for waveform simulation to run.
- AI-generated SPICE can still fail in Ngspice if the model produces unsupported or electrically invalid circuit structures.
- AI output can still be electrically incomplete or odd. Validation catches some structural issues, but not full circuit correctness.
- KiCad export is a netlist-style export, not a complete routed PCB.
- Ollama/local models may be slow or produce malformed JSON, especially for complex circuits.

## Suggested Next Steps

- Add a clearer timeout and loading status for Ollama requests.
- Add stricter schema validation for AI circuit output.
- Improve generated SPICE coverage for more component kinds, especially regulator, diode, MOSFET, and op-amp models.
- Improve KiCad export toward real KiCad project/schematic files.
- Add circuit-specific validators, especially for op-amps, regulators, and ICs.
- Add a JSON repair retry: if the first Ollama output is malformed, ask Ollama to repair only the JSON.
- Later, add provider adapters for OpenAI and Claude without exposing API keys in frontend code.
