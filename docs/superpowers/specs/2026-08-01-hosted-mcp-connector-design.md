# Hosted MCP connector — design

**Date:** 2026-08-01
**Status:** Design approved, not yet implemented
**Supersedes nothing.** Extends the local stdio MCP server in `mcp/` (see `mcp/README.md`).

## Goal

A PCB Pilot user signs in at impedo.ai, copies a URL from the app, pastes it into
Claude, and Claude can then validate, simulate, and export their circuits. Today's
`mcp/` server cannot do this: it is a stdio subprocess on a developer's machine, so
there is no URL to copy.

This design adds a **hosted** MCP endpoint on the existing Render backend, authorized
by an external identity provider, plus the in-app UI that surfaces the connection URL.

## What carries over

The six tool modules in `mcp/tools/` are pure `async (args, artifactDir) => result`
functions with no knowledge of stdio. They are reused unchanged. Only `mcp/server.ts`
is transport-specific, and it stays as the local entry point.

| Reused as-is | Replaced |
|---|---|
| `mcp/tools/*` (componentKinds, validate, export, simulate, render, layout, diagram) | Transport (stdio → streamable HTTP) |
| `mcp/schemas.ts` (zod circuit contract) | Artifact delivery (file path → inline or download URL) |
| The whole `src/core` dependency chain | Nothing else |

`Dockerfile` already installs ngspice, so `simulate_circuit` works in the deployed
container with no image change.

## Architecture

```text
Claude (Desktop / Code / claude.ai)
  │  1. POST /api/mcp  (no token)
  │  ← 401 + WWW-Authenticate: Bearer resource_metadata="…", scope="circuits:use"
  │  2. GET /.well-known/oauth-protected-resource   → names WorkOS as the AS
  │  3. OAuth 2.1 + PKCE against WorkOS AuthKit     → user signs in, consents
  │  ← access token, aud = https://<host>/api/mcp
  │  4. POST /api/mcp  Authorization: Bearer <token>
  ▼
server/index.ts
  └── /api/mcp → StreamableHTTPServerTransport (stateless, per-request)
        └── mcp/tools/*  →  src/core + server/simulation
```

PCB Pilot is an OAuth 2.1 **resource server only**. It never issues tokens, never
sees a password, and owns no authorization endpoints. WorkOS AuthKit is the
authorization server.

### Why an external IdP

The MCP spec requires the authorization server to implement OAuth 2.1 with PKCE,
RFC 8414 metadata, RFC 9207 `iss` responses, refresh-token rotation, one-time code
redemption, and either Client ID Metadata Documents or Dynamic Client Registration
so Claude can register itself. Building that on top of the repo's hand-rolled
scrypt + HMAC-SHA256 JWT module — which is currently dormant and not on `main` —
is a large, security-critical surface with no product value of its own.

WorkOS AuthKit was selected over Stytch, Auth0, and Descope because it documents
MCP support directly: you register the MCP server URL as a **Resource Indicator**
and AuthKit stamps issued tokens with a matching `aud`, which is exactly the
audience binding RFC 8707 and the MCP spec require. It also ships DCR **and** CIMD,
which matters because the spec has deprecated DCR in favour of CIMD while
claude.ai's connector flow still relies on DCR in practice.

## Components

### 1. `server/mcp/httpServer.ts` — transport

Builds an `McpServer` per request via a shared factory and connects it to
`StreamableHTTPServerTransport` in **stateless** mode (no session store). Render
runs multiple instances and may recycle them; stateless means any instance can
serve any request with no shared state.

Registers the same six tools as `mcp/server.ts`. To avoid drift, the tool
registration list moves into `mcp/registerTools.ts` and both entry points call it.

### 2. `server/mcp/resourceServer.ts` — OAuth resource server

| Route | Behaviour |
|---|---|
| `GET /.well-known/oauth-protected-resource` | RFC 9728 document: `resource` = the canonical `/api/mcp` URI, `authorization_servers` = the WorkOS issuer, `scopes_supported` = `["circuits:use"]` |
| `POST /api/mcp` without a token | `401` + `WWW-Authenticate: Bearer resource_metadata="…", scope="circuits:use"` |
| `POST /api/mcp` with a token | Verify signature against the WorkOS JWKS (cached), then check `exp`, `iss`, and **`aud` equals this server's canonical URI** |
| Valid token, missing scope | `403` + `WWW-Authenticate: Bearer error="insufficient_scope", scope="circuits:use", resource_metadata="…"` |

Audience validation is not optional. A token minted for another AuthKit-protected
resource must be rejected, or PCB Pilot becomes a confused deputy for any other
service sharing the IdP.

### 3. Artifact delivery — the one real behaviour change

A filesystem path on Render is useless to a remote user. Per tool:

| Tool | Local (stdio) | Hosted |
|---|---|---|
| `export_netlist` | text inline + file | text inline (unchanged — netlists are small) |
| `simulate_circuit` | stats + CSV path | stats inline; CSV via download URL |
| `render_schematic` | SVG path | summary + download URL |
| `pcb_layout` | summary + JSON path | summary inline; geometry via download URL |

Download URLs are `GET /api/mcp/artifacts/:id`, backed by an in-memory TTL cache
(15 minutes) keyed by a random id, scoped to the authenticated user, and served
with `Content-Disposition: attachment`. In-memory is acceptable because artifacts
are cheap to regenerate and the TTL is short; a cache miss returns 404 and the
user re-runs the tool. **No artifact is ever written to the container filesystem.**

### 4. Abuse controls

`simulate_circuit` shells out to ngspice, so it is the expensive tool. Reuse the
existing quota machinery in `server/billing/quota.ts` with a new `mcp_simulation`
meter rather than inventing a parallel limiter. Additionally:

- Circuit component count capped (existing zod schema gains a `.max()` on `components`)
- ngspice already runs with a temp dir and is killed on process close; add a wall-clock timeout
- Per-user concurrent simulation limit of 1

### 5. `src/features/connect/ConnectPanel.jsx` — the UI

The thing that started this: a panel showing

```
https://<render-host>/api/mcp
```

with a copy button, plus:

- **Claude Code:** `claude mcp add --transport http pcb-pilot <url>` (copyable)
- **Claude Desktop / claude.ai:** "Settings → Connectors → Add custom connector", paste the URL
- A short note that connecting requires signing in and granting access

Per the feature-chunk rule in `docs/ARCHITECTURE.md`, this is a new chunk under
`src/features/` and is wired in from `src/app/App.jsx`; it imports from `src/core`
only.

## Identity: two systems, deliberately

OAuth requires an authenticated user to consent. As of the `8b14826` merge from
`origin/Deployment`, the auth UI is **live on `main`** — `src/features/auth/auth.jsx`
is imported by `src/app/App.jsx`, so login, signup, and verify all ship. Nothing
needs reactivating; this is no longer a Phase 3 prerequisite.

The two identity systems coexist by design:

| System | Serves | Owns |
|---|---|---|
| Existing scrypt + HMAC-SHA256 JWT (`server/auth`) | The web app session | Login, signup, email verification |
| WorkOS AuthKit | MCP clients only | OAuth 2.1, PKCE, DCR/CIMD, token issuance |

Keeping them separate is the point. The web app's login is a session cookie for a
first-party UI; MCP authorization is a delegated-authority protocol with a
third-party client. Folding the second into the first would mean growing the
hand-rolled JWT module into a full authorization server — the exact surface this
design set out to avoid owning.

Unifying them later (WorkOS as the app's login too) stays possible and is **out of
scope here**.

## Phasing

Each phase is independently shippable and testable.

1. **Remote transport, no auth.** `/api/mcp` mounted, six tools reachable over HTTP,
   artifact delivery reworked. Gated to non-production by env var. Proves the tools
   work over the wire before any auth exists.
2. **Resource server.** RFC 9728 metadata, 401/403 challenges, JWKS verification,
   audience binding. Testable with a hand-minted AuthKit token.
3. **Authorization.** WorkOS AuthKit tenant, resource indicator registered, DCR
   enabled, end-to-end connect from a real Claude client.
4. **UI.** ConnectPanel, copy buttons, install instructions.

## Testing

Matching the existing vitest setup:

- **Resource server unit tests** — token missing / expired / wrong `iss` / **wrong `aud`** / insufficient scope, each asserting the exact status and `WWW-Authenticate` value. JWKS is stubbed with a locally generated keypair, so no network and no mocked crypto.
- **Transport integration test** — drive `/api/mcp` over real HTTP with `node:http`, listing tools and calling `validate_circuit`, reusing the fixtures in `mcp/testFixtures.ts`.
- **Artifact tests** — URL issued, content retrievable, expires after TTL, and a second user cannot fetch another user's artifact id.
- The existing `mcp/` suite (55 tests) must stay green; the shared tool modules are unchanged, so any failure there means the refactor into `registerTools.ts` broke something.

## Risks

| Risk | Mitigation |
|---|---|
| Two identity systems confuse users ("why sign in twice?") | The ConnectPanel states plainly that connecting Claude grants a separate authorization |
| A collaborator pushes directly to `Deployment` | Fetch before pushing (already standing practice for this repo); this work lives on its own feature branch until proven |
| ngspice abuse on a public endpoint | Quota meter, component cap, timeout, concurrency limit — all in Phase 1/2, before the endpoint is public |
| MCP auth spec is still moving (DCR deprecated mid-flight) | Delegating to AuthKit means spec churn is largely the IdP's problem, not ours |
| Stateless transport assumption wrong for some client | Verified in Phase 1 against a real Claude client before auth work starts |

## Out of scope

- Replacing the web app's existing session auth with WorkOS
- Per-seat billing for MCP access (the quota meter counts; it does not charge)
- Any AI/generation tool over MCP — the hosted server stays deterministic, same as local
- `import_netlist` (deferred from the local server's v1 for the same reason)
