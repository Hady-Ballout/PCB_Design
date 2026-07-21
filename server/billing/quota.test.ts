import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDb } from '../auth/db.js';
import { getBillingUser, setPlan, setUsage } from './store.js';
import { QuotaError, checkAndConsumeQuota, currentMonth } from './quota.js';

beforeEach(async () => {
  delete process.env.DATABASE_URL;
  process.env.STRIPE_SECRET_KEY = 'sk_test_quota';
  await initDb();
});

afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
});

describe('currentMonth', () => {
  it('formats as YYYY-MM in UTC', () => {
    expect(currentMonth(new Date('2026-07-21T23:59:00Z'))).toBe('2026-07');
    expect(currentMonth(new Date('2026-12-31T23:59:00Z'))).toBe('2026-12');
  });
});

describe('checkAndConsumeQuota', () => {
  it('lets a free user consume 5 generations then rejects the 6th with a QuotaError', async () => {
    for (let i = 0; i < 5; i += 1) await checkAndConsumeQuota(1, 'generation');
    expect((await getBillingUser(1))?.usageGenerations).toBe(5);

    const rejection = await checkAndConsumeQuota(1, 'generation').catch((error) => error);
    expect(rejection).toBeInstanceOf(QuotaError);
    expect(rejection.plan).toBe('free');
    expect(rejection.limit).toBe(5);
    expect(rejection.usage).toBe(5);
    expect((await getBillingUser(1))?.usageGenerations).toBe(5);
  });

  it('resets the counters when the stored month is stale', async () => {
    await setUsage(1, { generations: 5, assists: 20, month: '2026-06' });
    await checkAndConsumeQuota(1, 'generation');
    const user = await getBillingUser(1);
    expect(user?.usageGenerations).toBe(1);
    expect(user?.usageAssists).toBe(0);
    expect(user?.usageMonth).toBe(currentMonth());
  });

  it('enforces the shared assist meter at 20 for free users', async () => {
    await setUsage(1, { generations: 0, assists: 20, month: currentMonth() });
    await expect(checkAndConsumeQuota(1, 'assist')).rejects.toBeInstanceOf(QuotaError);
  });

  it('does not meter assists for paid plans', async () => {
    await setPlan(1, { plan: 'pro', status: 'active', periodEnd: null });
    await setUsage(1, { generations: 0, assists: 999, month: currentMonth() });
    await checkAndConsumeQuota(1, 'assist');
    expect((await getBillingUser(1))?.usageAssists).toBe(999);
  });

  it('never limits team generations but still counts them', async () => {
    await setPlan(1, { plan: 'team', status: 'active', periodEnd: null });
    await setUsage(1, { generations: 10000, assists: 0, month: currentMonth() });
    await checkAndConsumeQuota(1, 'generation');
    expect((await getBillingUser(1))?.usageGenerations).toBe(10001);
  });

  it('is a no-op when billing is disabled', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    await setUsage(1, { generations: 999, assists: 0, month: currentMonth() });
    await checkAndConsumeQuota(1, 'generation');
    expect((await getBillingUser(1))?.usageGenerations).toBe(999);
  });

  it('ignores unknown users (auth already gated them)', async () => {
    await expect(checkAndConsumeQuota(424242, 'generation')).resolves.toBeUndefined();
  });
});
