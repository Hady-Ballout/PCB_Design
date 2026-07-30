import { ALLOWED_KINDS } from '../../src/core/componentKinds.js';
import { normalizeChatMemory, chatMemoryLimits } from './chatMemory.js';
import { circuitKnowledgePrompt } from './circuitKnowledge.js';
import {
  buildOpenAiCompatibleBody,
  currentCircuitInventory,
  findBalancedJson,
  ollamaHeaders,
  ollamaUrl,
  openAiCompatibleHeaders,
  openAiCompatibleUrl,
  positiveIntegerOption,
  providerConfig,
  readOpenAiCompatibleContent,
  streamOpenAiCompatibleContent,
} from './ollamaProvider.js';
import { recordProviderUsage } from './tokenUsage.js';
import type {
  AssistMode,
  AssistResult,
  ChatMemory,
  ChatMessage,
  CurrentDesign,
  OllamaRequestBody,
  ThinkingCallback,
} from '../types.js';

const MAX_REPLY_LENGTH = 8000;

export const ASSIST_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
  },
  required: ['reply'],
} as const;

export const PLAN_SYSTEM_PROMPT = `You are an electronics design planner for a beginner-safe circuit generator.
Return exactly one valid JSON object shaped {"reply":"..."} and no other text, no Markdown fences.
The reply is a short textual design plan for the user's circuit request: the proposed approach and topology, a component list with concrete values and refs, the power or supply choice, key tradeoffs, and any assumptions you made.
Write plain text with newlines and simple "-" bullets. No Markdown headers, no code fences, no JSON circuit, no SPICE netlist.
Do NOT generate a circuit. Do not output component JSON or netlists; the user will separately ask to build the plan.
Only propose parts from this list of buildable component kinds: ${ALLOWED_KINDS.join(', ')}.
When a current design is provided, plan an edit to that design: describe what changes and what stays, preserving unchanged components, refs, and values.`;

export const ASK_SYSTEM_PROMPT = `You are a friendly electronics tutor inside a circuit-design app.
Return exactly one valid JSON object shaped {"reply":"..."} and no other text, no Markdown fences.
Answer the user's question conversationally and concisely in plain text. When a current design is provided, reference its actual component refs and values.
You never modify the design and must never claim to have changed anything; if the user wants a change, suggest switching to Implement mode.`;

// Ask needs conversational continuity, so unlike the generation history filter
// this keeps assistant text-only turns (plan/ask replies) alongside user turns
// and assistant circuit turns.
export const sanitizeAssistHistory = (history: unknown): Array<{ role: string; content: string }> =>
  (Array.isArray(history) ? history : [])
    .filter((message: ChatMessage) => message?.role === 'user' || message?.role === 'assistant')
    .slice(-chatMemoryLimits.history)
    .map((message: ChatMessage) => ({
      role: message.role,
      content: message.role === 'assistant' && message.circuit
        ? `Confirmed circuit: ${JSON.stringify(message.circuit).slice(0, 4000)}`
        : String(message.content || '').trim().slice(0, chatMemoryLimits.message),
    }))
    .filter((message) => message.content);

const assistDesignContext = (mode: AssistMode, currentDesign: CurrentDesign | null): Array<{ role: string; content: string }> => {
  if (!currentDesign?.circuit) return [];
  const inventory = `The user has an existing design titled "${currentDesign.circuit.title}".\n${currentCircuitInventory(currentDesign.circuit)}`;
  const content = mode === 'ask'
    ? `${inventory}\nFull current circuit JSON for reference:\n${JSON.stringify(currentDesign.circuit).slice(0, 8000)}`
    : `${inventory}\nTreat the request as a plan for an edit to this design, preserving unchanged parts.`;
  return [{ role: 'system', content }];
};

export const buildAssistRequestBody = (
  mode: AssistMode,
  prompt: string,
  history: ChatMessage[],
  currentDesign: CurrentDesign | null = null,
  memory: Partial<ChatMemory> | null = null,
): OllamaRequestBody => {
  const normalizedMemory = normalizeChatMemory(memory);
  const memoryContext = normalizedMemory.summary
    ? [{ role: 'system', content: `Active chat memory:\n${normalizedMemory.summary}` }]
    : [];
  const knowledgePrompt = mode === 'plan' ? circuitKnowledgePrompt() : '';

  return {
    model: process.env.OLLAMA_MODEL || 'llama3.2:latest',
    stream: false,
    format: ASSIST_SCHEMA as unknown as Record<string, unknown>,
    options: {
      num_ctx: positiveIntegerOption(process.env.OLLAMA_NUM_CTX, 8192),
      num_predict: positiveIntegerOption(process.env.OLLAMA_NUM_PREDICT_ASSIST, 1024),
      temperature: 0,
    },
    messages: [
      { role: 'system', content: mode === 'plan' ? PLAN_SYSTEM_PROMPT : ASK_SYSTEM_PROMPT },
      ...(knowledgePrompt ? [{ role: 'system', content: knowledgePrompt }] : []),
      ...memoryContext,
      ...assistDesignContext(mode, currentDesign),
      ...sanitizeAssistHistory(history),
      {
        role: 'user',
        content: mode === 'plan' ? `Circuit request to plan: ${prompt}` : `Question: ${prompt}`,
      },
    ],
  };
};

// Unlike clarify's cleaner this preserves newlines — plans are multi-line text.
export const cleanAssistReply = (value: unknown): string =>
  String(value || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_REPLY_LENGTH);

export async function generateAssistReply(
  mode: AssistMode,
  prompt: string,
  history: ChatMessage[] = [],
  currentDesign: CurrentDesign | null = null,
  memory: Partial<ChatMemory> | null = null,
  onThinking: ThinkingCallback | null = null,
): Promise<AssistResult> {
  const config = providerConfig();
  const body = buildAssistRequestBody(mode, prompt, history, currentDesign, memory);

  let content = '';
  if (config.provider === 'ollama') {
    const response = await fetch(ollamaUrl(), {
      method: 'POST',
      headers: ollamaHeaders(),
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
    const data = await response.json() as Record<string, unknown>;
    content = (data.message as Record<string, unknown>)?.content as string || '';
  } else if (onThinking) {
    content = await streamOpenAiCompatibleContent(config, body, { onThinking });
  } else {
    const response = await fetch(openAiCompatibleUrl(config), {
      method: 'POST',
      headers: openAiCompatibleHeaders(config),
      body: JSON.stringify(buildOpenAiCompatibleBody(config, body)),
    });
    if (!response.ok) throw new Error(`${config.provider} returned ${response.status}: ${await response.text()}`);
    const data = await response.json() as Record<string, unknown>;
    recordProviderUsage(data);
    content = readOpenAiCompatibleContent(data);
  }

  // No correction retry: assist replies are cheap and the client surfaces the
  // error without touching the design.
  const { jsonText, balanced } = findBalancedJson(content);
  let reply = '';
  let parsedWrapper = false;
  if (jsonText && balanced) {
    try {
      reply = cleanAssistReply((JSON.parse(jsonText) as Record<string, unknown>).reply);
      parsedWrapper = true;
    } catch {
      // fall through to the plain-text fallback
    }
  }
  // Plain-text fallback for models that ignore the JSON format — but not when
  // a wrapper parsed with an empty reply, where the raw content is just the
  // wrapper itself.
  if (!reply && !parsedWrapper) reply = cleanAssistReply(content);
  if (!reply) throw new Error('Assistant returned an empty reply.');
  return { mode, reply };
}
