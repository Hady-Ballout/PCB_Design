import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { loadEnv } from './env.js';
import { parseAllowedOrigins, resolveCorsOrigin } from './cors.js';
import { runNgspiceSimulation } from './simulation/simulator.js';
import { compileSketch } from './compile/compiler.js';
import { initDb } from './auth/db.js';
import { handleSignup, handleLogin, handleVerifyEmail, handleMe, verifyJwt } from './auth/auth.js';
import { handleBillingStatus, handleCreateCheckout, handleCreatePortal, handleStripeWebhook } from './billing/billing.js';
import { QuotaError } from './billing/quota.js';
import { DailyTokenLimitError, dailyLimitMessage, getDailyTokenStatus } from './billing/dailyTokens.js';
import { handleSandboxGenerate, handleSandboxRun } from './sandbox/generate.js';
import type { Circuit, JwtPayload } from './types.js';

loadEnv();

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Refusing to start without a signing secret.');
  process.exit(1);
}

const port = Number(process.env.PORT || process.env.API_PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const allowedOrigins = parseAllowedOrigins(process.env.CORS_ORIGIN);

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  // Access-Control-Allow-Origin is set per-request in the server handler.
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  response.end(JSON.stringify(body));
};

const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 4 * 1024 * 1024);

class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

const readJsonBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) {
      request.destroy();
      throw new HttpError(413, 'Request body is too large.');
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
};

const statusFor = (error: unknown): number => (error instanceof HttpError ? error.statusCode : 500);

// Stripe signature verification hashes the exact payload bytes, so the
// webhook body must be read raw — never through readJsonBody.
const readRawBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) {
      request.destroy();
      throw new HttpError(413, 'Request body is too large.');
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
};

// Quota exhaustion is an upsell, not an error: the client renders the 402
// payload as an upgrade prompt.
const sendQuotaExceeded = (response: ServerResponse, error: QuotaError): void => {
  sendJson(response, 402, {
    code: 'quota_exceeded',
    error: error.message,
    plan: error.plan,
    meter: error.meter,
    limit: error.limit,
    usage: error.usage,
  });
};

// The per-user daily token cap is hit: 429 with a user-facing message. Runs for
// every logged-in user, independent of Stripe.
const sendDailyLimitReached = (response: ServerResponse, error: DailyTokenLimitError): void => {
  sendJson(response, 429, {
    code: 'daily_token_limit',
    error: dailyLimitMessage(error.limit),
    limit: error.limit,
    usage: error.usage,
  });
};


function getUser(request: IncomingMessage): JwtPayload | null {
  const auth = request.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  return verifyJwt(token);
}

const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
  // The allowlist may hold several origins, but the header only permits one —
  // echo back the request's own origin when it is allowed. setHeader values
  // merge into every later writeHead that doesn't name the same header.
  response.setHeader('Access-Control-Allow-Origin', resolveCorsOrigin(allowedOrigins, request.headers.origin));
  response.setHeader('Vary', 'Origin');

  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {});
    return;
  }

  if (request.url === '/api/health') {
    // Circuit generation was removed; this reports only that the API is up.
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.url === '/api/auth/signup' && request.method === 'POST') {
    try {
      const body = await readJsonBody(request);
      const result = await handleSignup(body);
      sendJson(response, result.status, result.body);
    } catch (error) {
      sendJson(response, statusFor(error), { error: (error as Error).message });
    }
    return;
  }

  if (request.url === '/api/auth/login' && request.method === 'POST') {
    try {
      const body = await readJsonBody(request);
      const result = await handleLogin(body);
      sendJson(response, result.status, result.body);
    } catch (error) {
      sendJson(response, statusFor(error), { error: (error as Error).message });
    }
    return;
  }

  if (request.url?.startsWith('/api/auth/verify') && request.method === 'POST') {
    try {
      const body = await readJsonBody(request);
      const result = await handleVerifyEmail(body.token as string | undefined);
      sendJson(response, result.status, result.body);
    } catch (error) {
      sendJson(response, statusFor(error), { error: (error as Error).message });
    }
    return;
  }

  if (request.url === '/api/auth/me' && request.method === 'GET') {
    try {
      const result = await handleMe(request);
      sendJson(response, result.status, result.body);
    } catch (error) {
      sendJson(response, statusFor(error), { error: (error as Error).message });
    }
    return;
  }

  // Authenticated by Stripe's signature, not a JWT — must sit above the gate.
  if (request.url === '/api/stripe/webhook' && request.method === 'POST') {
    try {
      const rawBody = await readRawBody(request);
      const result = await handleStripeWebhook(rawBody, request.headers['stripe-signature'] as string | undefined);
      sendJson(response, result.status, result.body);
    } catch (error) {
      sendJson(response, statusFor(error), { error: (error as Error).message });
    }
    return;
  }


  // Everything below the auth/health/webhook routes requires a logged-in,
  // verified user. Anonymous requests are rejected here.
  const user = getUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Authentication required.' });
    return;
  }

  if (request.url === '/api/usage/daily' && request.method === 'GET') {
    try {
      sendJson(response, 200, await getDailyTokenStatus(user.id));
    } catch (error) {
      sendJson(response, statusFor(error), { error: (error as Error).message });
    }
    return;
  }

  if (request.url === '/api/billing/checkout' && request.method === 'POST') {
    try {
      const body = await readJsonBody(request);
      const result = await handleCreateCheckout(user, body);
      sendJson(response, result.status, result.body);
    } catch (error) {
      sendJson(response, statusFor(error), { error: (error as Error).message });
    }
    return;
  }

  if (request.url === '/api/billing/portal' && request.method === 'POST') {
    try {
      const result = await handleCreatePortal(user);
      sendJson(response, result.status, result.body);
    } catch (error) {
      sendJson(response, statusFor(error), { error: (error as Error).message });
    }
    return;
  }

  if (request.url === '/api/billing/status' && request.method === 'GET') {
    try {
      const result = await handleBillingStatus(user);
      sendJson(response, result.status, result.body);
    } catch (error) {
      sendJson(response, statusFor(error), { error: (error as Error).message });
    }
    return;
  }

  if (request.url === '/api/simulate-circuit' && request.method === 'POST') {
    try {
      const body = await readJsonBody(request);
      if (!body.circuit || !body.spice) {
        sendJson(response, 400, { error: 'Circuit and SPICE deck are required.' });
        return;
      }

      const simulation = await runNgspiceSimulation({
        circuit: body.circuit as Circuit,
        spice: body.spice as string,
      });
      sendJson(response, simulation.ok ? 200 : 422, simulation);
    } catch (error) {
      sendJson(response, statusFor(error), { error: (error as Error).message });
    }
    return;
  }

  if (request.url === '/api/compile-sketch' && request.method === 'POST') {
    try {
      const body = await readJsonBody(request);
      if (typeof body.code !== 'string' || !body.code.trim()) {
        sendJson(response, 400, { error: 'Sketch source code is required.' });
        return;
      }
      const compilation = await compileSketch({ code: body.code });
      sendJson(response, compilation.ok ? 200 : 422, compilation);
    } catch (error) {
      sendJson(response, statusFor(error), { error: (error as Error).message });
    }
    return;
  }

  if (request.url?.startsWith('/api/sandbox/run/') && request.method === 'GET') {
    handleSandboxRun(response, decodeURIComponent(request.url.slice('/api/sandbox/run/'.length)));
    return;
  }

  if (request.url === '/api/sandbox/generate' && request.method === 'POST') {
    try {
      await handleSandboxGenerate(request, response, await readJsonBody(request));
    } catch (error) {
      // The handler owns the response once it has written SSE headers, so only
      // a failure before that point can still be reported as JSON.
      if (!response.headersSent) sendJson(response, statusFor(error), { error: (error as Error).message });
      else response.end();
    }
    return;
  }

  sendJson(response, 404, { error: 'Not found.' });
});

initDb()
  .then(() => {
    server.listen(port, host, () => {
      console.log(`Prompt-to-PCB API listening on http://${host}:${port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  });
