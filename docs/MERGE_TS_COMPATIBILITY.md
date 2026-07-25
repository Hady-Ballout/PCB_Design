# Server build compatibility: JS (Deployment) vs TypeScript (main)

## The two methods

Before this merge, the `Deployment` and `main` branches ran the API server two
different ways:

- **Deployment**: `server/*.js`, executed directly with `node server/index.js`.
  No compiler, no build step. `Dockerfile`'s `CMD` ran that file as-is.
- **main**: `server/**/*.ts`, executed in development with `tsx server/index.ts`
  (a TS-aware runtime loader). `main` never added a production build step —
  its `Dockerfile` still ran `node server/index.js` (or the raw `.ts` path,
  depending on which copy you looked at), which does not work: Node cannot
  execute `.ts` files directly, and the file it referenced no longer existed
  once the server was converted.

## Why they're incompatible

- `node` cannot execute `.ts` source without a loader or a prior compile step.
- `tsx` solves this for local development (fast startup, no separate build),
  but shipping `tsx` and raw `.ts` sources into a production container adds
  an extra runtime dependency and startup overhead that isn't needed once the
  code is stable — production wants plain compiled JS.
- Because of this gap, `main`'s own `Dockerfile` was broken: it would fail to
  build/run against the TypeScript server it shipped.

## What was decided

`Deployment`'s server has been fully converted to TypeScript to match `main`
(gaining type-checked development going forward, and picking up all of
`main`'s server-side improvements — auth hardening, DB TLS/local-fallback,
simulator injection guard, streaming AI provider, etc.).

To fix the build gap:

- Added `tsconfig.server.json` (compiles `server/**/*.ts`, plus the
  `src/core/*.js` modules the server imports, to `dist/server/`).
- Added an `npm run build:server` script (`tsc -p tsconfig.server.json`).
- Local dev still uses `tsx` for fast iteration (`npm run dev` /
  `npm run dev:api`) — no change in developer experience.
- `Dockerfile` now: installs full dependencies (including `typescript`/`tsx`
  needed to build), copies `server/` and `src/core/` and `tsconfig.server.json`,
  runs `npm run build:server`, prunes devDependencies, and finally runs the
  **compiled** output (`node dist/server/server/index.js`) in production.
  `tsx` never ships in the production image.
