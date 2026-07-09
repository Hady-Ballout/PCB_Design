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

// ── AI provider ──

export interface ProviderConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface ParsedCircuitResponse {
  reply: string;
  circuit: Circuit;
  /** Firmware source for the circuit's MCU board; '' when the circuit has none. */
  code: string;
}

export interface CorrectionContext {
  content: string;
  error: string;
}

// ── Multi-stage pipeline ──

export type PipelineStageName = 'circuit' | 'reviewing' | 'reply';

export interface PipelineStageEvent {
  type: 'stage';
  stage: PipelineStageName;
}

export interface PipelineContentEvent {
  type: 'content';
  stage: 'circuit';
  content: string;
  attempt: number;
  correcting: boolean;
}

export type PipelineEvent = PipelineStageEvent | PipelineContentEvent;

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
