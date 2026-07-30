import { normalizeChatMemory, sanitizeConversationHistory } from './chatMemory.js';
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
  ChatMemory,
  ChatMessage,
  ClarifyQuestion,
  ClarifyResult,
  CurrentDesign,
  OllamaRequestBody,
  ThinkingCallback,
} from '../types.js';

export const NO_PREFERENCE_OPTION = 'No preference (you decide)';

const MAX_QUESTIONS = 3;
const MAX_MODEL_OPTIONS = 4;
const MAX_TEXT_LENGTH = 200;

export const CLARIFY_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_QUESTIONS,
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: MAX_MODEL_OPTIONS },
        },
        required: ['question', 'options'],
      },
    },
  },
  required: ['questions'],
} as const;

export const CLARIFY_SYSTEM_PROMPT = `You are a requirements assistant for a beginner-safe electronics circuit generator.
Return exactly one valid JSON object shaped {"questions":[{"question":"...","options":["...","..."]}]} and no other text, no Markdown.
Ask 1 to 3 short clarifying questions about the user's circuit request. Only ask about the decisions that most change the resulting design: power source or supply voltage, key electrical values (frequency, current, brightness, gain, timing), board or interface choice, and intended behavior.
Never ask about anything the request already specifies. Never ask about footprints, safety disclaimers, or software details unless the request involves a microcontroller board.
Each question must be at most 12 words. Each question gets 2 to 4 answer options: short concrete phrases of at most 6 words, mutually exclusive, most common choice first.
Do not include an "other", "no preference", or "you decide" option; the application adds one automatically.
When a current design is provided, the request is an edit: ask only about that edit (for example which component to change or by how much), not about the whole circuit.`;

const clarifyDesignContext = (currentDesign: CurrentDesign | null): Array<{ role: string; content: string }> => (
  currentDesign?.circuit
    ? [{
        role: 'system',
        content: `The user is editing an existing design titled "${currentDesign.circuit.title}".\n${currentCircuitInventory(currentDesign.circuit)}\nAsk clarifying questions about the requested edit only.`,
      }]
    : []
);

export const buildClarifyRequestBody = (
  prompt: string,
  history: ChatMessage[],
  currentDesign: CurrentDesign | null = null,
  memory: Partial<ChatMemory> | null = null,
): OllamaRequestBody => {
  const priorRequests = sanitizeConversationHistory(history)
    .filter((message) => message.role === 'user')
    .map((message) => ({ role: 'user', content: `Previous circuit request: ${String(message.content || '')}` }));

  const normalizedMemory = normalizeChatMemory(memory);
  const memoryContext = normalizedMemory.summary
    ? [{ role: 'system', content: `Active chat memory:\n${normalizedMemory.summary}` }]
    : [];

  return {
    model: process.env.OLLAMA_MODEL || 'llama3.2:latest',
    stream: false,
    format: CLARIFY_SCHEMA as unknown as Record<string, unknown>,
    options: {
      num_ctx: positiveIntegerOption(process.env.OLLAMA_NUM_CTX, 8192),
      num_predict: positiveIntegerOption(process.env.OLLAMA_NUM_PREDICT_CLARIFY, 512),
      temperature: 0,
    },
    messages: [
      { role: 'system', content: CLARIFY_SYSTEM_PROMPT },
      ...memoryContext,
      ...clarifyDesignContext(currentDesign),
      ...priorRequests,
      { role: 'user', content: `Circuit request: ${prompt}` },
    ],
  };
};

// Variants the model emits despite instructions; the canonical option is
// appended once below so duplicates here would render twice.
const NO_PREFERENCE_PATTERN = /^(no preference|you decide|other|any|either|whatever|not sure|don'?t (care|know|mind)|doesn'?t matter|surprise me)\b/i;

const cleanClarifyText = (value: unknown): string =>
  String(value || '').trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT_LENGTH);

export const sanitizeClarifyQuestions = (raw: unknown): ClarifyQuestion[] => {
  const rawQuestions = Array.isArray((raw as { questions?: unknown })?.questions)
    ? (raw as { questions: unknown[] }).questions
    : [];

  const questions: ClarifyQuestion[] = [];
  for (const item of rawQuestions) {
    if (questions.length >= MAX_QUESTIONS) break;
    if (!item || typeof item !== 'object') continue;
    const question = cleanClarifyText((item as { question?: unknown }).question);
    if (!question) continue;

    const seen = new Set<string>();
    const options: string[] = [];
    const rawOptions = Array.isArray((item as { options?: unknown }).options)
      ? (item as { options: unknown[] }).options
      : [];
    for (const rawOption of rawOptions) {
      if (options.length >= MAX_MODEL_OPTIONS) break;
      const option = cleanClarifyText(rawOption);
      if (!option || NO_PREFERENCE_PATTERN.test(option)) continue;
      const key = option.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      options.push(option);
    }
    if (!options.length) continue;

    questions.push({
      id: `q${questions.length + 1}`,
      question,
      options: [...options, NO_PREFERENCE_OPTION],
    });
  }
  return questions;
};

export async function generateClarifyingQuestions(
  prompt: string,
  history: ChatMessage[] = [],
  currentDesign: CurrentDesign | null = null,
  memory: Partial<ChatMemory> | null = null,
  onThinking: ThinkingCallback | null = null,
): Promise<ClarifyResult> {
  const config = providerConfig();
  const body = buildClarifyRequestBody(prompt, history, currentDesign, memory);

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

  const { jsonText, balanced } = findBalancedJson(content);
  if (!jsonText || !balanced) throw new Error('Clarify response did not contain a complete JSON object.');
  // No correction retry here: a failed clarify round is cheap, the client
  // falls back to direct circuit generation.
  return { questions: sanitizeClarifyQuestions(JSON.parse(jsonText)) };
}
