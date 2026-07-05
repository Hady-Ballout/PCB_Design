# Operations

## Scripts (`package.json`)

| Script | Command | Purpose |
|---|---|---|
| `npm run dev` | `node scripts/dev.mjs` | starts both the API server and Vite frontend together |
| `npm run dev:web` | `vite --host 127.0.0.1 --port 5174 --strictPort` | frontend only |
| `npm run dev:api` | `tsx server/index.ts` | API only |
| `npm run build` | `vite build` | production frontend build to `dist/` |
| `npm run preview` | `vite preview` | preview the production build |
| `npm test` | `vitest run` | unit tests |

`vite.config.js` proxies `/api` to `http://127.0.0.1:8787` in dev mode only; in production
the frontend expects `VITE_API_URL` (see below) or same-origin `/api`.

## Environment variables (`.env.example`)

| Var | Purpose |
|---|---|
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `OLLAMA_API_KEY` | local/hosted Ollama connection |
| `OLLAMA_NUM_CTX`, `OLLAMA_NUM_PREDICT` | context/output size for circuit generation |
| `OLLAMA_CONTEXT_DIAGNOSTICS` | `1` to log per-request turn count/revision flag |
| `AI_PROVIDER`, `AI_API_URL`, `AI_MODEL`, `AI_API_KEY`, `AI_MAX_TOKENS` | switch to an OpenAI-compatible provider (e.g. Z.ai/GLM) instead of Ollama |
| `ZAI_THINKING_TYPE`, `ZAI_REASONING_EFFORT` | Z.ai-specific tuning |
| `PORT`, `HOST`, `CORS_ORIGIN` | API server bind + allowed frontend origin |
| `JWT_SECRET` | **required** — the server refuses to start if it is unset |
| `MAX_BODY_BYTES` | max request body size before a `413` is returned (default `4 MiB`) |
| `DATABASE_URL` | Postgres/Neon connection string; **omit for local dev** to use the in-memory user store seeded with a local admin (see `docs/BACKEND.md`) |
| `PG_CA_CERT`, `PG_SSL_NO_VERIFY` | Postgres TLS: certificate verification is **on** by default; point `PG_CA_CERT` at a CA bundle, or set `PG_SSL_NO_VERIFY=1` to disable verification (local/self-signed only) |
| `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME` | signup verification email |
| `VITE_API_URL` | frontend's API base when not same-origin/proxied |

Real `.env*` files are gitignored; `.env.local` and `.env.production` exist locally but
aren't tracked content-wise beyond `.env.production/env.production`.

## Testing

`vitest run` (`--configLoader runner`). Test files sit next to their source
(`*.test.js` / `*.test.ts`), covering: circuit validation, SPICE/KiCad export, circuit sync
round-trips, schematic layout, chat store, Ngspice deck construction/waveform parsing,
Ollama request building/response validation, and circuit response reconciliation.

## Ngspice

Must be installed and on `PATH`. On Windows, `ngspice_con.exe` (console/batch mode) is
preferred over `ngspice.exe` to avoid launching a GUI (see `docs/BACKEND.md` /
`server/simulation/simulator.ts`).

## Deployment

- **`Dockerfile`** — `node:20-slim` + `apt-get install ngspice`, installs prod deps only,
  copies `server/` and `src/core/` (only the pieces the API needs — no frontend build step
  inside this image), runs `node server/index.js` on port 8787 with `HOST=0.0.0.0`.
- **`firebase.json`** — hosts the static `dist/` build (Vite frontend) with an SPA rewrite
  (`**` -> `/index.html`). Deployed via `.github/workflows/firebase-deploy.yml`.
- So the frontend (Firebase Hosting, static) and API (Docker container, wherever it's run)
  are deployed as two separate artifacts — the frontend's `VITE_API_URL` must point at
  wherever the API container ends up.

## Stray files worth knowing about

`dev-api-8787.err.log`, `dev-api-8787.out.log`, `dev-server-5174.*.log`,
`dev-web-5174.*.log` at the repo root are dev-server log output (written by
`scripts/dev.mjs` or manual runs) — gitignored per the `baseline` commit, safe to ignore or
delete.
