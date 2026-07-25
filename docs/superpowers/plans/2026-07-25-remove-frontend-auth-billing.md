# Remove Frontend Auth & Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** impedo.ai opens on the landing page with a single **Start** button; all auth/billing UI is deleted from the frontend while the backend auth/billing code stays dormant.

**Architecture:** Extract the landing page out of `src/features/auth/` into a new `src/features/landing/` feature, rewire routing (`''`/`#home` → landing, `#app` → workspace), strip auth/billing from `App.jsx`/`ChatPanel.jsx`, delete the two feature dirs, and make the server's auth gate optional (anonymous passes; quotas/billing only with a JWT).

**Tech Stack:** React 19 + Vite (frontend), Node http + TypeScript via tsx (server), vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-25-remove-frontend-auth-billing-design.md`
- No backend code deletion; no `.env` / Render changes; no rate limiting (explicit decision).
- Recovery tag `pre-frontend-auth-removal` already exists on main.
- Verification gate for every task: `npm test` — only the known pre-existing failure `pcbGenerator > lays out MCU circuits` is allowed.
- Final gate: `npx tsc -p tsconfig.server.json --noEmit`, `npm run build`, `npm run build:server` all pass.

---

### Task 1: Landing feature (additive only)

**Files:**
- Create: `src/features/landing/LandingPage.jsx`
- Create: `src/features/landing/landing.css`

**Interfaces:**
- Produces: `export function LandingPage()` — no props; renders the full landing page.
- Consumes: `BreadboardPreview` from `../realisticSchematic/BreadboardPreview.jsx`, `animejs`.

- [ ] **Step 1: Create `LandingPage.jsx`** — copy from `src/features/auth/auth.jsx` these exact pieces, unchanged except where noted: the `prefersReducedMotion` helper (lines 6–8), `PageBackdrop` (lines 12–21, keep the export), the circuit constants + `HOME_CASES` (lines 88–174), and `HomePage` (lines 176–290) renamed `LandingPage`. Drop the `API_BASE` import (unused here) and all auth context code. Replace the `home-actions` block with:

```jsx
        <div className="home-actions">
          <a href="#app" className="btn btn-primary">Start</a>
        </div>
```

- [ ] **Step 2: Create `landing.css`** — copy `src/features/auth/auth.css` wholesale, then delete: the `/* ── Auth pages ── */` section (lines 368–471), the `.loading-screen` rule block, and the `.auth-card` rule inside the mobile media query. Update the header comment to say it styles the landing page + app chrome (buttons, user bar, floating toggle).

- [ ] **Step 3: Verify + commit** — `npm test` (unchanged results; nothing imports the new files yet). `git add src/features/landing && git commit -m "feat: extract landing page with Start button into its own feature"`.

---

### Task 2: Cutover — routing, App.jsx, ChatPanel, delete auth/billing UI

**Files:**
- Modify: `src/app/routing.js`, `src/app/routing.test.js`, `src/app/App.jsx`, `src/features/chat/ChatPanel.jsx`
- Delete: `src/features/auth/` (auth.jsx, auth.css), `src/features/billing/` (PricingPage.jsx, billing.js, billing.css)

**Interfaces:**
- Produces: `pageFromHash(): 'home' | 'workspace' | 'waveform'` (no more `AUTH_PAGES`/`PUBLIC_PAGES` exports).
- Consumes: `LandingPage` from Task 1.

- [ ] **Step 1: Rewrite `routing.test.js` (failing first):**

```js
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { pageFromHash } from './routing.js';

describe('pageFromHash', () => {
  it('shows the landing page when there is no hash', () => {
    window.location.hash = '';
    expect(pageFromHash()).toBe('home');
    window.location.hash = '#home';
    expect(pageFromHash()).toBe('home');
  });

  it('opens the workspace from #app and unknown hashes', () => {
    window.location.hash = '#app';
    expect(pageFromHash()).toBe('workspace');
    window.location.hash = '#billing=success';
    expect(pageFromHash()).toBe('workspace');
  });

  it('keeps the waveform page', () => {
    window.location.hash = '#waveform';
    expect(pageFromHash()).toBe('waveform');
  });
});
```

Run `npx vitest run src/app/routing.test.js --configLoader runner` — expect FAIL (`''` currently maps to `'workspace'`).

- [ ] **Step 2: Rewrite `routing.js`:**

```js
// Hash-based page routing shared by the app shell.
export const pageFromHash = () => {
  const hash = window.location.hash;
  if (hash === '' || hash === '#' || hash === '#home') return 'home';
  if (hash === '#waveform') return 'waveform';
  // '#app' and anything unrecognized open the workspace.
  return 'workspace';
};
```

Re-run the routing test — expect PASS.

- [ ] **Step 3: Rewire `App.jsx`:**
  - Imports: delete the `features/auth/auth.jsx`, `PricingPage`, `billing.js`, `auth.css`, `billing.css` imports and the `AUTH_PAGES, PUBLIC_PAGES` names from the routing import; add `import { LandingPage } from '../features/landing/LandingPage.jsx';` and `import '../features/landing/landing.css';`.
  - Delete `const { user, loading, logout } = useAuth();`. Rename `authHeaders` → `jsonHeaders` returning only `{ 'Content-Type': 'application/json' }`; update its 5 call sites.
  - Delete `billingStatus`/`billingNotice` state; the logged-out-redirect effect (lines 270–289); the two billing effects (lines 291–322); `refreshBillingStatus` + `manageSubscription` and their call sites.
  - Quota plumbing: in the assist and generate catch paths, delete the `402`/`quota_exceeded` special-casing (`quotaError.quota = ...` throws, `const quota = requestError.quota`, `errorCode: quota ? ...`) so every failure takes the existing plain-error path; drop `errorCode` from chat updates and from the `<ChatPanel>` prop list.
  - Navigation: every remaining `window.location.hash = ''` that means "go to the workspace" (post-generation, `showWorkspace`, and the line ~643 site) becomes `window.location.hash = 'app'`.
  - Render: delete the `if (loading)` early return; `const visiblePage = page;`; keep only three branches — `'home'` → `withFloatingThemeToggle(<LandingPage />)`, `'waveform'` (unchanged), default workspace. In the workspace user bar keep only `<ThemeToggle .../>` (delete billing banner, usage badge, Upgrade/Manage, email, Log out).
  - Bottom: `export default App;` (delete `WrappedApp`/`AuthProvider`).
- [ ] **Step 4: Simplify `ChatPanel.jsx`** — remove the `errorCode` prop (line 148) and replace the quota-upsell conditional (lines 318–324) with:

```jsx
            {error && <p className="inline-error chat-error">{error}</p>}
```

- [ ] **Step 5: Delete the two directories** — `git rm -r src/features/auth src/features/billing`, then `grep -rn "features/auth\|features/billing\|useAuth\|pcb_token\|quota_exceeded" src` must return nothing.
- [ ] **Step 6: Verify + commit** — `npm test` (only the known failure) and `npm run build` (must succeed — catches dangling imports). `git commit -m "feat: replace login with a Start landing page; remove auth/billing UI"`.

---

### Task 3: Server — optional auth

**Files:**
- Modify: `server/index.ts`

**Interfaces:**
- Produces: `user: JwtPayload | null` after the gate; billing routes 401 individually; quota consumed only when `user` is set.

- [ ] **Step 1: Relax the gate** — replace:

```ts
  const user = getUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Authentication required.' });
    return;
  }
```

with:

```ts
  // Auth is optional while the frontend ships without login: anonymous
  // requests pass through, and quotas only apply to token-bearing requests.
  const user = getUser(request);
```

- [ ] **Step 2: Gate the three billing routes individually** — at the top of the `/api/billing/checkout`, `/api/billing/portal`, and `/api/billing/status` handlers insert:

```ts
    if (!user) {
      sendJson(response, 401, { error: 'Authentication required.' });
      return;
    }
```

- [ ] **Step 3: Make the three quota checks conditional** — wrap each `try { await checkAndConsumeQuota(user.id, ...); } catch (quotaError) {...}` block (two `'assist'`, one `'generation'`) in `if (user) { ... }`, keeping the inner QuotaError handling verbatim.
- [ ] **Step 4: Verify + commit** — `npx tsc -p tsconfig.server.json --noEmit` (catches any other `user.` deref), `npm test`. Manual smoke: `npm run dev:api` then `curl -s -X POST http://127.0.0.1:8787/api/simulate-circuit -H "Content-Type: application/json" -d "{}"` must NOT return `Authentication required.` (a 400 validation error is the expected shape). `git commit -m "feat: make API auth optional so the app works without login"`.

---

### Task 4: Docs + full verification

**Files:**
- Modify: `docs/FRONTEND.md`, `docs/OPERATIONS.md`, others surfaced by grep

- [ ] **Step 1:** `grep -rn "login\|signup\|pricing\|billing\|auth" docs/*.md` — update every frontend-facing mention: landing page with Start button, no accounts; note in OPERATIONS' Stripe section + BACKEND that server-side auth/billing code is dormant (auth optional since this change) and what re-enabling takes (restore tag `pre-frontend-auth-removal` frontend dirs + App wiring).
- [ ] **Step 2:** Full gate: `npx tsc -p tsconfig.server.json --noEmit && npm test && npm run build && npm run build:server`.
- [ ] **Step 3:** `git commit -m "docs: describe the no-login landing flow and dormant auth/billing backend"`.

---

### Task 5: Deploy

- [ ] **Step 1:** `git push origin main`
- [ ] **Step 2:** `git checkout Deployment && git merge --ff-only main && git push && git checkout main` (user-authorized: the change targets impedo.ai too).
- [ ] **Step 3:** After the Firebase action and Render deploy finish, spot-check https://impedo.ai shows the landing page with Start.
