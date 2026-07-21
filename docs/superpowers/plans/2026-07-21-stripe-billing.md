# Stripe Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Subscription billing (Free/Pro/Team) for impedo.ai via hosted Stripe Checkout + Customer Portal, with webhook-driven plan state and monthly usage quotas on the AI routes.

**Architecture:** New `server/billing/` module (plans, store, quota, Stripe client, route handlers) wired into the hand-rolled `node:http` router in `server/index.ts`; `users` table gains 7 billing columns (Postgres `ALTER TABLE` + in-memory dev-store mirror). Frontend gets `src/features/billing/` (pricing page, billing API client, usage badge) and a `quota_exceeded` upsell in the chat flow. Webhooks are the only writer of plan state.

**Tech Stack:** TypeScript server (no framework), official `stripe` npm package (server-only), vitest, React 19 + hash routing.

## Global Constraints

- Tiers: Free (5 generations/mo, 20 assist+clarify/mo), Pro (200 generations/mo, unlimited assists), Team (unlimited, fair use).
- Prices only via env: `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_YEARLY`, `STRIPE_PRICE_TEAM_MONTHLY`, `STRIPE_PRICE_TEAM_YEARLY`. Never hardcode amounts.
- Other env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `APP_URL`.
- `STRIPE_SECRET_KEY` unset → billing routes answer 503 `{code:'billing_disabled'}`, quotas not enforced.
- Webhook route reads the **raw body** and is registered **before** the JWT gate.
- Success redirect never grants entitlements; only webhook events write plan state.
- Quota exhaustion → HTTP 402 `{code:'quota_exceeded', plan, limit, usage}`.
- Tests: `npm test` (vitest). Server files are ESM TypeScript with `.js` import specifiers.
- Update `docs/*.md` at the end (standing user rule).

---

### Task 1: Plan definitions (`server/billing/plans.ts`)

**Files:**
- Create: `server/billing/plans.ts`
- Test: `server/billing/plans.test.ts`

**Interfaces:**
- Produces: `type PlanId = 'free'|'pro'|'team'`; `type BillingInterval = 'month'|'year'`; `type Meter = 'generation'|'assist'`; `PLAN_LIMITS: Record<PlanId, {generations: number|null, assists: number|null}>` (null = unlimited); `priceIdFor(plan: Exclude<PlanId,'free'>, interval: BillingInterval): string`; `resolvePlanFromPriceId(priceId: string|undefined): PlanId|null`; `isBillingEnabled(): boolean`; `normalizePlan(value: unknown): PlanId`.

- [ ] **Step 1: Write failing tests** covering: limits table values; `priceIdFor` reads env; `resolvePlanFromPriceId` maps all four env price IDs and returns null for unknown; `normalizePlan` falls back to `'free'`; `isBillingEnabled` keyed on `STRIPE_SECRET_KEY`.
- [ ] **Step 2: Run `npx vitest run server/billing/plans.test.ts`** — expect FAIL (module missing).
- [ ] **Step 3: Implement `plans.ts`** (env read at call time, not import time, so tests can set env per-case).
- [ ] **Step 4: Re-run test file** — expect PASS.
- [ ] **Step 5: Commit** `feat: add billing plan definitions`.

### Task 2: Billing columns in both user stores

**Files:**
- Modify: `server/auth/db.ts` (initDb ALTER TABLEs; `LocalUser` seed fields; new normalized local queries)
- Modify: `server/types.ts` (`LocalUser` billing fields)
- Create: `server/billing/store.ts`
- Test: `server/billing/store.test.ts` (runs against the in-memory store — no `DATABASE_URL`)

**Interfaces:**
- Produces (`store.ts`): `interface BillingUser {id: number; plan: PlanId; planStatus: string|null; planPeriodEnd: string|null; stripeCustomerId: string|null; usageGenerations: number; usageAssists: number; usageMonth: string|null}`; `getBillingUser(id: number): Promise<BillingUser|null>`; `findUserIdByCustomer(customerId: string): Promise<number|null>`; `setStripeCustomer(id: number, customerId: string): Promise<void>`; `setPlan(id: number, update: {plan: PlanId; status: string|null; periodEnd: string|null; customerId?: string}): Promise<void>`; `setUsage(id: number, usage: {generations: number; assists: number; month: string}): Promise<void>`.

- [ ] **Step 1: Failing tests** for get/set round-trips against the seeded local admin user (call `initDb()` in `beforeEach` with `DATABASE_URL` deleted).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Postgres: 7 `ALTER TABLE users ADD COLUMN IF NOT EXISTS ...` statements in `initDb`. Local store: extend `LocalUser` + seed defaults (`plan: 'free'`, counters 0), add the new normalized query branches used by `store.ts` (exact SQL strings in both places).
- [ ] **Step 4: Run — PASS.** Also `npx vitest run server` to catch regressions.
- [ ] **Step 5: Commit** `feat: add billing columns to user stores`.

### Task 3: Quota metering (`server/billing/quota.ts`)

**Files:**
- Create: `server/billing/quota.ts`
- Test: `server/billing/quota.test.ts`

**Interfaces:**
- Consumes: `store.ts` getters/setters, `PLAN_LIMITS`, `isBillingEnabled`.
- Produces: `class QuotaError extends Error {plan; meter; limit; usage}`; `currentMonth(now?: Date): string` (`'YYYY-MM'`, UTC); `checkAndConsumeQuota(userId: number, meter: Meter): Promise<void>`.

- [ ] **Step 1: Failing tests**: free user consumes 5 generations then 6th throws `QuotaError` with limit 5; month rollover resets counters; assist meter enforced at 20 for free, skipped (no increment) for pro/team; unlimited generation for team; no-op when billing disabled.
- [ ] **Step 2: Run — FAIL.  Step 3: Implement.  Step 4: Run — PASS.  Step 5: Commit** `feat: add monthly usage quotas`.

### Task 4: Stripe client + webhook verification (`server/billing/stripeClient.ts`)

**Files:**
- Create: `server/billing/stripeClient.ts`
- Modify: `package.json` (add `stripe` dependency)
- Test: covered via Task 5's signed-webhook tests

**Interfaces:**
- Produces: `getStripe(): Stripe|null` (lazy singleton, null when `STRIPE_SECRET_KEY` unset; `apiVersion` pinned); `verifyStripeWebhook(rawBody: Buffer, signatureHeader: string): Stripe.Event` (throws on bad signature; uses `stripe.webhooks.constructEvent` with `STRIPE_WEBHOOK_SECRET`).

- [ ] **Step 1:** `npm install stripe`.
- [ ] **Step 2:** Implement `stripeClient.ts`.
- [ ] **Step 3:** `npx tsc -p tsconfig.server.json --noEmit` (or `npx vitest run server`) to confirm it compiles. Commit `feat: add stripe client wrapper`.

### Task 5: Billing route handlers (`server/billing/billing.ts`)

**Files:**
- Create: `server/billing/billing.ts`
- Test: `server/billing/billing.test.ts`

**Interfaces:**
- Consumes: `getStripe`, `verifyStripeWebhook`, `store.ts`, `plans.ts`, `JwtPayload` from `../types.js`.
- Produces (all return `{status: number; body: Record<string, unknown>}`):
  - `handleCreateCheckout(user: JwtPayload, body: Record<string, unknown>, stripeOverride?)` — validates `{plan, interval}`, ensures customer (`setStripeCustomer`), creates subscription-mode Checkout Session (`client_reference_id: String(user.id)`, success `${APP_URL}/#billing=success`, cancel `${APP_URL}/#billing=cancel`) → `{url}`.
  - `handleCreatePortal(user: JwtPayload, stripeOverride?)` — 400 `{code:'no_customer'}` without a customer; else portal session → `{url}`.
  - `handleBillingStatus(user: JwtPayload)` — `{plan, planStatus, periodEnd, usage: {generations, assists}, limits}`.
  - `handleStripeWebhook(rawBody: Buffer, signatureHeader: string|undefined, stripeOverride?)` — verify, then `applyStripeEvent`.
  - `applyStripeEvent(event, stripe)` — exported for tests: `checkout.session.completed` (user by `client_reference_id`, `subscriptions.retrieve` for price/status/period), `customer.subscription.updated` (user by customer id; `canceled`/`incomplete_expired` → free), `customer.subscription.deleted` (→ free). Unknown events and unmatched users → 200.
- Fakes in tests: `stripeOverride` object with `checkout.sessions.create`, `billingPortal.sessions.create`, `customers.create`, `subscriptions.retrieve`. Webhook signatures forged for real with `node:crypto` HMAC (`t=<ts>,v1=...`) against a test `STRIPE_WEBHOOK_SECRET`.

- [ ] **Step 1: Failing tests** for: checkout validation errors (bad plan/interval), 503 when disabled, checkout body (price id, client_reference_id, urls), portal without customer → 400, status shape, webhook bad signature → 400, each event → correct store transition, idempotent replay.
- [ ] **Step 2: Run — FAIL.  Step 3: Implement.  Step 4: Run — PASS.  Step 5: Commit** `feat: add billing route handlers and webhook`.

### Task 6: Router wiring + quota enforcement (`server/index.ts`)

**Files:**
- Modify: `server/index.ts`

**Interfaces:**
- Consumes: `handleCreateCheckout`, `handleCreatePortal`, `handleBillingStatus`, `handleStripeWebhook`, `checkAndConsumeQuota`, `QuotaError`.

- [ ] **Step 1:** Add `/api/stripe/webhook` **before** the `getUser` JWT gate, reading raw bytes (same chunk loop as `readJsonBody` but no JSON parse), passing `request.headers['stripe-signature']`.
- [ ] **Step 2:** Add `/api/billing/checkout` (POST), `/api/billing/portal` (POST), `/api/billing/status` (GET) after the JWT gate.
- [ ] **Step 3:** In `/api/generate-circuit` after prompt validation and before `startJsonStream`: `await checkAndConsumeQuota(user.id, 'generation')`; catch `QuotaError` → 402 `{code:'quota_exceeded', plan, limit, usage}`. Same with meter `'assist'` in `/api/assist-circuit` and `/api/clarify-circuit`.
- [ ] **Step 4:** `npx vitest run server` + boot smoke test (`npm run dev:api` with no Stripe env → `/api/billing/status` 503, health OK).
- [ ] **Step 5: Commit** `feat: wire billing routes and quotas into the API router`.

### Task 7: Frontend — billing client, pricing page, routing

**Files:**
- Create: `src/features/billing/billing.js`, `src/features/billing/PricingPage.jsx`, `src/features/billing/billing.css`
- Modify: `src/app/routing.js` (add `pricing` to `PUBLIC_PAGES` + `#pricing` in `pageFromHash`)
- Modify: `src/app/App.jsx` (render `PricingPage` for `page==='pricing'`; handle `#billing=success|cancel` return)
- Test: `src/app/routing.test.js` (new; jsdom hash tests)

**Interfaces:**
- Produces (`billing.js`): `createCheckoutSession(plan, interval): Promise<{url}>`; `openBillingPortal(): Promise<{url}>`; `fetchBillingStatus(): Promise<status|null>` — all with the Bearer token from `localStorage.pcb_token`, against `API_BASE`.
- `PricingPage` props: none (uses `useAuth`); logged-out upgrade clicks route to `#signup`.

- [ ] **Step 1:** routing tests (`#pricing` → `'pricing'`, still public) — FAIL → implement → PASS.
- [ ] **Step 2:** Implement `billing.js` + `PricingPage.jsx` (3 tier cards from a local `TIERS` array, monthly↔annual toggle, "Current plan" state from `fetchBillingStatus` when logged in) + CSS consistent with `auth.css` patterns.
- [ ] **Step 3:** App wiring: pricing page render branch (public, like `home`); on `#billing=success` show a small confirmation banner in the workspace user-bar area and clear the hash.
- [ ] **Step 4:** `npm test` + `npm run build`. Commit `feat: add pricing page and billing client`.

### Task 8: Frontend — usage badge, portal button, quota upsell

**Files:**
- Modify: `src/app/App.jsx` (user-bar: usage badge + Upgrade/Manage-subscription button; 402 handling in the generate/assist/clarify fetch paths → `errorCode` on the chat)
- Modify: `src/features/chat/ChatPanel.jsx` (render upsell card when `errorCode==='quota_exceeded'`)
- Test: `src/features/chat/chatStore.test.js` untouched; upsell rendering covered by existing ChatPanel test conventions if present (else visual check via `npm run build`).

- [ ] **Step 1:** Fetch billing status on workspace mount (logged in); user-bar shows `usage.generations / limit` for limited plans, "Upgrade" (→ `#pricing`) on free, "Manage subscription" (portal redirect) on paid.
- [ ] **Step 2:** In the generate catch path: if `response.status === 402` and body `code==='quota_exceeded'`, set `chat.errorCode='quota_exceeded'` + friendly `chat.error`; ChatPanel renders an upsell card (message + "See plans" link to `#pricing`) instead of the plain error row. Same body-check for assist/clarify (clarify already falls back to direct generation — a 402 there should surface the upsell, not silently generate).
- [ ] **Step 3:** `npm test` + `npm run build`. Commit `feat: add usage badge and quota upsell`.

### Task 9: Docs + env documentation

**Files:**
- Modify: `docs/BACKEND.md` (routes table + `server/billing` section), `docs/FRONTEND.md` (billing feature), `docs/OPERATIONS.md` (env vars, webhook setup, Stripe CLI local flow, go-live checklist)

- [ ] **Step 1:** Update the three docs. Commit `docs: document stripe billing`.

### Task 10: Manual E2E (requires user's dashboard values)

- [ ] Create sandbox products/prices, portal config, webhook endpoint (or `stripe listen`) per the spec's dashboard section; fill `.env.local`; run checkout with `4242 4242 4242 4242`; verify plan flip, quota lift, portal cancel → downgrade.
