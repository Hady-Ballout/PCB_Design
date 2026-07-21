// Lazy singleton around the official Stripe SDK. Returns null when
// STRIPE_SECRET_KEY is unset so billing degrades to a clean 503 in dev.
import Stripe from 'stripe';

let stripe: Stripe | undefined;
let stripeKey: string | undefined;

export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!stripe || stripeKey !== key) {
    stripe = new Stripe(key);
    stripeKey = key;
  }
  return stripe;
}

// Throws (via the SDK) on a bad signature, a stale timestamp, or a missing
// secret — the webhook route maps any throw to HTTP 400.
export function verifyStripeWebhook(rawBody: Buffer, signatureHeader: string): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not set.');
  return Stripe.webhooks.constructEvent(rawBody, signatureHeader, secret);
}
