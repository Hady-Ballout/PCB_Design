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
| `OLLAMA_NUM_PREDICT_CLARIFY`, `OLLAMA_NUM_PREDICT_ASSIST` | output budgets for the clarify round (default 512) and Plan/Ask replies (default 1024) |
| `OLLAMA_CONTEXT_DIAGNOSTICS` | `1` to log per-request turn count/revision flag |
| `AI_PROVIDER`, `AI_API_URL`, `AI_MODEL`, `AI_API_KEY`, `AI_MAX_TOKENS` | switch to an OpenAI-compatible provider (e.g. Z.ai/GLM) instead of Ollama |
| `ZAI_THINKING_TYPE`, `ZAI_REASONING_EFFORT` | Z.ai-specific tuning |
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

Real `.env*` files are gitignored; `.env.local` and `.env.production` exist locally but
aren't tracked content-wise beyond `.env.production/env.production`.

## Stripe billing

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
