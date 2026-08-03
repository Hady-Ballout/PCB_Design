# CLAUDE.md

Guidance for an agent working in this repository.

## What this is

A prompt-to-PCB tool. Given a circuit description as JSON, it produces a placed,
routed, design-rule-checked two-layer board and exports it as Gerbers or a KiCad
project — with no KiCad installation required.

**Circuit generation has been removed.** The AI pipeline that turned a natural
language prompt into circuit JSON, and the MCP server that exposed the engine to
external agents, were both deleted so the generator can be rebuilt from scratch.
Everything downstream of the circuit JSON is intact and working.

Today a circuit enters the app through **Import JSON** in the workspace UI.

## Layout

```
src/core/        the engine — place, route, pour, DRC, Gerber, KiCad, SPICE
src/features/    UI features, one directory each
src/app/         app shell (App.jsx), routing, theme
server/          auth, billing, ngspice simulation, firmware compilation
knowledge/       what an agent reads to build a circuit   ← start here
scripts/         build-component-docs.mjs, dev.mjs, KiCad extractors
```

`src/core` is dependency-free (only `node:zlib`), so any part of the engine runs
under plain `node` with no build step. Use that — write a throwaway script and
run it rather than reasoning about what the code would do.

## Start with knowledge/

**[knowledge/README.md](knowledge/README.md)** is the entry point.

| Doing this | Read |
|------------|------|
| Building a circuit | [knowledge/prompts/build-a-circuit.md](knowledge/prompts/build-a-circuit.md) |
| A part seems missing | [knowledge/prompts/add-a-component.md](knowledge/prompts/add-a-component.md) |
| Checking a board | [knowledge/prompts/verify-a-board.md](knowledge/prompts/verify-a-board.md) |
| Looking up a part | [knowledge/components/README.md](knowledge/components/README.md) |

`knowledge/components/` holds one markdown file per component kind — 69 of them,
plus a scannable index. Frontmatter (`kind`, `pins`, `pin_order`,
`spice_prefix`) is **generated** from `src/core/componentKinds.js` and
`src/core/topologyRules.js`; prose is written by hand or by an agent and is never
overwritten.

After editing either source table:

```bash
node scripts/build-component-docs.mjs
```

## The rule that matters most

**Copy `pin_order` from the component's file. Never recall it.**

For 48 of 69 kinds, a component's `nodes` array is positional and its order
carries the entire electrical meaning. Validation checks the node *count*, not
which net lands on which pin. A 555 with `TRIG` and `THRES` swapped validates
clean, routes clean, passes DRC, and produces fab-ready Gerbers for a circuit
that does not oscillate.

This is the highest-frequency failure in this domain and nothing downstream
catches it.

## Verify by running, not by inspecting

```js
import { validateCircuit } from './src/core/pcbGenerator.js';
import { checkCircuitTopology } from './src/core/topologyRules.js';
import { buildPcbLayout } from './src/core/pcbLayout.js';
```

A circuit is done when all of these are clean — including zero warnings, since a
warning that a net touches one pin means a part is not wired:

```
validateCircuit  → { ok: true, errors: [], warnings: [] }
topology         → { ok: true, violations: [] }
routing          → { complete: true, failedNets: [] }
drc              → { ok: true, violations: [] }
connectivity     → { ok: true, incompleteNets: [] }
```

Report the verdict alongside the JSON. "Here is a circuit" is not a result.

## Running it

```bash
npm install
echo 'JWT_SECRET=any-long-random-string' > .env.local
npm run dev        # vite on :5174, API on :8787
npm test           # 1056 tests
```

`JWT_SECRET` is the only required variable. With `DATABASE_URL` unset the server
seeds an in-memory account — `admin@local.test` / `PcbPilotLocal!2026`. Stripe,
Brevo and Postgres are all optional and degrade cleanly.

## Where the new generator plugs in

1. **`buildImportedResult()`** in `src/features/importCircuit/importCircuit.js`
   builds the complete result package (validation, simulation, schematic
   diagram, SVG, SPICE, KiCad netlist) from a bare circuit, in the browser.
   **This is the contract** — produce a circuit that flows through it.
2. **The chat composer** in `src/features/chat/ChatPanel.jsx` is rendered but
   disabled. Wire it back when there is something to send to.
3. **`generatingChatId`** in `src/app/App.jsx` drives the workspace's busy state;
   every editor already disables itself off it.

## Conventions

- Comments explain *why*, not *what*. Match the density of the surrounding file.
- Tests live beside their source as `<name>.test.js`.
- Ground is the string `"0"`, never `"GND"`.
- `supplyVoltage` is a top-level number on the circuit and is what validation
  checks — a `voltage_source` with `value: "9V"` does not satisfy it.

## Known gaps

- **The schematic router fails on circuits the board router handles.** A 555
  astable with a `CTRL` capacitor, and some MCU circuits, throw
  `DiagramLayoutError` after 9 attempts. Callers fall back to
  `buildFallbackCircuitDiagram`. Recorded as `it.fails` in
  `src/core/pcbGenerator.test.js` — when it is fixed, that test starts failing.
- **Pin assignment is unvalidated** (see above). The fix is named connections
  (`{ "TRIG": "CT" }`) instead of positional arrays, which would turn a wrong pin
  into a schema error.
- `docs/` was deleted along with the AI pipeline. `knowledge/` replaces it for
  circuit work; there is currently no architecture documentation.
