// OAuth 2.1 resource server for the hosted MCP endpoint.
//
// PCB Pilot validates tokens; it never issues them. An external authorization
// server (WorkOS AuthKit) owns the authorization code flow, PKCE, client
// registration, consent, and refresh. That split is deliberate: the spec-required
// authorization-server surface is large and security-critical, and none of it is
// PCB Pilot's product.
//
// Implements the resource-server half of
// https://modelcontextprotocol.io/specification/draft/basic/authorization:
//   - RFC 9728 protected resource metadata, so a client can discover the AS
//   - RFC 6750 bearer tokens, with the WWW-Authenticate challenges the spec names
//   - RFC 8707 audience binding — the check that stops this server being used as a
//     confused deputy for any other resource behind the same IdP

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface McpAuthConfig {
  /** Canonical URI of this MCP server; must equal the token's `aud`. */
  resourceUri: string;
  issuer: string;
  jwksUri: string;
  requiredScope: string;
}

export type AuthOutcome =
  | { ok: true; subject: string; scopes: string[] }
  | { ok: false };

/** RFC 9728 document served at /.well-known/oauth-protected-resource. */
export const protectedResourceMetadata = (config: McpAuthConfig) => ({
  resource: config.resourceUri,
  authorization_servers: [config.issuer],
  scopes_supported: [config.requiredScope],
  bearer_methods_supported: ['header'],
});

/**
 * The metadata URL a client is pointed at. RFC 9728 puts it at the origin root,
 * not alongside the resource path.
 */
export const metadataUrlFor = (config: McpAuthConfig): string =>
  new URL('/.well-known/oauth-protected-resource', config.resourceUri).toString();

// One JWKS cache per issuer for the process lifetime. `jose` handles key rotation
// and rate-limits refetches, so this must not be rebuilt per request.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const jwksFor = (config: McpAuthConfig) => {
  const existing = jwksCache.get(config.jwksUri);
  if (existing) return existing;
  const jwks = createRemoteJWKSet(new URL(config.jwksUri));
  jwksCache.set(config.jwksUri, jwks);
  return jwks;
};

const bearerFrom = (request: IncomingMessage): string => {
  const header = request.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
};

const challenge = (
  response: ServerResponse,
  status: number,
  config: McpAuthConfig,
  extra: Record<string, string> = {},
): void => {
  const params = {
    resource_metadata: metadataUrlFor(config),
    scope: config.requiredScope,
    ...extra,
  };
  const value = `Bearer ${Object.entries(params)
    .map(([key, item]) => `${key}="${item}"`)
    .join(', ')}`;

  response.writeHead(status, {
    'WWW-Authenticate': value,
    'Content-Type': 'application/json',
  });
  response.end(JSON.stringify({
    error: status === 403 ? 'insufficient_scope' : 'unauthorized',
    error_description: status === 403
      ? `This operation requires the "${config.requiredScope}" scope.`
      : 'A valid access token is required to use the PCB Pilot MCP server.',
  }));
};

/**
 * Verifies the request's bearer token and, on failure, writes the appropriate
 * challenge before returning. Callers only need to check `ok`.
 */
export async function authorizeMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: McpAuthConfig,
): Promise<AuthOutcome> {
  const token = bearerFrom(request);
  if (!token) {
    challenge(response, 401, config);
    return { ok: false };
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwksFor(config), {
      issuer: config.issuer,
      // Audience binding. Without this, a token any other AuthKit-protected
      // resource issued would be accepted here.
      audience: config.resourceUri,
    }));
  } catch {
    // Signature, issuer, audience, and expiry failures are all one outcome to the
    // caller: 401 with no detail about which check failed.
    challenge(response, 401, config);
    return { ok: false };
  }

  const scopes = String(payload.scope ?? '').split(/\s+/).filter(Boolean);
  if (!scopes.includes(config.requiredScope)) {
    challenge(response, 403, config, { error: 'insufficient_scope' });
    return { ok: false };
  }

  // Namespaced so an IdP subject can never alias an app user id in artifact
  // scoping — `user:42` and `mcp:42` are different buckets.
  return { ok: true, subject: `mcp:${payload.sub}`, scopes };
}

/** Reads MCP auth settings from the environment; null when not configured. */
export const mcpAuthConfigFromEnv = (): McpAuthConfig | null => {
  const { MCP_RESOURCE_URI, MCP_OAUTH_ISSUER, MCP_OAUTH_JWKS_URI } = process.env;
  if (!MCP_RESOURCE_URI || !MCP_OAUTH_ISSUER) return null;

  return {
    resourceUri: MCP_RESOURCE_URI,
    issuer: MCP_OAUTH_ISSUER,
    jwksUri: MCP_OAUTH_JWKS_URI || new URL('/oauth2/jwks', MCP_OAUTH_ISSUER).toString(),
    requiredScope: process.env.MCP_REQUIRED_SCOPE || 'circuits:use',
  };
};
