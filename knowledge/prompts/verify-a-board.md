# Verify a board

How to check a circuit actually produces a manufacturable board, and how to read
the verdicts.

## The pipeline

`buildPcbLayout(circuit)` runs five stages and returns the verdict with the
board:

1. **footprints** — real KiCad geometry per part
2. **place** — netlist-aware placement with courtyard clearance
3. **route** — clearance-aware two-layer A* maze routing
4. **pour** — bottom-copper ground pour over what routing left
5. **DRC** — an independent measurement of the finished copper

If routing leaves nets unfinished it re-places on a roomier outline and retries,
up to four attempts.

## Running it

```js
import { buildPcbLayout } from './src/core/pcbLayout.js';
const layout = buildPcbLayout(circuit);
console.log('board       :', layout.board.width, 'x', layout.board.height, 'mm');
console.log('traces      :', layout.traces.length, '| vias:', layout.vias.length);
console.log('routing     :', JSON.stringify(layout.routing));
console.log('drc         :', JSON.stringify(layout.drc));
console.log('connectivity:', JSON.stringify(layout.connectivity));
```

## Reading the verdicts

| Verdict | Clean | What a failure means |
|---------|-------|----------------------|
| `routing` | `complete: true` | The router could not finish some nets. Usually too dense; sometimes genuinely unroutable. |
| `drc` | `ok: true` | Copper violates clearance — a short. Never ship this. |
| `connectivity` | `ok: true` | A net is split into islands: it looks wired but is not electrically one net. |

All three must be clean. `drc` failing is the most serious — it means the board
is wrong, not merely incomplete.

## Exports

Only once the three verdicts are clean:

```js
import { toKiCadPcb } from './src/core/kicadPcb.js';
import { toGerberArchive } from './src/core/gerberExport.js';
```

Both read the same layout object, so anything true of the layout is true of the
exports.

## What DRC does not check

- That the circuit is correct. A 555 with `TRIG` and `THRES` swapped produces a
  flawless board for a circuit that does not oscillate.
- That values are sensible. Nothing simulates your arithmetic.

DRC answers "can this be manufactured", not "does this work". Those are
different questions and only the first is automated.
