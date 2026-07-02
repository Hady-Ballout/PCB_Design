import { normalizeChatMemory, sanitizeConversationHistory } from './chatMemory.js';
import { circuitKnowledgePrompt } from './circuitKnowledge.js';
import { parseSpiceNetlist } from '../src/lib/circuitSync.js';

const SYSTEM_PROMPT = `You are a JSON API for beginner-safe electronics circuit generation.
Return exactly one valid JSON object and no other text.
The top-level object must contain "reply", "circuit", and "spice".
The "reply" field is a concise, conversational explanation of what you built or changed for the user. Mention important component refs when helpful, such as RLOAD, R1, or C1. Do not use Markdown.
The "circuit" field is the canonical structured circuit.
The "spice" field is a SPICE netlist generated from the same circuit.
Use node "0" for ground.
Every component needs ref, kind, value, nodes, and footprint.
The circuit may include optional "schematic" metadata for layout intent. Schematic metadata is visual only and must not add SPICE components.
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
- opamp components must use value LM358 in JSON and LM358 as the SPICE subcircuit name; do not use GENERIC or OPAMP.
- load refs should be modeled as resistors and start with R, e.g. RLOAD
- regulator refs may use U in the JSON, but include enough surrounding passives/load nodes for simulation.
Use simple Ngspice-friendly values such as 1k, 100nF, 10uF, 5V, and SINE(0 1 1k).
Use voltage_source for DC supplies and fixed DC input biases. Use signal_source only for waveform or time-varying sources such as SINE(...), PULSE(...), PWL(...), EXP(...), or AC.
If SPICE uses "V... ... DC value", the matching JSON component kind must be voltage_source. If SPICE uses a waveform source, the matching JSON component kind must be signal_source.
The SPICE netlist must use the exact same component refs, values, and node names as circuit.components.`;

const SCHEMATIC_SCHEMA = {
  type: 'object',
  properties: {
    version: { type: 'number' },
    topology: { type: 'string' },
    primaryRef: { type: 'string' },
    externalTerminals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          net: { type: 'string' },
          label: { type: 'string' },
          type: { type: 'string' },
          side: { type: 'string', enum: ['left', 'right', 'top', 'bottom'] },
        },
        required: ['net', 'label', 'type', 'side'],
      },
    },
    netRoles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          net: { type: 'string' },
          role: { type: 'string' },
          side: { type: 'string', enum: ['left', 'right', 'top', 'bottom', 'center'] },
        },
        required: ['net', 'role'],
      },
    },
    componentRoles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          role: { type: 'string' },
          block: { type: 'string' },
          side: { type: 'string', enum: ['left', 'right', 'top', 'bottom', 'center'] },
          orientation: { type: 'string', enum: ['horizontal', 'vertical'] },
          order: { type: 'number' },
          pinRoles: { type: 'object' },
        },
        required: ['ref', 'role'],
      },
    },
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          role: { type: 'string' },
          refs: { type: 'array', items: { type: 'string' } },
          side: { type: 'string', enum: ['left', 'right', 'top', 'bottom', 'center'] },
          order: { type: 'number' },
        },
        required: ['id', 'role', 'refs'],
      },
    },
  },
};

export const CIRCUIT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    type: { type: 'string' },
    supplyVoltage: { type: 'number' },
    nodes: { type: 'array', items: { type: 'string' }, minItems: 1 },
    components: {
      type: 'array',
      minItems: 1,
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
          nodes: { type: 'array', items: { type: 'string' }, minItems: 1 },
          footprint: { type: 'string' },
        },
        required: ['ref', 'kind', 'value', 'nodes', 'footprint'],
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
    schematic: SCHEMATIC_SCHEMA,
  },
  required: ['title', 'type', 'supplyVoltage', 'nodes', 'components', 'notes'],
};

export const AI_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    circuit: CIRCUIT_SCHEMA,
    spice: { type: 'string' },
  },
  required: ['reply', 'circuit', 'spice'],
};

function findBalancedJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return { jsonText: '', balanced: false };

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
    if (depth === 0) return { jsonText: text.slice(start, index + 1), balanced: true };
  }

  return { jsonText: text.slice(start), balanced: false };
}

class CircuitGenerationError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CircuitGenerationError';
    this.code = code;
  }
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const cleanReply = (value) => String(value || '').trim().replace(/\s+/g, ' ').slice(0, 1200);

const describeComponent = (component) => {
  const ref = String(component?.ref || '').toUpperCase();
  const kind = String(component?.kind || 'component');
  const value = String(component?.value || 'unknown value');
  const nodes = Array.isArray(component?.nodes) ? component.nodes.join(' - ') : 'unknown nodes';
  return `${ref}: ${kind}, value=${value}, nodes=${nodes}`;
};

const currentCircuitInventory = (circuit) => {
  const components = Array.isArray(circuit?.components) ? circuit.components : [];
  if (!components.length) return '';
  const refs = components.map((component) => String(component.ref || '').toUpperCase()).filter(Boolean);
  const loadRefs = components
    .filter((component) => (
      String(component.ref || '').toUpperCase().includes('LOAD')
      || String(component.kind || '').toLowerCase() === 'load'
    ))
    .map(describeComponent);
  return [
    `Current component inventory (${components.length} components):`,
    ...components.map(describeComponent),
    refs.length ? `Known refs and aliases are case-insensitive: ${refs.join(', ')}.` : '',
    loadRefs.length
      ? `Load references present now: ${loadRefs.join('; ')}. User phrases like "Rload", "RLOAD", "load resistor", or "the load" refer to these current load components unless they explicitly ask for a new load.`
      : '',
  ].filter(Boolean).join('\n');
};

export function validateCircuitResponse(circuit) {
  const errors = [];
  if (!isPlainObject(circuit)) return ['response must be a JSON object'];

  if (typeof circuit.title !== 'string') errors.push('title must be a string');
  if (typeof circuit.type !== 'string') errors.push('type must be a string');
  if (!Number.isFinite(circuit.supplyVoltage)) errors.push('supplyVoltage must be a number');
  if (!Array.isArray(circuit.nodes) || circuit.nodes.length === 0 || circuit.nodes.some((node) => typeof node !== 'string')) {
    errors.push('nodes must be a non-empty array of strings');
  }
  if (!Array.isArray(circuit.notes) || circuit.notes.some((note) => typeof note !== 'string')) {
    errors.push('notes must be an array of strings');
  }
  if (circuit.schematic !== undefined && !isPlainObject(circuit.schematic)) {
    errors.push('schematic must be an object when present');
  }
  if (!Array.isArray(circuit.components) || circuit.components.length === 0) {
    errors.push('components must be a non-empty array');
  } else {
    const allowedKinds = new Set(CIRCUIT_SCHEMA.properties.components.items.properties.kind.enum);
    circuit.components.forEach((component, index) => {
      const label = `components[${index}]`;
      if (!isPlainObject(component)) {
        errors.push(`${label} must be an object`);
        return;
      }
      if (typeof component.ref !== 'string' || !component.ref) errors.push(`${label}.ref must be a non-empty string`);
      if (!allowedKinds.has(component.kind)) errors.push(`${label}.kind is not supported`);
      if (typeof component.value !== 'string' || !component.value) errors.push(`${label}.value must be a non-empty string`);
      if (!Array.isArray(component.nodes) || component.nodes.length === 0 || component.nodes.some((node) => typeof node !== 'string')) {
        errors.push(`${label}.nodes must be a non-empty array of strings`);
      }
      if (typeof component.footprint !== 'string') errors.push(`${label}.footprint must be a string`);
    });
  }

  return errors;
}

const OPAMP_MODEL = 'LM358';
const OPAMP_MODEL_ALIASES = new Set(['', 'GENERIC', 'OPAMP', 'UNKNOWN']);

const normalizeOpampModel = (value) => {
  const normalized = String(value || '').trim().toUpperCase();
  return OPAMP_MODEL_ALIASES.has(normalized) || normalized === OPAMP_MODEL ? OPAMP_MODEL : normalized;
};

const isSourceKind = (kind) => kind === 'voltage_source' || kind === 'signal_source';

const voltageValue = (value) => {
  const text = String(value || '').trim();
  return /v$/i.test(text) ? text : `${text}V`;
};

const sourceExpressionKind = (value) => {
  const expression = String(value || '').trim();
  if (/^(SINE|SIN|PULSE|PWL|EXP|AC)\b/i.test(expression)) return 'signal_source';
  if (/^DC\b/i.test(expression)) return 'voltage_source';
  if (/^[+-]?\d+(?:\.\d+)?(?:[munpfkKMegG]+)?V?$/i.test(expression)) return 'voltage_source';
  return null;
};

const normalizeSourceComponent = (component) => {
  if (!isSourceKind(component.kind)) return component;
  const expression = String(component.value || '').trim();
  const kind = sourceExpressionKind(expression) || component.kind;
  const dcMatch = expression.match(/^DC\s+(.+)$/i);
  if (kind === 'voltage_source') {
    return {
      ...component,
      kind,
      value: voltageValue(dcMatch ? dcMatch[1] : expression),
    };
  }
  return { ...component, kind, value: expression };
};

export const normalizeCircuitForValidation = (circuit) => ({
  ...circuit,
  components: (circuit.components || []).map((component) => {
    const normalizedSource = normalizeSourceComponent(component);
    return normalizedSource.kind === 'opamp'
      ? { ...normalizedSource, value: OPAMP_MODEL }
      : normalizedSource;
  }),
});

const normalizeSignatureValue = (component) => (
  component.kind === 'opamp'
    ? normalizeOpampModel(component.value)
    : String(component.value || '').trim().toUpperCase()
);

const electricalSignature = (circuit) => (
  circuit?.components || []
).map((component) => ({
  ref: String(component.ref || '').toUpperCase(),
  kind: String(component.kind || ''),
  value: normalizeSignatureValue(component),
  nodes: (component.nodes || []).map((node) => String(node)),
})).sort((a, b) => a.ref.localeCompare(b.ref));

const describeSignatureMismatch = (expected, actual) => {
  const expectedByRef = new Map(expected.map((component) => [component.ref, component]));
  const actualByRef = new Map(actual.map((component) => [component.ref, component]));
  const missing = expected.filter((component) => !actualByRef.has(component.ref)).map((component) => component.ref);
  const extra = actual.filter((component) => !expectedByRef.has(component.ref)).map((component) => component.ref);
  if (missing.length) return `SPICE is missing component ${missing[0]}.`;
  if (extra.length) return `SPICE includes unexpected component ${extra[0]}.`;

  for (const expectedComponent of expected) {
    const actualComponent = actualByRef.get(expectedComponent.ref);
    if (!actualComponent) continue;
    if (actualComponent.kind !== expectedComponent.kind) {
      return `${expectedComponent.ref} has kind ${actualComponent.kind} in SPICE but ${expectedComponent.kind} in JSON.`;
    }
    if (actualComponent.value !== expectedComponent.value) {
      return `${expectedComponent.ref} has value ${actualComponent.value} in SPICE but ${expectedComponent.value} in JSON.`;
    }
    if (JSON.stringify(actualComponent.nodes) !== JSON.stringify(expectedComponent.nodes)) {
      return `${expectedComponent.ref} has nodes ${actualComponent.nodes.join(', ')} in SPICE but ${expectedComponent.nodes.join(', ')} in JSON.`;
    }
  }

  return 'SPICE does not match the JSON circuit.';
};

export function validateAiSpice(spice, circuit) {
  if (typeof spice !== 'string' || !spice.trim()) {
    throw new CircuitGenerationError('spice_validation', 'AI response must include a non-empty spice string.');
  }

  const parsed = parseSpiceNetlist(spice, circuit);
  if (!parsed.ok) {
    throw new CircuitGenerationError(
      'spice_validation',
      `AI SPICE netlist could not be parsed: ${parsed.errors.slice(0, 3).join('; ')}.`,
    );
  }

  const expected = electricalSignature(circuit);
  const actual = electricalSignature(parsed.circuit);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new CircuitGenerationError('spice_validation', describeSignatureMismatch(expected, actual));
  }
}

export function parseCircuitResponse(text) {
  const trimmed = text.trim();
  const { jsonText, balanced } = findBalancedJson(trimmed);
  if (!jsonText) {
    throw new CircuitGenerationError('json_missing', 'AI response did not contain a JSON object.');
  }
  if (!balanced) {
    throw new CircuitGenerationError('json_truncated', 'AI response ended before the JSON object was complete.');
  }

  let responseObject;
  try {
    responseObject = JSON.parse(jsonText);
  } catch (error) {
    throw new CircuitGenerationError('json_syntax', `AI returned malformed JSON: ${error.message}`, error);
  }

  if (!isPlainObject(responseObject)) {
    throw new CircuitGenerationError('schema_validation', 'AI response must be a JSON object.');
  }
  const reply = cleanReply(responseObject.reply);
  if (!reply) {
    throw new CircuitGenerationError('schema_validation', 'AI response must include a conversational reply string.');
  }
  if (!isPlainObject(responseObject.circuit)) {
    throw new CircuitGenerationError('schema_validation', 'AI response must include a circuit object.');
  }

  const circuit = responseObject.circuit;
  const validationErrors = validateCircuitResponse(circuit);
  if (validationErrors.length) {
    throw new CircuitGenerationError(
      'schema_validation',
      `AI circuit did not match the required schema: ${validationErrors.slice(0, 4).join('; ')}.`,
    );
  }
  const normalizedCircuit = normalizeCircuitForValidation(circuit);
  validateAiSpice(responseObject.spice, normalizedCircuit);

  return { reply, circuit: normalizedCircuit, spice: responseObject.spice };
}

const positiveIntegerOption = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const buildOllamaRequestBody = (
  prompt,
  history,
  stream,
  currentDesign = null,
  memory = null,
  correction = null,
) => {
  const conversation = sanitizeConversationHistory(history)
    .map((message) => ({
      role: message.role,
      content: message.role === 'assistant'
        ? JSON.stringify(message.circuit).slice(0, 12000)
        : `Previous circuit request: ${String(message.content || '')}`,
    }));

  const normalizedMemory = normalizeChatMemory(memory);
  const memoryContext = normalizedMemory.summary
    ? [{ role: 'system', content: `Active chat memory:\n${normalizedMemory.summary}` }]
    : [];
  const revisionContext = currentDesign?.circuit
    ? [{
        role: 'system',
        content: `This request belongs to an existing circuit conversation. The following circuit is the exact canonical current design:\n${JSON.stringify(currentDesign.circuit)}\n${currentCircuitInventory(currentDesign.circuit)}\nCurrent edited SPICE deck, included only as supplemental context:\n${String(currentDesign.spice || '').slice(0, 6000)}\nCurrent edited KiCad netlist, included only as supplemental context:\n${String(currentDesign.kicadNetlist || '').slice(0, 6000)}\nTreat the new request as an edit to this exact current design. If the user names a component ref case-insensitively, such as Rload, RLOAD, RLoad, or "the load resistor", modify or remove that existing component when present instead of inventing a new circuit. Keep every unchanged component, reference, node, value, and footprint exactly as-is. Only replace the whole design when the new request explicitly asks to start over, replace it, or create a different circuit.`,
      }]
    : [];

  const correctionMessages = correction
    ? [
        { role: 'assistant', content: String(correction.content || '').slice(0, 8000) },
        {
          role: 'user',
          content: `Your previous response was rejected: ${correction.error}. Return the complete response again as one valid JSON object with top-level "reply", "circuit", and "spice". The reply must be conversational and concise. The SPICE must exactly match the JSON circuit refs, values, and node names. Do not explain the correction and do not use Markdown outside the JSON.`,
        },
      ]
    : [];
  const knowledgePrompt = circuitKnowledgePrompt();

  return {
    model: process.env.OLLAMA_MODEL || 'llama3.2:latest',
    stream,
    format: AI_RESPONSE_SCHEMA,
    options: {
      num_ctx: positiveIntegerOption(process.env.OLLAMA_NUM_CTX, 8192),
      num_predict: positiveIntegerOption(process.env.OLLAMA_NUM_PREDICT, 2400),
      temperature: 0,
    },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...(knowledgePrompt ? [{ role: 'system', content: knowledgePrompt }] : []),
      ...memoryContext,
      ...revisionContext,
      ...conversation,
      {
        role: 'user',
        content: `Return this exact JSON shape with real circuit values:
{"reply":"I built a concise explanation of the circuit or edit for the user.","circuit":{"title":"...","type":"...","supplyVoltage":5,"nodes":["0"],"components":[{"ref":"R1","kind":"resistor","value":"1k","nodes":["A","0"],"footprint":"Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P7.62mm_Horizontal"}],"schematic":{"version":1,"topology":"...","primaryRef":"XU1","externalTerminals":[{"net":"VIN","label":"VIN","type":"input","side":"left"},{"net":"VOUT","label":"VOUT","type":"output","side":"right"}],"netRoles":[{"net":"VIN","role":"input","side":"left"},{"net":"VOUT","role":"output","side":"right"},{"net":"0","role":"ground","side":"bottom"}],"componentRoles":[{"ref":"R1","role":"input_network","block":"input","side":"left","orientation":"horizontal","order":1,"pinRoles":{"1":"input","2":"output"}}],"blocks":[{"id":"input","role":"input_network","refs":["R1"],"side":"left","order":1}]},"notes":["..."]},"spice":"* Example\\nR1 A 0 1k\\n.end"}
Use SPICE-safe component refs. For example, an LED must be {"ref":"DLED1","kind":"led",...}, not {"ref":"LED1",...}.
For op amps, use {"ref":"XU1","kind":"opamp","value":"LM358",...} and use LM358 as the SPICE subcircuit name; never use GENERIC or OPAMP.
For sources, use voltage_source for DC values and signal_source only for waveform values like SINE(...), PULSE(...), PWL(...), EXP(...), or AC.
Use schematic metadata to describe human schematic intent: primary op amp/component, input/output ports, feedback networks, load groups, power rails, and preferred sides/orientations.
Mark intentional single-pin user connections such as VINP, VINN, VIN, VOUT, CTRL, or test points in schematic.externalTerminals. Do not mark accidental floating internal nets as external terminals.
Schematic metadata is visual only. Do not create extra SPICE lines for externalTerminals, netRoles, componentRoles, or blocks.
The SPICE field must describe the same circuit.components entries using the same refs, values, and node names.
The reply field should sound like a helpful chat assistant: briefly explain what changed, mention relevant refs, and do not paste the netlist.
Circuit prompt: ${prompt}
This is a follow-up whenever canonical design context is present. Preserve all prior requirements and unchanged design details. Replace the whole circuit only when this request explicitly asks to start over, replace it, or create a different circuit.`,
      },
      ...correctionMessages,
    ],
  };
};

const ollamaHeaders = () => {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.OLLAMA_API_KEY) headers.Authorization = `Bearer ${process.env.OLLAMA_API_KEY}`;
  return headers;
};

const retryableOutputCodes = new Set([
  'json_missing',
  'json_truncated',
  'json_syntax',
  'schema_validation',
  'spice_validation',
]);

const finalOutputError = (error) => new CircuitGenerationError(
  error.code || 'invalid_output',
  `Circuit generation failed after one automatic correction attempt. ${error.message}`,
  error,
);

const parseWithCorrectionRetry = async (requestAttempt) => {
  let correction = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const content = await requestAttempt(correction, attempt);
    try {
      return parseCircuitResponse(content);
    } catch (error) {
      if (attempt === 1 || !retryableOutputCodes.has(error.code)) throw finalOutputError(error);
      correction = { content, error: error.message };
    }
  }
  throw new CircuitGenerationError('invalid_output', 'Circuit generation did not return a usable response.');
};

const ollamaUrl = () => `${(process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '')}/api/chat`;

export async function generateCircuitWithOllama(prompt, history = [], currentDesign = null, memory = null) {
  return parseWithCorrectionRetry(async (correction) => {
    const response = await fetch(ollamaUrl(), {
      method: 'POST',
      headers: ollamaHeaders(),
      body: JSON.stringify(buildOllamaRequestBody(prompt, history, false, currentDesign, memory, correction)),
    });

    if (!response.ok) throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
    const data = await response.json();
    return data.message?.content || '';
  });
}

export async function streamCircuitWithOllama(
  prompt,
  history = [],
  currentDesign = null,
  onContent = () => {},
  memory = null,
) {
  return parseWithCorrectionRetry(async (correction, attempt) => {
    const response = await fetch(ollamaUrl(), {
      method: 'POST',
      headers: ollamaHeaders(),
      body: JSON.stringify(buildOllamaRequestBody(prompt, history, true, currentDesign, memory, correction)),
    });

    if (!response.ok) throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
    if (!response.body) throw new Error('Ollama did not return a readable response stream.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    let content = '';

    const consumeLine = (line) => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.error) throw new Error(event.error);
      const token = event.message?.content || '';
      if (!token) return;
      content += token;
      onContent(content, { attempt, correcting: attempt > 0 });
    };

    while (true) {
      const { done, value } = await reader.read();
      buffered += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() || '';
      lines.forEach(consumeLine);
      if (done) break;
    }
    if (buffered.trim()) consumeLine(buffered);
    return content;
  });
}
