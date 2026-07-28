# Test Campaign Protocol

Every reviewed build follows the same loop:

1. Paste the app's debug description into the reviewer. Since the report now
   carries DESIGN RULE FINDINGS and physical WARNINGS, the reviewer's job is
   what the rules CANNOT see, not what they already caught.
2. For each new finding, answer one question first: **which deterministic
   check would have caught this?** Record it in the ledger below.
   - Netlist-shaped answer -> new entry in src/core/topologyRules.js
     (fixture pair in topologyRules.test.js).
   - Board-shaped answer -> new check in
     src/features/realisticSchematic/physicalChecks.js.
   - "No deterministic rule can" -> add it to the reviewer-stage checklist in
     server/ai/circuitPipeline.ts and note it as model-quality-bound.
3. A finding is CLOSED only when its fixture pair is committed and the rule
   fires on the bug fixture.

## Ledger

Status as of 2026-07-28: Tasks 1-21 of `Impedo_Reliability_Plan.md` are implemented,
reviewed, and committed. The statuses below reflect what actually shipped, not what
was planned.

| # | Test case | Finding | Deterministic check | Status |
|---|-----------|---------|----------------------|--------|
| 1 | TC1 | Empty-warnings report despite known issues | report DESIGN RULE FINDINGS section | closed |
| 2 | TC1 | Band 10 duplicates band 6 / fake bandpass / gain clipping / no detector / bypass sizing | reviewer checklist | reviewer-checklist (model-quality-bound) |
| 3 | TC1 | 250Ω non-E24 resistor | non_standard_resistor | closed |
| 4 | TC1 | Zero supply decoupling | missing_supply_decoupling | closed |
| 5 | TC1 | Dead Arduino (power-only connections) | dead_active_device | closed |
| 6 | TC7 | Dead ESP32 (power-only connections) | dead_active_device | closed |
| 7 | TC1 | LM358 unbuildable footprint + wrong supply pins | LM358 DIP-8 pinout fix | closed |
| 8 | TC5 | Pin 4 reported as GND (destroys chip if literal-built) | LM358 DIP-8 pinout fix | closed |
| 9 | TC1 | 190-column board, no seam info | physicalChecks SEAM | closed |
| 10 | TC1 | Signal nets on power rails | physicalChecks RAIL-POLICY | closed |
| 11 | TC4 | Signal nets on power rails | physicalChecks RAIL-POLICY | closed |
| 12 | TC1 | Bands not tiled (subcircuit layout) | none | out of scope (placement-quality, revisit) |
| 13 | TC2 | Modules stacked on the same holes | physicalChecks OCCUPANCY | closed |
| 14 | TC2 | Modules stacked on the same holes | ESP32/module off-board placement | closed |
| 15 | TC2 | Shredded header order | physicalChecks GEOMETRY (contiguity) | closed |
| 16 | TC2 | Shredded header order (strict pin-position order) | none | follow-up (needs per-package pin maps) |
| 17 | TC2 | Degree-1 net VCC5 railed | single_pin_net | closed |
| 18 | TC2 | Degree-1 net VCC5 railed | single_pin_net (RAIL-POLICY stays silent — VCC5 is a genuine MCU 5V supply, not a signal net) | closed |
| 19 | TC2 | No level shifting into RC522 | voltage_domain_overdrive | closed |
| 20 | TC2 | No local decoupling | missing_supply_decoupling | closed |
| 21 | TC1 | No local decoupling | missing_supply_decoupling | closed |
| 22 | TC3 | Same-net hole collisions | physicalChecks OCCUPANCY | closed |
| 23 | TC3 | Part pins on opposite board edges | physicalChecks GEOMETRY | closed |
| 24 | TC3 | L298N not breadboard-pluggable / wrong ESP32 footprint | ESP32/module off-board placement | closed |
| 25 | TC3 | Ground return path length / rail continuity | physicalChecks SEAM | closed |
| 26 | TC3 | Current-path length (deferred with tiling) | none | out of scope (placement-quality, revisit) |
| 27 | TC4 | Title promises parts the netlist lacks | dropped-part confession | closed |
| 28 | TC4 | Orphan buck subcircuit | orphan_supply | closed |
| 29 | TC4 | LM2596-4.0 not a real part | buck_unreal_part_number | closed |
| 30 | TC4 | Stretched electrolytic lead span | physicalChecks LEAD-SPAN | closed |
| 31 | TC5 | Wrong DIP supply pins (destroys chip) | LM358 DIP-8 pinout fix | closed |
| 32 | TC5 | Floating second section (warning) | LM358 DIP-8 pinout fix | closed |
| 33 | TC6 | Femtovolt divider built without comment | resistor_extreme_value | closed |
| 34 | TC7 | 5V TX into Pi GPIO | voltage_domain_overdrive | closed |
| 35 | TC7 | 5V pull-up into Pi GPIO domain | pullup_exceeds_domain | closed |
| 36 | TC7 | GPIO9 isn't UART | reviewer checklist | reviewer-checklist (model-quality-bound) |
| 37 | TC8 | Prompt injection — recorded only as "failed" | none | deferred by user decision |
| 38 | — | Rules exist but don't gate the live pipeline | pipeline gate | closed |
| 39 | — | Token exhaustion with thinking enabled | token budget | closed |
