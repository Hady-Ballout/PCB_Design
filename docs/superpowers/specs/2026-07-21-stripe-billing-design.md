# Stripe Billing for impedo.ai — Design

**Date:** 2026-07-21
**Status:** Approved (Option A: hosted Stripe Checkout + Customer Portal + webhooks)

## Goal

Monetize impedo.ai with three subscription tiers gated on AI usage:

| | Free | Pro | Team |
|---|---|---|---|
| AI circuit generations / month | 5 | 200 | Unlimited (fair use) |
| Plan/Ask assist + clarify calls / month | 20 (shared counter) | Unlimited | Unlimited |
| Simulations / compile | Unlimited | Unlimited | Unlimited |
| Price (monthly / annual) | — | $15 / $150 | $40 / $400 |

Prices live in Stripe (4 recurring Prices across 2 Products); code references them
only via env-var price IDs so amounts can be retuned in the dashboard.

## Architecture

- **Stripe Checkout (hosted)** for payment collection — the backend creates a
  Checkout Session and the frontend redirects to Stripe's page. No card data ever
  touches impedo.ai.
- **Stripe Customer Portal (hosted)** for plan switching / cancellation / payment
  method updates — zero custom billing UI.
- **Webhook** as the single source of truth for plan state. The success-URL
  redirect never grants entitlements; only signed webhook events write to the DB.
- Sandbox (test mode) first; live mode later is an env-var + dashboard exercise.

## Database (`users` table, Postgres + in-memory dev-store mirror)

New columns (added via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in `initDb`):

- `stripe_customer_id TEXT` — created lazily on first checkout.
- `plan TEXT DEFAULT 'free'` — `free` | `pro` | `team`.
- `plan_status TEXT` — Stripe subscription status (`active`, `past_due`, ...).
- `plan_period_end TIMESTAMPTZ` — end of the current billing period (display only).
- `usage_generations INTEGER DEFAULT 0` — generate-circuit calls this month.
- `usage_assists INTEGER DEFAULT 0` — assist+clarify calls this month (Free only).
- `usage_month TEXT` — `YYYY-MM` the counters belong to; counters reset lazily
  when the current month differs (no cron).

## Backend — new `server/billing/` module

- **`stripeClient.ts`** — lazily-constructed singleton of the official `stripe`
  npm package (the one new dependency, server-only), plus
  `verifyStripeWebhook(rawBody, signatureHeader)` wrapping
  `stripe.webhooks.constructEvent` with `STRIPE_WEBHOOK_SECRET`. Returns `null`
  when `STRIPE_SECRET_KEY` is unset so billing can be cleanly disabled in dev.
- **`plans.ts`** — tier definitions/limits, price-ID⇄plan mapping from env,
  `resolvePlanFromPriceId`.
- **`billing.ts`** — route handlers:
  - `handleCreateCheckout(user, body)` — `{plan: 'pro'|'team', interval: 'month'|'year'}`
    → ensures a Stripe customer for the user (stores `stripe_customer_id`),
    creates a subscription-mode Checkout Session with
    `success_url = APP_URL/#billing=success`, `cancel_url = APP_URL/#billing=cancel`,
    `client_reference_id = user.id`, returns `{url}`.
  - `handleCreatePortal(user)` — portal session for the stored customer → `{url}`.
    400 if the user has no Stripe customer yet.
  - `handleBillingStatus(user)` — `{plan, planStatus, periodEnd, usage: {generations, assists}, limits}`.
  - `handleStripeWebhook(rawBody, signatureHeader)` — verifies signature, then:
    - `checkout.session.completed` → look up user by `client_reference_id`,
      fetch the subscription, set `plan` from its price ID, `plan_status`,
      `plan_period_end`, `stripe_customer_id`.
    - `customer.subscription.updated` → find user by `stripe_customer_id`,
      update plan/status/period end (handles portal plan switches & renewals).
    - `customer.subscription.deleted` → downgrade that user to `free`.
    - Everything else → acknowledged and ignored. Handlers are idempotent
      (pure "set state to X" writes). Always respond 200 on handled events,
      400 on bad signature.
- **`quota.ts`** — `checkAndConsumeQuota(userId, meter)` where meter is
  `'generation' | 'assist'`: lazily resets counters on month rollover,
  enforces the tier limit, increments on success. Over limit → throws
  `QuotaError` → HTTP **402** `{code: 'quota_exceeded', plan, limit, usage}`.
  Quota is checked (and consumed) before starting the AI stream in
  `/api/generate-circuit`; `/api/assist-circuit` + `/api/clarify-circuit`
  consume the shared assist meter only for Free users.

### Router additions (`server/index.ts`)

| Route | Method | Auth |
|---|---|---|
| `/api/billing/checkout` | POST | JWT |
| `/api/billing/portal` | POST | JWT |
| `/api/billing/status` | GET | JWT |
| `/api/stripe/webhook` | POST | Stripe signature (raw body; registered **before** the JWT gate) |

The webhook route must read the raw request bytes (not `readJsonBody`) because
signature verification hashes the exact payload.

## Frontend

- **`src/features/billing/`**:
  - `PricingPage.jsx` (`#pricing`, public): three tier cards, monthly↔annual
    toggle, current-plan awareness when logged in. Upgrade buttons POST
    `/api/billing/checkout` and redirect to the returned URL; logged-out users
    are sent to `#signup` first.
  - `billing.js` — small client for the three billing endpoints.
  - `UsageBadge`/account menu additions in the workspace header: shows
    "x / N generations", a "Manage subscription" button (portal redirect) for
    paying users, and "Upgrade" for free users.
- **Routing:** add `pricing` to `PUBLIC_PAGES`; handle `#billing=success`
  (toast + refresh status) and `#billing=cancel` (silent return).
- **Quota UX:** a 402 `quota_exceeded` response in the chat flow renders an
  inline upsell card (link to `#pricing`) instead of an error message.

## Env vars

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO_MONTHLY`,
`STRIPE_PRICE_PRO_YEARLY`, `STRIPE_PRICE_TEAM_MONTHLY`, `STRIPE_PRICE_TEAM_YEARLY`,
`APP_URL` (e.g. `https://impedo.ai`). Local: `.env.local`; prod: Render env vars.
If `STRIPE_SECRET_KEY` is unset the billing routes return 503
`{code: 'billing_disabled'}` and quotas are not enforced (dev-friendly default).

## Error handling

- Webhook: bad signature → 400; unknown event → 200; DB miss (no matching user)
  → log + 200 (never make Stripe retry forever).
- Checkout/portal: Stripe API failure → 502 with a retryable message.
- `past_due` keeps access (Stripe dunning retries); `customer.subscription.deleted`
  (after dunning gives up, or cancellation period end) downgrades to free.

## Testing

- Unit (vitest): quota logic (limits, month rollover, per-tier), plan resolution
  from price IDs, webhook signature verification (valid/invalid/stale),
  webhook event → DB transitions (in-memory store), checkout body construction.
- Manual E2E: Stripe CLI `stripe listen --forward-to`, test card
  `4242 4242 4242 4242`, upgrade → generate over the free limit → portal cancel.

## Stripe dashboard setup (manual, sandbox)

1. Products "Impedo Pro" / "Impedo Team", each with monthly + yearly prices → 4 price IDs.
2. Enable Customer Portal; allow switching among the 4 prices + cancellation.
3. Webhook endpoint `https://<render-backend>/api/stripe/webhook` subscribing to
   the three handled events → signing secret.

## Go-live checklist (later)

Activate the Stripe account (business + bank details) → recreate the two
products in live mode → add the live webhook endpoint → swap the 7 env vars on
Render/Firebase → test one real card end to end.
