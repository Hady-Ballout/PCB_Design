// Monthly usage metering for the AI routes. Counters live on the users row
// and reset lazily when the stored month differs from the current one, so no
// cron is needed. Over-limit calls throw QuotaError, which the router turns
// into HTTP 402 {code: 'quota_exceeded'}.
import { PLAN_LIMITS, isBillingEnabled, type Meter, type PlanId } from './plans.js';
import { getBillingUser, setUsage } from './store.js';

export class QuotaError extends Error {
  constructor(
    public plan: PlanId,
    public meter: Meter,
    public limit: number,
    public usage: number
  ) {
    super(`Monthly ${meter} quota reached (${usage}/${limit} on the ${plan} plan).`);
  }
}

export function currentMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function checkAndConsumeQuota(userId: number, meter: Meter): Promise<void> {
  // Without Stripe configured (local dev) there is nothing to sell, so
  // nothing to meter.
  if (!isBillingEnabled()) return;

  const user = await getBillingUser(userId);
  if (!user) return; // Auth already vouched for the user; don't block on a store miss.

  const month = currentMonth();
  const fresh = user.usageMonth === month;
  let generations = fresh ? user.usageGenerations : 0;
  let assists = fresh ? user.usageAssists : 0;

  const limits = PLAN_LIMITS[user.plan];
  const limit = meter === 'generation' ? limits.generations : limits.assists;
  const usage = meter === 'generation' ? generations : assists;

  if (limit === null && meter === 'assist') return; // Unmetered: skip the write entirely.
  if (limit !== null && usage >= limit) throw new QuotaError(user.plan, meter, limit, usage);

  if (meter === 'generation') generations += 1;
  else assists += 1;
  await setUsage(userId, { generations, assists, month });
}
