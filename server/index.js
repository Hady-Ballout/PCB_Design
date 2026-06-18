import { createServer } from 'node:http';
import { loadEnv } from './env.js';
import { buildCircuitResponse, normalizeAiCircuit } from './circuitResponse.js';
import { generateCircuit } from './aiProvider.js';
import { runNgspiceSimulation } from './simulator.js';

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

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {});
    return;
  }

  if (request.url === '/api/health') {
    sendJson(response, 200, {
      ok: true,
      provider,
      model,
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

      const aiCircuit = await generateCircuit(prompt);
      const circuit = normalizeAiCircuit(aiCircuit, prompt);
      sendJson(response, 200, buildCircuitResponse(circuit, { rawPrompt: prompt, type: circuit.type }, provider));
    } catch (error) {
      sendJson(response, 500, { error: error.message });
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

server.listen(port, host, () => {
  console.log(`Prompt-to-PCB API listening on http://${host}:${port}`);
});
