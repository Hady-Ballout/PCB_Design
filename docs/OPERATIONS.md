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
| `npm run mcp` | `tsx mcp/server.ts` | local MCP server over stdio (for Claude Desktop / Claude Code) |
| `npm run mcp:live-check` | `node scripts/mcp-live-check.mjs` | boots the real API server and drives the hosted MCP endpoint end-to-end |
| — | `node scripts/kicad-drc-oracle.mjs` | lays out three fixtures, writes their `.kicad_pcb` files to a temp dir and runs KiCad's own DRC over them (see below) |

`vite.config.js` proxies `/api` to `http://127.0.0.1:8787` in dev mode only; in production
the frontend expects `VITE_API_URL` (see below) or same-origin `/api`.

## Environment variables (`.env.example`)

| Var | Purpose |
|---|---|
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `OLLAMA_API_KEY` | local/hosted Ollama connection |
| `OLLAMA_NUM_CTX`, `OLLAMA_NUM_PREDICT` | context/output size for circuit generation |
| `OLLAMA_NUM_PREDICT_CLARIFY`, `OLLAMA_NUM_PREDICT_ASSIST` | output budgets for the clarify round (default 512) and Plan/Ask replies (default 1024) |
| `OLLAMA_CONTEXT_DIAGNOSTICS` | `1` to log per-request turn count/revision flag |
| `AI_PROVIDER`, `AI_API_URL`, `AI_MODEL`, `AI_API_KEY`, `AI_MAX_TOKENS` | switch to an OpenAI-compatible provider (e.g. Z.ai/GLM) instead of Ollama. `AI_MAX_TOKENS` overrides the request's `max_tokens`; unset, it defaults to 4096, or for Z.ai providers 12000 (30000 when `ZAI_THINKING_TYPE=enabled` — reasoning and JSON output share that one budget, so thinking mode needs the larger default to avoid `finish_reason: length` truncation) |
| `ZAI_THINKING_TYPE`, `ZAI_REASONING_EFFORT` | Z.ai-specific tuning; `ZAI_THINKING_TYPE` is `disabled` (default) or `enabled` — enabling it raises the `AI_MAX_TOKENS` default from 12000 to 30000 (see above) |
| `PORT`, `HOST`, `CORS_ORIGIN` | API server bind + allowed frontend origin(s); `CORS_ORIGIN` accepts a comma-separated allowlist (`server/cors.ts`) — the matching request origin is echoed back per-response, and the **first** entry is the canonical frontend URL used in verification-email links |
| `JWT_SECRET` | **required** — the server refuses to start if it is unset |
| `MAX_BODY_BYTES` | max request body size before a `413` is returned (default `4 MiB`) |
| `DATABASE_URL` | Postgres/Neon connection string; **omit for local dev** to use the in-memory user store seeded with a local admin (see `docs/BACKEND.md`) |
| `PG_CA_CERT`, `PG_SSL_NO_VERIFY` | Postgres TLS: certificate verification is **on** by default; point `PG_CA_CERT` at a CA bundle, or set `PG_SSL_NO_VERIFY=1` to disable verification (local/self-signed only) |
| `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME` | signup verification email |
| `VITE_API_URL` | frontend's API base when not same-origin/proxied |
| `STRIPE_SECRET_KEY` | Stripe API key (`sk_test_...` / `sk_live_...`); **unset = billing disabled** (routes 503, quotas skipped) |
| `STRIPE_WEBHOOK_SECRET` | signing secret (`whsec_...`) of the webhook endpoint / `stripe listen` session |
| `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_YEARLY`, `STRIPE_PRICE_TEAM_MONTHLY`, `STRIPE_PRICE_TEAM_YEARLY` | the four recurring price IDs (`price_...`) from the Stripe dashboard |
| `APP_URL` | canonical frontend URL used in Checkout success/cancel and Portal return URLs (e.g. `https://impedo.ai`) |
| `MCP_HTTP_ENABLED` | `1` mounts the hosted MCP endpoint at `/api/mcp`; **unset = off**. With `NODE_ENV=production` the server refuses to start if this is on without the OAuth vars below, rather than exposing the tools unauthenticated |
| `MCP_RESOURCE_URI` | canonical URI of this MCP server. **Production: `https://mcp.impedo.ai/api/mcp`** (the MCP endpoint has its own subdomain — see `docs/MCP_DEPLOYMENT.md`). Tokens must carry it as `aud` — this is the audience binding that stops a token issued for another service being replayed here. Must match the WorkOS Resource Indicator and `VITE_MCP_BASE_URL` exactly |
| `MCP_OAUTH_ISSUER` | the authorization server's issuer URL (WorkOS AuthKit) |
| `MCP_OAUTH_JWKS_URI` | JWKS endpoint; defaults to `<issuer>/oauth2/jwks` |
| `MCP_REQUIRED_SCOPE` | scope a token must carry. **Default: empty (no scope required).** WorkOS AuthKit authorizes MCP by the Resource Indicator (`aud`) and rejects custom scopes with `invalid_scope`, so requiring one breaks sign-in. Set this only for an IdP that actually mints the scope into its tokens |
| `MCP_MAX_CONCURRENT_SIMULATIONS` | simultaneous ngspice runs per user (default `1`) |
| `NGSPICE_TIMEOUT_MS` | wall-clock cap on a single ngspice run before it is killed (default `30000`) |
| `VITE_MCP_BASE_URL` | frontend override for the base URL shown on the Connect page (it appends `/api/mcp`). **Production: `https://mcp.impedo.ai`**, set at build time in `.github/workflows/firebase-deploy.yml`. Needed because the MCP endpoint is on its own subdomain, not on `VITE_API_URL` |

Real `.env*` files are gitignored; `.env.local` and `.env.production` exist locally but
aren't tracked content-wise beyond `.env.production/env.production`.

## Stripe billing

**Dormant since 2026-07-25:** the frontend auth/billing UI was removed (landing page +
Start button, no login), and the API accepts anonymous requests. The server-side billing
code, routes, and env vars below are intact and waiting; re-enabling means restoring the
frontend from git tag `pre-frontend-auth-removal` plus the dashboard/env setup below.

Sandbox first: build/test everything against test-mode keys and card `4242 4242 4242 4242`.

**Dashboard setup (once per mode):** two Products (Impedo Pro $15/mo + $150/yr, Impedo
Team $40/mo + $400/yr) → the four price IDs above; enable the Customer Portal (allow
switching between the four prices + cancellation); add a webhook endpoint
`https://<render-backend>/api/stripe/webhook` subscribed to `checkout.session.completed`,
`customer.subscription.updated`, `customer.subscription.deleted` → `STRIPE_WEBHOOK_SECRET`.

**Local webhooks:** `stripe listen --forward-to http://127.0.0.1:8787/api/stripe/webhook`
prints a temporary `whsec_...` for `.env.local`.

**Go-live checklist:** activate the Stripe account (business + bank details) → recreate
the products/portal/webhook in live mode → swap the 7 `STRIPE_*`/`APP_URL` env vars on
Render → one real-card end-to-end test.

## Testing

`vitest run` (`--configLoader runner`). Test files sit next to their source
(`*.test.js` / `*.test.ts`), covering: circuit validation, SPICE/KiCad export, circuit sync
round-trips, schematic layout, chat store, Ngspice deck construction/waveform parsing,
Ollama request building/response validation, and circuit response reconciliation.

## KiCad DRC oracle (optional)

`src/core/pcbDrc.js` is an independent check of the boards this repo generates, but it is
still *our* check — same design rules, same pad model, same conventions as everything that
built the board. `scripts/kicad-drc-oracle.mjs` brings in an outside opinion: it lays out
three fixtures (an RC low-pass, the TO-92 board that forces the router's neck-down ladder,
and a 555 astable) through the real pipeline, writes their `.kicad_pcb` files to a temp
directory, prints our own verdict for each, and then runs
`kicad-cli pcb drc --exit-code-violations` over them.

```bash
node scripts/kicad-drc-oracle.mjs     # KICAD_CLI=/path/to/kicad-cli to override
```

`kicad-cli` is **optional**: without it the script says so and exits 0. `.github/workflows/
kicad-drc-oracle.yml` runs it on PRs that touch the PCB modules, with `continue-on-error`
at the **job** level — KiCad enforces rules this pipeline never claimed to satisfy
(courtyard overlaps, unconnected items), so a violation there is a prompt to go and look,
not a build failure.

## Ngspice

Must be installed and on `PATH`. On Windows, `ngspice_con.exe` (console/batch mode) is
preferred over `ngspice.exe` to avoid launching a GUI (see `docs/BACKEND.md` /
`server/simulation/simulator.ts`).

## Arduino CLI

Needed only for the breadboard view's live Uno firmware emulation (`POST
/api/compile-sketch` in `server/compile/compiler.ts`). Must be on `PATH` (override with
`ARDUINO_CLI_BINARY`). Install on Windows with `winget install ArduinoSA.CLI`, then run the
one-time toolchain setup:

```bash
arduino-cli core update-index
arduino-cli core install arduino:avr
# Libraries the generated sketches use (displays, keypad, servo, DHT…):
arduino-cli lib install "LiquidCrystal I2C" "Keypad" "Adafruit SSD1306" \
  "Adafruit GFX Library" "Adafruit BusIO" "Servo" \
  "DHT sensor library" "Adafruit Unified Sensor" \
  "RTClib" "Adafruit MPU6050" "Adafruit BMP280 Library" "Adafruit NeoPixel" \
  "Stepper" "IRremote" "MFRC522" "PMW3360 Module"
```

Sketches are compiled locally in a temp dir (`sketch/sketch.ino`, `--fqbn
arduino:avr:uno`) — source never leaves the machine — with an in-memory hash→hex cache for
repeat runs. If the CLI is missing, the endpoint returns a friendly install hint instead of
failing opaquely; the rest of the app (including non-firmware simulation) is unaffected.

## Deployment

- **Flow:** all work lands on `main`; `Deployment` is kept as a fast-forward of `main`
  (`git checkout Deployment && git merge --ff-only main && git push`). Pushing
  `Deployment` is what deploys: it triggers the Firebase Hosting workflow (frontend) and
  Render's auto-deploy (backend). Never let the branches diverge — as of the 2026-07
  reconciliation merge they carry identical content.
- **`Dockerfile`** — `node:20-slim` + `apt-get install ngspice`. Installs all deps
  (devDependencies included, needed for `tsc`), copies `server/` and `src/core/`, runs
  `npm run build:server` (compiles the TS server to `dist/server` and copies `src/core`
  beside it), then `npm prune --omit=dev` and runs the compiled
  `dist/server/server/index.js` on port 8787 with `HOST=0.0.0.0`. No frontend build step
  inside this image.
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
