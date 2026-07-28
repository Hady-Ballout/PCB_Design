import { normalizeChatMemory, sanitizeConversationHistory } from './chatMemory.js';
import { circuitKnowledgePrompt } from './circuitKnowledge.js';
import {
  ALLOWED_KINDS,
  FIXED_PIN_NAMES,
  MCU_KINDS,
  WIRING_ONLY_KINDS,
} from '../../src/core/componentKinds.js';
import {
  applySafeAutoFixes,
  checkCircuitTopology,
  composeTopologyCorrection,
} from '../../src/core/topologyRules.js';
import type { TopologyViolation } from '../../src/core/topologyRules.js';
import type {
  ChatMemory,
  ChatMessage,
  Circuit,
  CorrectionContext,
  CurrentDesign,
  PipelineEvent,
  ProviderConfig,
} from '../types.js';

type ChatCompletionMessage = { role: string; content: string };

// What the 3-stage pipeline resolves to. Unlike ParsedCircuitResponse this
// carries no `spice`; the caller derives SPICE from the circuit itself.
export interface PipelineCircuitResult {
  reply: string;
  circuit: Circuit;
  code: string;
}

// Prompt guidance derived from the component registry (componentKinds.js) so a
// kind added there is automatically offered to the model. Boards keep their
// bespoke pin/power guidance in the prompt below.
const MCU_PIN_CONTRACT = [...MCU_KINDS]
  .map((kind) => `- ${kind} (${FIXED_PIN_NAMES[kind].length} nodes): ${FIXED_PIN_NAMES[kind].join(', ')}`)
  .join('\n');

const MODULE_PIN_CONTRACT = ALLOWED_KINDS
  .filter((kind) => FIXED_PIN_NAMES[kind] && !MCU_KINDS.has(kind))
  .map((kind) => `- ${kind} (${FIXED_PIN_NAMES[kind].length} nodes): ${FIXED_PIN_NAMES[kind].join(', ')}`)
  .join('\n');

const WIRING_ONLY_PARTS = ALLOWED_KINDS
  .filter((kind) => WIRING_ONLY_KINDS.has(kind) && !MCU_KINDS.has(kind))
  .join(', ');

const MCU_PIN_COUNT_SUMMARY = [...MCU_KINDS]
  .map((kind) => `${kind} ${FIXED_PIN_NAMES[kind].length}`)
  .join(', ');

const CIRCUIT_SYSTEM_PROMPT = `You are a JSON API for beginner-safe electronics circuit generation.
Return exactly one valid JSON object and no other text.
The top-level object must contain "circuit".
The "circuit" field is the canonical structured circuit.
Use node "0" for ground.
Every component needs ref, kind, value, nodes, and footprint.
The circuit may include optional compact "schematic" metadata for layout intent. Omit schematic unless it is needed to mark external terminals or an op amp primaryRef. Schematic metadata is visual only and must not add SPICE components.
Allowed component kinds: ${ALLOWED_KINDS.join(', ')}.
Sensor and module parts (${WIRING_ONLY_PARTS}) are wiring-only: they are never simulated. Wire their fixed pins to the MCU/supply nets exactly as named.
The following parts use fixed positional node lists; the nodes array length and order must match exactly, using "NC_<REF>_<pinNumber>" for any unused pin:
${MODULE_PIN_CONTRACT}
Component refs must be SPICE-compatible because the program will simulate them with Ngspice:
- resistor refs start with R, e.g. R1
- capacitor refs start with C, e.g. C1
- inductor refs start with L, e.g. L1
- diode and led refs start with D, e.g. D1 or DLED1; never use LED1
- voltage_source and signal_source refs start with V, e.g. V1 or VSIG1
- bjt refs start with Q, e.g. Q1
- mosfet refs start with M, e.g. M1
- opamp/subcircuit refs start with X, e.g. XU1
- opamp components must use value LM358 in JSON; do not use GENERIC or OPAMP.
- load refs should be modeled as resistors and start with R, e.g. RLOAD
- regulator refs may use U in the JSON, but include enough surrounding passives/load nodes for simulation.
- microcontroller board refs start with U, e.g. U1
Use simple Ngspice-friendly values such as 1k, 100nF, 10uF, 5V, and SINE(0 1 1k).
Use voltage_source for DC supplies and fixed DC input biases. Use signal_source only for waveform or time-varying sources such as SINE(...), PULSE(...), PWL(...), EXP(...), or AC.
Every node except ground "0" must connect to at least two component pins and have a DC path to ground; never leave a node floating.
Microcontroller boards (${[...MCU_KINDS].join(', ')}) are wiring-only: they are never simulated and must never appear in the SPICE deck. Each kind has a fixed, positional pin/node list that must always be present in full, in this exact order:
${MCU_PIN_CONTRACT}
Fill any pin the circuit does not use with a unique placeholder node named NC_<REF>_<pinNumber>, e.g. NC_U1_5 for U1's fifth pin — never omit a pin and never leave it blank. Set value to the human board name, e.g. "Uno R3", "Pi 5", or "DevKit V1". Tie the board's GND pin to node "0". When there is no separate supply, power the circuit from the board's 5V or 3V3 pin and set supplyVoltage to match (5 for arduino_uno, 3.3 for raspberry_pi and esp32). A GPIO pin that drives a load must share its net with at least one other component, such as a series resistor; only add a separate voltage_source or signal_source when the user explicitly wants to simulate that pin's own waveform.
Both op-amp inputs must be connected: wire the inverting input to the feedback/summing network, and the non-inverting input to a reference node — ground "0" for a dual-supply design, or a mid-rail bias-divider node for a single-supply design. Never put an op-amp input on a node that no other component uses.
When you create a reference or bias node (for example a divider midpoint), connect the op-amp input to that exact node name. Do not invent a separate, otherwise-unused input node.`;

const REVIEWER_SYSTEM_PROMPT = `You are a circuit design reviewer. You will be given a structured circuit JSON (components, nodes, values) that was already generated by another model. Check it for correctness issues:
- Floating or under-connected nodes (a node other than ground "0" used by fewer than two component pins).
- Missing or incorrect bias/reference paths, especially op-amp inputs that aren't tied into the feedback network or a proper reference node.
- A component kind that doesn't match its evident role (e.g. a load modeled as anything other than a resistor).
- Component values that are physically implausible for the stated circuit type (e.g. a 1 ohm pull-up, a femtofarad decoupling cap).
- Repeated stages (filter banks, LED arrays): verify the progression is monotonic and no stage duplicates another's values.
- Gain × input amplitude must fit within the supply rails with ~1.5V headroom on single-supply op amps.
- A "VU meter"/level detector needs a rectifier + RC envelope stage between filter output and LED, not a direct connection.
- Filter titles must match topology: a capacitor shunting a virtual-ground summing node contributes nothing — it is not a bandpass.
- Any AC-coupled input needs a series capacitor; bias networks need a bypass sized for the lowest signal frequency (corner = 1/(2π·R_source·C) well below f_min).
Return exactly one valid JSON object and no other text: {"ok": true} if the circuit has no issues worth fixing, or {"ok": false, "issues": ["..."], "circuit": {<the same circuit JSON schema, corrected>}} if you must fix something. When returning a corrected circuit, keep every ref, node name, and value that was already correct exactly as-is — change only what is actually wrong. Do not add unrelated components or redesign the circuit. Preserve every microcontroller board's fixed pin count and order (${MCU_PIN_COUNT_SUMMARY}) exactly; never drop or reorder its NC_<ref>_<pin> placeholder nodes.
If the final circuit (after any correction) includes a microcontroller board (arduino_uno, raspberry_pi, or esp32), also return a top-level "code" field containing complete firmware for it as a single plain-text JSON string with \n newlines, no Markdown fences, no explanation. Use Arduino C++ (setup()/loop()) for arduino_uno and esp32, deriving pin numbers from the pin name (D13 -> 13, A0 -> A0, GPIO2 -> 2). Use Python 3 with gpiozero for raspberry_pi (GPIO17 -> LED(17) or Button(17), etc.). Only reference pins that are actually wired in circuit.components, implement exactly the behavior the user asked for, keep it under 40 lines, and keep it beginner-friendly with brief comments. When there is no microcontroller board, omit "code" or return an empty string.`;

const REPLY_SYSTEM_PROMPT = `You are a helpful chat assistant writing the conversational reply for a circuit that has already been designed and finalized by another model. Return exactly one valid JSON object and no other text: {"reply": "..."}. The reply must be concise, conversational, and explain what was built or changed. Mention important component refs when helpful, such as RLOAD, R1, or C1. Do not use Markdown and do not paste the netlist.`;

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
            enum: [...ALLOWED_KINDS],
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

export const STAGE1_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    circuit: CIRCUIT_SCHEMA,
  },
  required: ['circuit'],
} as const;

export const REVIEWER_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
    circuit: CIRCUIT_SCHEMA,
    code: { type: 'string' },
  },
  required: ['ok'],
} as const;

export const REPLY_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
  },
  required: ['reply'],
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
    const allowedKinds = new Set<string>(CIRCUIT_SCHEMA.properties.components.items.properties.kind.enum);
    (circuit.components as Record<string, unknown>[]).forEach((component, index) => {
      const label = `components[${index}]`;
      if (!isPlainObject(component)) {
        errors.push(`${label} must be an object`);
        return;
      }
      if (typeof component.ref !== 'string' || !component.ref) errors.push(`${label}.ref must be a non-empty string`);
      if (!allowedKinds.has(component.kind as string)) errors.push(`${label}.kind "${String(component.kind)}" is not supported`);
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

function parseStage1Circuit(text: string): Circuit {
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

  if (!isPlainObject(responseObject) || !isPlainObject(responseObject.circuit)) {
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

  return normalizeCircuitForValidation(circuit) as unknown as Circuit;
}

const sanitizeFirmwareCode = (value: unknown): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.replace(/^```[a-zA-Z0-9+-]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
};

interface ReviewerResult {
  ok: boolean;
  circuit: Circuit | null;
  issues: string[];
  code: string;
}

function parseReviewerResponse(text: string): ReviewerResult {
  const trimmed = text.trim();
  const { jsonText, balanced } = findBalancedJson(trimmed);
  if (!jsonText) {
    throw new CircuitGenerationError('json_missing', 'Reviewer response did not contain a JSON object.');
  }
  if (!balanced) {
    throw new CircuitGenerationError('json_truncated', 'Reviewer response ended before the JSON object was complete.');
  }

  let responseObject: Record<string, unknown>;
  try {
    responseObject = JSON.parse(jsonText);
  } catch (error) {
    throw new CircuitGenerationError('json_syntax', `Reviewer returned malformed JSON: ${(error as Error).message}`, error as Error);
  }

  if (!isPlainObject(responseObject) || typeof responseObject.ok !== 'boolean') {
    throw new CircuitGenerationError('schema_validation', 'Reviewer response must include a boolean "ok" field.');
  }
  const code = sanitizeFirmwareCode(responseObject.code);
  if (responseObject.ok) return { ok: true, circuit: null, issues: [], code };

  if (!isPlainObject(responseObject.circuit)) {
    throw new CircuitGenerationError('schema_validation', 'Reviewer response must include a corrected circuit when ok is false.');
  }
  const validationErrors = validateCircuitResponse(responseObject.circuit as Record<string, unknown>);
  if (validationErrors.length) {
    throw new CircuitGenerationError(
      'schema_validation',
      `Reviewer circuit did not match the required schema: ${validationErrors.slice(0, 4).join('; ')}.`,
    );
  }
  const issues = Array.isArray(responseObject.issues) ? (responseObject.issues as unknown[]).map(String) : [];
  return {
    ok: false,
    circuit: normalizeCircuitForValidation(responseObject.circuit as Record<string, unknown>) as unknown as Circuit,
    issues,
    code,
  };
}

function parseReplyResponse(text: string): string {
  const trimmed = text.trim();
  const { jsonText, balanced } = findBalancedJson(trimmed);
  if (!jsonText) {
    throw new CircuitGenerationError('json_missing', 'Reply response did not contain a JSON object.');
  }
  if (!balanced) {
    throw new CircuitGenerationError('json_truncated', 'Reply response ended before the JSON object was complete.');
  }

  let responseObject: Record<string, unknown>;
  try {
    responseObject = JSON.parse(jsonText);
  } catch (error) {
    throw new CircuitGenerationError('json_syntax', `Reply returned malformed JSON: ${(error as Error).message}`, error as Error);
  }

  const reply = cleanReply(isPlainObject(responseObject) ? responseObject.reply : '');
  if (!reply) {
    throw new CircuitGenerationError('schema_validation', 'Reply response must include a non-empty reply string.');
  }
  return reply;
}

const positiveIntegerOption = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

type PipelineStage = 'circuit' | 'reviewer' | 'reply';

const STAGE_MODEL_ENV: Record<PipelineStage, string> = {
  circuit: 'AI_MODEL_CIRCUIT',
  reviewer: 'AI_MODEL_REVIEWER',
  reply: 'AI_MODEL_REPLY',
};

const providerConfig = (stage: PipelineStage): ProviderConfig => {
  const provider = String(process.env.AI_PROVIDER || 'ollama').toLowerCase();
  const stageEnvVar = STAGE_MODEL_ENV[stage];
  if (provider === 'ollama') {
    return {
      provider,
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      model: process.env[stageEnvVar] || process.env.OLLAMA_MODEL || 'llama3.2:latest',
      apiKey: process.env.OLLAMA_API_KEY || '',
    };
  }

  return {
    provider,
    baseUrl: process.env.AI_API_URL || '',
    model: process.env[stageEnvVar] || process.env.AI_MODEL || '',
    apiKey: process.env.AI_API_KEY || '',
  };
};

const reviewerEnabled = (): boolean => process.env.AI_PIPELINE_REVIEWER !== '0';

const buildStage1Messages = (
  prompt: string,
  history: ChatMessage[],
  currentDesign: CurrentDesign | null,
  memory: Partial<ChatMemory> | null,
  correction: CorrectionContext | null,
): ChatCompletionMessage[] => {
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
          content: `Your previous response was rejected: ${correction.error}. Return a smaller complete response as one valid JSON object with a top-level "circuit" field. Omit circuit.schematic unless it is essential for external terminals or op amp intent. Do not explain the correction and do not use Markdown outside the JSON.`,
        },
      ]
    : [];
  const knowledgePrompt = circuitKnowledgePrompt();

  return [
    { role: 'system', content: CIRCUIT_SYSTEM_PROMPT },
    ...(knowledgePrompt ? [{ role: 'system', content: knowledgePrompt }] : []),
    ...memoryContext,
    ...revisionContext,
    ...conversation,
    {
      role: 'user',
      content: `Return this exact compact JSON shape with real circuit values:
{"circuit":{"title":"...","type":"...","supplyVoltage":5,"nodes":["VIN","VOUT","0"],"components":[{"ref":"R1","kind":"resistor","value":"1k","nodes":["VIN","VOUT"],"footprint":"Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P7.62mm_Horizontal"}],"notes":["..."]}}
Use SPICE-safe component refs. For example, an LED must be {"ref":"DLED1","kind":"led",...}, not {"ref":"LED1",...}.
For op amps, use {"ref":"XU1","kind":"opamp","value":"LM358",...}; never use GENERIC or OPAMP.
For sources, use voltage_source for DC values and signal_source only for waveform values like SINE(...), PULSE(...), PWL(...), EXP(...), or AC.
Only include circuit.schematic when it adds essential layout intent. Keep it compact: use primaryRef for op amps and externalTerminals for intentional single-pin user connections such as VINP, VINN, VIN, VOUT, CTRL, or test points. Omit netRoles, componentRoles, and blocks unless the user request truly needs them.
Schematic metadata is visual only. Do not create extra SPICE lines for schematic fields.
Circuit prompt: ${prompt}
This is a follow-up whenever canonical design context is present. Preserve all prior requirements and unchanged design details. Replace the whole circuit only when this request explicitly asks to start over, replace it, or create a different circuit.`,
    },
    ...correctionMessages,
  ];
};

const buildStage2Messages = (
  circuit: Circuit,
  correction: CorrectionContext | null,
): ChatCompletionMessage[] => [
  { role: 'system', content: REVIEWER_SYSTEM_PROMPT },
  { role: 'user', content: `Review this circuit JSON:\n${JSON.stringify(circuit)}` },
  ...(correction
    ? [{
        role: 'user',
        content: `Your previous response was rejected: ${correction.error}. Return exactly one valid JSON object matching the required shape, no other text.`,
      }]
    : []),
];

const buildStage3Messages = (
  prompt: string,
  circuit: Circuit,
  reviewIssues: string[],
  droppedKinds: Set<string>,
  correction: CorrectionContext | null,
): ChatCompletionMessage[] => [
  { role: 'system', content: REPLY_SYSTEM_PROMPT },
  {
    role: 'user',
    content: `User request: ${prompt}\nFinal circuit: ${JSON.stringify(circuit)}${reviewIssues.length ? `\nA reviewer also fixed: ${reviewIssues.join('; ')}` : ''}${droppedKinds.size ? `\nUnsupported parts that were omitted and MUST be mentioned in the reply: ${[...droppedKinds].join(', ')}.` : ''}\nWrite the reply now.`,
  },
  ...(correction
    ? [{
        role: 'user',
        content: `Your previous response was rejected: ${correction.error}. Return exactly one valid JSON object matching the required shape, no other text.`,
      }]
    : []),
];

const authHeaders = (apiKey = ''): Record<string, string> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
};

const ollamaHeaders = (): Record<string, string> => authHeaders(process.env.OLLAMA_API_KEY);

const retryableOutputCodes = new Set([
  'json_missing', 'json_truncated', 'json_syntax', 'schema_validation',
]);

async function parseWithCorrectionRetry<T>(
  label: string,
  requestAttempt: (correction: CorrectionContext | null, attempt: number) => Promise<string>,
  parse: (content: string) => T,
  checkCorrection: (parsed: T) => string | null = () => null,
): Promise<T> {
  let correction: CorrectionContext | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const content = await requestAttempt(correction, attempt);
    let parsed: T;
    try {
      parsed = parse(content);
    } catch (error) {
      const generationError = error as CircuitGenerationError;
      if (attempt === 1 || !retryableOutputCodes.has(generationError.code)) {
        throw new CircuitGenerationError(
          generationError.code || 'invalid_output',
          `${label} failed after one automatic correction attempt. ${generationError.message}`,
          generationError,
        );
      }
      correction = { content, error: generationError.message };
      continue;
    }
    const correctionNeeded = checkCorrection(parsed);
    if (correctionNeeded && attempt === 0) {
      correction = { content, error: correctionNeeded };
      continue;
    }
    return parsed;
  }
  throw new CircuitGenerationError('invalid_output', `${label} did not return a usable response.`);
}

const ollamaUrl = (): string => `${(process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '')}/api/chat`;

const isZaiProvider = (provider: string): boolean => new Set(['zai', 'zhipu', 'bigmodel']).has(provider);

const shouldUseJsonResponseFormat = (): boolean => process.env.AI_RESPONSE_FORMAT !== 'text';

const buildOpenAiCompatibleBody = (config: ProviderConfig, messages: ChatCompletionMessage[]): Record<string, unknown> => ({
  model: config.model,
  temperature: 0,
  max_tokens: positiveIntegerOption(process.env.AI_MAX_TOKENS, isZaiProvider(config.provider) ? 12000 : 4096),
  ...(shouldUseJsonResponseFormat() ? { response_format: { type: 'json_object' } } : {}),
  ...(isZaiProvider(config.provider)
    ? {
        thinking: { type: process.env.ZAI_THINKING_TYPE || 'disabled' },
        reasoning_effort: process.env.ZAI_REASONING_EFFORT || 'none',
      }
    : {}),
  messages,
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

async function sendChatCompletion(
  config: ProviderConfig,
  messages: ChatCompletionMessage[],
  schema: Record<string, unknown>,
): Promise<string> {
  if (config.provider === 'ollama') {
    const response = await fetch(ollamaUrl(), {
      method: 'POST',
      headers: ollamaHeaders(),
      body: JSON.stringify({
        model: config.model,
        stream: false,
        format: schema,
        options: {
          num_ctx: positiveIntegerOption(process.env.OLLAMA_NUM_CTX, 8192),
          num_predict: positiveIntegerOption(process.env.OLLAMA_NUM_PREDICT, 4096),
          temperature: 0,
        },
        messages,
      }),
    });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
    const data = await response.json() as Record<string, unknown>;
    return (data.message as Record<string, unknown>)?.content as string || '';
  }

  const response = await fetch(openAiCompatibleUrl(config), {
    method: 'POST',
    headers: openAiCompatibleHeaders(config),
    body: JSON.stringify(buildOpenAiCompatibleBody(config, messages)),
  });
  if (!response.ok) throw new Error(`${config.provider} returned ${response.status}: ${await response.text()}`);
  const data = await response.json() as Record<string, unknown>;
  const content = readOpenAiCompatibleContent(data);
  if (!content) throw providerContentError(config, data);
  return content;
}

async function streamOllamaChat(
  config: ProviderConfig,
  messages: ChatCompletionMessage[],
  schema: Record<string, unknown>,
  onToken: (content: string) => void,
): Promise<string> {
  const response = await fetch(ollamaUrl(), {
    method: 'POST',
    headers: ollamaHeaders(),
    body: JSON.stringify({
      model: config.model,
      stream: true,
      format: schema,
      options: {
        num_ctx: positiveIntegerOption(process.env.OLLAMA_NUM_CTX, 8192),
        num_predict: positiveIntegerOption(process.env.OLLAMA_NUM_PREDICT, 4096),
        temperature: 0,
      },
      messages,
    }),
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
    onToken(content);
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
}

async function runReviewerStage(circuit: Circuit): Promise<{ circuit: Circuit; issues: string[]; code: string } | null> {
  const config = providerConfig('reviewer');
  try {
    const result = await parseWithCorrectionRetry(
      'Circuit review',
      (correction) => sendChatCompletion(config, buildStage2Messages(circuit, correction), REVIEWER_RESPONSE_SCHEMA),
      parseReviewerResponse,
    );
    if (result.ok || !result.circuit) return { circuit, issues: [], code: result.code };
    return { circuit: result.circuit, issues: result.issues, code: result.code };
  } catch (error) {
    console.error(`[circuit-reviewer] ${(error as Error).message}`);
    return null;
  }
}

async function runReplyStage(
  prompt: string,
  circuit: Circuit,
  reviewIssues: string[],
  droppedKinds: Set<string>,
): Promise<string> {
  const config = providerConfig('reply');
  try {
    return await parseWithCorrectionRetry(
      'Reply generation',
      (correction) => sendChatCompletion(config, buildStage3Messages(prompt, circuit, reviewIssues, droppedKinds, correction), REPLY_RESPONSE_SCHEMA),
      parseReplyResponse,
    );
  } catch (error) {
    console.error(`[circuit-reply] ${(error as Error).message}`);
    return '';
  }
}

export async function runCircuitPipeline(
  prompt: string,
  history: ChatMessage[] = [],
  currentDesign: CurrentDesign | null = null,
  memory: Partial<ChatMemory> | null = null,
  onEvent: (event: PipelineEvent) => void = () => {},
): Promise<PipelineCircuitResult> {
  onEvent({ type: 'stage', stage: 'circuit' });
  const stage1Config = providerConfig('circuit');
  const useOllamaStream = stage1Config.provider === 'ollama';

  // Topology gate: every parsed candidate is scored on the shared rule engine
  // (src/core/topologyRules.js). Error-severity violations become the corrective
  // feedback for one retry via parseWithCorrectionRetry's checkCorrection hook;
  // warnings surface later but never block. The gate subsumes the old
  // floatingOpampInputCorrection (now the opamp_input_floating rule).
  const attempts: Array<{ circuit: Circuit; violations: TopologyViolation[]; errorCount: number }> = [];
  const topologyGate = (parsed: Circuit): string | null => {
    const { violations } = checkCircuitTopology(parsed);
    const errorCount = violations.filter((entry) => entry.severity === 'error').length;
    attempts.push({ circuit: parsed, violations, errorCount });
    return errorCount ? composeTopologyCorrection(violations) : null;
  };

  // Task 20: when a correction retry was provoked by an unsupported component
  // kind (validateCircuitResponse's `.kind "<x>" is not supported` error), the
  // model is told to "return a smaller complete response" and typically drops
  // the offending part rather than surfacing it. Harvest those kinds here so
  // the final circuit/reply can confess the omission instead of silently
  // shrinking the design.
  const droppedKinds = new Set<string>();
  const circuit = await parseWithCorrectionRetry(
    'Circuit generation',
    async (correction, attempt) => {
      if (correction) {
        for (const match of correction.error.matchAll(/\.kind "([^"]+)" is not supported/g)) droppedKinds.add(match[1]);
      }
      const messages = buildStage1Messages(prompt, history, currentDesign, memory, correction);
      if (useOllamaStream) {
        return streamOllamaChat(stage1Config, messages, STAGE1_RESPONSE_SCHEMA, (content) => {
          onEvent({ type: 'content', stage: 'circuit', content, attempt, correcting: Boolean(correction) });
        });
      }
      const content = await sendChatCompletion(stage1Config, messages, STAGE1_RESPONSE_SCHEMA);
      onEvent({ type: 'content', stage: 'circuit', content, attempt, correcting: Boolean(correction) });
      return content;
    },
    parseStage1Circuit,
    topologyGate,
  );

  // Never fail the turn once a candidate parsed: accept the best attempt (fewest
  // error violations, later attempt wins ties) and apply additive-only repairs
  // (flyback diode, gate pull-down) before the reviewer stage sees the circuit.
  const best = attempts.reduce((a, b) => (b.errorCount <= a.errorCount ? b : a), attempts[0])
    ?? { circuit, violations: [] as TopologyViolation[], errorCount: 0 };
  const repaired = applySafeAutoFixes(best.circuit, best.violations);
  let finalCircuit: Circuit = repaired.applied ? (repaired.circuit as Circuit) : best.circuit;
  if (droppedKinds.size) {
    finalCircuit = {
      ...finalCircuit,
      notes: [
        ...(finalCircuit.notes ?? []),
        ...[...droppedKinds].map((kind) => `Requested part "${kind}" is not supported by the component library and was omitted from this design.`),
      ],
    };
  }
  let reviewIssues: string[] = [];
  let code = '';
  if (reviewerEnabled()) {
    onEvent({ type: 'stage', stage: 'reviewing' });
    const reviewed = await runReviewerStage(finalCircuit);
    if (reviewed) {
      finalCircuit = reviewed.circuit;
      reviewIssues = reviewed.issues;
      code = reviewed.code;
    }
  }

  onEvent({ type: 'stage', stage: 'reply' });
  const reply = await runReplyStage(prompt, finalCircuit, reviewIssues, droppedKinds);

  return { reply, circuit: finalCircuit, code };
}
