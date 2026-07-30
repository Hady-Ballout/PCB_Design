// Request-scoped token accounting. A single AI request (e.g. a circuit
// generation) makes several provider calls across the pipeline; this collects
// the token usage each Z.ai / OpenAI-compatible response reports so the route
// can charge the total against the caller's daily allowance.
//
// AsyncLocalStorage keeps the running total isolated per in-flight request, so
// concurrent users never contaminate each other's counters — no parameter has
// to be threaded through every provider function.
import { AsyncLocalStorage } from 'node:async_hooks';

interface UsageBucket {
  tokens: number;
}

const storage = new AsyncLocalStorage<UsageBucket>();

// Runs `fn` inside a fresh accounting scope and returns its result alongside the
// total provider tokens recorded while it ran.
export async function trackTokenUsage<T>(fn: () => Promise<T>): Promise<{ result: T; tokens: number }> {
  const bucket: UsageBucket = { tokens: 0 };
  const result = await storage.run(bucket, fn);
  return { result, tokens: bucket.tokens };
}

// Reads an OpenAI-compatible `usage` object off a response body or a streamed
// chunk and adds its token count to the active scope. A no-op when there is no
// active scope (tests, unmetered callers) or when the payload carries no usage
// (most streamed deltas) — so it is always safe to call.
export function recordProviderUsage(payload: unknown): void {
  const bucket = storage.getStore();
  if (!bucket) return;
  const usage = (payload as { usage?: Record<string, unknown> } | null | undefined)?.usage;
  if (!usage || typeof usage !== 'object') return;

  const total = Number((usage as Record<string, unknown>).total_tokens);
  if (Number.isFinite(total) && total > 0) {
    bucket.tokens += total;
    return;
  }
  // Some gateways omit total_tokens; fall back to prompt + completion.
  const prompt = Number((usage as Record<string, unknown>).prompt_tokens) || 0;
  const completion = Number((usage as Record<string, unknown>).completion_tokens) || 0;
  if (prompt > 0 || completion > 0) bucket.tokens += prompt + completion;
}

// Test-only: read the current scope's running total.
export function currentTrackedTokens(): number {
  return storage.getStore()?.tokens ?? 0;
}
