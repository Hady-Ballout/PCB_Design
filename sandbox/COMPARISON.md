# Sandbox vs. the tool-calling pipeline on `main`

The same ten prompts, the same model, the same scoring, run twice: once through
this branch's sandbox, once through `main`'s three-stage generation pipeline.

- **Sandbox** — an agent with a shell, a snapshot of the engine, `verify.mjs` and
  `solve.mjs`. It can run the engine and iterate until the gates pass.
- **Baseline** — `main`'s `runCircuitPipeline`: generate → topology gate → review
  → reply, with one correction retry. No filesystem, no ability to execute
  anything, no way to check its own arithmetic.

Reproduce with `node sandbox/compare.mjs` and `node sandbox/accuracy.mjs --table`;
the baseline harness is `bench/run.ts` on `bilal-main-baseline`.

## Headline

| | Sandbox | Baseline |
|---|---|---|
| Passed | **10/10** | **7/10** |
| Cost per board | $0.0242 | **$0.0079** |
| Cost per *working* board | $0.0242 | **$0.0112** |
| Mean design error | **0.33%** | 3.26% |
| Wall time | 21 min | 25 min |
| Provider calls | 86 | 35 |
| Fresh input / cache / output | 398k / 2.94M / 69k | 16.6k / 173k / 81k |

**The baseline is 3x cheaper per board and the sandbox is 10x more accurate.**
That is the whole trade, and which side wins depends entirely on what a wrong
board costs you.

## Per case

| Case | Sandbox | cost | Baseline | cost | Baseline failed on |
|---|---|---|---|---|---|
| blink-1hz | PASS | $0.0247 | PASS | $0.0047 | |
| buck-supply | PASS | $0.0229 | PASS | $0.0103 | |
| button-mcu | PASS | $0.0313 | PASS | $0.0064 | |
| dual-blinker | PASS | $0.0225 | PASS | $0.0084 | |
| i2c-sensor | PASS | $0.0209 | PASS | $0.0053 | |
| led-bar | PASS | $0.0223 | **FAIL** | $0.0105 | six LED cathodes floating |
| motor-driver | PASS | $0.0230 | **FAIL** | $0.0084 | gate control net floating |
| opamp-preamp | PASS | $0.0250 | **FAIL** | $0.0093 | input floating, no bias network |
| rc-filter | PASS | $0.0214 | PASS | $0.0043 | |
| temp-logger | PASS | $0.0278 | PASS | $0.0112 | |

## Judging the three failures

Read individually, not classified by string match.

**led-bar — component library, not framework.** The pipeline tried
`kind: "header"`, the validator rejected it, and after its one correction retry
the six LED cathodes had nowhere to terminate. `main` has no `pin_header`, so
there was no correct answer available to it.

**motor-driver — component library.** The power stage is *right*: motor from VCC
to the drain, MOSFET drain/gate/source, flyback diode anode on the drain and
cathode on VCC, a gate series resistor and a gate pulldown. Both combination
rules the case exists to test are satisfied. The only defect is `CTRL` dangling,
because the prompt puts the control signal on a pin header and that kind does not
exist here. Give it the connector and this board passes.

**opamp-preamp — half library, half real.** The gain network is fine (9.1k/1k =
10.1, 1% off). But this is a single-supply build — `V-` on ground, 9 V rail — with
`IN+` connected straight to a floating input net and no bias network at all. Even
with a screw terminal fitted, an AC input around ground would clip against the
negative rail. The sandbox's answer added a 100k/100k divider to mid-rail, which
the prompt never asked for and the gates never demanded.

So: **two of the three failures are a missing component kind, not a worse
framework.** Corrected for that, the baseline is roughly 9/10 on manufacturability
— it is a competent generator. The interesting differences are elsewhere.

## Where the sandbox is actually better

**Numeric accuracy.** Nothing in either system simulates anything, so this is
purely whether values were searched or guessed.

| Case | Target | Sandbox | err | Baseline | err |
|---|---|---|---|---|---|
| blink-1hz | 1 s | 0.9993 s | **0.07%** | 0.9494 s | 5.06% |
| dual-blinker A | 2 s | 1.989 s | **0.55%** | 2.079 s | 3.95% |
| dual-blinker B | 2.5 s | 2.488 s | 0.49% | 2.495 s | **0.21%** |
| rc-filter | 1 kHz | 994.7 Hz | **0.53%** | 1061 Hz | 6.10% |
| opamp-preamp | gain 10 | 10.000 | **0.00%** | 10.1 | 1.00% |

The baseline wins one of five, so this is a tendency rather than a law — but its
worst cases are 5–6% out while the sandbox never exceeds 0.55%. That gap is
`solve.mjs` searching the E24 grid against an equation instead of a model
recalling a plausible-looking pair.

**Documented landmines.** `CLAUDE.md` records that the regulator value parser
reads a part number as a voltage. On temp-logger the sandbox wrote
`value: "3.3V"`; the baseline wrote `value: "AMS1117-3.3"`, which the engine reads
as **1117 volts** in both the SPICE deck and the topology rules. It passed anyway
— the false `pullup_exceeds_domain` needs conditions this board did not meet — so
this is a latent wrongness that the gates did not catch and would have shipped.
The sandbox avoided it by reading the defect table, not by being smarter.

**Completeness.** Asked for an RC filter "fed from a 5 V supply", the baseline
returned two components — a resistor and a capacitor with a floating input, no
source. The sandbox returned a source, two terminal blocks, R and C. The
baseline's answer is a fragment of a schematic; the sandbox's is a board.

## Where the baseline is better

**Cost, decisively.** $0.0079 against $0.0242 per board — and per *working* board
still $0.0112 against $0.0242. Three focused calls beat a 7–11 request agent loop
carrying a 28k-token system prompt.

**Token shape.** The baseline sends 16.6k fresh input across all ten boards; the
sandbox sends 398k. Almost all of the sandbox's prompt is cache reads (2.94M, at
1/120th the price), which is what keeps the gap at 3x instead of 20x.

**Simplicity of failure.** When the baseline fails it fails immediately and
cheaply. The sandbox spends its budget discovering it was wrong, which is the
thing you are paying for.

## What this measured, and what it did not

Fairness controls: same ten prompts from the same `suite/*.json`; same model
(`deepseek-v4-pro`, reached through DeepSeek's Anthropic endpoint for the SDK and
its OpenAI-compatible one for the baseline); same scoring through this branch's
`verify.mjs` with each case's own assertions; same prices from `pricing.json`
applied to each harness's recorded tokens. The baseline was called at
`runCircuitPipeline` directly, bypassing auth, quota and streaming, which are not
what is being compared.

Two asymmetries could not be removed and are corrected for above rather than
hidden:

1. `main` lacks `pin_header`, `terminal_block` and `barrel_jack`, and six prompts
   ask for a connector.
2. The baseline's `max_tokens` default of 4096 is sized for a model that does not
   think out loud. `deepseek-v4-pro` spent that budget on reasoning and returned
   an empty message, killing dual-blinker outright. The field is removed in the
   harness so the model runs to its own limit; scoring the pipeline on a default
   it warns you about would have measured the default.

Not measured: whether either board *works*. Nothing simulates. The accuracy table
above is arithmetic re-derived from the produced JSON, which is as close as
either side gets to a functional check.

## The conclusion I would act on

For anything where a wrong board is cheap to discover — a draft, an exploration,
a schematic you are going to review anyway — the baseline is the better buy at a
third of the price.

For anything heading toward fabrication, the sandbox's premium is small in
absolute terms (**two cents**) against a board that is 10x closer to its target
values, complete rather than fragmentary, and steered around a known parser
defect. A single respin costs more than a thousand sandbox runs.

The deeper point is that the two systems fail differently. The baseline cannot
check its own work, so its errors are silent and arrive as a clean-looking JSON
object. The sandbox runs the engine, so its errors mostly turn into more turns.
That is what the extra 1.7 cents buys.
