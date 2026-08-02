// Per-user daily token allowance for the AI routes. Unlike the monthly plan
// quotas (quota.ts), this cap is ALWAYS on — it does not depend on Stripe being
// configured — because its job is to bound provider cost/abuse for every
// logged-in user, including on the free, no-billing deployment.
//
// The counter lives on the users row (usage_tokens + usage_day) and resets
// lazily when the stored UTC day differs from today, so no cron is needed.
// Tokens are the counts Z.ai reports (see server/ai/tokenUsage.ts); providers
// that report nothing (local Ollama) simply never advance the meter.
import { getBillingUser, setDailyTokens } from './store.js';

export const DEFAULT_DAILY_TOKEN_LIMIT = 100000;

export function dailyTokenLimit(): number {
  const value = Number(process.env.DAILY_TOKEN_LIMIT);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_DAILY_TOKEN_LIMIT;
}

// UTC calendar day, e.g. "2026-07-30". The window resets at 00:00 UTC.
export function currentDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// ISO timestamp of the next 00:00 UTC — when today's allowance resets.
export function nextDailyResetAt(now = new Date()): string {
  return new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0
  )).toISOString();
}

export interface DailyTokenStatus {
  used: number;
  limit: number;
  remaining: number;
  percentUsed: number; // 0–100, clamped
  resetsAt: string;    // ISO 00:00 UTC
}

// Read-only snapshot of the caller's daily allowance for the usage meter. Never
// throws for a missing user — reports a fresh (zero-used) window instead.
export async function getDailyTokenStatus(userId: number, now = new Date()): Promise<DailyTokenStatus> {
  const limit = dailyTokenLimit();
  const user = await getBillingUser(userId);
  const used = user && user.usageDay === currentDay(now) ? Math.max(0, user.usageTokens) : 0;
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    percentUsed: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0,
    resetsAt: nextDailyResetAt(now),
  };
}

export class DailyTokenLimitError extends Error {
  constructor(public limit: number, public usage: number) {
    super(`Daily token limit reached (${usage}/${limit}).`);
  }
}

// The message shown to the user when they hit the cap.
export function dailyLimitMessage(limit: number): string {
  return `You've reached today's ${limit.toLocaleString('en-US')}-token limit. `
    + `It resets at 00:00 UTC — please try again tomorrow.`;
}

// Throws DailyTokenLimitError when the user has already spent their allowance
// today. Call BEFORE starting AI work. A store miss never blocks: auth already
// vouched for the user.
export async function enforceDailyTokenLimit(userId: number): Promise<void> {
  const limit = dailyTokenLimit();
  const user = await getBillingUser(userId);
  if (!user) return;
  const used = user.usageDay === currentDay() ? user.usageTokens : 0;
  if (used >= limit) throw new DailyTokenLimitError(limit, used);
}

// Adds the tokens a completed request consumed to today's counter, resetting
// first when the stored day has rolled over. Call AFTER the AI work returns.
export async function recordDailyTokens(userId: number, tokens: number): Promise<void> {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  const user = await getBillingUser(userId);
  if (!user) return;
  const day = currentDay();
  const used = user.usageDay === day ? user.usageTokens : 0;
  await setDailyTokens(userId, { tokens: used + tokens, day });
}
