# PCB Pilot MCP server

Exposes the deterministic half of the PCB Pilot engine to any MCP client as tools.
Claude authors the circuit JSON; these tools check it, run it, and turn it into files.

There is deliberately **no AI in this server** — no Ollama, no provider keys, no HTTP
backend. It imports `src/core` (and `server/simulation`) directly, so it always matches
whatever the app itself would do with the same circuit.

## Install

Nothing to build — `tsx` runs the TypeScript directly.

**Claude Code**

```bash
claude mcp add pcb-pilot -- npx tsx C:/Users/hady/Documents/GitHub/PCB_Design/mcp/server.ts
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pcb-pilot": {
      "command": "npx",
      "args": ["tsx", "C:/Users/hady/Documents/GitHub/PCB_Design/mcp/server.ts"],
      "cwd": "C:/Users/hady/Documents/GitHub/PCB_Design"
    }
  }
}
```

Restart the client; the six tools appear as `pcb-pilot`.

### Requirements

- `npm install` has been run in the repo (the server imports from `node_modules`).
- **Ngspice on PATH** for `simulate_circuit` only — `ngspice_con` on Windows, `ngspice`
  elsewhere, or set `NGSPICE_BINARY`. Every other tool works without it.

## Tools

| Tool | Does | Backed by |
|---|---|---|
| `list_component_kinds` | The ~70-kind registry and the circuit-JSON contract | `src/core/componentKinds.js` |
| `validate_circuit` | Structural checks + the topology rule engine; optional safe auto-fixes | `pcbGenerator.validateCircuit`, `topologyRules` |
| `export_netlist` | SPICE `.cir`, KiCad `.net`, or KiCad `.kicad_sch` | `toSpice`, `toKiCadNetlist`, `toKiCadSchematic` |
| `simulate_circuit` | Transient analysis; per-node stats + CSV | `server/simulation/simulator.ts` |
| `render_schematic` | Laid-out schematic as SVG | `buildCircuitDiagram`, `toDiagramSvg` |
| `pcb_layout` | Two-layer placement + clearance-aware maze routing, with a `manufacturable` verdict from an independent DRC | `src/core/pcbLayout.js` |

**Start with `list_component_kinds`.** It returns the pin-order contract for positional
kinds (op amps, MCU boards, modules) and the ref-prefix rules the exporter enforces —
authoring a circuit without it means guessing.

A typical loop: `list_component_kinds` → author JSON → `validate_circuit` → fix what it
reports → `simulate_circuit` → `export_netlist` / `render_schematic` / `pcb_layout`.

## Artifacts

Anything bulky — SVG, PCB geometry, full waveform samples — is written to a file and the
tool returns its path plus a summary, rather than inlining thousands of tokens.

Default location is `mcp/.artifacts/` (gitignored). Override with `--artifact-dir <path>`
in the launch args or `PCB_MCP_ARTIFACT_DIR`.

## Circuit JSON

```json
{
  "title": "RC low-pass",
  "components": [
    { "ref": "V1", "kind": "voltage_source", "value": "5V",     "nodes": ["VIN", "0"] },
    { "ref": "R1", "kind": "resistor",       "value": "1k",     "nodes": ["VIN", "VOUT"] },
    { "ref": "C1", "kind": "capacitor",      "value": "100nF",  "nodes": ["VOUT", "0"] }
  ]
}
```

Ground is the net `"0"`. Parts sharing a net name are connected. `type`, `supplyVoltage`,
`notes`, `nodes` and `footprint` are filled in automatically when omitted.

## Tests

```bash
npx vitest run --configLoader runner mcp/
```

`mcp/server.test.ts` drives the server over the SDK's in-memory transport; the
`simulate_circuit` tests shell out to the real Ngspice binary.
