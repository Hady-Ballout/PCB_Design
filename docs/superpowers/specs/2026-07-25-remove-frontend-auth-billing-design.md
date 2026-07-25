# Remove auth & billing from the frontend (backend stays dormant)

**Date:** 2026-07-25 · **Status:** approved by hady in-session

## Goal

Visiting impedo.ai shows the landing page with a single **Start** button (no Login/Sign-up
anywhere). Start opens the workspace. All auth/billing UI is removed from the frontend.
Backend auth/billing code is kept intact but dormant, so accounts/billing can return later.

## Scope

### Frontend (removal)

- Extract the landing page from `src/features/auth/auth.jsx` into `src/features/landing/`
  keeping its current visual design; replace Login/Sign-up controls with one **Start**
  button that navigates to the workspace.
- Routing (`src/app/routing.js`): no hash (or `#home`) → landing; `#app` → workspace;
  `#waveform` unchanged. `#login`, `#signup`, `#verify`, `#pricing`, `#billing=*` routes
  are removed (unknown hashes fall back to the workspace, matching current behavior).
- Delete `src/features/auth/` and `src/features/billing/` (login/signup/verify pages, auth
  context, pricing page, usage badge, upgrade banners, checkout-return handling).
- `App.jsx` / `src/core/config.js`: drop AuthProvider/useAuth, billing state and UI,
  auth tokens on API calls — plain `fetch` everywhere.

### Server (one minimal change, nothing deleted)

- The blanket 401 gate in `server/index.ts` becomes optional auth: anonymous requests
  proceed; `checkAndConsumeQuota` runs only when a JWT user is present (never, until the
  frontend re-adds login). Billing endpoints individually keep requiring a user (401).
- `server/auth/`, `server/billing/`, their routes, env vars, and the Neon data stay as-is.

### Out of scope

- No backend code deletion, no Render env changes, no database changes.
- No rate limiting (explicit decision: fully open API, AI-provider limits are the backstop).

## Recovery path

Tag `pre-frontend-auth-removal` on the commit before removal. Restoring = checking out the
two deleted feature directories from the tag and rewiring ~10 lines in `App.jsx`/routing.

## Verification

`npx tsc -p tsconfig.server.json --noEmit`, `npm test` (only the known pre-existing layout
failure allowed), `npm run build`, `npm run build:server`. Manual: landing renders at `/`,
Start opens workspace, generation works with no token. Deploy: push `main`, fast-forward
`Deployment`, push (user-authorized: change targets both local and impedo.ai).
