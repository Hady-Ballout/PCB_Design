# AI provider and the circuit model

## Two-phase prompt flow: clarify, then generate

Every user prompt runs two AI calls, orchestrated deterministically by the client
(`beginPrompt` in `src/app/App.jsx`):

1. **Clarify** — `POST /api/clarify-circuit` → `generateClarifyingQuestions`
   (`server/ai/clarifyProvider.ts`). A cheap, non-streaming call with its own small
   grammar-constrained schema (`CLARIFY_SCHEMA`: 1–3 questions, 2–4 short options each) and
   a standalone system prompt (no knowledge base). The server sanitizes the model output
   (`sanitizeClarifyQuestions`: caps, dedupe, `q1..q3` ids) and always appends the
   canonical `'No preference (you decide)'` option to every question. The chat UI renders
   the questions as clickable chips; unanswered questions default to "No preference".
2. **Generate** — the existing `/api/generate-circuit` pipeline, unchanged, with the
   answers folded into the prompt by `composeClarifiedPrompt`
   (`Original request: …\nUser clarifications:\n- Q → A…`). The generation call itself must
   still never ask questions (see `ai-context/pcb-circuit-expert.md`).

Failure semantics: **any** clarify failure (network, non-OK, zero usable questions) makes
the client silently fall back to direct generation with the original prompt — the round can
never block a prompt. There is no correction retry on the clarify call.

Clarification assistant messages carry no `circuit`, so `buildConversationContext`
(client) and `sanitizeConversationHistory` (server) exclude them from model history; the
user's answers reach future turns via the compact `Clarifications: …` user message instead.

## The circuit JSON contract

Every AI response must be a single JSON object with `reply`, `circuit`, and `spice`, plus
an optional fourth field `code` — firmware source for the circuit's microcontroller board
(Arduino C++ sketch for `arduino_uno`/`esp32`, Python gpiozero for `raspberry_pi`; empty
string when the circuit has no board). `code` validation is soft: a missing or empty value
never fails or retries a generation, and `parseCircuitResponse` defensively strips
accidental Markdown fences. Unlike `spice`/`kicadNetlist`, firmware is not derivable from
the circuit, so it is never regenerated server-side — after manual circuit edits the stored
code can go stale until the next AI generation (known limitation). The
`circuit` object:

```json
{
  "title": "Circuit title",
  "type": "circuit_type",
  "supplyVoltage": 5,
  "nodes": ["VCC", "VOUT", "0"],
  "components": [
    { "ref": "R1", "kind": "resistor", "value": "1k", "nodes": ["VCC", "VOUT"], "footprint": "..." }
  ],
  "notes": ["Short useful note."]
}
```

Allowed `kind` values are the single source of truth in `src/core/componentKinds.js`
(`ALLOWED_KINDS`). The AI schema `enum` and the "Allowed component kinds" / fixed-pin
guidance in the system prompt (`server/ai/ollamaProvider.ts`) are **generated from it**, so
adding a kind to the registry automatically offers it to the model. The current 64 kinds:

- **Core (14):** `resistor`, `capacitor`, `inductor`, `diode`, `led`, `bjt_npn`, `bjt_pnp`,
  `mosfet_n`, `mosfet_p`, `opamp`, `regulator`, `voltage_source`, `signal_source`, `load`.
- **Extended (47):** `zener`, `photoresistor`, `thermistor`, `buzzer`, `crystal`,
  `temp_sensor`, `comparator`, `pushbutton`, `potentiometer`, `switch_spdt`, `rgb_led`,
  `seven_segment`, `timer_555`, `ultrasonic_sensor`, `dht_sensor`, `oled_display`,
  `pir_sensor`, `servo`, `dc_motor`, `relay_module`, `stepper_motor`, `stepper_driver`,
  `motor_driver`, `lcd_display`, `rotary_encoder`, `led_strip`, `imu_sensor`,
  `ir_receiver`, `shift_register`, `optocoupler`, `current_sensor`, `keypad`, `joystick`,
  `rtc_module`, `sd_card`, `rfid_reader`, `soil_moisture`, `gas_sensor`, `baro_sensor`,
  `adc_module`, `schottky`, `bridge_rectifier`, `fuse`, `vibration_motor`,
  `sound_sensor`, `hall_sensor`, `solar_panel`. Several of these are simulated rather
  than wiring-only: `optocoupler` emits one X line against the built-in `PC817`
  subcircuit, `current_sensor` a single derived `<REF>_S` milliohm shunt line,
  `bridge_rectifier` four derived `<REF>_A..D` diode lines (compound pattern),
  `schottky` a D line with the `DSCH` model, `fuse`/`vibration_motor` resistive R lines,
  and `solar_panel` a plain `V... DC` line (full source treatment — see below).
- **Microcontroller boards (3):** `arduino_uno`, `raspberry_pi`, `esp32`.

Microcontroller boards (`arduino_uno`, `raspberry_pi`, `esp32`) use fixed positional pin
lists (24/14/12 pins — see `MCU_PINS` in
`src/features/realisticSchematic/breadboardModel.js` and `MCU_PIN_COUNTS` in
`src/core/componentKinds.js`); unused pins carry `NC_<REF>_<pinNumber>` placeholder nets.
Sensor/module parts (`temp_sensor`, `ultrasonic_sensor`, `dht_sensor`, `oled_display`,
`pir_sensor`, `servo`, `relay_module`, the tier-1 additions `stepper_motor`,
`stepper_driver`, `motor_driver`, `lcd_display`, `rotary_encoder`, `led_strip`,
`imu_sensor`, `ir_receiver`, `shift_register`, plus the tier-2 additions `keypad`,
`joystick`, `rtc_module`, `sd_card`, `rfid_reader`, `soil_moisture`, `gas_sensor`,
`baro_sensor`, `adc_module`, plus the tier-3 `sound_sensor` and `hall_sensor`) are
likewise **wiring-only** and use fixed pin lists (`FIXED_PIN_NAMES` in
`src/core/componentKinds.js`), exported to SPICE only as a comment.

`solar_panel` gets the full **source treatment**: it joins `isSourceKind` (net ordering,
canvas orientation), populates `supplyNets` in the topology graph, and renders off-board
as a photovoltaic pack feeding a power rail via the same `batteries` path as
`voltage_source` (the battery entry carries `kind` so `BatteryPack` dispatches to
`SolarPanelPack`). The SPICE parser's V-line branch preserves richer 2-lead source kinds
on reparse (`keepsSourceKind` in `circuitSync.js`) so a solar panel survives round-trips
instead of degrading to `voltage_source`; the D-line branch likewise recognizes `DSCH`
for schottky.

The Raspberry Pi's pin list was extended from 10 to 14 pins (GPIO8-11, its SPI0
CE0/MISO/MOSI/SCLK) — MCU pins are only ever **appended** so saved circuits stay
index-compatible. `padMcuNodes(circuit)` in `componentKinds.js` migrates older circuits
by padding short MCU nodes arrays with `NC_<ref>_<n>` placeholders; it runs in
`chatStore.js`'s `normalizeChat`/`normalizeMessage` on load (which also re-serializes
`editableCircuitJson` — otherwise App's JSON-sync effect would revert the migration —
and resets the affected chat's diagram `layoutVersion` for re-layout) and in
`circuitSync.js`'s `parseCircuitJson` for pasted JSON.
They use `U` refs, are **wiring-only** — exported to SPICE as a comment (`* U1
arduino_uno ...`), never as an element line — and `parseSpiceNetlist` carries them over
from the base circuit during SPICE sync so editing the deck does not drop them.

On the realistic-schematic breadboard, per-kind placement is table-driven
(`STRADDLE_PACKAGES` / `INLINE_BODY_BY_KIND` / `OFFBOARD_SLOT_HEIGHTS` in
`src/features/realisticSchematic/breadboardModel.js`): `comparator` (5-pin opamp contract)
and `timer_555` (canonical pins = NE555 DIP 1-8) straddle the trench as DIP-8s like the
opamp, `pushbutton` straddles with both pins on the bottom strip (top legs decorative),
`seven_segment` straddles as a 5161AS DIP-10 (second COM leg decorative),
`shift_register` and `adc_module` straddle as DIP-16s and `optocoupler` as a DIP-4
(canonical pins = DIP order, identity leg layouts), `temp_sensor` and `ir_receiver` get
TO-92 cans, `rotary_encoder`/`imu_sensor`/`rtc_module`/`sd_card`/`soil_moisture`/
`gas_sensor`/`baro_sensor` stay inline as breadboard-pluggable modules, and
`servo`/`dc_motor`/`relay_module`/`lcd_display`/`motor_driver`/`stepper_motor`/
`stepper_driver`/`led_strip`/`keypad`/`joystick`/`rfid_reader`/`current_sensor` sit in
compact off-board slots below the board (variable-height slot stack shared with the MCU
boards; MCU boards always claim the first slots). Kind-specific artwork dispatches via
`KIND_RENDERERS` in `parts.jsx` (zener/photoresistor/thermistor/buzzer/crystal/
potentiometer/switch_spdt/rgb_led/ultrasonic_sensor/dht_sensor/oled_display/pir_sensor/
rotary_encoder/imu_sensor) plus dedicated straddle and slot bodies (custom LCD/L298N/
28BYJ-48/keypad/joystick artwork; `OffboardModuleBody` is the generic slot PCB for the
rest);
selection pin labels come from the registry's `FIXED_PIN_NAMES` plus manual canonical
orders in `selectionModel.js`.

Rules baked into the system prompt (`server/ai/ollamaProvider.ts`) and
`ai-context/pcb-circuit-expert.md`:

- Component refs must be SPICE-safe by kind: `R`=resistor/load, `C`=capacitor, `L`=inductor,
  `D`=diode/LED (never `LED1` — SPICE would parse the leading `L` as an inductor), `V`=DC or
  signal source, `Q`=BJT, `M`=MOSFET, `X`=opamp/subcircuit.
- `"0"` is the only ground node; never `"GND"`.
- Opamps must use `LM358` as both the JSON value and the SPICE subcircuit name — the app
  ships a built-in 5-pin `LM358` model (`LM358_SUBCIRCUIT` in `src/core/pcbGenerator.js`)
  that `addMissingSpiceModels` injects into any deck that references it without defining it.
- `voltage_source` = DC/fixed bias; `signal_source` = waveform (`SINE`, `PULSE`, `PWL`,
  `EXP`, `AC`).
- Never omit an LED current-limiting resistor or required biasing/feedback components.
- Optional compact `schematic` metadata can mark external terminals or an opamp's
  `primaryRef` — visual-only, must not add SPICE components.

The exporter (`src/core/pcbGenerator.js`) also normalizes refs during SPICE export as a
safety net even if the AI produces an imperfect ref (e.g. an LED-kind component with a
non-`D` ref still exports as `D_<ref>`).

## Reliability pipeline

1. Ollama (or the OpenAI-compatible provider under `AI_PROVIDER`) is called with the JSON
   schema as structured-output format (`CIRCUIT_SCHEMA`/`AI_RESPONSE_SCHEMA`).
2. `parseCircuitResponse` repairs malformed/truncated JSON where possible.
3. `validateCircuitResponse` / `validateCircuit` (frontend) check schema conformance,
   including exact node counts for every positional kind (`POSITIONAL_NODE_KINDS`): all
   `fixedPins` kinds, the compound kinds (`potentiometer` 3, `switch_spdt` 3, `rgb_led` 4,
   `seven_segment` 9), plus `opamp`/`comparator`/`pushbutton`/BJTs/MOSFETs — everything
   whose pins are mapped by index downstream (breadboard leg layouts, SPICE expansion).
4. A parseable circuit is then gated on the **topology rule engine**
   (`checkCircuitTopology`, `src/core/topologyRules.js`) — functional design rules that
   net-continuity checks cannot see: GPIO driving a heavy load with no transistor stage,
   the divider-powered-load pattern, LEDs without series resistors, reversed polarity,
   floating bases/gates, missing flyback diodes, missing pull-ups, GPIO current budgets,
   floating op-amp inputs, stepper coils without a ULN2003 driver
   (`stepper_missing_driver`), and WS2812 strips powered from a GPIO
   (`led_strip_power_from_gpio`). Error-severity violations become a corrective message
   (`composeTopologyCorrection`) fed back to the model.
5. Up to `MAX_GENERATION_ATTEMPTS` (3) attempts run in `parseWithCorrectionRetry`:
   structural failures (bad JSON/schema/SPICE) retry with the parser error; topology
   errors retry with the rule violations. Compound-part SPICE mismatches (e.g. one bare
   `DLED1` diode line instead of derived `DLED1_R/_G/_B` lines) produce a correction
   message that spells out the expected derived-line names.
6. If the final attempt still fails only the SPICE-vs-JSON consistency check
   (`spice_validation`), the deck is regenerated deterministically from the canonical
   JSON via `toSpice` instead of failing the chat turn.
7. **Never a terminal failure once anything parsed**: after the retry budget, the
   best-scoring candidate (fewest error violations; later attempt wins ties) is accepted
   with `generation.degraded: true`, safe additive auto-fixes are applied
   (`applySafeAutoFixes`: MOSFET gate pull-down, flyback diode — marked `autoFixed`), and
   the surviving violations ship in the response `issues` for the UI to surface. A hard
   throw only happens when all three attempts failed structurally.
8. `reconcileCircuitRevision` merges the new circuit against the previous confirmed design
   (a revision, not a fresh generation, when `currentDesign` is present); the server
   re-runs the topology check on the reconciled circuit before responding.
9. Streamed SPICE is marked `provisional`/`correcting` until the full circuit validates.
10. On structural failure, the previous confirmed SPICE/circuit is restored — the UI never
    silently replaces a working design with a broken one.

## Topology rule engine (`src/core/topologyRules.js`)

A pure, shared module (plain JS + `.d.ts`, imported by both the server retry loop and the
frontend) that checks *functional* correctness on top of schema/continuity validation. It
exists because a circuit can have perfect net continuity and still be wrong — the canonical
case: a buzzer on an ESP32 GPIO net fed from 3V3 with a resistor divider to ground and no
transistor anywhere. Every net checks out; the GPIO cannot switch the load.

- `buildCircuitGraph(circuit)` — net→pins index, GPIO/supply net detection, and a
  `reach(net, opts)` BFS through conductive parts (options select which kinds conduct:
  resistors, switches, diodes, driver channels).
- `checkCircuitTopology(circuit)` → `{ ok, violations }`. Violations are
  `{ id, severity: 'error'|'warning', refs, nets, message, fix, autoFixed }` — `fix` is a
  concrete recipe with real refs, reused verbatim in the AI correction message and the UI.
- `TOPOLOGY_RULES` is a flat array; adding a rule = one entry + one fixture pair in
  `topologyRules.test.js`. A rule may declare `supersedes` so a specific finding (e.g.
  `divider_powered_load`) silences the generic one (`gpio_direct_load`) for the same refs.
- Rules are deliberately conservative (skip ambiguous topologies): a false positive burns
  a retry and erodes trust. The test suite pins a zero-error known-good corpus.
- Driver-module breakouts (`motor_driver` OUT1-OUT4, `stepper_driver` OUTA-OUTD; the
  `DRIVER_MODULE_OUTPUT_PINS` table) count as switching elements in `hasDriverOutputOn`,
  so a load on their outputs never trips `gpio_direct_load`; `missing_flyback_diode`
  additionally skips motors on driver-module outputs (the boards integrate protection
  diodes, and an H-bridge output pair can't take a simple parallel diode).
- Tier-3 conduction/rule notes: `schottky` joined `DIODE_KINDS` (crossDiodes conduction,
  valid flyback part, included in `led_polarity` — zener stays excluded);
  `vibration_motor` joined `HEAVY_LOAD_KINDS` and the new `MOTOR_KINDS` set gates
  `missing_flyback_diode` (deliberately narrower than HEAVY_LOAD_KINDS so buzzers never
  demand a flyback diode); `fuse` conducts unconditionally in `crossings()` (even under
  `crossResistors: false`) so it never masks a missing series resistor;
  `bridge_rectifier` conducts across all pins under `crossDiodes` like `rgb_led`.
- The optocoupler's output pins live in a separate `ISOLATOR_OUTPUT_PINS` table:
  `hasDriverOutputOn` consults it (suppressing `gpio_direct_load` on the isolated side)
  but the flyback skip does **not** — a motor on a bare opto output still gets flagged.
  In `crossings()` the opto conducts A↔K like a diode and E↔C like a driver channel,
  never across the isolation barrier, and `led_no_series_resistor` covers its input LED;
  the `current_sensor` conducts only IP+↔IP- (its shunt path), so series-loop rules see
  through it.
- `applySafeAutoFixes(circuit, violations)` applies additive-only repairs (100k gate
  pull-down, 1N4007 flyback diode) in the degraded path and marks them `autoFixed`;
  anything that would rearrange existing parts stays a surfaced violation.

## Chat memory / context window

`server/ai/chatMemory.ts` keeps a persisted, per-chat summary of confirmed requirements and
decisions (`updateChatMemory`), rather than replaying the full conversation every time.
Requests to Ollama combine: that memory summary + the canonical current circuit + recent
turns (`sanitizeConversationHistory`) + the newest prompt, inside a server-controlled
context window (`OLLAMA_NUM_CTX` / `OLLAMA_NUM_PREDICT`).

## Synchronization: SPICE <-> canvas <-> KiCad <-> JSON

`src/core/circuitSync.js` is the single synchronization layer all editable views go
through. The canonical electrical representation is: component ref, kind, value, ordered
pin nodes, footprint. Visual layout — canvas (x/y) and breadboard part-placement anchors
(`editedBreadboard`) — is never part of `circuitElectricalSignature`.

- **Canvas -> circuit**: `circuitFromDiagram`. New components start with `NC_...`
  placeholder nodes (unconnected) until wired.
- **Breadboard -> circuit**: the realistic-schematic editor rewires by dragging a pin to a
  new hole, which is a targeted edit of one `component.nodes[i]` (the net on the dropped
  tie group via `netAtHole`, or an `NC_<ref>_<pin>` placeholder when unplugged). `App.jsx`'s
  `applyCircuitChange` gates on `circuitElectricalSignature` and runs the same
  `synchronizeResult` spine — no diagram inverse needed since the next circuit is already in
  hand. Breadboard placement itself is visual-only (see `editedBreadboard` below).
- **SPICE -> canvas**: parsing supports `R`/`C`/`L`/`V`/`D`/`Q` lines and the 5-node `X`
  opamp form used by this app; `.model`/`.tran`/`.op`/`.end`/comments and `.subckt`/`.ends`
  bodies are ignored for canvas sync. `+` continuation lines are **not** supported.
  Incomplete/unsupported lines pause sync and show an error rather than corrupting the
  diagram.
- **KiCad -> canvas**: XML netlist edits (values, footprints, kinds, net names, pin
  assignments, add/remove) sync back the same way; malformed XML pauses sync.
- **Layout preservation**: `preserveDiagramLayout` keeps existing component positions (by
  ref) and net-label positions (by stable pin label ID) across edits; only new components
  get freshly generated positions. Layout format is versioned
  (`LAYOUT_VERSION` in `schematicLayout.js`, currently 5) with migration for older saved
  diagrams (`migrateChatDiagram` in `chatStore.js`).
- **Breadboard placement (`editedBreadboard`)**: a persisted `{ version, parts: { [ref]:
  { strip, column } } }` layer on the chat record pinning parts the user dragged.
  `circuitToBreadboard(circuit, overrides)` places pinned parts first, then greedy-places the
  rest around them (byte-identical to pure auto-placement when empty). `reconcileOverrides`
  drops anchors whose part is gone when topology changes; added parts have no anchor and fall
  to auto-placement — the breadboard analogue of `preserveDiagramLayout`.
- **Routing**: `schematicLayout.js` treats components, labels, and existing wires as hard
  obstacles — auto-routed wires cannot cross/touch/come within `WIRE_CLEARANCE` (16px) of
  another wire. Interactive dragging is unconstrained (no snapping/collision correction while
  the user drags).

## Live in-browser simulation (`src/core/sim`)

The realistic-breadboard view's **Run** mode simulates the canonical circuit model
client-side — a hand-rolled MNA engine, not Ngspice, and not the SPICE text (it consumes
circuit JSON directly). The design contract is that **`buildSimNetlist` mirrors `toSpice()`
element-for-element**: the same compound expansions (potentiometer → two half resistors
around the wiper, switch_spdt with pin 2 as COM, rgb_led → three diodes, seven_segment →
per-connected-segment diode, bridge_rectifier → four DGEN legs, current_sensor → 1.2 mΩ
shunt gated on connected IP± pins), the same NC-leg skipping, and the same `.model`
parameters (DGEN/DRED/DSCH/zener BV), so the live sim and the server-side Ngspice waveform
page agree numerically. Where they intentionally differ:

| Aspect | `toSpice()` / Ngspice | live sim (M1–M3) |
|---|---|---|
| pushbutton / switch / pot / LDR / thermistor | fixed snapshot (open button, 50 % wiper, 10 k defaults) | **interactive**: control state (pressed, throw, wiper α, lux, °C) parameterizes the stamps live |
| BJT | Q2N2222/Q2N3906 with VAF=100 | Ebers-Moll, same IS/BF, **no Early effect** (simpler Jacobian, negligible at breadboard scale) |
| MOSFET | LEVEL=1, no λ | same level 1 plus **λ=0.01** (keeps the saturation Jacobian nonsingular). Both are the deck's weak KP=20µ device — a 5 V gate saturates at ~90 µA, so LEDs won't visibly light through it; this matches ngspice exactly and is not a sim bug |
| opamp | LM358 subcircuit (VCVS ladder, **no rail clamp**) | behavioral tanh VCVS (gain 1e5, Ro=100Ω) **clamped to the supply rails** with LM358-ish headroom — a deliberate improvement |
| comparator | LM393 subcircuit (push-pull VCVS) | **open-collector** switch with ±5 mV hysteresis — physically correct LM393 behavior, matches the topology rules' pull-up expectations |
| 555 | TIMER555 subcircuit (hysteretic switches, fixed 5 V trip points) | behavioral SR latch reading real thresholds off the internal 5k/10k CTRL ladder (external CTRL parts shift the trip points); OUT drives VCC−1.7/0.1 V behind 10 Ω, DISCH 25 Ω/open |
| optocoupler | PC817 subcircuit (on/off switch, no CTR) | same on/off semantics (SW VT=1.1 VH=0.15 on the LED junction); CTR-proportional output remains a possible future refinement |
| regulator | ideal DC source on OUT, IN ignored | same, **plus dropout**: output tracks min(Vnom, vIN − 1.5) when IN is wired; unpowered stays ideal with the `regulator_unpowered` warning |
| relay_module | wiring-only comment | **behavioral**: COM–NO closes / COM–NC opens when powered (>4 V) and IN > 2.5 V (2.2 V drop-out hysteresis), coil loads the supply 70 Ω energized / 10 kΩ idle; indicator LED lights on the board |
| Tier-2a sensors (temp_sensor, pir_sensor, soil_moisture, gas_sensor, sound_sensor, hall_sensor) | wiring-only comments | **behavioral stimulus-driven sources** gated on module power (>2.5 V): TMP36 OUT = 0.5 + 10 mV/°C (slider), PIR OUT 3.3/0.05 V (click the dome to toggle motion), soil AOUT 2.8→1.2 V vs moisture, gas/sound AO = 0.4 + 3.6·level with a push-pull DO that flips at level 0.5; the hall is an open-collector switch (click to toggle the magnet; power gate ignored — documented simplification). The remaining modules (ultrasonic, DHT, displays, SPI/I2C breakouts…) stay wiring-only until the MCU-emulation track exists — their outputs are protocols, not voltages |
| fuse | fixed resistor | same resistance **plus i²t blow**: sustained current above 2× `parseAmps(value, 1)` opens it (instantly at DC, after 10 ms in transient); broken-glass artwork, resets on Stop/Run ("replace the fuse") |
| current_sensor | shunt only, no OUT drive | shunt **plus the ACS712 analog output**: OUT driven at 2.5 V + 185 mV/A of shunt current when VCC/OUT/GND are wired |
| solar_panel | ideal DC source | ideal source behind **5 Ω** — panels sag under load (and survive a short at V/5Ω instead of a singular matrix) |
| buzzer / motors | plain resistors | plain resistors **plus observables**: buzzer frequency detection (rising-1V-crossing timestamps → Web Audio tone in the UI), motor `speed01` from drive voltage vs rated (6 V dc / 3 V vibration) → spin/shake animation |
| analysis | one-shot `.tran 0.1ms 20ms` + `.op` | backward-Euler from a zero state (power-on transient is visible), real-time-paced with a per-frame budget and a speed chip |

Event-state devices (comparator, 555 latch, opto switch, regulator dropout) update
**between** timesteps from the committed solution — hysteresis prevents chatter, and DC
solves run a bounded settle loop (solve → update states → re-solve, ≤10 rounds). Circuits
containing only event devices stay static (`isDynamic` false): they re-settle on every
control edit, and anything a 555 does usefully involves its timing capacitor, which
already makes the circuit dynamic.

### Arduino Uno firmware execution (avr8js)

The biggest sim/deck divergence: **the live sim actually executes the chat's firmware; the
ngspice deck never does.** Pressing Run on a circuit whose first `arduino_uno` has a sketch
(`editableCode`) compiles it server-side (`POST /api/compile-sketch` → local `arduino-cli`,
see docs/OPERATIONS.md; per-chat hash→hex cache client-side) and attaches an **avr8js**
ATmega328P emulator (`src/core/sim/avrRunner.js`: CPU + timers 0/1/2 + ports B/C/D + USART
+ ADC, pinned `avr8js@0.21.0`) to the engine. `buildSimNetlist(circuit, {mcuRef})` then
emits real devices for the board: an internal always-on 5 V supply (USB) behind 0.5 Ω on
the 5V/3V3 pins (so a parallel user battery can't fight an ideal source), a 0 V tie for a
non-`'0'` GND-pin net, and one `mcu_pin` branch + 40 Ω output resistance per connected
D0–D13/A0–A5 pin. Each timestep runs **lockstep**: `h·16 MHz` AVR cycles execute, pin
modes/levels latch into the stamps (output → 0/5 V drive; input → floating zero-current
branch; INPUT_PULLUP → +35 kΩ to 5 V), the MNA solve runs, and the solved net voltages
feed back (digital reads at a 2.5 V threshold, all six ADC channels) with one step of lag.
`Serial.print` bytes stream into a 4 KB ring buffer shown in the breadboard's serial
monitor strip. PWM (`analogWrite`) is electrically real — a 490/980 Hz square wave through
the circuit — and LED **brightness** renders its 30 ms persistence-of-vision average
(`emaI`) so PWM dims instead of flickering, while readout amps and the V map stay
instantaneous. Firmware-less Unos warn `mcu_no_firmware` and float as before; ESP32/Pi
remain `mcu_not_simulated`; one Uno per circuit executes (the first).

**Protocol modules on the bridge** (`src/core/sim/avrPeripherals.js`): `servo`,
`ultrasonic_sensor`, `dht_sensor`, and `rotary_encoder` attach at **cycle resolution** —
their timing (10 µs TRIG pulses, 26/70 µs DHT bits, µs-precision servo PWM) is far finer
than the 20 µs lockstep, so they listen to MCU port writes via `AVRIOPort.addListener`
and answer with `cpu.addClockEvent` + `port.setPin` (Wokwi's architecture). Attachment is
by **direct-wire discovery**: a module simulates only when its protocol pins share nets
with the firmware Uno's signal pins (a series resistor in between breaks it; unwired
modules keep the `module_not_simulated` warning). Behaviors: servo decodes 500–2500 µs
pulses to a 0–180° horn angle (drawn live); HC-SR04 answers a ≥10 µs TRIG with an ECHO of
`distanceCm·58 µs` (distance slider); DHT emits the full DHT22 40-bit packet (temp and
humidity sliders, checksummed) after the MCU's ≥0.9 ms start pulse; the encoder emits
quadrature detents from CW/CCW stimulus buttons plus a 50 ms switch press.
Module-driven pins (ECHO, DATA, CLK/DT/SW) carry a **display-only 1 kΩ presence branch**
so the legend/V-map track the digital levels while the MCU's 40 Ω driver still wins any
shared-net moments. Pins a peripheral **digitally owns** (keypad rows, protocol input
lines) are excluded from the lockstep's electrical input feedback — the crossbar/protocol
is their source of truth, not the floating net voltage.

**Slice 2 — displays, shift register, keypad.** The runner carries an **I2C bus router**
on avr8js's `AVRTWI` (ACK only registered slave addresses; the `Wire` library's
`beginTransmission/endTransmission` maps onto the TWIEventHandler callbacks with
synchronous completions). `displayModels.js` holds pure protocol parsers: **SSD1306**
(0x3C, the exact Adafruit_SSD1306 subset — 0x00/0x40 control-byte framing tolerant of
32-byte Wire chunks, column/page windows, on/off/invert, horizontal-addressing pointer
walk into a 1024-byte framebuffer) and **PCF8574 + HD44780** (0x27, LiquidCrystal_I2C
wiring P0=RS/P2=E/P3=backlight/P4-7=data, nibbles latched on the E falling edge with the
4-bit-init one→two-nibble mode switch, clear/home/DDRAM-address/display-control, 2×16
text). The React layer renders the OLED framebuffer as a canvas-generated `<image>` data
URL (first canvas use in the codebase; jsdom falls back to static artwork) and the LCD as
per-cell text glyphs. The **74HC595** shifts SER on SRCLK rising and latches on RCLK
(MSBFIRST semantics: value bit 7 → QH); its outputs are **real 50 Ω drive branches** on
arbitrary nets, so 595→7-seg circuits light through the ordinary segment-diode path. The
**4×4 keypad** is a crossbar honoring the Keypad library's scan (columns driven output-low
one at a time, rows INPUT_PULLUP): artwork keys are clickable in run mode
(`data-keypad-key` press-and-hold), and row input levels are recomputed from pressed keys
× driven columns. I2C displays attach only when wired to the hardware TWI pins (SDA↔A4,
SCL↔A5). Compilation of display/keypad sketches needs the curated `arduino-cli lib
install` set (docs/OPERATIONS.md; baked into the Dockerfile).

**Slice 3 — register sensors, SPI ADC, serial input, NeoPixel.** `registerModels.js`
adds the pointer-write-then-burst-read I2C register-slave pattern carrying the **MPU6050**
(WHO_AM_I 0x68; pitch/roll sliders orient the gravity vector into the 14-byte big-endian
accel burst at ±2g scale), the **DS3231** (BCD time rolled forward from a fixed 2026-01-01
base by AVR cycles — never wall clock; `adjust()` writes become the new base; the rolling
clock shows in the part readout), and the **BMP280** with a **deliberately degenerate
calibration** (dig_T1=dig_T2=16384, dig_P1=6250, rest zero) that collapses Bosch's integer
compensation to exact linear maps — `adc_T = 5120·T + 262144`, `adc_P = 1048576 − Pa` — so
temperature/pressure sliders invert exactly (verified in tests against the verbatim Bosch
formulas). The runner gains an **SPI layer**: AVRSPI plus a CS-keyed device router
(chip-select is plain GPIO; the device whose CS reads output-low gets each byte, completion
scheduled at the true `transferCycles`). The **MCP3008** rides it with the standard 3-byte
frame, and its CH0–CH7 pins read **live circuit nets** through the lockstep feedback — an
Uno can now `SPI.transfer` its way to real divider voltages. SPI discovery requires the
hardware pins (DIN↔D11, DOUT↔D12, CLK↔D13; CS anywhere). One simulated device per I2C
address (`i2c_address_conflict` warning — IMU and RTC both live at 0x68, first wins).
**Serial input**: the monitor strip gains a Send field; bytes queue engine-side and drain
one per accepted UART window into `usart.writeByte` (no `Serial.begin` → the queue waits).
**WS2812 strip**: DIN port-writes are decoded at cycle resolution (pulse >10 cycles = 1,
≥640-cycle gap latches, GRB order) into up to 30 live pixels on the strip artwork.
Still deferred: `sd_card` (FAT), `rfid_reader` (RC522).

Solver notes: junction limiting (pnjlim) must veto NR convergence — with an LED off-seed,
node voltages sit nearly still for ~10 iterations while the junction linearization climbs
to conduction, so a plain delta-x test converges prematurely to the wrong operating point.
DC fallbacks run gmin stepping then source stepping; a solve that still fails keeps the
last good solution and flags `converged:false` instead of ever emitting NaN. Value parsing
lives in `src/core/sim/simValues.js` (not the scattered per-module parsers) and keeps the
codebase's suffix conventions: bare `m` is MEG for resistances but milli inside SPICE
`SINE(...)` argument lists, and a bare capacitor number means µF.

## Known limitations (carried over from `SESSION_SUMMARY.md`)

- The SPICE parser handles only this app's generated syntax, not arbitrary SPICE dialects.
- MOSFET and general subcircuit parsing from hand-edited SPICE/KiCad is not implemented.
- KiCad export is an XML netlist, not a full `.kicad_sch`/PCB project.
- Ngspice validates that the deck *runs*, not that the circuit is electrically correct;
  functional correctness is checked by the topology rule engine above, whose rules are
  heuristics — a clean report is strong evidence, not proof, of a working circuit.
