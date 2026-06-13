import { createServer } from 'node:http';
import { loadEnv } from './env.js';
import { buildCircuitResponse, reconcileCircuitRevision } from './circuitResponse.js';
import { streamCircuitWithOllama } from './ollamaProvider.js';
import { runNgspiceSimulation } from './simulator.js';
import { buildStreamingSpice } from './streamingCircuit.js';

loadEnv();

const port = Number(process.env.API_PORT || 8787);

const sendJson = (response, status, body) => {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'http://127.0.0.1:5173',
    'Access-Control-Allow-Headers': 'Content-Type',
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

const startJsonStream = (response) => {
  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Access-Control-Allow-Origin': 'http://127.0.0.1:5173',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
};

const writeStreamEvent = (response, event) => {
  response.write(`${JSON.stringify(event)}\n`);
};

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {});
    return;
  }

  if (request.url === '/api/health') {
    sendJson(response, 200, {
      ok: true,
      provider: 'ollama',
      model: process.env.OLLAMA_MODEL || 'llama3.2:latest',
    });
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

      const messages = Array.isArray(body.messages) ? body.messages : [];
      const currentDesign = body.currentDesign?.circuit ? body.currentDesign : null;
      startJsonStream(response);
      writeStreamEvent(response, {
        type: 'spice',
        provisional: true,
        componentCount: currentDesign?.circuit.components?.length || 0,
        spice: currentDesign?.spice || '* AI is preparing the circuit...\n* Components will appear here as they are generated.',
      });

      let lastSpiceEvent = '';
      const aiCircuit = await streamCircuitWithOllama(prompt, messages, currentDesign, (content, streamState) => {
        const partial = buildStreamingSpice(content, prompt, currentDesign?.circuit);
        const eventKey = `${streamState.attempt}:${partial.spice}`;
        if (eventKey === lastSpiceEvent) return;
        lastSpiceEvent = eventKey;
        writeStreamEvent(response, {
          type: 'spice',
          provisional: true,
          correcting: streamState.correcting,
          ...partial,
        });
      });
      const circuit = reconcileCircuitRevision(aiCircuit, prompt, currentDesign?.circuit);
      writeStreamEvent(response, {
        type: 'complete',
        data: buildCircuitResponse(circuit, { rawPrompt: prompt, type: circuit.type }, 'ollama'),
      });
      response.end();
    } catch (error) {
      const errorCode = error.code || 'generation_failed';
      console.error(`[circuit-generation:${errorCode}] ${error.message}`);
      if (response.headersSent) {
        writeStreamEvent(response, { type: 'error', code: errorCode, error: error.message });
        response.end();
      } else {
        sendJson(response, 500, { code: errorCode, error: error.message });
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

server.listen(port, '127.0.0.1', () => {
  console.log(`Prompt-to-PCB API listening on http://127.0.0.1:${port}`);
});
