# The sandbox

An LLM builds circuit JSON in a disposable workspace, verifies it by running the
real engine, and hands it back for review.

```bash
node sandbox/cli.mjs new "blink an LED once per second from a 9 V battery"
node sandbox/cli.mjs say <id> "make it 5 seconds and add a power LED"
node sandbox/cli.mjs done <id>
```

## Why a sandbox rather than a tool-calling agent

`CLAUDE.md` is the procedure, and three of its nine steps say some version of
*write a script and run it* — search the E24 grid, verify by running the engine,
assert the pin assignment yourself. An agent with a fixed menu of domain tools
cannot do any of that; it can only call what someone anticipated. An agent with
a directory, a real engine and a shell can.

That is the entire design. The engine is dependency-free, so a workspace is a
directory of files and `node` — no install, no build, no service.

## What a run looks like

```
sandbox/runs/2026-08-03-a1b2/
  CLAUDE.md            the procedure, copied verbatim
  WORKSPACE.md         the addendum: where to write, which tools exist
  knowledge/           components, patterns, prompts     (read-only)
  src/core/            the engine, snapshotted           (read-only)
  verify.mjs           the five verdicts + pin table
  solve.mjs            E24 component-value search
  circuit.json         the agent writes this
  report.md            the agent writes this
  session.json         status, model session id, cost
  trace.jsonl          every tool call and permission decision
```

Snapshotting rather than pointing at the repo means the agent cannot edit the
engine it is judged by, and a finished run is a self-contained reproduction.

## The prompt is CLAUDE.md, unmodified

`CLAUDE.md` is passed verbatim as the system prompt, with `WORKSPACE.md`
appended. The split is deliberate: `CLAUDE.md` is the portable domain knowledge
and must stay free of repo and environment specifics, so every host that runs it
supplies its own addendum describing where files go and what tools exist. If the
domain prompt needs a change, that is a finding from an eval run — not a
setup step.

Nothing from the host machine reaches the agent (`settingSources: []`): no user
`CLAUDE.md`, no project settings, no skills.

## verify.mjs — the reason this works

```bash
node verify.mjs circuit.json
node verify.mjs circuit.json --assert 'U1.TRIG == U1.THRES'
node verify.mjs circuit.json --json          # for the eval harness
```

It prints the five verdicts, the board's size and trace/via counts, the
**pin-assignment table**, and any structural findings. Exit 0 means everything
passed.

The `--assert` flag exists because of a measured fact. Take
`local/blinker-1hz.json` and swap TRIG with CTRL on the 555. Every net keeps the
same pin count, so nothing dangles, and:

```
validate     ok    0 errors, 0 warnings
topology     ok    0 violations
routing      ok    complete
drc          ok    0 violations
connectivity ok    ok
```

All five gates clean, on a board that cannot blink. Nothing in the engine knows
what you meant. An assertion is the only place intent gets checked — which is
why eval cases are mostly assertions, and why `WORKSPACE.md` tells the agent to
write the ones that would have caught its own topology being wrong.

One thing `verify.mjs` deliberately does *not* do is re-check node counts. A
`timer_555` with three nodes does pass `validateCircuit` with no errors, but the
topology gate catches it as `fixed_pin_node_count` — and that rule already
handles the awkward cases, since connectors are variable by design and MCU nodes
get padded. A duplicate check here failed three circuits that were already
verified clean, which is the argument against duplicating a rule: you end up
maintaining its exceptions twice.

## Permissions

The agent runs with `permissionMode: 'default'` and a `canUseTool` guard bound
to the workspace. It denies paths outside the run directory, writes to the
seeded material, and Bash commands that install, reach the network, use git, or
touch `.env`.

**Do not pass bare tool names as `allowedTools`.** A bare entry auto-approves
the tool *before* `canUseTool` runs, and the guard becomes dead code while still
looking wired up. This happened during development: the guard's unit tests all
passed while a live agent read `../../.env.deepseek` without producing a single
permission event. `sandbox.test.js` now asserts `allowedTools` stays empty.

## Review, not auto-close

A run reaching PASS moves to `awaiting-review`, never to `done`. A board that
verifies clean can still be the wrong board, so closing it is the user's call.
`say` resumes the same model session, so a follow-up keeps the context that
produced the first answer rather than rebuilding it from the JSON.

`session.json` plus the workspace is also the memory snapshot a future
resume-after-done would restore — nothing extra needs capturing.

## Eval

```bash
node sandbox/eval.mjs                 # whole suite
node sandbox/eval.mjs blink-1hz       # one case
node sandbox/eval.mjs --parallel 3 --keep
```

Ten cases live in `suite/*.json` as a prompt plus assertions, chosen to cover
distinct failure modes rather than distinct circuits — the 555 pattern, repeated
blocks with per-stage nets, the `buck_converter` pin contract, combination rules
(`missing_flyback_diode`, `pushbutton_no_pull`, `i2c_missing_pullups`), a gain
equation, SMD repetition, and one four-subsystem board.

Reports land in `results/` (git-ignored, one per run). The committed record is
[BENCHMARK.md](BENCHMARK.md), generated from the run directories themselves:

```bash
node sandbox/eval.mjs --parallel 3 --keep
node sandbox/benchmark.mjs > sandbox/BENCHMARK.md
```

Failed workspaces are kept regardless of `--keep` — a failure you cannot open is
a failure you cannot diagnose.

Assertions select by kind and position (`timer_555[0].TRIG`) rather than by ref,
because refs are the agent's choice: asserting `U1.TRIG` really asserts that the
model happened to name its timer `U1`.

## What a board costs

```bash
node sandbox/cli.mjs cost            # every run, against board size
node sandbox/cli.mjs cost <id>       # where one run's tokens went
node sandbox/cli.mjs cost <id> --requests
```

### Why we price it ourselves

The SDK does report cost — `total_cost_usd` on the result, and `costUSD` per
model. **We do not use those numbers**, for one measured reason: on this endpoint
they are wrong by 20×.

The SDK prices every model from its own internal rate table. For
`deepseek-v4-pro[1m]` that table charges $5/$25 per Mtok. DeepSeek's published
rate is $0.435/$0.87. Same tokens, same run:

| | fresh input | cache read | output | cost |
|---|---|---|---|---|
| SDK's rates | 36,126 | 240,512 | 4,266 | **$0.4127** |
| DeepSeek's real rates | 36,126 | 240,512 | 4,266 | **$0.0204** |

The token counts are ground truth and come straight from the SDK. Only the
multiplication differs, and `sandbox/cost.mjs` reproduces the SDK's figure
*exactly* when fed its rate table — which is what proves the gap is pricing and
not an accounting bug. There is a test pinning that.

So: tokens are stored, money never is. Correcting `pricing.json` reprices every
past run instead of stranding a pile of figures computed under rates you no
longer believe.

### Where the tokens go

Measured, one 8-component board from scratch, 25 API requests:

```
fresh input      36,126     ← the bill lives here
cache read      240,512     ← 87% of the prompt, at 1/120th the price
output            4,266
```

Two things follow. **Cache reads dominate the token count and barely touch the
bill** — 91% of prompt tokens are cache hits, and at $0.003625/Mtok those 240k
tokens cost a fifth of a cent. And the fixed overhead is large: the system prompt
(CLAUDE.md + WORKSPACE.md + tool definitions) is ~28k tokens, so the *first*
request of a run costs more than most of what follows. A follow-up turn measured
3,194 fresh input against the first turn's 36,126, because the context is
already cached.

**Board size barely moves the bill.** Measured:

| Board | Parts | Requests | Cost |
|---|---|---|---|
| RC low-pass filter | 5 | 9 | $0.0248 |
| 555 blinker | 8 | 22 | $0.0244 |

The smaller board cost slightly *more*. What varies is reading the knowledge base
and iterating, not component count — so `$/component` is a much weaker predictor
than it looks, and the honest planning figure is **≈$0.02–0.03 per board**
whatever is on it. Expect that to hold until a board is large enough to need
substantially more design turns.

A note on request counting: one API response arrives as several assistant
messages, one per content block, each repeating the same usage. Raw, a run
reported 40 requests where there were 9. `session.mjs` deduplicates on the API
message id — worth knowing if you compare against an older `session.json`, since
runs recorded before that fix carry the inflated count.

### Estimates on other providers

Same measured token profile, current published rates (August 2026). Providers
that bill cache writes are charged for 40k of them — our DeepSeek endpoint
reports zero cache-creation tokens, so that column is an assumption, not a
measurement.

| Model | 1 board | 100 boards | 1000 boards |
|---|---|---|---|
| DeepSeek V4 Flash | $0.0069 | $0.69 | $7 |
| DeepSeek V4 Pro **(current)** | $0.0203 | $2.03 | $20 |
| GPT-5.6 Luna | $0.0272 | $2.72 | $27 |
| Claude Haiku 4.5 | $0.1315 | $13.15 | $132 |
| Gemini 3.1 Pro | $0.1973 | $19.73 | $197 |
| Claude Sonnet 5 (intro rate) | $0.2630 | $26.30 | $263 |
| GPT-5.6 Terra | $0.2715 | $27.15 | $272 |
| Claude Sonnet 4.6 | $0.3945 | $39.45 | $395 |
| Claude Opus 4.8 | $0.6575 | $65.75 | $658 |
| GPT-5.6 Sol | $0.6789 | $67.89 | $679 |

Read these as an order of magnitude, not a quote. Three caveats that matter:

1. **A cheaper model is not cheaper per board if it fails more.** A model that
   needs two attempts at $0.02 beats one that succeeds once at $0.03 — and a
   model that produces a board which verifies clean but does not oscillate costs
   whatever the respin costs. That is what `eval.mjs` measures and this table
   cannot.
2. **Only Claude models run natively through the Agent SDK.** GPT and Gemini
   figures assume a proxy translating the Anthropic API, which is how DeepSeek
   is wired here — the token profile would shift with a different tokenizer.
3. Batch APIs (50% off on Anthropic) do not apply: this is an interactive agent
   loop, not a batch job.

## Configuration

Credentials come from one env file (git-ignored) named by `SANDBOX_ENV_FILE` —
the default is `.env.deepseek`; this repo's current setup is `.env.glm` (GLM
5.2 through Z.ai's Anthropic-compatible endpoint, see `.env.example`).
`ANTHROPIC_MODEL` in that file selects the model. When the file does not exist
the process environment is used as-is, which is how production supplies the
`ANTHROPIC_*` variables.

## Moving execution off this machine

Three seams, one file each:

| Seam | Local | Remote |
|------|-------|--------|
| `workspace.mjs` | `fs` under `sandbox/runs/` | S3 / EFS / container volume |
| `exec.mjs` | `child_process` | `docker run` in a Fargate task |
| `session.mjs` store | `session.json` | Postgres — `pg` and `server/auth/db.ts` exist |

`say()` is an async generator of normalized events (`init`, `text`, `tool`,
`permission`, `result`, `verify`), which an SSE route can forward as-is.

One honest constraint: the Agent SDK spawns the `claude` binary as a subprocess
and needs a writable filesystem for the length of a run. Vercel serverless
functions give neither reliably. The realistic targets are Fargate, Fly, or a
long-lived worker, with Vercel serving the UI and holding the queue.

`SANDBOX_EXEC_MODE=docker` throws rather than falling back to the host — a
container mode that silently runs locally would be worse than none, because the
isolation would be assumed and absent.

## Tests

`sandbox/sandbox.test.js` runs in the normal suite and needs no model: the
permission guard, the workspace boundary, engine self-sufficiency, and the cases
where `verify.mjs` catches what the engine misses.
