import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { loadEnv } from './env.js';
import { buildCircuitResponse, reconcileCircuitRevision } from './circuit/circuitResponse.js';
import { normalizeChatMemory, sanitizeConversationHistory, updateChatMemory } from './ai/chatMemory.js';
import { runCircuitPipeline } from './ai/circuitPipeline.js';
import { checkCircuitTopology } from '../src/core/topologyRules.js';
import { generateClarifyingQuestions } from './ai/clarifyProvider.js';
import { generateAssistReply } from './ai/assistProvider.js';
import { runNgspiceSimulation } from './simulation/simulator.js';
import { compileSketch } from './compile/compiler.js';
import { buildStreamingSpice } from './circuit/streamingCircuit.js';
import { initDb } from './auth/db.js';
import { handleSignup, handleLogin, handleVerifyEmail, handleMe, verifyJwt } from './auth/auth.js';
import type { ChatMemory, ChatMessage, Circuit, CurrentDesign, JwtPayload, PipelineEvent } from './types.js';

loadEnv();

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Refusing to start without a signing secret.');
  process.exit(1);
}

const port = Number(process.env.PORT || process.env.API_PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
// CORS_ORIGIN may list several allowed origins, comma-separated. The
// Access-Control-Allow-Origin header may only carry ONE origin, so we echo
// back whichever configured origin matches the request (never the raw list —
// a comma-joined value is invalid and browsers reject it, which surfaces to
// the user as a bare "Network error").
const corsOrigins = (process.env.CORS_ORIGIN || 'http://127.0.0.1:5174')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const resolveCorsOrigin = (request: IncomingMessage): string => {
  const origin = request.headers.origin;
  if (origin && corsOrigins.includes(origin)) return origin;
  return corsOrigins[0] || '';
};

const applyCorsHeaders = (request: IncomingMessage, response: ServerResponse): void => {
  response.setHeader('Access-Control-Allow-Origin', resolveCorsOrigin(request));
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  // Responses vary by request Origin, so caches must key on it.
  response.setHeader('Vary', 'Origin');
};
const aiProviderName = (): string => process.env.AI_PROVIDER || 'ollama';
const aiModelName = (): string => (
  process.env.AI_PROVIDER && process.env.AI_PROVIDER !== 'ollama'
    ? process.env.AI_MODEL || ''
    : process.env.OLLAMA_MODEL || 'llama3.2:latest'
);

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  // CORS headers are applied once per request via applyCorsHeaders(); they
  // survive writeHead because they were set with setHeader() beforehand.
  response.writeHead(status, { 'Content-Type': 'application/json' });
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

const startJsonStream = (response: ServerResponse): void => {
  // CORS headers were already set per-request via applyCorsHeaders().
  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
  });
};

const writeStreamEvent = (response: ServerResponse, event: unknown): void => {
  response.write(`${JSON.stringify(event)}\n`);
};

// Reasoning tokens arrive one word at a time; batching them into ~10 events
// per second keeps the NDJSON wire and the client's re-render rate sane.
// Deltas are flushed with the next push after the interval elapses, so a tail
// shorter than the interval is only dropped when the request finishes — at
// which point the thinking display disappears anyway.
const createThinkingBatcher = (write: (delta: string) => void, intervalMs = 100) => {
  let buffer = '';
  let lastFlush = 0;
  return {
    push(delta: string): void {
      buffer += delta;
      const now = Date.now();
      if (now - lastFlush >= intervalMs) {
        lastFlush = now;
        const batched = buffer;
        buffer = '';
        write(batched);
      }
    },
    flush(): void {
      if (!buffer) return;
      const batched = buffer;
      buffer = '';
      write(batched);
    },
  };
};

function getUser(request: IncomingMessage): JwtPayload | null {
  const auth = request.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  return verifyJwt(token);
}

const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
  applyCorsHeaders(request, response);

  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {});
    return;
  }

  if (request.url === '/api/health') {
    sendJson(response, 200, {
      ok: true,
      provider: aiProviderName(),
      model: aiModelName(),
    });
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

  const user = getUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Authentication required.' });
    return;
  }

  if (request.url === '/api/clarify-circuit' && request.method === 'POST') {
    try {
      const body = await readJsonBody(request);
      const prompt = String(body.prompt || '').trim();
      if (!prompt) {
        sendJson(response, 400, { code: 'clarify_failed', error: 'Prompt is required.' });
        return;
      }

      const messages = Array.isArray(body.messages) ? body.messages as ChatMessage[] : [];
      const currentDesign = (body.currentDesign as CurrentDesign)?.circuit ? body.currentDesign as CurrentDesign : null;
      const memory = normalizeChatMemory(body.memory as Partial<ChatMemory> | null);
      startJsonStream(response);
      const thinking = createThinkingBatcher((delta) => writeStreamEvent(response, { type: 'thinking', delta }));
      const result = await generateClarifyingQuestions(prompt, messages, currentDesign, memory, thinking.push);
      writeStreamEvent(response, { type: 'complete', data: result });
      response.end();
    } catch (error) {
      console.error(`[circuit-clarify] ${(error as Error).message}`);
      if (response.headersSent) {
        writeStreamEvent(response, { type: 'error', code: 'clarify_failed', error: (error as Error).message });
        response.end();
      } else {
        sendJson(response, statusFor(error), { code: 'clarify_failed', error: (error as Error).message });
      }
    }
    return;
  }

  if (request.url === '/api/assist-circuit' && request.method === 'POST') {
    try {
      const body = await readJsonBody(request);
      const mode = String(body.mode || '');
      if (mode !== 'plan' && mode !== 'ask') {
        sendJson(response, 400, { code: 'assist_failed', error: 'Mode must be "plan" or "ask".' });
        return;
      }
      const prompt = String(body.prompt || '').trim();
      if (!prompt) {
        sendJson(response, 400, { code: 'assist_failed', error: 'Prompt is required.' });
        return;
      }

      const messages = Array.isArray(body.messages) ? body.messages as ChatMessage[] : [];
      const currentDesign = (body.currentDesign as CurrentDesign)?.circuit ? body.currentDesign as CurrentDesign : null;
      const memory = normalizeChatMemory(body.memory as Partial<ChatMemory> | null);
      startJsonStream(response);
      const thinking = createThinkingBatcher((delta) => writeStreamEvent(response, { type: 'thinking', delta }));
      // Assist replies confirm no design, so chat memory is deliberately not updated.
      const result = await generateAssistReply(mode, prompt, messages, currentDesign, memory, thinking.push);
      writeStreamEvent(response, { type: 'complete', data: result });
      response.end();
    } catch (error) {
      console.error(`[circuit-assist] ${(error as Error).message}`);
      if (response.headersSent) {
        writeStreamEvent(response, { type: 'error', code: 'assist_failed', error: (error as Error).message });
        response.end();
      } else {
        sendJson(response, statusFor(error), { code: 'assist_failed', error: (error as Error).message });
      }
    }
    return;
  }

  if (request.url === '/api/generate-circuit' && request.method === 'POST') {
    try {
      const body = await readJsonBody(request);
      const prompt = String(body.prompt || '').trim();
      if (!prompt) {
        sendJson(response, 400, { error: 'Prompt is required.' });
        return;
      }

      const messages = Array.isArray(body.messages) ? body.messages as ChatMessage[] : [];
      const currentDesign = (body.currentDesign as CurrentDesign)?.circuit ? body.currentDesign as CurrentDesign : null;
      const memory = normalizeChatMemory(body.memory as Partial<ChatMemory> | null);
      const contextDiagnostics = {
        contextTurnCount: sanitizeConversationHistory(messages).length,
        revision: Boolean(currentDesign),
      };
      if (process.env.OLLAMA_CONTEXT_DIAGNOSTICS === '1') {
        console.info(`[circuit-context] turns=${contextDiagnostics.contextTurnCount} revision=${contextDiagnostics.revision}`);
      }
      startJsonStream(response);
      writeStreamEvent(response, {
        type: 'spice',
        provisional: true,
        componentCount: currentDesign?.circuit.components?.length || 0,
        spice: currentDesign?.spice || '* AI is preparing the circuit...\n* Components will appear here as they are generated.',
      });

      let lastSpiceEvent = '';
      const aiResponse = await runCircuitPipeline(prompt, messages, currentDesign, memory, (event: PipelineEvent) => {
        if (event.type === 'stage') {
          writeStreamEvent(response, { type: 'stage', stage: event.stage });
          return;
        }
        const partial = buildStreamingSpice(event.content, prompt, currentDesign?.circuit ?? null);
        const eventKey = `${event.attempt}:${partial.spice}`;
        if (eventKey === lastSpiceEvent) return;
        lastSpiceEvent = eventKey;
        writeStreamEvent(response, {
          type: 'spice',
          provisional: true,
          correcting: event.correcting,
          ...partial,
        });
      });
      const circuit = reconcileCircuitRevision(aiResponse.circuit as unknown as Record<string, unknown>, prompt, currentDesign?.circuit ?? null);
      // Reconciliation can merge the candidate with the prior confirmed
      // design, so run the topology check on what actually ships; the
      // pipeline's reviewer stage already corrected what it could, so the
      // checker's surviving findings are surfaced in the UI, never fatal.
      let issues: Array<Record<string, unknown>> = [];
      try {
        issues = (checkCircuitTopology(circuit) as unknown as { violations: typeof issues }).violations;
      } catch (topologyError) {
        console.error(`[topology-check] ${(topologyError as Error).message}`);
      }
      let updatedMemory: ChatMemory = memory;
      try {
        updatedMemory = updateChatMemory(memory, prompt, circuit);
      } catch (memoryError) {
        console.error(`[chat-memory] ${(memoryError as Error).message}`);
      }
      writeStreamEvent(response, {
        type: 'complete',
        data: {
          ...buildCircuitResponse(circuit, { rawPrompt: prompt, type: circuit.type }, aiProviderName()),
          reply: aiResponse.reply,
          code: aiResponse.code || '',
          memory: updatedMemory,
          issues,
          ...(process.env.OLLAMA_CONTEXT_DIAGNOSTICS === '1' ? { contextDiagnostics } : {}),
        },
      });
      response.end();
    } catch (error) {
      const errorCode = (error as Error & { code?: string }).code || 'generation_failed';
      console.error(`[circuit-generation:${errorCode}] ${(error as Error).message}`);
      if (response.headersSent) {
        writeStreamEvent(response, { type: 'error', code: errorCode, error: (error as Error).message });
        response.end();
      } else {
        sendJson(response, statusFor(error), { code: errorCode, error: (error as Error).message });
      }
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
