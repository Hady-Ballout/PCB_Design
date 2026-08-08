# 20-case extension suite: sandbox vs. main's pipeline, on GLM 5.2

Twenty prompts that do not overlap the original ten, run through both systems
with the same model and scored by the same standard (this branch's `verify.mjs`
with each case's own assertions). Suite files: `sandbox/suite/` (the 20 named
below); harnesses: `sandbox/eval.mjs` here, `bench/run.ts` on the
`bilal-main-baseline` worktree; accuracy: `sandbox/accuracy20.mjs`.

**Model note.** The original comparison ran deepseek-v4-pro. That key is not on
this machine, so both sides ran **glm-5.2** (Z.ai): the sandbox through the
Anthropic-compatible endpoint (`open.bigmodel.cn/api/anthropic`), the baseline
through the OpenAI-compatible one with `AI_PROVIDER=zai`, thinking enabled —
the same provider config the app itself ships in `.env.local`. Same weights on
both sides, so the comparison is internally fair; the absolute numbers are not
comparable to the DeepSeek run.

**Coverage caveat.** The Z.ai account ran out of balance (error 1113) near the
end. The baseline completed all 20 (4 transient `fetch failed` cases were
retried and built). The sandbox completed 17: `seven-seg-counter` was killed
mid-iteration at 29 turns, and `ultrasonic-alarm` / `zener-clamp` never got a
working turn. Those three are excluded from head-to-head rows and marked
pending; finishing them costs roughly a dollar of credit after a top-up.

## Headline — the 17 cases both sides completed

| | Sandbox | Baseline |
|---|---|---|
| Passed, strict verify | 16/17 | 15/17 |
| Passed, corrected¹ | **17/17** | 16/17 |
| Genuinely wrong boards shipped | **0** | 1 (astable-25khz) |
| Mean design error (numeric metrics)² | **0.37%** | 0.76% |
| Cost per board | $0.221 | **$0.023** |
| Typical wall time per board | 1–4 min | **20–75 s** |

¹ Both sides "fail" `inverting-amp-15` only on a verifier invariant that
requires any pin named `V-` to sit on net "0". Both boards are correct
dual-rail amplifiers (15k/1k around the inverting input, V− on the −9 V rail,
exactly as prompted). That is a verifier limitation — split supplies are legal —
so the corrected row counts both as passes.

² Excluding the `linear-reg-5v` landmine row, which measures something else
(below). Raw means including it: ~14182% both sides.

Baseline's two real failures, judged by reading, not string match:

- **astable-25khz** — component values are right (24.83 kHz, 0.48% off), but
  the requested `PWM_OUT` net connects only the 555's OUT pin. A one-pin net is
  a missing connection; main's own topology gate flags it and its single
  correction retry did not fix it. The sandbox terminated the same net
  properly because `verify.mjs` failed it until it did. This is the framework
  difference in miniature: same gate, but one system iterates against it.
- **zener-clamp** (sandbox untested — killed by balance) — the zener is
  backwards: anode on `PROTECTED_OUT`, cathode on ground. It forward-conducts
  at 0.7 V and the output can never reach 5.1 V. Values and the rest of the
  topology are right; the board is still wrong.

## Accuracy detail (numeric subset)

| case | metric | target | sandbox | err | baseline | err |
|---|---|---|---|---|---|---|
| astable-4hz | period | 0.25 s | 0.2488 | 0.49% | 0.2495 | **0.21%** |
| astable-25khz | frequency | 25 kHz | 25.05k | **0.21%** | 24.88k | 0.48% |
| monostable-3s | pulse | 3 s | 2.97 | 1.00% | 2.97 | 1.00% |
| rc-highpass-500hz | cutoff | 500 Hz | 498 | **0.40%** | 482.3 | 3.54% |
| inverting-amp-15 | gain | 15 | 15.000 | 0.00% | 15.000 | 0.00% |
| divider-9to3 | ratio | 0.3333 | 0.3333 | **0.00%** | 0.3358 | 0.74% |
| divider-9to3 | drain ≤ 1 mA | — | 0.30 mA | ok | 0.33 mA | ok |
| led-12ma | current | 12 mA | 12.2 mA | 1.63% | 12.2 mA | 1.63% |
| comparator-night-light | threshold | 0.5 Vcc | 0.500 | 0.00% | 0.500 | 0.00% |
| keypad-entry | distinct nets | 8 | 8 | 0.00% | 8 | 0.00% |

GLM 5.2 changes the accuracy story. On DeepSeek the baseline guessed values and
missed by 5–6%; on GLM it derives them and lands under 1% almost everywhere.
The sandbox's E24-search edge survives (0.37% vs 0.76% mean, and the baseline's
worst case is 3.54% vs the sandbox's 1.63%) but the 10x gap from the original
report is now about 2x.

**The landmine caught both sides.** On `linear-reg-5v`, both wrote the
regulator value as `7805` — which the engine's value parser reads as **7805
volts** in the SPICE deck and topology rules. `CLAUDE.md` documents exactly
this defect and the sandbox still wrote the part number. The knowledge-base
advantage that dodged this trap on DeepSeek (`temp-logger`, original run) did
not fire on GLM: documentation the model may or may not read is not a control.
If this defect matters, it belongs in `verify.mjs` as a check, not in prose.

## Reliability notes from the campaign

- Baseline: 4 of 20 first attempts died on transient `fetch failed`; all four
  built on retry. Cheap to retry (~$0.02).
- Sandbox: a mid-run provider failure costs the whole run (seven-seg-counter
  died at 29 turns / $0.47). Expensive to retry.
- The sandbox spent 35 turns and $0.55 on `inverting-amp-15` fighting the V−
  invariant — an unsatisfiable check for the prompted design. A wrong gate
  doesn't just misscore the sandbox, it burns its budget.

## Reading

For the goal stated for this run — output-circuit correctness above all — the
sandbox is still the stronger system: zero wrong boards on everything it
completed, and the one class of failure it does have (a gate that is itself
wrong) is fixable in the verifier. The baseline shipped one clearly broken
board and one subtly broken one out of 19 completed, at a tenth of the cost.

But GLM 5.2 narrowed the gap enough that the decision is closer than the
DeepSeek numbers suggested: corrected scores 17/17 vs 16/17, accuracy 0.37% vs
0.76%. What the 10x price still buys is the *shape* of failure: the pipeline's
errors ship silently as clean-looking JSON; the sandbox's errors become more
turns until the gates pass.

Two fixes are worth making before betting on either system:
1. Teach `verify.mjs` about split supplies (V− ≠ ground is legal when a
   negative rail exists) — it cost the sandbox $0.55 and a false FAIL here.
2. Move the documented engine landmines (regulator value parsing, above all)
   from `CLAUDE.md` prose into `verify.mjs` checks. Both systems shipped 7805 V
   this run.

Pending to complete the record: top up the Z.ai balance and run
`seven-seg-counter`, `ultrasonic-alarm`, `zener-clamp` through
`sandbox/eval.mjs` (≈ $1).
