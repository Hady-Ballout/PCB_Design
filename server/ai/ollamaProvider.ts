import { normalizeChatMemory, sanitizeConversationHistory } from './chatMemory.js';
import { circuitKnowledgePrompt } from './circuitKnowledge.js';
import { parseSpiceNetlist } from '../../src/core/circuitSync.js';
import type {
  ChatMemory,
  ChatMessage,
  Circuit,
  CorrectionContext,
  CurrentDesign,
  OllamaRequestBody,
  ParsedCircuitResponse,
  ProviderConfig,
  StreamState,
} from '../types.js';

const SYSTEM_PROMPT = `You are a JSON API for beginner-safe electronics circuit generation.
Return exactly one valid JSON object and no other text.
The top-level object must contain "reply", "circuit", and "spice".
The "reply" field is a concise, conversational explanation of what you built or changed for the user. Mention important component refs when helpful, such as RLOAD, R1, or C1. Do not use Markdown.
The "circuit" field is the canonical structured circuit.
The "spice" field is a SPICE netlist generated from the same circuit.
Use node "0" for ground.
Every component needs ref, kind, value, nodes, and footprint.
The circuit may include optional compact "schematic" metadata for layout intent. Omit schematic unless it is needed to mark external terminals or an op amp primaryRef. Schematic metadata is visual only and must not add SPICE components.
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
The SPICE netlist must use the exact same component refs, values, and node names as circuit.components.
Every node except ground "0" must connect to at least two component pins and have a DC path to ground; never leave a node floating.
Both op-amp inputs must be connected: wire the inverting input to the feedback/summing network, and the non-inverting input to a reference node — ground "0" for a dual-supply design, or a mid-rail bias-divider node for a single-supply design. Never put an op-amp input on a node that no other component uses.
When you create a reference or bias node (for example a divider midpoint), connect the op-amp input to that exact node name. Do not invent a separate, otherwise-unused input node.`;

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
} as const;

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
              'resistor', 'capacitor', 'inductor', 'diode', 'led',
              'bjt_npn', 'bjt_pnp', 'mosfet_n', 'mosfet_p',
              'opamp', 'regulator', 'voltage_source', 'signal_source', 'load',
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
} as const;

export const AI_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    circuit: CIRCUIT_SCHEMA,
    spice: { type: 'string' },
  },
  required: ['reply', 'circuit', 'spice'],
} as const;

function findBalancedJson(text: string): { jsonText: string; balanced: boolean } {
  const start = text.indexOf('{');
  if (start === -1) return { jsonText: '', balanced: false };

  let inString = false;
  let escaped = false;
  let depth = 0;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && inString) { escaped = true; continue; }
    if (char === '"') inString = !inString;
    if (inString) continue;

    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return { jsonText: text.slice(start, index + 1), balanced: true };
  }

  return { jsonText: text.slice(start), balanced: false };
}

class CircuitGenerationError extends Error {
  code: string;
  constructor(code: string, message: string, cause?: Error) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CircuitGenerationError';
    this.code = code;
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const cleanReply = (value: unknown): string => String(value || '').trim().replace(/\s+/g, ' ').slice(0, 1200);

interface ComponentLike {
  ref?: string;
  kind?: string;
  value?: string;
  nodes?: string[];
}

const describeComponent = (component: ComponentLike): string => {
  const ref = String(component?.ref || '').toUpperCase();
  const kind = String(component?.kind || 'component');
  const value = String(component?.value || 'unknown value');
  const nodes = Array.isArray(component?.nodes) ? component.nodes.join(' - ') : 'unknown nodes';
  return `${ref}: ${kind}, value=${value}, nodes=${nodes}`;
};

const currentCircuitInventory = (circuit: Circuit | null | undefined): string => {
  const components = Array.isArray(circuit?.components) ? circuit!.components : [];
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

export function validateCircuitResponse(circuit: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (!isPlainObject(circuit)) return ['response must be a JSON object'];

  if (typeof circuit.title !== 'string') errors.push('title must be a string');
  if (typeof circuit.type !== 'string') errors.push('type must be a string');
  if (!Number.isFinite(circuit.supplyVoltage)) errors.push('supplyVoltage must be a number');
  if (!Array.isArray(circuit.nodes) || (circuit.nodes as unknown[]).length === 0 || (circuit.nodes as unknown[]).some((node: unknown) => typeof node !== 'string')) {
    errors.push('nodes must be a non-empty array of strings');
  }
  if (!Array.isArray(circuit.notes) || (circuit.notes as unknown[]).some((note: unknown) => typeof note !== 'string')) {
    errors.push('notes must be an array of strings');
  }
  if (circuit.schematic !== undefined && !isPlainObject(circuit.schematic)) {
    errors.push('schematic must be an object when present');
  }
  if (!Array.isArray(circuit.components) || (circuit.components as unknown[]).length === 0) {
    errors.push('components must be a non-empty array');
  } else {
    const allowedKinds = new Set(CIRCUIT_SCHEMA.properties.components.items.properties.kind.enum);
    (circuit.components as Record<string, unknown>[]).forEach((component, index) => {
      const label = `components[${index}]`;
      if (!isPlainObject(component)) {
        errors.push(`${label} must be an object`);
        return;
      }
      if (typeof component.ref !== 'string' || !component.ref) errors.push(`${label}.ref must be a non-empty string`);
      if (!allowedKinds.has(component.kind as string)) errors.push(`${label}.kind is not supported`);
      if (typeof component.value !== 'string' || !component.value) errors.push(`${label}.value must be a non-empty string`);
      if (!Array.isArray(component.nodes) || (component.nodes as unknown[]).length === 0 || (component.nodes as unknown[]).some((node: unknown) => typeof node !== 'string')) {
        errors.push(`${label}.nodes must be a non-empty array of strings`);
      }
      if (typeof component.footprint !== 'string') errors.push(`${label}.footprint must be a string`);
    });
  }

  return errors;
}

const OPAMP_MODEL = 'LM358';
const OPAMP_MODEL_ALIASES = new Set(['', 'GENERIC', 'OPAMP', 'UNKNOWN']);

const normalizeOpampModel = (value: unknown): string => {
  const normalized = String(value || '').trim().toUpperCase();
  return OPAMP_MODEL_ALIASES.has(normalized) || normalized === OPAMP_MODEL ? OPAMP_MODEL : normalized;
};

const isSourceKind = (kind: string): boolean => kind === 'voltage_source' || kind === 'signal_source';

const voltageValue = (value: string): string => {
  const text = String(value || '').trim();
  return /v$/i.test(text) ? text : `${text}V`;
};

const sourceExpressionKind = (value: string): string | null => {
  const expression = String(value || '').trim();
  if (/^(SINE|SIN|PULSE|PWL|EXP|AC)\b/i.test(expression)) return 'signal_source';
  if (/^DC\b/i.test(expression)) return 'voltage_source';
  if (/^[+-]?\d+(?:\.\d+)?(?:[munpfkKMegG]+)?V?$/i.test(expression)) return 'voltage_source';
  return null;
};

interface SourceComponent {
  kind: string;
  value: string;
  [key: string]: unknown;
}

const normalizeSourceComponent = (component: SourceComponent): SourceComponent => {
  if (!isSourceKind(component.kind)) return component;
  const expression = String(component.value || '').trim();
  const kind = sourceExpressionKind(expression) || component.kind;
  const dcMatch = expression.match(/^DC\s+(.+)$/i);
  if (kind === 'voltage_source') {
    return { ...component, kind, value: voltageValue(dcMatch ? dcMatch[1] : expression) };
  }
  return { ...component, kind, value: expression };
};

export const normalizeCircuitForValidation = (circuit: Record<string, unknown>): Record<string, unknown> => ({
  ...circuit,
  components: ((circuit.components as SourceComponent[]) || []).map((component) => {
    const normalizedSource = normalizeSourceComponent(component);
    return normalizedSource.kind === 'opamp'
      ? { ...normalizedSource, value: OPAMP_MODEL }
      : normalizedSource;
  }),
});

const normalizeSignatureValue = (component: { kind: string; value: string }): string => (
  component.kind === 'opamp'
    ? normalizeOpampModel(component.value)
    : String(component.value || '').trim().toUpperCase()
);

interface SignatureEntry {
  ref: string;
  kind: string;
  value: string;
  nodes: string[];
}

const electricalSignature = (circuit: Record<string, unknown> | null | undefined): SignatureEntry[] => (
  (circuit?.components as ComponentLike[]) || []
).map((component) => ({
  ref: String(component.ref || '').toUpperCase(),
  kind: String(component.kind || ''),
  value: normalizeSignatureValue(component as { kind: string; value: string }),
  nodes: (component.nodes || []).map((node) => String(node)),
})).sort((a, b) => a.ref.localeCompare(b.ref));

const describeSignatureMismatch = (expected: SignatureEntry[], actual: SignatureEntry[]): string => {
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

export function validateAiSpice(spice: unknown, circuit: Record<string, unknown>): void {
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

export function parseCircuitResponse(text: string): ParsedCircuitResponse {
  const trimmed = text.trim();
  const { jsonText, balanced } = findBalancedJson(trimmed);
  if (!jsonText) {
    throw new CircuitGenerationError('json_missing', 'AI response did not contain a JSON object.');
  }
  if (!balanced) {
    throw new CircuitGenerationError('json_truncated', 'AI response ended before the JSON object was complete.');
  }

  let responseObject: Record<string, unknown>;
  try {
    responseObject = JSON.parse(jsonText);
  } catch (error) {
    throw new CircuitGenerationError('json_syntax', `AI returned malformed JSON: ${(error as Error).message}`, error as Error);
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

  const circuit = responseObject.circuit as Record<string, unknown>;
  const validationErrors = validateCircuitResponse(circuit);
  if (validationErrors.length) {
    throw new CircuitGenerationError(
      'schema_validation',
      `AI circuit did not match the required schema: ${validationErrors.slice(0, 4).join('; ')}.`,
    );
  }
  const normalizedCircuit = normalizeCircuitForValidation(circuit);
  validateAiSpice(responseObject.spice, normalizedCircuit);

  return { reply, circuit: normalizedCircuit as unknown as Circuit, spice: responseObject.spice as string };
}

const positiveIntegerOption = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const providerConfig = (): ProviderConfig => {
  const provider = String(process.env.AI_PROVIDER || 'ollama').toLowerCase();
  if (provider === 'ollama') {
    return {
      provider,
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      model: process.env.OLLAMA_MODEL || 'llama3.2:latest',
      apiKey: process.env.OLLAMA_API_KEY || '',
    };
  }

  return {
    provider,
    baseUrl: process.env.AI_API_URL || '',
    model: process.env.AI_MODEL || '',
    apiKey: process.env.AI_API_KEY || '',
  };
};

export const buildOllamaRequestBody = (
  prompt: string,
  history: ChatMessage[],
  stream: boolean,
  currentDesign: CurrentDesign | null = null,
  memory: Partial<ChatMemory> | null = null,
  correction: CorrectionContext | null = null,
): OllamaRequestBody => {
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
        {
          role: 'user',
          content: `Your previous response was rejected: ${correction.error}. Return a smaller complete response as one valid JSON object with top-level "reply", "circuit", and "spice". Omit circuit.schematic unless it is essential for external terminals or op amp intent. The reply must be conversational and concise. The SPICE must exactly match the JSON circuit refs, values, and node names. Do not explain the correction and do not use Markdown outside the JSON.`,
        },
      ]
    : [];
  const knowledgePrompt = circuitKnowledgePrompt();

  return {
    model: process.env.OLLAMA_MODEL || 'llama3.2:latest',
    stream,
    format: AI_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
    options: {
      num_ctx: positiveIntegerOption(process.env.OLLAMA_NUM_CTX, 8192),
      num_predict: positiveIntegerOption(process.env.OLLAMA_NUM_PREDICT, 4096),
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
        content: `Return this exact compact JSON shape with real circuit values:
{"reply":"I built a concise explanation of the circuit or edit for the user.","circuit":{"title":"...","type":"...","supplyVoltage":5,"nodes":["VIN","VOUT","0"],"components":[{"ref":"R1","kind":"resistor","value":"1k","nodes":["VIN","VOUT"],"footprint":"Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P7.62mm_Horizontal"}],"notes":["..."]},"spice":"* Example\\nR1 VIN VOUT 1k\\n.end"}
Use SPICE-safe component refs. For example, an LED must be {"ref":"DLED1","kind":"led",...}, not {"ref":"LED1",...}.
For op amps, use {"ref":"XU1","kind":"opamp","value":"LM358",...} and use LM358 as the SPICE subcircuit name; never use GENERIC or OPAMP.
For sources, use voltage_source for DC values and signal_source only for waveform values like SINE(...), PULSE(...), PWL(...), EXP(...), or AC.
Only include circuit.schematic when it adds essential layout intent. Keep it compact: use primaryRef for op amps and externalTerminals for intentional single-pin user connections such as VINP, VINN, VIN, VOUT, CTRL, or test points. Omit netRoles, componentRoles, and blocks unless the user request truly needs them.
Schematic metadata is visual only. Do not create extra SPICE lines for schematic fields.
The SPICE field must describe the same circuit.components entries using the same refs, values, and node names.
The reply field should sound like a helpful chat assistant: briefly explain what changed, mention relevant refs, and do not paste the netlist.
Circuit prompt: ${prompt}
This is a follow-up whenever canonical design context is present. Preserve all prior requirements and unchanged design details. Replace the whole circuit only when this request explicitly asks to start over, replace it, or create a different circuit.`,
      },
      ...correctionMessages,
    ],
  };
};

const authHeaders = (apiKey = ''): Record<string, string> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
};

const ollamaHeaders = (): Record<string, string> => authHeaders(process.env.OLLAMA_API_KEY);

const retryableOutputCodes = new Set([
  'json_missing', 'json_truncated', 'json_syntax', 'schema_validation', 'spice_validation',
]);

const finalOutputError = (error: CircuitGenerationError): CircuitGenerationError => new CircuitGenerationError(
  error.code || 'invalid_output',
  `Circuit generation failed after one automatic correction attempt. ${error.message}`,
  error,
);

// Detect the classic simulation-killer: an op-amp input sitting on a node no
// other component uses (floating high-impedance input → singular matrix). Kept
// deliberately narrow so it never rejects a legitimately driven output node.
const floatingOpampInputCorrection = (circuit: Circuit): string | null => {
  const components = Array.isArray(circuit?.components) ? circuit.components : [];
  const nodeUse = new Map<string, number>();
  for (const part of components) {
    for (const node of part.nodes || []) nodeUse.set(String(node), (nodeUse.get(String(node)) || 0) + 1);
  }
  const problems: string[] = [];
  for (const part of components) {
    if (part.kind !== 'opamp') continue;
    const [plus, minus] = (part.nodes || []).map(String);
    ([['non-inverting (+)', plus], ['inverting (-)', minus]] as const).forEach(([label, node]) => {
      if (!node || node === '0') return; // a grounded input is fine
      if ((nodeUse.get(node) || 0) < 2) problems.push(`${part.ref}'s ${label} input (node "${node}")`);
    });
  }
  if (!problems.length) return null;
  return `Floating op-amp input(s): ${problems.join('; ')} connect to no other component. Each op-amp input must join the rest of the circuit: the inverting input to the feedback/summing network, and the non-inverting input to a reference node — ground "0" or a mid-rail bias-divider node. Reuse the existing reference node name for that input; do not leave it on its own node. Return the corrected circuit and matching SPICE.`;
};

const parseWithCorrectionRetry = async (
  requestAttempt: (correction: CorrectionContext | null, attempt: number) => Promise<string>,
): Promise<ParsedCircuitResponse> => {
  let correction: CorrectionContext | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const content = await requestAttempt(correction, attempt);
    let parsed: ParsedCircuitResponse;
    try {
      parsed = parseCircuitResponse(content);
    } catch (error) {
      if (attempt === 1 || !retryableOutputCodes.has((error as CircuitGenerationError).code)) throw finalOutputError(error as CircuitGenerationError);
      correction = { content, error: (error as Error).message };
      continue;
    }
    // Semantic connectivity check: retry once with a targeted correction, but
    // never hard-fail on it — accept the circuit (with its warnings) otherwise.
    const floating = floatingOpampInputCorrection(parsed.circuit);
    if (floating && attempt === 0) {
      correction = { content, error: floating };
      continue;
    }
    return parsed;
  }
  throw new CircuitGenerationError('invalid_output', 'Circuit generation did not return a usable response.');
};

const ollamaUrl = (): string => `${(process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '')}/api/chat`;

const isZaiProvider = (provider: string): boolean => new Set(['zai', 'zhipu', 'bigmodel']).has(provider);

const shouldUseJsonResponseFormat = (): boolean => process.env.AI_RESPONSE_FORMAT !== 'text';

const buildOpenAiCompatibleBody = (config: ProviderConfig, ollamaBody: OllamaRequestBody): Record<string, unknown> => ({
  model: config.model,
  temperature: ollamaBody.options.temperature,
  max_tokens: positiveIntegerOption(process.env.AI_MAX_TOKENS, isZaiProvider(config.provider) ? 12000 : 4096),
  ...(shouldUseJsonResponseFormat() ? { response_format: { type: 'json_object' } } : {}),
  ...(isZaiProvider(config.provider)
    ? {
        thinking: { type: process.env.ZAI_THINKING_TYPE || 'disabled' },
        reasoning_effort: process.env.ZAI_REASONING_EFFORT || 'none',
      }
    : {}),
  messages: ollamaBody.messages,
});

const openAiCompatibleHeaders = (config: ProviderConfig): Record<string, string> => {
  const headers = authHeaders(config.apiKey);
  if (config.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://pcb-pilot.web.app';
    headers['X-Title'] = 'PCB Pilot';
  }
  return headers;
};

const openAiCompatibleUrl = (config: ProviderConfig): string => {
  if (!config.baseUrl) throw new Error('AI_API_URL is not set.');
  if (!config.model) throw new Error('AI_MODEL is not set.');
  if (!config.apiKey) throw new Error('AI_API_KEY is not set.');
  return `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
};

const stringifyContentPart = (part: unknown): string => {
  if (typeof part === 'string') return part;
  if (!isPlainObject(part)) return '';
  if (typeof part.text === 'string') return part.text;
  if (typeof part.content === 'string') return part.content;
  if (typeof part.output_text === 'string') return part.output_text;
  return '';
};

const readOpenAiCompatibleContent = (data: Record<string, unknown>): string => {
  const choice = (data?.choices as Record<string, unknown>[])?.[0]
    || ((data?.data as Record<string, unknown>)?.choices as Record<string, unknown>[])?.[0];
  const message = (choice?.message || choice?.delta || choice) as Record<string, unknown> | undefined;
  const content = message?.content ?? (data as Record<string, unknown>)?.output_text ?? (data as Record<string, unknown>)?.content;

  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(stringifyContentPart).join('');
  if (isPlainObject(content)) return stringifyContentPart(content);
  return '';
};

const compactResponsePreview = (data: Record<string, unknown>): string => JSON.stringify(data)
  .replace(/"content"\s*:\s*"[^"]{120,}"/g, '"content":"<long content omitted>"')
  .replace(/"reasoning_content"\s*:\s*"[^"]{120,}"/g, '"reasoning_content":"<long reasoning omitted>"')
  .slice(0, 500);

const providerContentError = (config: ProviderConfig, data: Record<string, unknown>): CircuitGenerationError => {
  const choice = (data?.choices as Record<string, unknown>[])?.[0]
    || ((data?.data as Record<string, unknown>)?.choices as Record<string, unknown>[])?.[0];
  const finishReason = (choice as Record<string, unknown>)?.finish_reason;
  if (finishReason === 'length') {
    return new CircuitGenerationError(
      'provider_response',
      `${config.provider} stopped because max_tokens was exhausted before returning final JSON. Increase AI_MAX_TOKENS or keep ZAI_THINKING_TYPE=disabled. Response preview: ${compactResponsePreview(data)}`,
    );
  }
  return new CircuitGenerationError(
    'provider_response',
    `${config.provider} returned no assistant content. Response preview: ${compactResponsePreview(data)}`,
  );
};

async function callOpenAiCompatible(
  config: ProviderConfig,
  prompt: string,
  history: ChatMessage[],
  currentDesign: CurrentDesign | null,
  memory: Partial<ChatMemory> | null,
  correction: CorrectionContext | null,
): Promise<string> {
  const ollamaBody = buildOllamaRequestBody(prompt, history, false, currentDesign, memory, correction);
  const response = await fetch(openAiCompatibleUrl(config), {
    method: 'POST',
    headers: openAiCompatibleHeaders(config),
    body: JSON.stringify(buildOpenAiCompatibleBody(config, ollamaBody)),
  });

  if (!response.ok) throw new Error(`${config.provider} returned ${response.status}: ${await response.text()}`);
  const data = await response.json() as Record<string, unknown>;
  const content = readOpenAiCompatibleContent(data);
  if (!content) {
    throw providerContentError(config, data);
  }
  return content;
}

export async function generateCircuitWithOllama(
  prompt: string,
  history: ChatMessage[] = [],
  currentDesign: CurrentDesign | null = null,
  memory: Partial<ChatMemory> | null = null,
): Promise<ParsedCircuitResponse> {
  const config = providerConfig();
  if (config.provider !== 'ollama') {
    return parseWithCorrectionRetry((correction) =>
      callOpenAiCompatible(config, prompt, history, currentDesign, memory, correction));
  }

  return parseWithCorrectionRetry(async (correction) => {
    const response = await fetch(ollamaUrl(), {
      method: 'POST',
      headers: ollamaHeaders(),
      body: JSON.stringify(buildOllamaRequestBody(prompt, history, false, currentDesign, memory, correction)),
    });

    if (!response.ok) throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
    const data = await response.json() as Record<string, unknown>;
    return (data.message as Record<string, unknown>)?.content as string || '';
  });
}

export async function streamCircuitWithOllama(
  prompt: string,
  history: ChatMessage[] = [],
  currentDesign: CurrentDesign | null = null,
  onContent: (content: string, state: StreamState) => void = () => {},
  memory: Partial<ChatMemory> | null = null,
): Promise<ParsedCircuitResponse> {
  const config = providerConfig();
  if (config.provider !== 'ollama') {
    return parseWithCorrectionRetry(async (correction, attempt) => {
      const content = await callOpenAiCompatible(config, prompt, history, currentDesign, memory, correction);
      onContent(content, { attempt, correcting: attempt > 0 });
      return content;
    });
  }

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

    const consumeLine = (line: string): void => {
      if (!line.trim()) return;
      const event = JSON.parse(line) as { error?: string; message?: { content?: string } };
      if (event.error) throw new Error(event.error);
      const token = event.message?.content || '';
      if (!token) return;
      content += token;
      onContent(content, { attempt, correcting: attempt > 0 });
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        buffered += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() || '';
        lines.forEach(consumeLine);
        if (done) break;
      }
      if (buffered.trim()) consumeLine(buffered);
    } finally {
      reader.cancel().catch(() => {});
    }
    return content;
  });
}
