# Prompt-to-PCB Session Summary

## Session Goal

This session evolved the original prompt form into an AI circuit workspace with persistent chats and synchronized SPICE, schematic, and KiCad editors.

The current workflow is:

```text
Chat prompt
-> Ollama circuit generation or revision
-> structured circuit model
-> synchronized SPICE, canvas, and KiCad views
-> optional Ngspice simulation
```

## User Interface

- The prompt area is now a persistent chat interface.
- Previous conversations are available through the back arrow.
- New conversations can be created without crowding the active chat.
- The chat panel is positioned on the right side of the workspace.
- The old Summary and Simulation pages were removed.
- Simulation is launched with the play button in the Spice window.
- The `Generator: Ollama AI` banner was removed.
- Spice, Canvas, and KiCad behave like closable editor windows.
- Multiple editor windows can be open in split view.
- Split panes can be resized horizontally and vertically.

## Chat And AI Revisions

- Chats and their generated artifacts are persisted in local storage.
- Sending a follow-up prompt edits the current circuit instead of starting from an unrelated circuit.
- The current circuit, edited SPICE, and edited KiCad netlist are sent as revision context.
- SPICE generation streams into the editor while the AI is working.
- Chat history includes previous user and assistant messages.

## AI Output Reliability

- Ollama generation now uses the circuit JSON schema as the structured-output format.
- Model output is parsed and validated before it can replace the confirmed circuit.
- Malformed, truncated, missing, or schema-invalid JSON triggers one automatic corrective retry.
- Streamed SPICE is labeled as an unconfirmed preview until the complete circuit passes validation.
- A failed revision restores the previous confirmed SPICE deck and leaves the existing circuit/canvas intact.
- Provider errors are classified in server diagnostics.
- Ollama context and output limits are configurable with `OLLAMA_NUM_CTX` and `OLLAMA_NUM_PREDICT`.

## Op Amp Simulation

- Generated SPICE now includes a built-in five-pin `LM358`-compatible subcircuit for op amp components.
- The simulator injects the same model into older saved or manually edited decks that reference `LM358` without defining it.
- This fixes Ngspice `unknown subckt` failures for generated op amp circuits.

## Shared Circuit Model

`src/lib/circuitSync.js` provides the synchronization layer shared by all editors.

The structured circuit model remains the canonical electrical representation:

```text
component reference
component kind
component value
ordered pin nodes
footprint
```

Canvas coordinates and window layout are visual state and do not affect electrical connectivity.

## Canvas To Netlists

Canvas edits update the structured circuit, SPICE deck, and KiCad netlist.

Supported canvas operations include:

- Adding resistors, capacitors, sources, LEDs, BJTs, and op amps.
- Deleting components, nets, and wires.
- Creating explicit connections with the Wire tool.
- Moving components, nets, and wire paths without changing connectivity.
- Editing a selected component value from the canvas toolbar.
- Ground node `0` is rendered with a standard ground symbol on the canvas and in downloaded SVG files.

New components start unconnected. Their pins use `NC_...` placeholder nodes and do not display automatic wires or net labels. Legacy placeholders such as `V1_1` and `V1_2` are also treated as unconnected for compatibility with saved chats.

The component value editor stays open while typing and closes when Enter is pressed. Value edits immediately update the canvas label, SPICE line, and KiCad `<value>` entry.

## SPICE To Canvas

Editing component lines in the Spice window updates the canvas after a short debounce.

Examples:

```spice
R1 IN OUT 2.2k
C1 OUT 0 220n
V1 IN 0 SINE(0 1 60)
```

Supported component lines currently include:

- `R`: resistor or existing load
- `C`: capacitor
- `L`: inductor
- `V`: DC or signal voltage source
- `D`: diode or LED
- `Q`: BJT
- `X`: five-node op amp/subcircuit form used by this application

Changing values or nodes redraws the canvas. Adding a component line adds the component. Removing a component line removes it from the canvas and KiCad netlist.

SPICE directives and comments such as `.model`, `.tran`, `.op`, `.end`, and `* comment` do not create canvas components.

Subcircuit model definitions between `.subckt` and `.ends` are also ignored by canvas synchronization. Internal model elements such as `EGAIN`, `RPOLE`, and `EOUT` remain in SPICE for simulation but are not treated as editable schematic components.

Incomplete or unsupported component lines pause canvas synchronization and display an error without replacing the last valid schematic.

## KiCad To Canvas

Editing the generated KiCad XML netlist updates the structured circuit and canvas after a short debounce.

Supported edits include:

- Component values
- Component footprints and kinds
- Net names
- Pin-to-net assignments
- Component additions and removals

Malformed or incomplete XML pauses synchronization and preserves the last valid circuit. Generated XML now escapes references, values, footprints, kinds, and net names correctly.

## Layout Preservation

When a valid SPICE or KiCad edit redraws the schematic:

- Existing component positions are preserved by reference.
- Existing repeated net-label positions are preserved by stable pin label ID.
- New components receive generated positions.
- Electrical changes regenerate normalized wires.
- Every connected pin receives its own repeated net label or ground symbol, so same-net wires do not share trunks or junctions.
- Components, component labels, net labels, and previously routed wires are hard routing obstacles.
- Automatic and manually adjusted routes cannot cross, touch, share segments, or come within 16px of another wire.
- The canvas expands in bounded steps when more routing space is required; failed layouts raise an error instead of returning partial stubs.
- Saved v1/v2 diagrams migrate to layout v3 by preserving legal component positions and rerouting without bridges or junction dots.

## Important Files

- `src/App.jsx`: chat UI, editor windows, canvas controls, synchronization effects, simulation controls.
- `src/styles.css`: chat, workbench, split pane, canvas, and component value editor styling.
- `src/lib/chatStore.js`: persistent chat state and conversation context.
- `src/lib/circuitSync.js`: canvas, SPICE, and KiCad parsing and synchronization.
- `src/lib/circuitSync.test.js`: synchronization and round-trip tests.
- `src/lib/pcbGenerator.js`: validation, diagram generation, SPICE export, KiCad export, and simulation metadata.
- `server/streamingCircuit.js`: progressive SPICE streaming support.
- `server/ollamaProvider.js`: Ollama generation and current-design revision prompting.
- `server/index.js`: generation and simulation API routes.

## Verification

Latest verification completed during this session:

```text
7 test files passed
44 tests passed
Vite production build succeeded
```

Commands:

```bash
npm test
npm run build
```

## Current Limitations

- The SPICE parser supports the component syntax generated by this application, not every SPICE dialect or device.
- SPICE continuation lines beginning with `+` are not supported by canvas synchronization.
- MOSFET and arbitrary subcircuit parsing are not yet implemented.
- KiCad output remains an XML netlist rather than a complete `.kicad_sch` or PCB project.
- Ngspice must be installed and available on PATH for simulation.
- Validation checks structural issues but does not guarantee a physically correct circuit.

## Suggested Next Work

- Add MOSFET and general subcircuit parsing.
- Add editable component reference, kind, and footprint controls on the canvas.
- Add undo/redo for canvas and text editor synchronization.
- Add clearer visual markers for unconnected pins.
- Add direct net naming and pin-disconnect controls on the canvas.
- Move toward native KiCad schematic project generation.
