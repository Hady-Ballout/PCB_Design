import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDb } from '../auth/db.js';
import { getBillingUser, setDailyTokens } from './store.js';
import {
  DEFAULT_DAILY_TOKEN_LIMIT,
  DailyTokenLimitError,
  currentDay,
  dailyTokenLimit,
  enforceDailyTokenLimit,
  getDailyTokenStatus,
  nextDailyResetAt,
  recordDailyTokens,
} from './dailyTokens.js';

beforeEach(async () => {
  delete process.env.DATABASE_URL;
  delete process.env.DAILY_TOKEN_LIMIT;
  delete process.env.STRIPE_SECRET_KEY; // the daily cap must work with billing OFF
  await initDb();
});

afterEach(() => {
  delete process.env.DAILY_TOKEN_LIMIT;
});

describe('currentDay', () => {
  it('formats as YYYY-MM-DD in UTC', () => {
    expect(currentDay(new Date('2026-07-30T23:59:00Z'))).toBe('2026-07-30');
    expect(currentDay(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01');
  });
});

describe('dailyTokenLimit', () => {
  it('defaults to 100000', () => {
    expect(dailyTokenLimit()).toBe(DEFAULT_DAILY_TOKEN_LIMIT);
    expect(DEFAULT_DAILY_TOKEN_LIMIT).toBe(100000);
  });

  it('reads a positive DAILY_TOKEN_LIMIT override', () => {
    process.env.DAILY_TOKEN_LIMIT = '12000';
    expect(dailyTokenLimit()).toBe(12000);
  });

  it('ignores non-positive / non-numeric overrides', () => {
    process.env.DAILY_TOKEN_LIMIT = '0';
    expect(dailyTokenLimit()).toBe(100000);
    process.env.DAILY_TOKEN_LIMIT = 'lots';
    expect(dailyTokenLimit()).toBe(100000);
  });
});

describe('recordDailyTokens + enforceDailyTokenLimit', () => {
  it('accumulates tokens across requests within the same day', async () => {
    await recordDailyTokens(1, 20000);
    await recordDailyTokens(1, 5000);
    const user = await getBillingUser(1);
    expect(user?.usageTokens).toBe(25000);
    expect(user?.usageDay).toBe(currentDay());
  });

  it('allows requests under the limit and blocks once the allowance is spent', async () => {
    await setDailyTokens(1, { tokens: 99999, day: currentDay() });
    await expect(enforceDailyTokenLimit(1)).resolves.toBeUndefined();

    await setDailyTokens(1, { tokens: 100000, day: currentDay() });
    const rejection = await enforceDailyTokenLimit(1).catch((error) => error);
    expect(rejection).toBeInstanceOf(DailyTokenLimitError);
    expect(rejection.limit).toBe(100000);
    expect(rejection.usage).toBe(100000);
  });

  it('resets the counter when the stored day is stale', async () => {
    await setDailyTokens(1, { tokens: 100000, day: '2000-01-01' });
    // A stale day means today starts fresh, so enforcement passes...
    await expect(enforceDailyTokenLimit(1)).resolves.toBeUndefined();
    // ...and a new charge starts from zero, not from yesterday's total.
    await recordDailyTokens(1, 300);
    const user = await getBillingUser(1);
    expect(user?.usageTokens).toBe(300);
    expect(user?.usageDay).toBe(currentDay());
  });

  it('is enforced even when billing is disabled (no STRIPE_SECRET_KEY)', async () => {
    expect(process.env.STRIPE_SECRET_KEY).toBeUndefined();
    await setDailyTokens(1, { tokens: 100000, day: currentDay() });
    await expect(enforceDailyTokenLimit(1)).rejects.toBeInstanceOf(DailyTokenLimitError);
  });

  it('respects a lowered DAILY_TOKEN_LIMIT override', async () => {
    process.env.DAILY_TOKEN_LIMIT = '1000';
    await setDailyTokens(1, { tokens: 1000, day: currentDay() });
    await expect(enforceDailyTokenLimit(1)).rejects.toBeInstanceOf(DailyTokenLimitError);
  });

  it('ignores zero/negative charges', async () => {
    await recordDailyTokens(1, 0);
    await recordDailyTokens(1, -5);
    expect((await getBillingUser(1))?.usageTokens).toBe(0);
  });

  it('ignores unknown users (auth already gated them)', async () => {
    await expect(enforceDailyTokenLimit(424242)).resolves.toBeUndefined();
    await expect(recordDailyTokens(424242, 100)).resolves.toBeUndefined();
  });
});

describe('nextDailyResetAt', () => {
  it('is the next 00:00 UTC', () => {
    expect(nextDailyResetAt(new Date('2026-07-30T14:22:00Z'))).toBe('2026-07-31T00:00:00.000Z');
    expect(nextDailyResetAt(new Date('2026-12-31T23:59:59Z'))).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('getDailyTokenStatus', () => {
  it('reports zero usage for a fresh user', async () => {
    const status = await getDailyTokenStatus(1, new Date('2026-07-30T10:00:00Z'));
    expect(status).toEqual({
      used: 0,
      limit: 100000,
      remaining: 100000,
      percentUsed: 0,
      resetsAt: '2026-07-31T00:00:00.000Z',
    });
  });

  it('reflects today\'s spend as a rounded percentage', async () => {
    await setDailyTokens(1, { tokens: 25000, day: currentDay() });
    const status = await getDailyTokenStatus(1);
    expect(status.used).toBe(25000);
    expect(status.remaining).toBe(75000);
    expect(status.percentUsed).toBe(25);
  });

  it('treats a stale day as zero used', async () => {
    await setDailyTokens(1, { tokens: 100000, day: '2000-01-01' });
    const status = await getDailyTokenStatus(1);
    expect(status.used).toBe(0);
    expect(status.percentUsed).toBe(0);
  });

  it('clamps the percentage to 100 on overshoot', async () => {
    await setDailyTokens(1, { tokens: 120000, day: currentDay() });
    const status = await getDailyTokenStatus(1);
    expect(status.used).toBe(120000);
    expect(status.remaining).toBe(0);
    expect(status.percentUsed).toBe(100);
  });
});
