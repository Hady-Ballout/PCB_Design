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

const CIRCUIT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    type: { type: 'string' },
    supplyVoltage: { type: 'number' },
    nodes: { type: 'array', items: { type: 'string' } },
    components: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          kind: {
            type: 'string',
            enum: [
              'resistor',
              'capacitor',
              'inductor',
              'diode',
              'led',
              'bjt_npn',
              'bjt_pnp',
              'mosfet_n',
              'mosfet_p',
              'opamp',
              'regulator',
              'voltage_source',
              'signal_source',
              'load',
            ],
          },
          value: { type: 'string' },
          nodes: { type: 'array', items: { type: 'string' } },
          footprint: { type: 'string' },
        },
        required: ['ref', 'kind', 'value', 'nodes', 'footprint'],
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'type', 'supplyVoltage', 'nodes', 'components', 'notes'],
};

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

export async function generateCircuitWithOllama(prompt) {
  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const model = process.env.OLLAMA_MODEL || 'llama3.2:latest';
  const apiKey = process.env.OLLAMA_API_KEY;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      stream: false,
      format: 'json',
      options: {
        num_ctx: 2048,
        num_predict: 1400,
        temperature: 0.2,
      },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Return this exact JSON shape with real circuit values:
{"title":"...","type":"...","supplyVoltage":0,"nodes":["0"],"components":[{"ref":"R1","kind":"resistor","value":"1k","nodes":["A","0"],"footprint":"Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P7.62mm_Horizontal"}],"notes":["..."]}
Use SPICE-safe component refs. For example, an LED must be {"ref":"DLED1","kind":"led",...}, not {"ref":"LED1",...}.
Circuit prompt: ${prompt}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return extractJson(data.message?.content || '');
}
