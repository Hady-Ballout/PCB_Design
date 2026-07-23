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
| `/api/clarify-circuit` | POST | **yes** | streams NDJSON, pre-generation question round |
| `/api/assist-circuit` | POST | **yes** | streams NDJSON, Plan/Ask conversational reply |
| `/api/generate-circuit` | POST | **yes** (`Authorization: Bearer <jwt>`) | streams NDJSON |
| `/api/simulate-circuit` | POST | **yes** | runs Ngspice |

Every route below `/api/auth/*` requires a valid JWT (`getUser` via `verifyJwt`); there is
no anonymous circuit generation path.

All three AI chat endpoints stream NDJSON and share a `{type: 'thinking', delta}` event:
live model reasoning tokens (GLM `reasoning_content` via the streaming SSE call in
`streamOpenAiCompatibleContent`, or Ollama `message.thinking` when a model emits it),
batched server-side to ~10 events/sec by `createThinkingBatcher`. The client renders them
in an ephemeral "Thinking" window and discards them when the reply lands; models without
reasoning tokens simply produce no `thinking` events.

`/api/clarify-circuit` takes the same request body as `/api/generate-circuit`
(`{prompt, messages, currentDesign, memory}`) and streams `thinking` events followed by
`{type: 'complete', data: {questions: [{id, question, options}]}}` — up to 3 clarifying
questions, each with the canonical `'No preference (you decide)'` option appended
server-side. Failures become `{type: 'error', code: 'clarify_failed', error}` mid-stream
(or a plain JSON error before the stream starts); the client treats any failure as "skip
the round and generate directly", so this endpoint must never block generation.

`/api/assist-circuit` serves the chat composer's **Plan** and **Ask** modes. It takes
`{mode: 'plan' | 'ask', prompt, messages, currentDesign, memory}` and streams `thinking`
events followed by `{type: 'complete', data: {mode, reply}}` — one conversational
plain-text reply, no circuit, no SPICE, and deliberately **no `updateChatMemory` call**
(assist replies confirm no design). Failures become
`{type: 'error', code: 'assist_failed', error}` (or plain JSON pre-stream) and the client
surfaces them as a chat message without touching the design.

`/api/generate-circuit` streams `{type: 'thinking', delta, attempt}` and
`{type: 'spice', provisional: true, ...}` events as the AI
response arrives (via `streamCircuitWithOllama`'s callbacks, spice deduped by
`${attempt}:${spice}`; an attempt bump tells the client to reset the thinking window for
the correction retry), then a final `{type: 'complete', data: {...}}` event containing the
reconciled circuit, SPICE, reply, firmware `code` (`''` when the circuit has no MCU board),
updated chat memory, plus the generation-quality fields:

- `issues: RuleViolation[]` — topology-rule findings (`{id, severity, refs, nets, message,
  fix, autoFixed}`) re-checked on the reconciled circuit, with any `autoFixed` entries from
  the retry loop preserved.
- `generation: {attempts, degraded}` — how many attempts ran and whether the retry budget
  expired with error violations left (best candidate accepted, issues surfaced).

Errors become `{type: 'error'}` if the stream already started, or a plain 500 JSON body if
it hasn't — but since the retry loop accepts the best parsed candidate rather than failing,
a hard error only occurs when all `MAX_GENERATION_ATTEMPTS` (3) attempts failed structurally.

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
  `validateCircuitResponse` (schema plus exact node counts for every positional kind —
  `POSITIONAL_NODE_KINDS`: fixed-pin kinds, compound kinds, opamp/comparator/pushbutton/
  BJTs/MOSFETs — since their pins are mapped by index downstream),
  `parseCircuitResponse` (repairs malformed/truncated JSON; on the final attempt a deck
  that still fails only SPICE-vs-JSON consistency is regenerated from the canonical JSON
  via `toSpice` rather than failing the turn),
  `parseWithCorrectionRetry` (up to 3 attempts gated on the shared topology rule engine in
  `src/core/topologyRules.js`; error violations become corrective feedback; after the
  budget, the best candidate is accepted with `degraded: true` and safe additive auto-fixes
  applied — never a user-facing hard failure once anything parsed),
  `buildOllamaRequestBody`, and `generateCircuitWithOllama`/`streamCircuitWithOllama`
  (both resolve to `GeneratedCircuit` = parsed response + `issues` + `generation`;
  `streamCircuitWithOllama` also takes `onThinking(delta, state)` alongside `onContent`).
  Also supports an OpenAI-compatible provider path (`AI_PROVIDER`, e.g. Z.ai/GLM) as an
  alternative to Ollama, including `streamOpenAiCompatibleContent` — an SSE streaming
  call that forwards `delta.reasoning_content` chunks to `onThinking` and cumulative
  `delta.content` to `onContent` (so the provisional-SPICE preview works for
  OpenAI-compatible providers too), with a plain-JSON fallback for gateways that ignore
  `stream: true`.
- **`clarifyProvider.ts`** — the pre-generation clarifying-question round. Owns
  `CLARIFY_SCHEMA` (1–3 questions, 2–4 options each, grammar-constrained like the circuit
  schema), a small standalone system prompt (no `circuitKnowledgePrompt()` — this call is
  deliberately cheap), `buildClarifyRequestBody` (memory + design inventory + prior *user*
  turns only), `sanitizeClarifyQuestions` (caps/dedupes options, strips model-provided
  "no preference" variants, appends the canonical one, assigns `q1..q3` ids), and
  `generateClarifyingQuestions` (optional `onThinking` switches the OpenAI-compatible
  path to the streaming SSE call). No correction retry: a failed clarify round is cheap
  and the client falls back to direct generation.
- **`assistProvider.ts`** — the Plan/Ask conversational endpoint. Owns `ASSIST_SCHEMA`
  (`{"reply": "..."}`, the smallest possible wrapper — a JSON `format` is mandatory on both
  provider paths), `PLAN_SYSTEM_PROMPT` (textual design plan, embeds `ALLOWED_KINDS` so
  plans only propose buildable parts, plans edits when a design exists) and
  `ASK_SYSTEM_PROMPT` (tutor persona, never claims to change the design),
  `sanitizeAssistHistory` (unlike the generation filter it keeps assistant *text* turns for
  conversational continuity, folding circuit turns into a compact summary),
  `buildAssistRequestBody` (knowledge base injected for **plan** only; full circuit JSON in
  context for **ask** only), `cleanAssistReply` (newline-preserving, 8k cap), and
  `generateAssistReply` (parses the `{"reply"}` wrapper via `findBalancedJson` with a
  plain-text fallback for models that ignore the format; optional `onThinking` switches
  the OpenAI-compatible path to the streaming SSE call). No correction retry and no
  chat-memory update. `OLLAMA_NUM_PREDICT_ASSIST` (default 1024) bounds the reply budget.
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
