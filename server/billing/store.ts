// Typed access to the billing columns on `users`. Every SQL string here has a
// matching branch in the in-memory dev store (server/auth/db.ts), so the same
// code paths work with and without DATABASE_URL.
import { query } from '../auth/db.js';
import { normalizePlan, type PlanId } from './plans.js';

export interface BillingUser {
  id: number;
  plan: PlanId;
  planStatus: string | null;
  planPeriodEnd: string | null;
  stripeCustomerId: string | null;
  usageGenerations: number;
  usageAssists: number;
  usageMonth: string | null;
}

interface BillingRow {
  id: number;
  plan: string | null;
  plan_status: string | null;
  plan_period_end: string | Date | null;
  stripe_customer_id: string | null;
  usage_generations: number | null;
  usage_assists: number | null;
  usage_month: string | null;
}

export async function getBillingUser(id: number): Promise<BillingUser | null> {
  const result = await query(
    'SELECT id, plan, plan_status, plan_period_end, stripe_customer_id, usage_generations, usage_assists, usage_month FROM users WHERE id = $1',
    [id]
  );
  const row = result.rows[0] as BillingRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    plan: normalizePlan(row.plan),
    planStatus: row.plan_status ?? null,
    // pg returns TIMESTAMPTZ as Date; the local store keeps ISO strings.
    planPeriodEnd: row.plan_period_end instanceof Date
      ? row.plan_period_end.toISOString()
      : row.plan_period_end ?? null,
    stripeCustomerId: row.stripe_customer_id ?? null,
    usageGenerations: Number(row.usage_generations ?? 0),
    usageAssists: Number(row.usage_assists ?? 0),
    usageMonth: row.usage_month ?? null,
  };
}

export async function findUserIdByCustomer(customerId: string): Promise<number | null> {
  const result = await query('SELECT id FROM users WHERE stripe_customer_id = $1', [customerId]);
  const row = result.rows[0] as { id: number } | undefined;
  return row ? row.id : null;
}

export async function setStripeCustomer(id: number, customerId: string): Promise<void> {
  await query('UPDATE users SET stripe_customer_id = $2 WHERE id = $1', [id, customerId]);
}

export async function setPlan(
  id: number,
  update: { plan: PlanId; status: string | null; periodEnd: string | null; customerId?: string }
): Promise<void> {
  if (update.customerId) {
    await query(
      'UPDATE users SET plan = $2, plan_status = $3, plan_period_end = $4, stripe_customer_id = $5 WHERE id = $1',
      [id, update.plan, update.status, update.periodEnd, update.customerId]
    );
    return;
  }
  await query(
    'UPDATE users SET plan = $2, plan_status = $3, plan_period_end = $4 WHERE id = $1',
    [id, update.plan, update.status, update.periodEnd]
  );
}

export async function setUsage(
  id: number,
  usage: { generations: number; assists: number; month: string }
): Promise<void> {
  await query(
    'UPDATE users SET usage_generations = $2, usage_assists = $3, usage_month = $4 WHERE id = $1',
    [id, usage.generations, usage.assists, usage.month]
  );
}
