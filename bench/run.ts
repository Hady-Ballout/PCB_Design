// Benchmark harness for the tool-calling pipeline on main.
//
// Runs the same ten prompts the sandbox suite uses, through this branch's
// `runCircuitPipeline`, and records the same numbers: wall time, provider calls,
// and the token split needed to price a run. The HTTP route is bypassed on
// purpose — auth, quota and streaming are not what is being compared. This
// calls the generation pipeline directly, which is the fairest possible read of
// the framework itself.
//
//   node bench/run.ts [caseName ...]
//
// Results land in bench/results/<case>.json, scored separately by the
// exploration branch's verify.mjs so both sides face one scoring standard.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
// The suite lives in the other worktree — same JSON, so neither side can be
// accused of having been run on a different set of problems.
const suiteDir = resolve(root, '../PCB_Design/sandbox/suite');
const outDir = resolve(here, 'results');

// ------------------------------------------------------------------ env
// Same model the sandbox ran on, through DeepSeek's OpenAI-compatible endpoint
// rather than its Anthropic one. Everything else is this framework's default.
const dotenv = Object.fromEntries(
  readFileSync(resolve(root, '../PCB_Design/.env.deepseek'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }),
);

process.env.AI_PROVIDER = 'deepseek';
process.env.AI_API_URL = 'https://api.deepseek.com';
process.env.AI_MODEL = process.env.BENCH_MODEL || 'deepseek-v4-pro';
process.env.AI_API_KEY = dotenv.ANTHROPIC_AUTH_TOKEN;

// -------------------------------------------------------------- metering
// The framework's own tokenUsage.ts records a single total. Pricing needs the
// split, and DeepSeek reports cache hits under prompt_tokens_details, so wrap
// fetch and keep the whole usage object per call.
interface Call {
  input: number;
  output: number;
  cacheRead: number;
  status: number;
  ms: number;
}

const calls: Call[] = [];
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(typeof input === 'string' ? input : (input as Request).url ?? input);

  // Drop max_tokens so the model runs to its own limit.
  //
  // buildOpenAiCompatibleBody always sends it, defaulting to 4096 — a number
  // sized for a model that does not think out loud. deepseek-v4-pro spends that
  // budget on reasoning_content and returns an empty message: dual-blinker died
  // on "max_tokens was exhausted before returning final JSON", which the
  // framework itself tells you to fix by raising the knob. Capping the model
  // here would measure the default rather than the pipeline, so the field is
  // removed instead of re-tuned.
  let request = init;
  if (url.includes('/chat/completions') && init?.body) {
    try {
      const body = JSON.parse(String(init.body));
      delete body.max_tokens;
      request = { ...init, body: JSON.stringify(body) };
    } catch {
      // Leave the body untouched if it is not the JSON we expect.
    }
  }

  const started = Date.now();
  const response = await realFetch(input, request);
  if (!url.includes('/chat/completions')) return response;

  // Read the body through a clone so the pipeline still gets an unconsumed stream.
  const clone = response.clone();
  try {
    const data = await clone.json() as Record<string, any>;
    const usage = data?.usage ?? {};
    const cacheRead = Number(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0) || 0;
    calls.push({
      // DeepSeek's prompt_tokens INCLUDES cache hits, unlike the Anthropic
      // shape where they are reported separately. Subtract so "fresh input"
      // means the same thing on both sides of the comparison.
      input: Math.max(0, (Number(usage.prompt_tokens) || 0) - cacheRead),
      output: Number(usage.completion_tokens) || 0,
      cacheRead,
      status: response.status,
      ms: Date.now() - started,
    });
  } catch {
    calls.push({ input: 0, output: 0, cacheRead: 0, status: response.status, ms: Date.now() - started });
  }
  return response;
}) as typeof fetch;

// ------------------------------------------------------------------ run
const { runCircuitPipeline } = await import('../server/ai/circuitPipeline.ts');

const only = process.argv.slice(2);
const cases = readdirSync(suiteDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(resolve(suiteDir, name), 'utf8')))
  .filter((testCase) => !only.length || only.includes(testCase.name))
  .sort((a, b) => a.name.localeCompare(b.name));

mkdirSync(outDir, { recursive: true });

for (const testCase of cases) {
  calls.length = 0;
  const started = Date.now();
  let circuit: unknown = null;
  let error: string | null = null;

  try {
    const result = await runCircuitPipeline(testCase.prompt);
    circuit = result.circuit;
  } catch (caught) {
    error = (caught as Error).message;
  }

  const totals = calls.reduce((sum, call) => ({
    input: sum.input + call.input,
    output: sum.output + call.output,
    cacheRead: sum.cacheRead + call.cacheRead,
    cacheWrite: 0,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

  const record = {
    name: testCase.name,
    prompt: testCase.prompt,
    assertions: testCase.assertions ?? [],
    model: process.env.AI_MODEL,
    error,
    durationMs: Date.now() - started,
    requests: calls.length,
    usage: totals,
    calls,
    circuit,
  };
  writeFileSync(resolve(outDir, `${testCase.name}.json`), `${JSON.stringify(record, null, 2)}\n`);
  if (circuit) writeFileSync(resolve(outDir, `${testCase.name}.circuit.json`), `${JSON.stringify(circuit, null, 2)}\n`);

  const seconds = Math.round(record.durationMs / 1000);
  console.log(`${error ? 'ERROR' : 'built'}  ${testCase.name.padEnd(14)} `
    + `${String(calls.length).padStart(2)} req · ${seconds}s · `
    + `${totals.input} in / ${totals.cacheRead} cached / ${totals.output} out`
    + `${error ? `\n       ${error.slice(0, 160)}` : ''}`);
}
