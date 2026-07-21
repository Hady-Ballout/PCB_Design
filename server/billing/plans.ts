// Tier definitions and Stripe price-ID mapping. Amounts live in Stripe;
// code only ever references prices through the four STRIPE_PRICE_* env vars,
// so pricing can be retuned in the dashboard without a deploy.

export type PlanId = 'free' | 'pro' | 'team';
export type BillingInterval = 'month' | 'year';
export type Meter = 'generation' | 'assist';

export interface PlanLimits {
  // null = unlimited.
  generations: number | null;
  assists: number | null;
}

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: { generations: 5, assists: 20 },
  pro: { generations: 200, assists: null },
  team: { generations: null, assists: null },
};

const PRICE_ENV_KEYS: Record<Exclude<PlanId, 'free'>, Record<BillingInterval, string>> = {
  pro: { month: 'STRIPE_PRICE_PRO_MONTHLY', year: 'STRIPE_PRICE_PRO_YEARLY' },
  team: { month: 'STRIPE_PRICE_TEAM_MONTHLY', year: 'STRIPE_PRICE_TEAM_YEARLY' },
};

// Env is read at call time (not module load) so tests and late-loaded
// .env.local both work.
export function priceIdFor(plan: Exclude<PlanId, 'free'>, interval: BillingInterval): string {
  return process.env[PRICE_ENV_KEYS[plan][interval]] || '';
}

export function resolvePlanFromPriceId(priceId: string | undefined): PlanId | null {
  if (!priceId) return null;
  for (const plan of Object.keys(PRICE_ENV_KEYS) as Array<Exclude<PlanId, 'free'>>) {
    for (const interval of ['month', 'year'] as BillingInterval[]) {
      const configured = priceIdFor(plan, interval);
      if (configured && configured === priceId) return plan;
    }
  }
  return null;
}

export function normalizePlan(value: unknown): PlanId {
  return value === 'pro' || value === 'team' ? value : 'free';
}

export function isBillingEnabled(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}
