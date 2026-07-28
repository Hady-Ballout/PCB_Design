# uA741 op-amp as a first-class simulatable component

**Date:** 2026-07-28
**Status:** Approved (kind = new component kind, 8-pin full DIP contract, enhanced-behavioral SPICE model)

## Goal

Add a `ua741` component kind that the AI can generate, the breadboard/schematic
views can draw with the true single-741 DIP-8 pinout, and ngspice can simulate
with datasheet-faithful behavior (Avol ≈ 200k, GBW ≈ 1 MHz, output clamped
~1.5 V inside each supply rail). The generic `opamp` kind (LM358 model) stays
untouched.

## Decisions made during brainstorming

1. **New component kind** (not value-driven model selection on `opamp`).
2. **Enhanced behavioral SPICE model**: gain + pole core plus supply-rail
   output clamping via a B-source. No slew-rate limiting (convergence risk
   outweighs payoff).
3. **8-pin full DIP contract** (`fixedPins`, timer_555 pattern): canonical
   order = physical DIP pins 1–8, so leg layouts and KiCad pin numbering are
   identity mappings.

## Design

### 1. Component kind (`src/core/componentKinds.js`)

```js
ua741: {
  spicePrefix: 'X', pins: 8, symbolType: 'generic', label: 'Op amp (uA741)',
  fixedPins: ['OFS1', 'IN-', 'IN+', 'V-', 'OFS2', 'OUT', 'V+', 'NC'],
},
```

AI schema enum, prompt pin-contract lists, node-count validation, and
selection pin labels all derive from this table automatically.

### 2. SPICE model (`src/core/pcbGenerator.js`)

`UA741_SUBCIRCUIT` with all 8 ports, registered in `SPICE_SUBCIRCUITS`, plus a
`toSpice` line emitting `X<ref> <8 nodes> UA741`:

```spice
.subckt UA741 OFS1 INN INP VEE OFS2 OUT VCC NC
RIN INP INN 2Meg
EGAIN NRAW 0 INP INN 200k
RPOLE NRAW NINT 1k
CPOLE NINT 0 31.8u
BOUT NCLAMP 0 V = max(min(V(NINT), V(VCC)-1.5), V(VEE)+1.5)
ROUT NCLAMP OUT 75
ROFS1 OFS1 VEE 10Meg
ROFS2 OFS2 VEE 10Meg
RNC NC 0 10Meg
.ends UA741
```

- 200k gain / 5 Hz pole → GBW ≈ 1 MHz.
- B-source clamp: output saturates ~1.5 V inside V+/V− (real 741 headroom),
  so open-loop/comparator circuits clip realistically.
- 10 MΩ leaks keep unwired OFS/NC pins DC-connected (no singular matrix from
  `NC_*` placeholder nets).

### 3. Breadboard (`src/features/realisticSchematic/breadboardModel.js`)

`STRADDLE_PACKAGES.ua741`: DIP-8 straddle, identity legs
(`bottom: [0,1,2,3], top: [7,6,5,4]`), `body: 'dip'`, `requirePins: 8`.
True single-741 pinout — a literal physical build is correct.

### 4. Canvas + KiCad export

- Canvas symbol: `generic` labeled box (triangle opamp symbol assumes the
  5-pin contract; out of scope).
- `src/core/kicadSchematic.js`: `ua741` → `Amplifier_Operational:LM741`,
  `pinNumbers: ['1','2','3','4','5','6','7','8']`. Verify the embedded symbol
  in `kicadSymbolLibrary.js` exposes pins 1/5/8; refresh via
  `scripts/extract-kicad-symbols.mjs` if not.

### 5. Wiring rules (`src/core/topologyRules.js`)

- Add `ua741` to `DECOUPLED_IC_KINDS`.
- Generalize `opamp_input_floating` to cover ua741 (input node indices 1/2,
  zero-based, vs the opamp's 0/1).
- Add to the powered-parts list so missing V+/V− is flagged.

### 6. AI guidance (`server/ai/ollamaProvider.ts`, `server/ai/circuitPipeline.ts`)

One steering sentence in both system prompts: use `ua741` when the user names
a 741 (uA741/UA741/LM741); otherwise use the generic `opamp`; never wire
OFS1/OFS2/NC unless explicitly asked (use `NC_<ref>_<pin>` placeholders).

### 7. Testing

Per-file, following existing patterns:

- `pcbGenerator.test.js`: toSpice emits the X-line; `addMissingSpiceModels`
  injects UA741 once and skips when hand-defined.
- `breadboardModel.test.js`: DIP-8 straddle placement with identity legs.
- KiCad export test: pins 1–8 mapping.
- `topologyRules.test.js`: floating-input and missing-supply findings.
- AI provider tests: contract strings include `ua741 (8 nodes): …`.
- Simulation deck test through `buildSimulationDeck`: clamp B-source survives
  deck assembly.

### 8. Docs

Update `docs/AI_AND_CIRCUIT_MODEL.md` (kind tables) and any kind enumerations
in `docs/FRONTEND.md` / `docs/BACKEND.md` in the same change.

## Out of scope

- Slew-rate limiting in the SPICE model.
- Extending the triangle opamp canvas symbol to 8 pins.
- Offset-null trimming circuits in AI guidance (pins exist, unwired by default).
