# PCB Pilot

Turns a circuit description into a manufacturable two-layer PCB — placed,
routed, ground-poured and design-rule-checked — and exports it as Gerbers or a
KiCad project. No KiCad installation required.

## Status

**Circuit generation is being rebuilt.** The AI pipeline that produced circuit
JSON from a natural-language prompt, and the MCP server that exposed the engine
to external agents, have been removed. Everything downstream of the circuit JSON
works: schematic, breadboard, board editor, 3D view, simulation, and exports.

A circuit currently enters the app through **Import JSON** in the workspace.

If you are an agent working here, read [CLAUDE.md](CLAUDE.md).

## Run it

```bash
npm install
echo 'JWT_SECRET=any-long-random-string' > .env.local
npm run dev
```

Vite on `127.0.0.1:5174`, API on `127.0.0.1:8787`. `JWT_SECRET` is the only
required variable — with `DATABASE_URL` unset the server seeds an in-memory
account, `admin@local.test` / `PcbPilotLocal!2026`. Stripe, Brevo and Postgres
are optional and degrade cleanly.

## Try it

Open the app, click **Import JSON**, and paste:

```json
{
  "title": "RC low-pass",
  "supplyVoltage": 5,
  "components": [
    { "ref": "V1", "kind": "voltage_source", "value": "5V",    "nodes": ["VIN", "0"] },
    { "ref": "R1", "kind": "resistor",       "value": "1k",    "nodes": ["VIN", "VOUT"] },
    { "ref": "C1", "kind": "capacitor",      "value": "100nF", "nodes": ["VOUT", "0"] }
  ]
}
```

## Layout

```
src/core/      the engine — place, route, pour, DRC, Gerber, KiCad, SPICE
src/features/  UI features, one directory each
src/app/       app shell, routing, theme
server/        auth, billing, ngspice simulation, firmware compilation
knowledge/     component and pattern reference for building circuits
scripts/       doc generator, dev runner, KiCad extractors
```

`src/core` is dependency-free — the whole engine runs under plain `node`.

## The pipeline

`buildPcbLayout(circuit)` runs five stages and returns its own verdict:

1. **footprints** — real KiCad geometry per part
2. **place** — netlist-aware placement with courtyard clearance
3. **route** — clearance-aware two-layer A* maze routing
4. **pour** — bottom-copper ground pour
5. **DRC** — an independent measurement of the finished copper

If routing leaves nets unfinished, the board is re-placed on a roomier outline
and routed again, up to four attempts. The result carries `routing`, `drc` and
`connectivity`, so a caller never has to guess whether the board is fabricable.

## Scripts

```bash
npm run dev              # vite + API together
npm test                 # 1056 tests
npm run knowledge        # regenerate knowledge/components from src/core
npm run knowledge:check  # fail if they have drifted
npm run build            # production frontend bundle
```

## Component reference

`knowledge/components/` documents all 69 component kinds — one markdown file
each, plus an index. The frontmatter is generated from `src/core`, so the
`pin_order` you read there is the order the validator actually expects. See
[knowledge/README.md](knowledge/README.md).
