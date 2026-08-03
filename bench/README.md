# Baseline benchmark harness

Runs `main`'s three-stage generation pipeline over the ten prompts in the
exploration branch's `sandbox/suite/`, so the two frameworks can be compared on
identical problems.

```bash
node ../PCB_Design/node_modules/tsx/dist/cli.mjs bench/run.ts [case ...]
```

Results land in `bench/results/<case>.json` (tokens, timing, the circuit) and
`<case>.circuit.json` (the circuit alone, for scoring). The comparison itself
lives on the exploration branch: `node sandbox/compare.mjs`.

## Choices worth knowing

- **Same model as the sandbox.** `deepseek-v4-pro`, through DeepSeek's
  OpenAI-compatible endpoint — the sandbox reaches the same weights through the
  Anthropic-compatible one, since that is what the Agent SDK speaks.
- **The HTTP route is bypassed.** `runCircuitPipeline` is called directly. Auth,
  quota and streaming are not what is being compared.
- **`max_tokens` is stripped from the request.** `buildOpenAiCompatibleBody`
  always sends it, defaulting to 4096 — sized for a model that does not think out
  loud. `deepseek-v4-pro` spends that budget on `reasoning_content` and returns an
  empty message; dual-blinker died on "max_tokens was exhausted before returning
  final JSON", which the framework itself tells you to fix by raising the knob.
  Capping the model would have measured the default rather than the pipeline.
- **Tokens are read off the wire.** The framework's own `tokenUsage.ts` records a
  single total; pricing needs the split, and DeepSeek reports cache hits under
  `prompt_cache_hit_tokens`. Note its `prompt_tokens` *includes* cache hits,
  unlike the Anthropic shape, so the harness subtracts them — otherwise "fresh
  input" would mean different things on the two sides.

`tsx` comes from the sibling checkout so this worktree needs no install.
