# Backend (`server/`)

Plain `node:http` server (no Express/Fastify), TypeScript, run via `tsx server/index.ts`
(`npm run dev:api`) or compiled for the Docker image.

## `server/index.ts` — router

A single `createServer` callback does manual `request.url`/`request.method` matching
(no routing framework):

| Route | Method | Auth required | Notes |
|---|---|---|---|
| `/api/health` | GET | no | reports `provider` + `model` from env |
| `/api/auth/signup` | POST | no | |
| `/api/auth/login` | POST | no | returns a JWT |
| `/api/auth/verify` | POST | no | consumes the email verification token |
| `/api/auth/me` | GET | via header | |
| `/api/generate-circuit` | POST | **yes** (`Authorization: Bearer <jwt>`) | streams NDJSON |
| `/api/simulate-circuit` | POST | **yes** | runs Ngspice |

Every route below `/api/auth/*` requires a valid JWT (`getUser` via `verifyJwt`); there is
no anonymous circuit generation path.

`/api/generate-circuit` streams `{type: 'spice', provisional: true, ...}` events as the AI
response arrives (via `streamCircuitWithOllama`'s callback, deduped by
`${attempt}:${spice}`), then a final `{type: 'complete', data: {...}}` event containing the
reconciled circuit, SPICE, reply, and updated chat memory. Errors become `{type: 'error'}`
if the stream already started, or a plain 500 JSON body if it hasn't.

## `server/auth`

- **`db.ts`** — `initDb`/`query`. If `DATABASE_URL` is unset, falls back to an **in-memory**
  user store seeded with one local admin account (`LOCAL_ADMIN_EMAIL` /
  `LOCAL_ADMIN_PASSWORD`, defaults `admin@local.test` / `PcbPilotLocal!2026`) — useful for
  local dev without Postgres. With `DATABASE_URL` set, it talks to Postgres via `pg`
  (`ssl: { rejectUnauthorized: false }`, i.e. expects a Neon-style managed Postgres).
- **`auth.ts`** — hand-rolled scrypt password hashing + HMAC-SHA256 JWT (no external auth
  library). `signJwt`/`verifyJwt`, `handleSignup`, `handleLogin`, `handleVerifyEmail`,
  `handleMe`. JWTs expire after 7 days. Requires `JWT_SECRET` to be set.
- **`brevo.ts`** — `sendVerificationEmail` via the Brevo transactional email API.

## `server/ai`

- **`ollamaProvider.ts`** (~730 ln, largest backend file) — owns the system prompt that
  defines the circuit JSON contract (SPICE-safe ref prefixes per component kind, ground
  node `"0"`, `LM358` as the only opamp model, voltage_source vs signal_source rules),
  `CIRCUIT_SCHEMA`/`AI_RESPONSE_SCHEMA` (used as Ollama structured-output format),
  `validateCircuitResponse`, `parseCircuitResponse` (repairs malformed/truncated JSON),
  `buildOllamaRequestBody`, and `generateCircuitWithOllama`/`streamCircuitWithOllama`. Also
  supports an OpenAI-compatible provider path (`AI_PROVIDER`, e.g. Z.ai/GLM) as an
  alternative to Ollama.
- **`chatMemory.ts`** — `normalizeChatMemory`, `sanitizeConversationHistory`,
  `updateChatMemory`: a per-chat persisted summary of confirmed requirements/decisions, sent
  back to the model on every revision request instead of the full transcript.
- **`circuitKnowledge.ts`** — loads `ai-context/pcb-circuit-expert.md` and injects it into
  the prompt as `circuitKnowledgePrompt()`.

## `server/circuit`

- **`circuitResponse.ts`** — `normalizeAiCircuit`, `normalizeSchematicHints`,
  `reconcileCircuitRevision` (merges an AI revision against the previous confirmed design),
  `buildCircuitResponse` (final API response shape sent to the frontend).
- **`streamingCircuit.ts`** — `extractCompleteComponents`, `buildStreamingSpice`: turns
  partial/incomplete AI JSON into a best-effort provisional SPICE preview while streaming.

## `server/simulation`

- **`simulator.ts`** — `buildSimulationDeck` (injects `LM358` model if referenced but
  undefined), `chooseWaveformNodes`, `runNgspiceSimulation` (writes a temp `.cir`, shells out
  to `ngspice`/`ngspice_con -b`, on Windows prefers `ngspice_con` to avoid launching a GUI),
  `parseWaveformData`.

## `server/types.ts` / `server/env.ts`

Shared TypeScript types (`Circuit`, `Component`, `ChatMemory`, `StreamState`, etc.) and
`loadEnv()` (thin dotenv-style loader for `.env.local`).
