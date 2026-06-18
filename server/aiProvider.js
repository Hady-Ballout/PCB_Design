const SYSTEM_PROMPT = `You are a JSON API for beginner-safe electronics circuit generation.
Return exactly one valid JSON object and no other text.
Use node "0" for ground.
Every component needs ref, kind, value, nodes, and footprint.
Allowed component kinds: resistor, capacitor, inductor, diode, led, bjt_npn, bjt_pnp, mosfet_n, mosfet_p, opamp, regulator, voltage_source, signal_source, load.
Component refs must be SPICE-compatible because the program will simulate them with Ngspice:
- resistor refs start with R, e.g. R1
- capacitor refs start with C, e.g. C1
- inductor refs start with L, e.g. L1
- diode and led refs start with D, e.g. D1 or DLED1; never use LED1
- voltage_source and signal_source refs start with V, e.g. V1 or VSIG1
- bjt refs start with Q, e.g. Q1
- mosfet refs start with M, e.g. M1
- opamp/subcircuit refs start with X, e.g. XU1
- load refs should be modeled as resistors and start with R, e.g. RLOAD
- regulator refs may use U in the JSON, but include enough surrounding passives/load nodes for simulation.
Use simple Ngspice-friendly values such as 1k, 100nF, 10uF, 5V, and SINE(0 1 1k).`;

const USER_PROMPT_TEMPLATE = (prompt) =>
  `Return this exact JSON shape with real circuit values:
{"title":"...","type":"...","supplyVoltage":0,"nodes":["0"],"components":[{"ref":"R1","kind":"resistor","value":"1k","nodes":["A","0"],"footprint":"Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P7.62mm_Horizontal"}],"notes":["..."]}
Use SPICE-safe component refs. For example, an LED must be {"ref":"DLED1","kind":"led",...}, not {"ref":"LED1",...}.
Circuit prompt: ${prompt}`;

// ── JSON repair helpers (unchanged) ──

function closeJsonFragment(text) {
  let repaired = text.trim();
  repaired = repaired.replace(/,\s*([}\]])/g, '$1');

  const quoteCount = [...repaired].filter((char) => char === '"' && !repaired.endsWith('\\"')).length;
  if (quoteCount % 2 === 1) repaired += '"';

  const stack = [];
  let inString = false;
  let escaped = false;

  for (const char of repaired) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === '{' || char === '[') stack.push(char);
    if (char === '}' && stack.at(-1) === '{') stack.pop();
    if (char === ']' && stack.at(-1) === '[') stack.pop();
  }

  while (stack.length) {
    repaired += stack.pop() === '[' ? ']' : '}';
  }

  return repaired;
}

function findBalancedJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return '';

  let inString = false;
  let escaped = false;
  let depth = 0;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    if (inString) continue;

    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }

  return text.slice(start);
}

function removeIncompleteTrailingProperty(jsonText) {
  let text = jsonText.trim();
  const lastProp = text.lastIndexOf(',"');
  const lastBrace = text.lastIndexOf('}');
  if (lastProp > -1 && lastProp > lastBrace) text = text.slice(0, lastProp);
  return closeJsonFragment(text);
}

function extractJson(text) {
  const trimmed = text.trim();
  const jsonText = findBalancedJson(trimmed);
  if (!jsonText) {
    throw new Error(`AI response did not contain a JSON object. Raw: ${trimmed.slice(0, 180)}`);
  }

  try {
    return JSON.parse(jsonText);
  } catch (error) {
    try {
      return JSON.parse(closeJsonFragment(jsonText));
    } catch {
      return JSON.parse(removeIncompleteTrailingProperty(jsonText));
    }
  }
}

// ── Provider detection ──

function getProviderConfig() {
  const provider = (process.env.AI_PROVIDER || 'ollama').toLowerCase();

  if (provider === 'ollama') {
    return {
      provider: 'ollama',
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      model: process.env.OLLAMA_MODEL || 'llama3.2:latest',
      apiKey: process.env.OLLAMA_API_KEY || '',
    };
  }

  // OpenAI-compatible: groq, openrouter, together, openai, or any custom endpoint
  return {
    provider,
    baseUrl: process.env.AI_API_URL || '',
    model: process.env.AI_MODEL || '',
    apiKey: process.env.AI_API_KEY || '',
  };
}

// ── Ollama request ──

async function callOllama(prompt, config) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      stream: false,
      format: 'json',
      options: {
        num_ctx: 2048,
        num_predict: 1400,
        temperature: 0.2,
      },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: USER_PROMPT_TEMPLATE(prompt) },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return data.message?.content || '';
}

// ── OpenAI-compatible request (Groq, OpenRouter, Together, etc.) ──

async function callOpenAICompatible(prompt, config) {
  if (!config.baseUrl) throw new Error('AI_API_URL is not set.');
  if (!config.model) throw new Error('AI_MODEL is not set.');

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  };

  // OpenRouter wants this header
  if (config.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://pcb-pilot.web.app';
    headers['X-Title'] = 'PCB Pilot';
  }

  const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      max_tokens: 1400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: USER_PROMPT_TEMPLATE(prompt) },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`${config.provider} returned ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

// ── Public API (drop-in replacement for generateCircuitWithOllama) ──

export async function generateCircuit(prompt) {
  const config = getProviderConfig();
  const raw =
    config.provider === 'ollama'
      ? await callOllama(prompt, config)
      : await callOpenAICompatible(prompt, config);

  return extractJson(raw);
}

// Keep backward-compatible export name
export const generateCircuitWithOllama = generateCircuit;
