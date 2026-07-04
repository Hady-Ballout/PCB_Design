import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { loadEnv } from './env.js';
import { buildCircuitResponse, reconcileCircuitRevision } from './circuitResponse.js';
import { normalizeChatMemory, sanitizeConversationHistory, updateChatMemory } from './chatMemory.js';
import { streamCircuitWithOllama } from './ollamaProvider.js';
import { runNgspiceSimulation } from './simulator.js';
import { buildStreamingSpice } from './streamingCircuit.js';
import { initDb } from './db.js';
import { handleSignup, handleLogin, handleVerifyEmail, handleMe, verifyJwt } from './auth.js';
import type { ChatMemory, ChatMessage, Circuit, CurrentDesign, JwtPayload, StreamState } from './types.js';

loadEnv();

const port = Number(process.env.PORT || process.env.API_PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const corsOrigin = process.env.CORS_ORIGIN || 'http://127.0.0.1:5174';
const aiProviderName = (): string => process.env.AI_PROVIDER || 'ollama';
const aiModelName = (): string => (
  process.env.AI_PROVIDER && process.env.AI_PROVIDER !== 'ollama'
    ? process.env.AI_MODEL || ''
    : process.env.OLLAMA_MODEL || 'llama3.2:latest'
);

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  response.end(JSON.stringify(body));
};

const readJsonBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
};

const startJsonStream = (response: ServerResponse): void => {
  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
};

const writeStreamEvent = (response: ServerResponse, event: unknown): void => {
  response.write(`${JSON.stringify(event)}\n`);
};

function getUser(request: IncomingMessage): JwtPayload | null {
  const auth = request.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  return verifyJwt(token);
}

const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
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
      sendJson(response, 500, { error: (error as Error).message });
    }
    return;
  }

  if (request.url === '/api/auth/login' && request.method === 'POST') {
    try {
      const body = await readJsonBody(request);
      const result = await handleLogin(body);
      sendJson(response, result.status, result.body);
    } catch (error) {
      sendJson(response, 500, { error: (error as Error).message });
    }
    return;
  }

  if (request.url?.startsWith('/api/auth/verify') && request.method === 'POST') {
    try {
      const body = await readJsonBody(request);
      const result = await handleVerifyEmail(body.token as string | undefined);
      sendJson(response, result.status, result.body);
    } catch (error) {
      sendJson(response, 500, { error: (error as Error).message });
    }
    return;
  }

  if (request.url === '/api/auth/me' && request.method === 'GET') {
    try {
      const result = await handleMe(request);
      sendJson(response, result.status, result.body);
    } catch (error) {
      sendJson(response, 500, { error: (error as Error).message });
    }
    return;
  }

  const user = getUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Authentication required.' });
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
      const aiResponse = await streamCircuitWithOllama(prompt, messages, currentDesign, (content: string, streamState: StreamState) => {
        const partial = buildStreamingSpice(content, prompt, currentDesign?.circuit ?? null);
        const eventKey = `${streamState.attempt}:${partial.spice}`;
        if (eventKey === lastSpiceEvent) return;
        lastSpiceEvent = eventKey;
        writeStreamEvent(response, {
          type: 'spice',
          provisional: true,
          correcting: streamState.correcting,
          ...partial,
        });
      }, memory);
      const circuit = reconcileCircuitRevision(aiResponse.circuit as unknown as Record<string, unknown>, prompt, currentDesign?.circuit ?? null);
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
          memory: updatedMemory,
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
        sendJson(response, 500, { code: errorCode, error: (error as Error).message });
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
      sendJson(response, 500, { error: (error as Error).message });
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
