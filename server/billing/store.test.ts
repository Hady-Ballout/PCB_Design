import { beforeEach, describe, expect, it } from 'vitest';
import { initDb } from '../auth/db.js';
import {
  findUserIdByCustomer,
  getBillingUser,
  setPlan,
  setStripeCustomer,
  setUsage,
} from './store.js';

// All tests run against the in-memory dev store (no DATABASE_URL); the seeded
// local admin has id 1.
beforeEach(async () => {
  delete process.env.DATABASE_URL;
  await initDb();
});

describe('getBillingUser', () => {
  it('returns free-plan defaults for a fresh user', async () => {
    const user = await getBillingUser(1);
    expect(user).toEqual({
      id: 1,
      plan: 'free',
      planStatus: null,
      planPeriodEnd: null,
      stripeCustomerId: null,
      usageGenerations: 0,
      usageAssists: 0,
      usageMonth: null,
      usageTokens: 0,
      usageDay: null,
    });
  });

  it('returns null for an unknown user', async () => {
    expect(await getBillingUser(999)).toBeNull();
  });
});

describe('setStripeCustomer / findUserIdByCustomer', () => {
  it('stores and finds the customer mapping', async () => {
    await setStripeCustomer(1, 'cus_123');
    expect((await getBillingUser(1))?.stripeCustomerId).toBe('cus_123');
    expect(await findUserIdByCustomer('cus_123')).toBe(1);
    expect(await findUserIdByCustomer('cus_missing')).toBeNull();
  });
});

describe('setPlan', () => {
  it('updates plan, status, and period end', async () => {
    await setPlan(1, { plan: 'pro', status: 'active', periodEnd: '2026-08-21T00:00:00.000Z' });
    const user = await getBillingUser(1);
    expect(user?.plan).toBe('pro');
    expect(user?.planStatus).toBe('active');
    expect(user?.planPeriodEnd).toBe('2026-08-21T00:00:00.000Z');
  });

  it('optionally stores the customer id in the same write', async () => {
    await setPlan(1, { plan: 'team', status: 'active', periodEnd: null, customerId: 'cus_777' });
    const user = await getBillingUser(1);
    expect(user?.plan).toBe('team');
    expect(user?.stripeCustomerId).toBe('cus_777');
  });
});

describe('setUsage', () => {
  it('round-trips the usage counters and month', async () => {
    await setUsage(1, { generations: 3, assists: 7, month: '2026-07' });
    const user = await getBillingUser(1);
    expect(user?.usageGenerations).toBe(3);
    expect(user?.usageAssists).toBe(7);
    expect(user?.usageMonth).toBe('2026-07');
  });
});
