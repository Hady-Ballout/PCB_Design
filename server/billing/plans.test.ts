import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PLAN_LIMITS,
  isBillingEnabled,
  normalizePlan,
  priceIdFor,
  resolvePlanFromPriceId,
} from './plans.js';

const PRICE_ENV = {
  STRIPE_PRICE_PRO_MONTHLY: 'price_pro_m',
  STRIPE_PRICE_PRO_YEARLY: 'price_pro_y',
  STRIPE_PRICE_TEAM_MONTHLY: 'price_team_m',
  STRIPE_PRICE_TEAM_YEARLY: 'price_team_y',
};

beforeEach(() => {
  Object.assign(process.env, PRICE_ENV);
});

afterEach(() => {
  for (const key of Object.keys(PRICE_ENV)) delete process.env[key];
  delete process.env.STRIPE_SECRET_KEY;
});

describe('PLAN_LIMITS', () => {
  it('matches the spec tiers (null = unlimited)', () => {
    expect(PLAN_LIMITS.free).toEqual({ generations: 5, assists: 20 });
    expect(PLAN_LIMITS.pro).toEqual({ generations: 200, assists: null });
    expect(PLAN_LIMITS.team).toEqual({ generations: null, assists: null });
  });
});

describe('priceIdFor', () => {
  it('reads the four price IDs from env', () => {
    expect(priceIdFor('pro', 'month')).toBe('price_pro_m');
    expect(priceIdFor('pro', 'year')).toBe('price_pro_y');
    expect(priceIdFor('team', 'month')).toBe('price_team_m');
    expect(priceIdFor('team', 'year')).toBe('price_team_y');
  });

  it('returns an empty string when the price is not configured', () => {
    delete process.env.STRIPE_PRICE_TEAM_YEARLY;
    expect(priceIdFor('team', 'year')).toBe('');
  });
});

describe('resolvePlanFromPriceId', () => {
  it('maps each configured price ID back to its plan', () => {
    expect(resolvePlanFromPriceId('price_pro_m')).toBe('pro');
    expect(resolvePlanFromPriceId('price_pro_y')).toBe('pro');
    expect(resolvePlanFromPriceId('price_team_m')).toBe('team');
    expect(resolvePlanFromPriceId('price_team_y')).toBe('team');
  });

  it('returns null for unknown or missing price IDs', () => {
    expect(resolvePlanFromPriceId('price_someone_elses')).toBeNull();
    expect(resolvePlanFromPriceId(undefined)).toBeNull();
    expect(resolvePlanFromPriceId('')).toBeNull();
  });
});

describe('normalizePlan', () => {
  it('accepts known plans and falls back to free', () => {
    expect(normalizePlan('pro')).toBe('pro');
    expect(normalizePlan('team')).toBe('team');
    expect(normalizePlan('free')).toBe('free');
    expect(normalizePlan('enterprise')).toBe('free');
    expect(normalizePlan(null)).toBe('free');
  });
});

describe('isBillingEnabled', () => {
  it('is keyed on STRIPE_SECRET_KEY', () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect(isBillingEnabled()).toBe(false);
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    expect(isBillingEnabled()).toBe(true);
  });
});
