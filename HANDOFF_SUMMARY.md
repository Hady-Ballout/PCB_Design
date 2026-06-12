# Prompt-to-PCB Generator Handoff Summary

## Current Goal

This repo is a React/Vite MVP for generating PCB/schematic artifacts from natural-language circuit prompts.

The intended architecture is:

```text
User prompt
-> React frontend
-> local Node API
-> Ollama AI circuit JSON generation
-> deterministic validation/export
-> editable SPICE and KiCad netlist
-> local Ngspice simulation
-> frontend waveform viewer
```

The AI is responsible for producing a structured circuit model. The program is responsible for export, simulation, and waveform rendering.

## Current Run Setup

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

Backend:

```text
http://127.0.0.1:8787
```

Run checks:

```bash
npm test
npm run build
```

## Environment

`.env.local` is used locally and is ignored by git.

Current expected shape:

```env
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=gpt-oss:120b-cloud
OLLAMA_API_KEY=
```

The model may be changed to any working Ollama/Ollama-compatible model.

## Ngspice Setup

Ngspice was installed from the Windows `.7z` package.

The folder added to User PATH was:

```text
C:\Users\hady\Downloads\ngspice-46_64\Spice64\bin
```

That folder contains both:

```text
ngspice.exe
ngspice_con.exe
```

The backend prefers `ngspice_con` on Windows so simulation runs in console/batch mode instead of launching the GUI.

Verify from a new PowerShell:

```powershell
ngspice -v
ngspice_con -v
```

## Important Files

- `src/App.jsx`: main React UI, editable SPICE/KiCad tabs, simulation workflow, waveform viewer.
- `src/styles.css`: UI and waveform/editor styling.
- `src/lib/pcbGenerator.js`: deterministic validation, SPICE export, KiCad netlist export, generic simulation metadata.
- `src/lib/pcbGenerator.test.js`: exporter and validation tests.
- `server/index.js`: local Node API, including generation and simulation endpoints.
- `server/ollamaProvider.js`: Ollama request logic, JSON extraction/repair, and AI prompt rules.
- `server/circuitResponse.js`: normalizes AI JSON and builds frontend response objects.
- `server/simulator.js`: writes temporary Ngspice decks, runs Ngspice, parses waveform output.
- `server/simulator.test.js`: simulator helper tests.
- `scripts/dev.mjs`: starts API server and Vite frontend together.
- `vite.config.js`: Vite config and `/api` proxy.

## API Endpoints

Health:

```text
GET /api/health
```

Generate circuit:

```text
POST /api/generate-circuit
```

Body:

```json
{
  "prompt": "Design an RC low-pass filter..."
}
```

Run simulation:

```text
POST /api/simulate-circuit
```

Body:

```json
{
  "circuit": {},
  "spice": "* edited or generated SPICE deck"
}
```

## What Was Implemented

### AI-Only Generation

Hardcoded examples and local rule-based generation were removed from the runtime.

The app now starts empty. Generation goes through Ollama. If the AI/backend fails, the UI shows an error instead of substituting a canned circuit.

### AI Prompt Improvements

`server/ollamaProvider.js` now instructs the AI to use SPICE-safe component references:

- `R...` for resistors
- `C...` for capacitors
- `L...` for inductors
- `D...` for diodes and LEDs
- `V...` for voltage and signal sources
- `Q...` for BJTs
- `M...` for MOSFETs
- `X...` for opamps/subcircuits
- `R...` for loads

This fixed the observed Ngspice issue where an AI-generated `LED1` ref was interpreted by SPICE as an inductor because it started with `L`.

### Exporter Safety Net

`src/lib/pcbGenerator.js` also normalizes SPICE references during export.

Example:

```text
LED1 kind=led
```

exports as:

```spice
D_LED1 ...
```

This keeps simulation safer even if the AI produces imperfect refs.

### Real Ngspice Simulation

The app now runs actual Ngspice simulations from the backend.

Flow:

```text
current SPICE deck
-> temporary simulation.cir
-> ngspice_con -b simulation.cir
-> waveform.dat
-> parsed waveform JSON
-> frontend chart
```

The simulation tab has a `Run simulation` button.

### Waveform Viewer

The frontend waveform chart supports:

- trace checkboxes
- zoom in/out
- pan buttons
- click-and-drag panning after zooming
- hover cursor readout with time and voltage values
- Y-axis autoscaling based on selected/visible traces
- visible-window CSV export
- collapsible Ngspice log

### Editable SPICE and KiCad

The `Spice` and `Kicad` tabs are editable text editors now.

Edited SPICE is used by:

- `Run simulation`
- `Download SPICE`
- `Export files`

Edited KiCad netlist is used by:

- `Download KiCad netlist`
- `Export files`

Each editor has a reset button:

- `Reset SPICE`
- `Reset KiCad`

## Good Test Prompts

RC transient test:

```text
Design an RC low-pass filter with a 5V pulse input source. Use VSTEP as PULSE(0 5 0 1us 1us 10ms 20ms), a 1k resistor from IN to OUT, and a 100nF capacitor from OUT to ground. Use nodes IN, OUT, and 0.
```

Slow RC curve test:

```text
Design an RC low-pass filter with a 5V pulse input source. Use VSTEP as PULSE(0 5 0 1us 1us 10ms 20ms), a 10k resistor from IN to OUT, and a 10uF capacitor from OUT to ground. Use nodes IN, OUT, and 0.
```

Regulator test:

```text
Design a 12V to 5V regulator circuit using a 7805. Include input and output capacitors, a 1k load resistor on VOUT, and nodes named VIN_RAW, VIN, VOUT, and 0.
```

NPN switch test:

```text
Design an NPN low-side LED switch powered from 5V. Use a 3.3V pulse control signal PULSE(0 3.3 0 1us 1us 5ms 10ms), a base resistor, an LED with current-limiting resistor, and a 2N2222 transistor. Use nodes VIN, CTRL, BASE, LED_ANODE, COLLECTOR, and 0.
```

## Current Known Limitations

- AI output can still be prompt-incomplete or electrically questionable.
- Structural validation does not yet mean the circuit matches the prompt.
- Ngspice success means the deck ran, not that the circuit is correct.
- SPICE models are simple and incomplete, especially for regulators, opamps, MOSFETs, and ICs.
- KiCad export is still a netlist-style XML export, not a complete KiCad schematic/project.
- The waveform chart is custom SVG; it works, but a dedicated plotting library may eventually be better.

## Suggested Next Steps

- Add prompt-compliance validation, e.g. warn when prompt asks for an LED/load/12V source but generated circuit omits it.
- Add a signal selector that controls which nodes Ngspice exports, not just which traces the frontend displays.
- Add a simulation repair loop: send Ngspice error + circuit JSON back to the AI to request corrected JSON.
- Add stronger schema validation for AI output before export.
- Improve SPICE source handling so phrases like "step input" map to `PULSE(...)`.
- Improve models for regulators, opamps, MOSFETs, and common ICs.
- Add optional provider/model selection for stronger AI models later.
- Add CSV export for full simulation results, not only visible waveform window.

## Current Verification

Latest checks passed:

```text
npm test
npm run build
```

At the time of this handoff, tests covered:

- validation
- SPICE export
- KiCad netlist export
- SPICE-safe ref normalization
- generic simulation metadata
- Ngspice deck construction helpers
- waveform parser helpers

