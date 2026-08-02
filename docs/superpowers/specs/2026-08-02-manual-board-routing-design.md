# Manual board routing — design

**Date:** 2026-08-02 · **Status:** approved (user), implementing

## Idea

Let the user route the PCB by hand: hover a pad to see every pad on the same
net highlighted, click to lock the net, then click waypoints to draw the trace.
Placement stays automatic (and gets roomier); routing becomes manual-first with
an Auto-route escape hatch. Correctness is not the user's problem: the existing
independent DRC + connectivity checkers measure whatever copper exists, and the
Gerber export stays hard-gated on a clean board.

## Decisions (settled with the user)

1. **Manual-first hybrid.** Boards open placed but unrouted. An **Auto-route**
   button runs the existing A* router on the still-unconnected nets and writes
   the result into the same manual-traces store, so auto traces are ordinary
   editable traces.
2. **The editor replaces the KiCanvas Board mode.** KiCanvas cannot be made
   interactive; the Board mode inside the `pcb3d` window becomes our own SVG
   editor. Downloads (`.kicad_pcb`, Gerbers) stay and export what was routed.
3. **Click-waypoint drawing.** Click the start pad, click corners, finish on a
   highlighted pad. Grid + 45°/90° snapping, live rubber-band preview, `Esc`
   cancels, `Backspace` removes the last corner.
4. **Both copper layers + vias from v1.** Top/Bottom toolbar toggle; `V` (or
   double-click) mid-route drops a via and switches layers.

## Architecture

### Data flow and persistence

- Chat gains a `manualRouting` field (same lifecycle as `editedDiagram`):
  `{ traces: [{ net, layer, width, points: [{x,y},…] }], vias: [{ net, at }] }`,
  persisted per chat in the chat store.
- `buildPcbLayout(circuit, { manualRouting })` places but does not route:
  traces/vias come from the caller. Pour, DRC, connectivity, and the exporters
  run unchanged on the assembled layout — they cannot tell traces were drawn by
  hand, so the fab gate logic needs no changes.
- When the circuit changes, a reconciliation helper drops manual traces/vias
  whose nets no longer exist; the rest survive.

### Editor

New chunk `src/features/pcbEditor/` following the `realisticSchematic`
patterns: pan/zoom world `<g>`, pure model modules, unit + interaction tests.

- `pcbEditorModel.js` (pure): net-highlight sets, ratsnest (unconnected pad
  pairs per net), snapping (routing grid + 45°), trace commit/delete/via ops on
  the `manualRouting` value, incremental clearance check reusing `pcbDrc`
  measurement primitives, and a progress summary ("7 of 12 nets connected · 1
  clearance violation").
- `PcbBoardEditor.jsx`: renders outline, footprint pads, silk refs, traces
  (top red / bottom blue), vias, pour; hover → highlight + dim; click → lock
  net and route; toolbar: layer toggle, Auto-route, progress line. Violating
  segments draw red immediately but are not blocked — the export gate blocks.

### Placement

Manual mode starts the placer at a roomier spacing (compactness no longer
matters when a human routes), leaving obvious channels between footprints.
Auto-route works on the same roomy board.

## Testing

- Model modules: pure unit tests (snap, highlight, commit, reconcile, DRC
  increments, progress).
- Editor: interaction tests in the style of
  `RealisticSchematic.interaction.test.jsx`.
- Exporters/gate: existing tests already cover the assembled-layout path.

## Out of scope (v1)

General undo stack (delete + redraw instead), trace dragging/editing after
commit, net class widths (all traces at the design default; the router's
neck-down stays auto-route-only), interactive placement editing.
