import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDb } from '../auth/db.js';
import { getBillingUser, setPlan, setStripeCustomer, setUsage } from './store.js';
import {
  applyStripeEvent,
  handleBillingStatus,
  handleCreateCheckout,
  handleCreatePortal,
  handleStripeWebhook,
} from './billing.js';

const USER = { id: 1, email: 'admin@local.test' };
const WEBHOOK_SECRET = 'whsec_test_secret';

const ENV = {
  STRIPE_SECRET_KEY: 'sk_test_billing',
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_PRO_MONTHLY: 'price_pro_m',
  STRIPE_PRICE_PRO_YEARLY: 'price_pro_y',
  STRIPE_PRICE_TEAM_MONTHLY: 'price_team_m',
  STRIPE_PRICE_TEAM_YEARLY: 'price_team_y',
  APP_URL: 'https://impedo.ai',
};

beforeEach(async () => {
  delete process.env.DATABASE_URL;
  Object.assign(process.env, ENV);
  await initDb();
});

afterEach(() => {
  for (const key of Object.keys(ENV)) delete process.env[key];
});

// A fake of the tiny Stripe surface the handlers use.
function fakeStripe(overrides: Record<string, unknown> = {}) {
  const calls: Record<string, unknown[]> = { checkout: [], portal: [], customers: [] };
  return {
    calls,
    customers: {
      create: async (params: unknown) => {
        calls.customers.push(params);
        return { id: 'cus_new' };
      },
    },
    checkout: {
      sessions: {
        create: async (params: unknown) => {
          calls.checkout.push(params);
          return { id: 'cs_1', url: 'https://checkout.stripe.com/pay/cs_1' };
        },
      },
    },
    billingPortal: {
      sessions: {
        create: async (params: unknown) => {
          calls.portal.push(params);
          return { url: 'https://billing.stripe.com/session/xyz' };
        },
      },
    },
    subscriptions: {
      retrieve: async () => ({
        id: 'sub_1',
        status: 'active',
        customer: 'cus_new',
        items: { data: [{ price: { id: 'price_pro_m' }, current_period_end: 1758412800 }] },
      }),
    },
    ...overrides,
  };
}

function signedPayload(event: Record<string, unknown>, secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const body = Buffer.from(JSON.stringify(event));
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return { body, header: `t=${timestamp},v1=${signature}` };
}

describe('handleCreateCheckout', () => {
  it('rejects unknown plans and intervals', async () => {
    expect((await handleCreateCheckout(USER, { plan: 'gold', interval: 'month' }, fakeStripe() as never)).status).toBe(400);
    expect((await handleCreateCheckout(USER, { plan: 'pro', interval: 'weekly' }, fakeStripe() as never)).status).toBe(400);
  });

  it('returns 503 when billing is disabled', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const result = await handleCreateCheckout(USER, { plan: 'pro', interval: 'month' });
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('billing_disabled');
  });

  it('creates a customer once and a subscription checkout session', async () => {
    const stripe = fakeStripe();
    const result = await handleCreateCheckout(USER, { plan: 'pro', interval: 'month' }, stripe as never);
    expect(result.status).toBe(200);
    expect(result.body.url).toBe('https://checkout.stripe.com/pay/cs_1');
    expect((await getBillingUser(1))?.stripeCustomerId).toBe('cus_new');

    const session = stripe.calls.checkout[0] as Record<string, unknown>;
    expect(session.mode).toBe('subscription');
    expect(session.customer).toBe('cus_new');
    expect(session.client_reference_id).toBe('1');
    expect(session.line_items).toEqual([{ price: 'price_pro_m', quantity: 1 }]);
    expect(session.success_url).toBe('https://impedo.ai/#billing=success');
    expect(session.cancel_url).toBe('https://impedo.ai/#billing=cancel');

    // Second checkout reuses the stored customer.
    await handleCreateCheckout(USER, { plan: 'team', interval: 'year' }, stripe as never);
    expect(stripe.calls.customers.length).toBe(1);
    expect((stripe.calls.checkout[1] as Record<string, unknown>).line_items).toEqual([{ price: 'price_team_y', quantity: 1 }]);
  });
});

describe('handleCreatePortal', () => {
  it('requires an existing Stripe customer', async () => {
    const result = await handleCreatePortal(USER, fakeStripe() as never);
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('no_customer');
  });

  it('returns a portal URL for a known customer', async () => {
    await setStripeCustomer(1, 'cus_known');
    const stripe = fakeStripe();
    const result = await handleCreatePortal(USER, stripe as never);
    expect(result.status).toBe(200);
    expect(result.body.url).toBe('https://billing.stripe.com/session/xyz');
    expect((stripe.calls.portal[0] as Record<string, unknown>).customer).toBe('cus_known');
  });
});

describe('handleBillingStatus', () => {
  it('reports plan, usage, and limits', async () => {
    await setPlan(1, { plan: 'pro', status: 'active', periodEnd: '2026-08-21T00:00:00.000Z' });
    await setUsage(1, { generations: 42, assists: 3, month: '2026-07' });
    const result = await handleBillingStatus(USER);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      plan: 'pro',
      planStatus: 'active',
      periodEnd: '2026-08-21T00:00:00.000Z',
      usage: { generations: 42, assists: 3 },
      limits: { generations: 200, assists: null },
    });
  });
});

describe('handleStripeWebhook', () => {
  it('rejects a bad signature with 400', async () => {
    const { body } = signedPayload({ type: 'noop', data: { object: {} } }, 'whsec_wrong');
    const forged = signedPayload({ type: 'noop', data: { object: {} } }, 'whsec_wrong');
    const result = await handleStripeWebhook(body, forged.header, fakeStripe() as never);
    expect(result.status).toBe(400);
  });

  it('accepts a correctly signed event', async () => {
    const { body, header } = signedPayload({ id: 'evt_1', type: 'unhandled.event', data: { object: {} } });
    const result = await handleStripeWebhook(body, header, fakeStripe() as never);
    expect(result.status).toBe(200);
  });
});

describe('applyStripeEvent', () => {
  it('checkout.session.completed sets the plan from the subscription price', async () => {
    const event = {
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: '1', customer: 'cus_new', subscription: 'sub_1' } },
    };
    await applyStripeEvent(event as never, fakeStripe() as never);
    const user = await getBillingUser(1);
    expect(user?.plan).toBe('pro');
    expect(user?.planStatus).toBe('active');
    expect(user?.stripeCustomerId).toBe('cus_new');
    expect(user?.planPeriodEnd).toBe(new Date(1758412800 * 1000).toISOString());
  });

  it('customer.subscription.updated switches the plan for the matching customer', async () => {
    await setStripeCustomer(1, 'cus_abc');
    const event = {
      type: 'customer.subscription.updated',
      data: {
        object: {
          customer: 'cus_abc',
          status: 'active',
          items: { data: [{ price: { id: 'price_team_m' }, current_period_end: 1758412800 }] },
        },
      },
    };
    await applyStripeEvent(event as never, fakeStripe() as never);
    expect((await getBillingUser(1))?.plan).toBe('team');
  });

  it('a canceled-status update downgrades to free', async () => {
    await setStripeCustomer(1, 'cus_abc');
    await setPlan(1, { plan: 'pro', status: 'active', periodEnd: null });
    const event = {
      type: 'customer.subscription.updated',
      data: {
        object: {
          customer: 'cus_abc',
          status: 'canceled',
          items: { data: [{ price: { id: 'price_pro_m' }, current_period_end: 1758412800 }] },
        },
      },
    };
    await applyStripeEvent(event as never, fakeStripe() as never);
    const user = await getBillingUser(1);
    expect(user?.plan).toBe('free');
    expect(user?.planStatus).toBe('canceled');
  });

  it('customer.subscription.deleted downgrades to free and is idempotent', async () => {
    await setStripeCustomer(1, 'cus_abc');
    await setPlan(1, { plan: 'team', status: 'active', periodEnd: null });
    const event = {
      type: 'customer.subscription.deleted',
      data: { object: { customer: 'cus_abc', status: 'canceled' } },
    };
    await applyStripeEvent(event as never, fakeStripe() as never);
    await applyStripeEvent(event as never, fakeStripe() as never);
    const user = await getBillingUser(1);
    expect(user?.plan).toBe('free');
  });

  it('ignores events for unknown users without throwing', async () => {
    const event = {
      type: 'customer.subscription.deleted',
      data: { object: { customer: 'cus_stranger', status: 'canceled' } },
    };
    await expect(applyStripeEvent(event as never, fakeStripe() as never)).resolves.toBeUndefined();
  });
});
