// CORS_ORIGIN accepts a comma-separated allowlist (e.g. the production domain
// plus its www/dev variants). Access-Control-Allow-Origin only permits a single
// value, so each response must echo back the one matching request origin.

const DEV_ORIGIN = 'http://127.0.0.1:5174';

export function parseAllowedOrigins(raw: string | undefined): string[] {
  const origins = (raw || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : [DEV_ORIGIN];
}

// The first configured origin doubles as the canonical frontend URL (used in
// emails and as the header value when a request has no/unknown Origin — the
// browser then rejects the mismatch, which is the correct outcome).
export function resolveCorsOrigin(allowed: string[], requestOrigin: string | undefined): string {
  return requestOrigin && allowed.includes(requestOrigin) ? requestOrigin : allowed[0];
}
