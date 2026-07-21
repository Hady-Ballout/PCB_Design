// Billing route handlers. Checkout and the Customer Portal are Stripe-hosted
// pages — the backend only mints session URLs. Plan state is written
// exclusively by the webhook: returning from a success URL proves nothing,
// the signed event does.
import type Stripe from 'stripe';
import type { AuthResult, JwtPayload } from '../types.js';
import {
  PLAN_LIMITS,
  isBillingEnabled,
  normalizePlan,
  priceIdFor,
  resolvePlanFromPriceId,
  type BillingInterval,
  type PlanId,
} from './plans.js';
import { findUserIdByCustomer, getBillingUser, setPlan, setStripeCustomer } from './store.js';
import { getStripe, verifyStripeWebhook } from './stripeClient.js';

const DISABLED: AuthResult = { status: 503, body: { code: 'billing_disabled', error: 'Billing is not configured.' } };

function appUrl(): string {
  return (process.env.APP_URL || 'http://127.0.0.1:5174').replace(/\/$/, '');
}

async function ensureStripeCustomer(user: JwtPayload, stripe: Stripe): Promise<string> {
  const billing = await getBillingUser(user.id);
  if (billing?.stripeCustomerId) return billing.stripeCustomerId;
  const customer = await stripe.customers.create({
    email: user.email,
    metadata: { impedo_user_id: String(user.id) },
  });
  await setStripeCustomer(user.id, customer.id);
  return customer.id;
}

export async function handleCreateCheckout(
  user: JwtPayload,
  body: Record<string, unknown>,
  stripeOverride?: Stripe
): Promise<AuthResult> {
  const stripe = stripeOverride ?? getStripe();
  if (!stripe || !isBillingEnabled()) return DISABLED;

  const plan = body.plan as PlanId;
  const interval = body.interval as BillingInterval;
  if (plan !== 'pro' && plan !== 'team') return { status: 400, body: { error: 'Plan must be "pro" or "team".' } };
  if (interval !== 'month' && interval !== 'year') return { status: 400, body: { error: 'Interval must be "month" or "year".' } };

  const price = priceIdFor(plan, interval);
  if (!price) return { status: 503, body: { code: 'billing_disabled', error: `No Stripe price configured for ${plan}/${interval}.` } };

  try {
    const customer = await ensureStripeCustomer(user, stripe);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer,
      client_reference_id: String(user.id),
      line_items: [{ price, quantity: 1 }],
      success_url: `${appUrl()}/#billing=success`,
      cancel_url: `${appUrl()}/#billing=cancel`,
      allow_promotion_codes: true,
    });
    return { status: 200, body: { url: session.url } };
  } catch (error) {
    console.error(`[billing-checkout] ${(error as Error).message}`);
    return { status: 502, body: { error: 'Could not start checkout. Please try again.' } };
  }
}

export async function handleCreatePortal(user: JwtPayload, stripeOverride?: Stripe): Promise<AuthResult> {
  const stripe = stripeOverride ?? getStripe();
  if (!stripe) return DISABLED;

  const billing = await getBillingUser(user.id);
  if (!billing?.stripeCustomerId) {
    return { status: 400, body: { code: 'no_customer', error: 'No subscription to manage yet.' } };
  }
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: billing.stripeCustomerId,
      return_url: appUrl(),
    });
    return { status: 200, body: { url: session.url } };
  } catch (error) {
    console.error(`[billing-portal] ${(error as Error).message}`);
    return { status: 502, body: { error: 'Could not open the billing portal. Please try again.' } };
  }
}

export async function handleBillingStatus(user: JwtPayload): Promise<AuthResult> {
  const billing = await getBillingUser(user.id);
  const plan = billing?.plan ?? 'free';
  return {
    status: 200,
    body: {
      plan,
      planStatus: billing?.planStatus ?? null,
      periodEnd: billing?.planPeriodEnd ?? null,
      usage: {
        generations: billing?.usageGenerations ?? 0,
        assists: billing?.usageAssists ?? 0,
      },
      limits: PLAN_LIMITS[plan],
    },
  };
}

// ── Webhook ──

// Statuses that keep paid access. `past_due` stays paid while Stripe's
// dunning retries run; a terminal status downgrades to free.
const TERMINAL_STATUSES = new Set(['canceled', 'incomplete_expired', 'unpaid']);

function periodEndIso(subscription: Stripe.Subscription): string | null {
  const end = subscription.items?.data?.[0]?.current_period_end;
  return end ? new Date(end * 1000).toISOString() : null;
}

function planFromSubscription(subscription: Stripe.Subscription): PlanId {
  if (TERMINAL_STATUSES.has(subscription.status)) return 'free';
  return normalizePlan(resolvePlanFromPriceId(subscription.items?.data?.[0]?.price?.id));
}

export async function applyStripeEvent(event: Stripe.Event, stripe: Stripe): Promise<void> {
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = Number(session.client_reference_id);
    const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    if (!userId || !subscriptionId) return;
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    await setPlan(userId, {
      plan: planFromSubscription(subscription),
      status: subscription.status,
      periodEnd: periodEndIso(subscription),
      customerId: customerId || undefined,
    });
    return;
  }

  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object as Stripe.Subscription;
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
    if (!customerId) return;
    const userId = await findUserIdByCustomer(customerId);
    if (!userId) {
      console.warn(`[billing-webhook] No user for Stripe customer ${customerId}; ignoring ${event.type}.`);
      return;
    }
    const plan = event.type === 'customer.subscription.deleted' ? 'free' : planFromSubscription(subscription);
    await setPlan(userId, {
      plan,
      status: subscription.status,
      periodEnd: plan === 'free' ? null : periodEndIso(subscription),
    });
  }
  // Every other event type is acknowledged and ignored.
}

export async function handleStripeWebhook(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  stripeOverride?: Stripe
): Promise<AuthResult> {
  const stripe = stripeOverride ?? getStripe();
  if (!stripe) return DISABLED;

  let event: Stripe.Event;
  try {
    event = verifyStripeWebhook(rawBody, signatureHeader || '');
  } catch (error) {
    console.error(`[billing-webhook] Signature verification failed: ${(error as Error).message}`);
    return { status: 400, body: { error: 'Invalid webhook signature.' } };
  }

  try {
    await applyStripeEvent(event, stripe);
  } catch (error) {
    // A processing bug should not make Stripe retry forever with a signature
    // that already verified; log loudly and acknowledge.
    console.error(`[billing-webhook] Failed to apply ${event.type}: ${(error as Error).message}`);
  }
  return { status: 200, body: { received: true } };
}
