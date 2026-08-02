Task 1: complete (uncommitted working-tree changes: componentKinds.js, simValues.js+test, pcbGenerator.js+test, RealisticSchematic.jsx DEFAULT_VALUE; review clean, no commits by user mandate)
Task 2: complete (simNetlist.js buck case, simEngine.js event filter + headroom dropout, tests; review clean)
  Minor (for final review triage): kitchen-sink fixture special case simEngine.test.js ~1015 (groundPin = kind==='buck_converter' ? 2 : 1) — generalize if more switcher kinds are added
Task 3: complete (topologyRules.js supplyNets + led_polarity rectifier-scoped exemption + 4 buck rules, 94/94; one Important fixed in round 1, re-review Approved)
Task 4: complete (To220Body N-pin generalization, INLINE_BODY_BY_KIND, thumbnail; review Approved, 3-pin arithmetic verified)
  Minor (final review triage): parts.render.test.jsx ~191 test name overstates (checks body string, not geometry); thumbnail viewBox asymmetric 17/19px vs regulator 17/17
Task 5: complete (blockSymbols case, KIND_LABELS/MULTI_PIN_LABELS, 11/11 tests; review Approved)
Task 6: complete (SYSTEM_PROMPT rule, pcb-circuit-expert.md recipe/table/footprint, 49/49 tests; review Approved)
Task 7: complete (AI_AND_CIRCUIT_MODEL.md 68-kind roster + sim row + rules bullet, FRONTEND.md one line; caught pre-existing 66-vs-67 count bug; review Approved)
Task 8: complete (final review: Ready to hand back, Yes; 671/672 full suite, 1 pre-existing failure; docs parity note added post-review; user committed slices 1-3 themselves in 5404ed6, slices 4-7 remain uncommitted)

---
## Impedo Reliability Plan — started 2026-07-27, base 2d644d9, commits on main
Source: "Test Cases/Impedo_Reliability_Plan.md" + deltas in ~/.claude/plans/ignore-tc8-we-will-eventual-backus.md (approved). TC8 deferred by user.
Task 1: complete (2d644d9..a22b1c9, review Approved)
  Minor (final review triage): breadboardDescription.js findings guard — `checkCircuitTopology(circuit).violations ?? []` so a violations-less return cannot throw outside the try
  Minor: crash-comment duplicated (block + catch); no test covers `fix:` sub-line / auto-fixed tag branches
Task 2: complete (a22b1c9..7d69763, review Approved, no findings)
Task 4: complete (11d3d3c..97fd2b0, review Approved, no findings)
Task 5: complete (97fd2b0..c803071, review Approved, no findings)
Task 6: complete (c803071..8886b0e, review Approved; two Minors judged not-worth-fixing: orphan VCC5 in silent fixture, RPU1 named via refs not message)
Task 7: complete (8886b0e..89148e6, review Approved; Minor note: future source-only one-pin nets will warn by design)
Task 8: complete (89148e6..e2561f9, review Approved; Minor note: ~4 loadless buck fixtures co-fire orphan_supply — breaks only if a future toEqual([]) assertion lands on one)
Task 9: complete (e2561f9..a0fe885, review Approved; Minor latent: MCU with only a supply-strapped GPIO would warn — future refinement, no current kind/fixture hits it)
Task 10: complete (a0fe885..2c7b155, review Approved; Minor plan-mandated: E24 nearest-value scan is within-decade only — mantissa >9.55 mis-names 9.1 instead of 10; fire/no-fire unaffected)
Task 11: complete (2c7b155..ea9f74a, review Approved; noted future-work: buckVolts defaults bare/ADJ values to 5V so LM2596-ADJ passes silently — belongs to a future FB-net rule, not this one)
Task 12: complete (ea9f74a..7bdd432, review Approved, no findings; PHASE 2 COMPLETE — all 9 rules live + documented)
Task 13: complete (7bdd432..ce0e1f7, review Approved, no findings; GROUND const is Task 15 scaffolding)
Task 14: complete (ce0e1f7..642499a, review Approved; Minor: RED evidence was disable-the-call, not test-first — acknowledged, tests confirmed non-vacuous by trace)
Task 15: complete (642499a..f0c7762, review Approved, no findings; unknown-role rail nets fail closed by design)
Task 16: complete (f0c7762..e1d996e, review Approved; brief prose/code seam-count discrepancy resolved in favor of code, documented; Minor: "4 full-size boards" wording imprecise for 190 cols — plan-inherited)
Task 17: complete (e1d996e..812f32a, review Approved; PHASE 3 COMPLETE — physical checks live in every model; zero fixture fallout; Minor: new SEAM test fixture duplicates the neighboring big fixture verbatim)
Task 18: complete (812f32a..849de62, review Approved on opus, no findings; pin mapping verified physically correct incl. top-strip direction)
Task 19: complete (849de62..bff4c70, review Approved on opus; PHASE 4 COMPLETE; Minor: VCC3 rail assertion couples to esp32 3V3-only supply pin — note for final pass)
Task 20: complete (bff4c70..0e23513 + fix 5877f84, one Important found+fixed+re-review Approved: confession append moved post-reviewer with regression test)
  Minor (final triage): slice(0,4) caps harvested dropped kinds at 4; docs phrasing says "at validation time" vs post-reviewer append
Task 21: complete (5877f84..6b3cc9e, review Approved; Minor cosmetic: OPERATIONS.md dense table row)
Task 22: complete (6b3cc9e..89e7250, review Approved; 39-row ledger verified faithful; ALL 22 TASKS DONE)
Full suite at 89e7250: 812/813 pass; only red = pre-existing pcbGenerator.test.js:479 (documented). Final whole-branch review dispatched.
Final review: round 1 = With fixes (2 Important: inert RAIL-POLICY, structural-retry throw); fix wave 169708d+b6b4a6f; round 2 = READY TO HAND BACK: YES
  Deferred (new): supplyNets omits battery minus net + regulator/buck outputs (warning-severity FP, no current trigger); catch also swallows HTTP retry errors when candidate exists (consistent with never-fail, comment someday)
  Deferred (carried): pullup divider FP watch, SEAM+grown-past dup, silent auto-fix confession asymmetry, 12 triage-DEFER rows
Live smoke (TC2 RC522 re-run, direct-wire+D10): PASS — report shows DESIGN RULE FINDINGS with [error] voltage_domain_overdrive (D12->MISO) + i2c_missing_pullups warning; both modules labeled [off-board module — flying leads]; gate retry demonstrably improved output (1k/2k dividers generated on RST/SS/MOSI/SCK). Residuals observed live: MISO flag is the known direction-blind FP (deferred watch-item); RC522 3V3 SUPPLY pin wired to VCC5 goes unflagged (SUPPLY_PIN_NAMES exemption — candidate future supply-domain rule). CAMPAIGN FIX PHASE COMPLETE.

---
## Manufacturable PCB Pipeline — started 2026-08-01, base e3c71e6, branch feat/pcb-fab-pipeline (off feat/hosted-mcp-connector)
Plan: ~/.claude/plans/instead-of-the-schematic-glistening-goose.md (approved). Phases A-F.
Task A: complete (e3c71e6..e12d224, 5 commits; review round 1 found Critical cap-polarity inversion + Important exact-match polarity bypass — fixed 7079dbc; round 2 found electrolytic exact-match gap — fixed e12d224; round 3 Approved)
  Minor (final review triage): isElectrolytic regex needs explicit uF suffix — bare numeric values (treated as µF by simValues.js convention) fall through to non-polar C_Disc
  Minor: synthesizedHeaderRecord libId 'Synthesized:kind_N' is not a lookup key — wants a one-line comment
Task B: complete (e12d224..aa13584, commits 4504dfc placement + aa13584 pad-shape rotation fix; review Approved; fix re-review Approved)
  Carried into Task D brief: pcbScene.js ignores component.rotation in THREE branches (axial ~101-127, TO-220 ~176-180, module headers ~211-226) — user-visible 3D regression until D lands
  Minor (final review triage): courtyard stays footprint-local while width/height are rotated extents (naming trap); expanded-lattice gap can theoretically lose 0.01mm to 2dp rounding; layout.components now in placement order (changes MCP artifact row order, rotation not in layout.ts summary); FALLBACK_PAD lookup duplicated in pcbPlace.js
Task C: complete (aa13584..1422846; commits 11dfece/863d7da/6b780b4 router+DRC+orchestrator, 1121497 fix wave 1 (C1 rect circumscribing radius + I1 DRC-first ranking + I2 escape sag + I3 perf assert), 1422846 fix wave 2 (N1 shape-exact containment, two-tier clearance); round 3 Approved)
  Queued as Task C2 (#7): TO-92 neck-down ladder + stadium/rect obstacle model + minTraceWidth + annular inscribed measure @0.13 rule + unknown-shape fallback hardening
  Minor (final review triage): M1 blockingNets O(closed×copper) hoist; M2 escape/terminal cells bypass EDGE_OWNER (unreachable at margin 4); M3 violation comparator lacks total-order tail; M4 3D viewer doesn't surface routing/drc status (Phase D adds warning line); pcbPlace angle double-count documented+locked (no downstream reader); pcbDrc.js:239 'inscribed' computed-unused until C2
Task C2: complete (1422846..647f441; 17edca9 annular inscribed@0.13, f665bf2 stadium/rect stamping + generalised sag lemma, 75c5304 neck-down ladder + minTraceWidth floor + M1/M2, 647f441 fix wave (per-rung terminal admission + source gating); review round 2 Approved. BJT/TO-92 circuits now route DRC-clean)
  Minor (final review triage): N1 comment over-claim pcbRoute.js:85/:662 + docs/FRONTEND.md:15 (per-rung proof covers foreign pads only; segments/vias held by fullHalf escape disk); terminal-vs-terminal escape-disk hole (pre-existing, fails loud via DRC, ~0.05mm window at 1-grid-step adjacency); new regression test's A* cost margin ~4.5 units (re-verify RED if VIA_COST/BEND_COST move); fixture brittleness: TO-92 middle-pin corridor 0.3025 vs 0.3 rule
Task D: complete (647f441..c06c324; ec806eb writer+MCP format+Board view+3D rotation fixes, c06c324 fix wave (Critical absolute pad angle + snapshot guard + 3 minors); review round 2 Approved. kicadAngle=(360-rot)%360 verified against vendored KiCanvas parser both directions)
  Minor (final review triage): warning line renders in 3D mode too (flagged as intent deviation, arguably better); axial color-band order reversed for rotated parts (cosmetic); manual KiCanvas render verify + real-KiCad open still pending (phase-end verify step)
Task E: complete (c06c324..3f9c855; 51e57fc zipStore, faf7072 shared record helper, b33ee60 gerberExport, 2339f6f MCP gerber+binary artifacts, 3f9c855 UI+docs; review Approved, no Critical/Important. Y-flip + drill registration proven with exact-coordinate cross-file tests; in-passing fix: warning line gained connectivity)
  Minors 1-4 folded into Task F brief (G36 first-object aperture, README polarity wording, NaN swallow in fmt, empty tooltip); Minor (final triage): silk placement has no clamp invariant (measured safe today); paintPad assumes axis-aligned pads (true today, wants assert/comment)
  Human pre-order checklist (from review, keep for docs/PR): open all files in gerbv/GerbView — silk not mirrored, drills centred both layers, mask on pads not vias, profile bounds copper, vendor accepts .GKO profile name + empty .GBO, METRIC,TZ read as mm
Task F: complete (3f9c855..8df4b0e, 5 commits; pour as disjoint-rectangle decomposition (marching-squares deviation accepted — union semantics would flood keep-outs), edge rule corrected to edgeClearance+cellReach, connect_pads yes, docs sweep, CI oracle, 4 fold-in Minors; review Approved, no Critical/Important. Pour excluded from connectivity BY DESIGN (fail-safe); additiveness proven via pre-feature snapshots)
  Minor (final review triage): human() lacks non-finite guard (README NaN); RawLayout interface missing pour field; edge test uses half-diagonal where half-side suffices (conservative); token aperture defined-but-unused CAM warning; pour-touches-ground-pad asserted only on hand-built fixture
ALL 7 IMPLEMENTATION TASKS DONE. Full suite at 8df4b0e: 1188/1189, only pre-existing pcbGenerator MCU failure. Final whole-branch review next.
Final whole-branch review (fable, e3c71e6..8df4b0e): With fixes — 2 NEW Criticals (unwired footprint pads never emitted: DIP-8 boards get 5/8 holes, physically unbuildable while gate says fabricable; optocoupler padOrder ['1','2','3','4'] = single DIP-8 column) + 1 Important (App.jsx eager buildPcbLayout on main thread every generation) + fold-ins (RawLayout pour field, slug unification, PinHeader<=9 guard). All ~25 ledger Minors triaged: none block; fp_text rotation cosmetic + DIP-4 silhouette deferred. Fix wave dispatched.
Browser verify (live LM358 LDR circuit): Board view KiCanvas parse+paint zero errors incl. 111-polygon pour; gate enabled with tooltip; 3D ok. NOTE: pre-fix board shows the missing-holes Critical (XU1 5 pads) — re-verify after fix wave.
Final-review fix wave: complete (8df4b0e..9ea2319; b822b1b emit-all-footprint-pads via NC_<ref>_<pad> nets (zero changes needed downstream — existing #nc: machinery), 081bc3c optocoupler ['1','2','7','8'] straddle + pinHeader guard, 9ea2319 lazy layout memo + slug + pour field; re-review verdict: READY TO HAND BACK — YES)
Live re-verify post-fix: XU1 8 pads (5 netted), +3 drills, gate still passes, KiCanvas renders clean.
Remaining HUMAN pre-order action: gerbv/real-KiCad open + JLC upload dry-run on a post-fix DIP-8 board (earlier manual checks predate the geometry fix).
PIPELINE COMPLETE at 9ea2319. Full suite 1193/1194 (pre-existing failure only).
