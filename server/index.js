import { createServer } from 'node:http';
import { loadEnv } from './env.js';
import { buildCircuitResponse, reconcileCircuitRevision } from './circuitResponse.js';
import { normalizeChatMemory, sanitizeConversationHistory, updateChatMemory } from './chatMemory.js';
import { generateCircuit } from './aiProvider.js';
import { runNgspiceSimulation } from './simulator.js';
import { initDb } from './db.js';
import { handleSignup, handleLogin, handleVerifyEmail, handleMe, verifyJwt } from './auth.js';

loadEnv();

const port = Number(process.env.PORT || process.env.API_PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const corsOrigin = process.env.CORS_ORIGIN || 'http://127.0.0.1:5173';

const provider = process.env.AI_PROVIDER || 'ollama';
const model = process.env.AI_MODEL || process.env.OLLAMA_MODEL || 'llama3.2:latest';

const sendJson = (response, status, body) => {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  response.end(JSON.stringify(body));
};

const readJsonBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
};

// Auth guard — returns user payload or null
function getUser(request) {
  const auth = request.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  return verifyJwt(token);
}

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {});
    return;
  }

  // ── Public routes ──

  if (request.url === '/api/health') {
    sendJson(response, 200, { ok: true, provider, model });
    return;
  }

  if (request.url === '/api/auth/signup' && request.method === 'POST') {
    try {
      const body = await readJsonBody(request);
      const result = await handleSignup(body);
      sendJson(response, result.status, result.body);
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
    return;
  }

  if (request.url === '/api/auth/login' && request.method === 'POST') {
    try {
      const body = await readJsonBody(request);
      const result = await handleLogin(body);
      sendJson(response, result.status, result.body);
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
    return;
  }

  if (request.url?.startsWith('/api/auth/verify') && request.method === 'POST') {
    try {
      const body = await readJsonBody(request);
      const result = await handleVerifyEmail(body.token);
      sendJson(response, result.status, result.body);
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
    return;
  }

  if (request.url === '/api/auth/me' && request.method === 'GET') {
    try {
      const result = await handleMe(request);
      sendJson(response, result.status, result.body);
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
    return;
  }

  // ── Protected routes (require auth) ──

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

      // Preserve main's conversation/memory/revision context, but use the
      // production (non-streaming) provider from the deployment branch.
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const currentDesign = body.currentDesign?.circuit ? body.currentDesign : null;
      const memory = normalizeChatMemory(body.memory);
      const contextDiagnostics = {
        contextTurnCount: sanitizeConversationHistory(messages).length,
        revision: Boolean(currentDesign),
      };
      if (process.env.AI_CONTEXT_DIAGNOSTICS === '1' || process.env.OLLAMA_CONTEXT_DIAGNOSTICS === '1') {
        console.info(`[circuit-context] turns=${contextDiagnostics.contextTurnCount} revision=${contextDiagnostics.revision}`);
      }

      const aiCircuit = await generateCircuit(prompt, messages, currentDesign, memory);
      const circuit = reconcileCircuitRevision(aiCircuit, prompt, currentDesign?.circuit);

      let updatedMemory = memory;
      try {
        updatedMemory = updateChatMemory(memory, prompt, circuit);
      } catch (memoryError) {
        console.error(`[chat-memory] ${memoryError.message}`);
      }

      sendJson(response, 200, {
        ...buildCircuitResponse(circuit, { rawPrompt: prompt, type: circuit.type }, provider),
        memory: updatedMemory,
        ...(process.env.AI_CONTEXT_DIAGNOSTICS === '1' ? { contextDiagnostics } : {}),
      });
    } catch (error) {
      const errorCode = error.code || 'generation_failed';
      console.error(`[circuit-generation:${errorCode}] ${error.message}`);
      sendJson(response, 500, { code: errorCode, error: error.message });
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
        circuit: body.circuit,
        spice: body.spice,
      });
      sendJson(response, simulation.ok ? 200 : 422, simulation);
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
    return;
  }

  sendJson(response, 404, { error: 'Not found.' });
});

// Initialize DB then start server
initDb()
  .then(() => {
    server.listen(port, host, () => {
      console.log(`Prompt-to-PCB API listening on http://${host}:${port}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
