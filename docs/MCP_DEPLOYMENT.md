# Hosted MCP connector — go-live runbook (`mcp.impedo.ai`)

Brings the hosted MCP endpoint live at **`https://mcp.impedo.ai/api/mcp`** so a user
can paste it into Claude and connect. The code is complete and on `main`; this is the
configuration + deploy sequence. Design rationale lives in
`docs/superpowers/specs/2026-08-01-hosted-mcp-connector-design.md`.

## The one URL everything must agree on

Three places name the endpoint, and the OAuth **audience check rejects the token** if
any of them disagree. They must be byte-for-byte identical:

| Where | Value |
|---|---|
| API env `MCP_RESOURCE_URI` (Render) | `https://mcp.impedo.ai/api/mcp` |
| WorkOS **Resource Indicator** | `https://mcp.impedo.ai/api/mcp` |
| Frontend `VITE_MCP_BASE_URL` (build) | `https://mcp.impedo.ai` (code appends `/api/mcp`) |

`mcp.impedo.ai` is a **custom domain on the existing Render backend service**, not a new
service — the same container already serves `/api/mcp`. The subdomain is branding and a
clean audience boundary; no server code changes.

## Order of operations

Do these in order. The endpoint stays dark (`MCP_HTTP_ENABLED` defaults off) until the
last step, so deploying early does no harm — but the Connect page will show a URL that
does not resolve until DNS + domain are done, so finish the whole list before telling
users.

### 1. WorkOS (you — needs the account; I cannot create accounts or enter credentials)

1. Create a WorkOS account and an **AuthKit** environment (Production).
2. **Configuration → register a Resource Indicator**: `https://mcp.impedo.ai/api/mcp`.
   AuthKit stamps this as the `aud` on issued tokens.
3. **Do not define a custom scope.** AuthKit authorizes MCP by the Resource
   Indicator above and rejects any custom scope (e.g. `circuits:use`) in the
   authorization request with `invalid_scope` — which Claude surfaces as the
   misleading error `state: Field required`. The server runs scope-less by default
   (`MCP_REQUIRED_SCOPE` unset); the `aud` binding is the authorization boundary.
4. Enable **Dynamic Client Registration (DCR)** so Claude can self-register.
   (The MCP spec now prefers CIMD, but claude.ai's connector flow still uses DCR;
   AuthKit supports both — enabling DCR covers both clients.)
5. Note two values for step 3:
   - **Issuer** — your AuthKit issuer URL → `MCP_OAUTH_ISSUER`
   - **JWKS URL** — usually `<issuer>/oauth2/jwks` → `MCP_OAUTH_JWKS_URI`
     (can be omitted; the API defaults to `<issuer>/oauth2/jwks`).

### 2. DNS + Render custom domain (you — needs DNS + Render dashboard access)

1. In **Render → the backend service → Settings → Custom Domains**, add
   `mcp.impedo.ai`. Render shows a DNS target (a `CNAME` host).
2. At your DNS provider for `impedo.ai`, add a **CNAME** record: `mcp` → the target
   Render gave you.
3. Wait for Render to show the domain **Verified** and issue its TLS cert (HTTPS is
   mandatory — Claude rejects `http://` connectors).

### 3. Render environment variables (you — dashboard only; nothing in the repo sets these)

On the backend service, in **Environment**, set:

```
MCP_HTTP_ENABLED=1
MCP_RESOURCE_URI=https://mcp.impedo.ai/api/mcp
MCP_OAUTH_ISSUER=<your WorkOS AuthKit issuer URL>
MCP_OAUTH_JWKS_URI=<issuer>/oauth2/jwks        # optional; this is the default
```

Optional hardening (all have safe defaults): `MCP_REQUIRED_SCOPE` (`circuits:use`),
`MCP_MAX_CONCURRENT_SIMULATIONS` (`1`), `NGSPICE_TIMEOUT_MS` (`30000`).

> Safety net: if `MCP_HTTP_ENABLED=1` but the OAuth vars are missing, the API keeps the
> MCP endpoint **disabled** in production rather than exposing the tools unauthenticated
> (`server/index.ts`). So a typo fails closed, not open.

### 4. Frontend build config (done in code)

`VITE_MCP_BASE_URL=https://mcp.impedo.ai` is already wired into
`.github/workflows/firebase-deploy.yml`. No GitHub secret to add — the value is public
(it is the URL shown for users to copy). The Connect page then displays
`https://mcp.impedo.ai/api/mcp`.

### 5. Deploy (final step)

`Deployment` is what ships to impedo.ai. Merge and push:

```bash
git fetch origin
git checkout Deployment
git merge --ff-only main
git push origin Deployment
```

This triggers the Firebase Hosting build (frontend, picks up `VITE_MCP_BASE_URL`) and
Render's auto-deploy (backend, picks up the new env vars). Keep `main` and `Deployment`
identical — only ever fast-forward.

## Verify

1. **Discovery is public:**
   ```bash
   curl https://mcp.impedo.ai/.well-known/oauth-protected-resource
   ```
   Expect JSON with `"resource":"https://mcp.impedo.ai/api/mcp"` and your WorkOS issuer
   under `authorization_servers`.
2. **Unauthenticated call is challenged:**
   ```bash
   curl -i -X POST https://mcp.impedo.ai/api/mcp
   ```
   Expect `401` with a `WWW-Authenticate: Bearer resource_metadata="…"` header
   (no `scope=` unless you deliberately configured one — see step 1.3).
3. **Real client round-trip:** in Claude (Settings → Connectors → Add custom connector)
   paste `https://mcp.impedo.ai/api/mcp`, or run
   `claude mcp add --transport http pcb-pilot https://mcp.impedo.ai/api/mcp`. Complete
   the WorkOS sign-in + consent; confirm the six tools appear and `validate_circuit`
   runs.
4. **In-app:** open impedo.ai → **Connect to Claude** and confirm the page shows
   `https://mcp.impedo.ai/api/mcp` with no local-URL warning.

## Rollback

Set `MCP_HTTP_ENABLED=0` (or unset it) on Render and redeploy the service. The endpoint
goes dark immediately; the rest of the API is unaffected. No frontend change needed —
the Connect page keeps showing the URL, but the endpoint stops answering.
