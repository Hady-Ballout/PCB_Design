import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type KeyObject } from 'jose';

import {
  authorizeMcpRequest,
  protectedResourceMetadata,
  type McpAuthConfig,
} from './resourceServer.js';

// A real local authorization server: real RS256 keys, a real JWKS endpoint over
// HTTP, real signature verification. Nothing about the crypto path is stubbed —
// the only thing standing in for WorkOS is who holds the private key.
let jwksServer: Server;
let config: McpAuthConfig;
let privateKey: KeyObject;
let issuer: string;

const RESOURCE = 'https://pcb.example.com/api/mcp';

const mintToken = async (claims: {
  aud?: string | string[];
  iss?: string;
  scope?: string;
  sub?: string;
  expiresIn?: string;
} = {}) => new SignJWT({ scope: claims.scope ?? 'circuits:use' })
  .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
  .setSubject(claims.sub ?? 'user_abc123')
  .setIssuer(claims.iss ?? issuer)
  .setAudience(claims.aud ?? RESOURCE)
  .setIssuedAt()
  .setExpirationTime(claims.expiresIn ?? '5m')
  .sign(privateKey);

/** Minimal fake request/response so challenges can be asserted without a socket. */
const fakeExchange = (headers: Record<string, string> = {}) => {
  const written = { status: 0, headers: {} as Record<string, string>, body: '' };
  return {
    request: { headers, url: '/api/mcp', method: 'POST' } as never,
    response: {
      writeHead(status: number, responseHeaders: Record<string, string>) {
        written.status = status;
        written.headers = responseHeaders;
        return this;
      },
      end(body?: string) { written.body = body ?? ''; },
      headersSent: false,
    } as never,
    written,
  };
};

beforeEach(async () => {
  const keyPair = await generateKeyPair('RS256');
  privateKey = keyPair.privateKey as KeyObject;
  const publicJwk = { ...(await exportJWK(keyPair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

  jwksServer = createServer((request, response) => {
    if (request.url === '/.well-known/jwks.json') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  const { port } = jwksServer.address() as AddressInfo;
  issuer = `http://127.0.0.1:${port}`;

  config = {
    resourceUri: RESOURCE,
    issuer,
    jwksUri: `${issuer}/.well-known/jwks.json`,
    requiredScope: 'circuits:use',
  };
});

afterEach(async () => {
  await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
});

describe('protectedResourceMetadata (RFC 9728)', () => {
  it('names this server as the resource and the IdP as its authorization server', () => {
    const metadata = protectedResourceMetadata(config);

    expect(metadata.resource).toBe(RESOURCE);
    expect(metadata.authorization_servers).toEqual([issuer]);
  });

  it('advertises the scope a client needs', () => {
    expect(protectedResourceMetadata(config).scopes_supported).toEqual(['circuits:use']);
  });

  it('does not advertise offline_access, which is not a resource requirement', () => {
    expect(protectedResourceMetadata(config).scopes_supported).not.toContain('offline_access');
  });
});

describe('authorizeMcpRequest', () => {
  it('accepts a correctly-issued token and reports the subject', async () => {
    const { request, response } = fakeExchange({ authorization: `Bearer ${await mintToken()}` });

    const result = await authorizeMcpRequest(request, response, config);

    expect(result).toMatchObject({ ok: true, subject: 'mcp:user_abc123' });
  });

  it('challenges an unauthenticated request with 401 and a discovery pointer', async () => {
    const { request, response, written } = fakeExchange();

    const result = await authorizeMcpRequest(request, response, config);

    expect(result.ok).toBe(false);
    expect(written.status).toBe(401);
    expect(written.headers['WWW-Authenticate']).toContain('Bearer');
    expect(written.headers['WWW-Authenticate'])
      .toContain('resource_metadata="https://pcb.example.com/.well-known/oauth-protected-resource"');
    expect(written.headers['WWW-Authenticate']).toContain('scope="circuits:use"');
  });

  it('rejects a token minted for a different resource', async () => {
    // The confused-deputy case: a valid token from the same IdP, issued for
    // somebody else's MCP server. Audience binding is what stops it.
    const token = await mintToken({ aud: 'https://other-service.example.com/api/mcp' });
    const { request, response, written } = fakeExchange({ authorization: `Bearer ${token}` });

    const result = await authorizeMcpRequest(request, response, config);

    expect(result.ok).toBe(false);
    expect(written.status).toBe(401);
  });

  it('rejects a token from an unexpected issuer', async () => {
    const token = await mintToken({ iss: 'https://impostor.example.com' });
    const { request, response, written } = fakeExchange({ authorization: `Bearer ${token}` });

    expect((await authorizeMcpRequest(request, response, config)).ok).toBe(false);
    expect(written.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const token = await mintToken({ expiresIn: '-1m' });
    const { request, response, written } = fakeExchange({ authorization: `Bearer ${token}` });

    expect((await authorizeMcpRequest(request, response, config)).ok).toBe(false);
    expect(written.status).toBe(401);
  });

  it('rejects a token signed by the wrong key', async () => {
    const impostor = await generateKeyPair('RS256');
    const token = await new SignJWT({ scope: 'circuits:use' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject('user_abc123').setIssuer(issuer).setAudience(RESOURCE)
      .setIssuedAt().setExpirationTime('5m')
      .sign(impostor.privateKey);
    const { request, response, written } = fakeExchange({ authorization: `Bearer ${token}` });

    expect((await authorizeMcpRequest(request, response, config)).ok).toBe(false);
    expect(written.status).toBe(401);
  });

  it('answers 403 with insufficient_scope when the token is valid but under-scoped', async () => {
    const token = await mintToken({ scope: 'profile:read' });
    const { request, response, written } = fakeExchange({ authorization: `Bearer ${token}` });

    const result = await authorizeMcpRequest(request, response, config);

    expect(result.ok).toBe(false);
    expect(written.status).toBe(403);
    expect(written.headers['WWW-Authenticate']).toContain('error="insufficient_scope"');
    expect(written.headers['WWW-Authenticate']).toContain('scope="circuits:use"');
  });

  it('accepts a token carrying the required scope among others', async () => {
    const token = await mintToken({ scope: 'profile:read circuits:use extra:thing' });
    const { request, response } = fakeExchange({ authorization: `Bearer ${token}` });

    expect((await authorizeMcpRequest(request, response, config)).ok).toBe(true);
  });

  it('ignores a non-Bearer authorization header', async () => {
    const { request, response, written } = fakeExchange({ authorization: 'Basic dXNlcjpwYXNz' });

    expect((await authorizeMcpRequest(request, response, config)).ok).toBe(false);
    expect(written.status).toBe(401);
  });

  it('namespaces the subject so it cannot collide with an app user id', async () => {
    const { request, response } = fakeExchange({ authorization: `Bearer ${await mintToken({ sub: '42' })}` });

    const result = await authorizeMcpRequest(request, response, config);

    // Artifact scoping keys on this; a bare "42" would alias app user 42.
    expect(result.ok && result.subject).toBe('mcp:42');
  });
});
