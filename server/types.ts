import type { IncomingMessage } from 'node:http';

// ── Circuit model ──

export interface Component {
  ref: string;
  kind: string;
  value: string;
  nodes: string[];
  footprint: string;
  order?: number;
}

export interface ExternalTerminal {
  net: string;
  label: string;
  type: string;
  side: string;
  explicit?: boolean;
}

export interface NetRole {
  net: string;
  role: string;
  side: string;
}

export interface ComponentRole {
  ref: string;
  role: string;
  block: string;
  side: string;
  orientation: string;
  order?: number;
  pinRoles: Record<string, string>;
}

export interface SchematicBlock {
  id: string;
  role: string;
  refs: string[];
  side: string;
  order: number;
}

export interface SchematicHints {
  version: number;
  topology: string;
  primaryRef: string;
  externalTerminals: ExternalTerminal[];
  netRoles: NetRole[];
  componentRoles: ComponentRole[];
  blocks: SchematicBlock[];
}

export interface Circuit {
  title: string;
  type: string;
  supplyVoltage: number;
  nodes: string[];
  components: Component[];
  notes: string[];
  schematic?: SchematicHints;
}

// ── Chat & memory ──

export interface ChatMemory {
  summary: string;
  updatedAt: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content?: string;
  circuit?: Circuit;
}

export interface CurrentDesign {
  circuit: Circuit;
  spice?: string;
  kicadNetlist?: string;
}

// ── Clarifying questions ──

export interface ClarifyQuestion {
  id: string;
  question: string;
  options: string[];
}

export interface ClarifyResult {
  questions: ClarifyQuestion[];
}

// ── AI provider ──

export interface ProviderConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

// A functional design-rule finding from the shared topology checker
// (src/core/topologyRules.js). Error-severity violations gate the generation
// retry loop; whatever survives is surfaced in the UI, never fatal.
export interface RuleViolation {
  id: string;
  severity: 'error' | 'warning';
  refs: string[];
  nets: string[];
  message: string;
  fix: string;
  autoFixed?: boolean;
}

export interface GenerationMeta {
  attempts: number;
  // True when the retry budget ran out with error-severity violations left:
  // the best-scoring candidate was accepted and its issues surfaced.
  degraded: boolean;
}

export interface ParsedCircuitResponse {
  reply: string;
  circuit: Circuit;
  spice: string;
  // Firmware source for the circuit's MCU board; '' when the circuit has none.
  code: string;
}

// What the generation retry loop resolves to: the parsed response plus the
// topology-rule findings and retry metadata.
export interface GeneratedCircuit extends ParsedCircuitResponse {
  issues: RuleViolation[];
  generation: GenerationMeta;
}

export interface StreamState {
  attempt: number;
  correcting: boolean;
}

export interface CorrectionContext {
  content: string;
  error: string;
}

// ── Diagram & response ──

export interface DiagramPort {
  net: string;
  [key: string]: unknown;
}

export interface DiagramWire {
  points: Array<{ x: number; y: number }>;
  labelId?: string;
  [key: string]: unknown;
}

export interface Diagram {
  layoutMode?: string;
  layoutWarning?: string;
  layoutError?: string;
  layoutViolations?: Array<{ type: string; [key: string]: unknown }>;
  netLabels: unknown[];
  ports: DiagramPort[];
  wires: DiagramWire[];
  [key: string]: unknown;
}

export interface CircuitIntent {
  rawPrompt: string;
  type: string;
}

export interface Validation {
  ok: boolean;
  errors?: string[];
  warnings?: string[];
}

export interface CircuitResponse {
  intent: CircuitIntent;
  circuit: Circuit;
  validation: Validation;
  diagram: Diagram;
  diagramSvg: string;
  spice: string;
  kicadNetlist: string;
  simulation: unknown;
  source: string;
  reply?: string;
  code?: string;
  memory?: ChatMemory;
  issues?: RuleViolation[];
  generation?: GenerationMeta;
  contextDiagnostics?: Record<string, unknown>;
}

// ── Simulation ──

export interface WaveformPoint {
  x: number;
  y: number;
}

export interface WaveformSeries {
  name: string;
  points: WaveformPoint[];
}

export interface Waveform {
  xLabel: string;
  yLabel: string;
  series: WaveformSeries[];
}

export interface SimulationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  rawOutput: string;
  waveform: Waveform;
}

// ── Firmware compilation ──

export interface CompileResult {
  ok: boolean;
  // Intel HEX text of the compiled sketch ('' on failure).
  hex: string;
  errors: string[];
  warnings: string[];
  rawOutput: string;
}

// ── Auth ──

export interface JwtPayload {
  id: number;
  email: string;
  iat?: number;
  exp?: number;
}

export interface AuthResult {
  status: number;
  body: Record<string, unknown>;
}

export interface AuthRequest extends IncomingMessage {
  headers: IncomingMessage['headers'] & {
    authorization?: string;
  };
}

export interface LocalUser {
  id: number;
  email: string;
  password_hash: string;
  verified: boolean;
  verify_token: string | null;
  created_at: string;
}

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
}

// ── Streaming ──

export interface StreamingSpiceResult {
  componentCount: number;
  title: string;
  spice: string;
}

export interface OllamaRequestBody {
  model: string;
  stream: boolean;
  format: Record<string, unknown>;
  options: {
    num_ctx: number;
    num_predict: number;
    temperature: number;
  };
  messages: Array<{ role: string; content: string }>;
}
