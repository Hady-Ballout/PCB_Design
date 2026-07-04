import type { ChatMemory, ChatMessage, Circuit } from '../types.js';

const MEMORY_SUMMARY_LIMIT = 6000;
const REQUEST_HISTORY_LIMIT = 12;
const MESSAGE_CONTENT_LIMIT = 2000;

const cleanText = (value: unknown, limit: number): string =>
  String(value || '').trim().replace(/\s+/g, ' ').slice(0, limit);

export const normalizeChatMemory = (memory: Partial<ChatMemory> | null | undefined): ChatMemory => ({
  summary: cleanText(memory?.summary, MEMORY_SUMMARY_LIMIT),
  updatedAt: Number(memory?.updatedAt) > 0 ? Number(memory!.updatedAt) : 0,
});

export const sanitizeConversationHistory = (history: unknown): ChatMessage[] =>
  (Array.isArray(history) ? history : [])
    .filter((message: ChatMessage) => message?.role === 'user' || (message?.role === 'assistant' && message.circuit))
    .slice(-REQUEST_HISTORY_LIMIT)
    .map((message: ChatMessage) => ({
      role: message.role,
      content: cleanText(message.content, MESSAGE_CONTENT_LIMIT),
      ...(message.circuit && typeof message.circuit === 'object' ? { circuit: message.circuit } : {}),
    }));

const componentSummary = (component: { ref: string; kind: string; value: string; nodes: string[] }): string => {
  const nodes = Array.isArray(component.nodes) ? component.nodes.join('-') : '';
  return `${component.ref}:${component.kind}:${component.value}:${nodes}`;
};

export const updateChatMemory = (
  memory: Partial<ChatMemory> | null | undefined,
  prompt: string,
  circuit: Circuit | null | undefined,
  now: number = Date.now(),
): ChatMemory => {
  const previous = normalizeChatMemory(memory).summary;
  const request = cleanText(prompt, 1000);
  const components = (Array.isArray(circuit?.components) ? circuit!.components : [])
    .map(componentSummary)
    .join(', ');
  const design = cleanText(
    `${circuit?.title || 'Circuit'}; type=${circuit?.type || 'unknown'}; supply=${circuit?.supplyVoltage ?? 'unknown'}V; components=[${components}]; notes=[${(circuit?.notes || []).join('; ')}]`,
    3000,
  );
  const latest = `Latest request: ${request}\nConfirmed design: ${design}`;
  const priorBudget = Math.max(0, MEMORY_SUMMARY_LIMIT - latest.length - 2);
  const retainedPrevious = previous.slice(-priorBudget);

  return {
    summary: retainedPrevious ? `${retainedPrevious}\n${latest}` : latest,
    updatedAt: now,
  };
};

export const chatMemoryLimits = {
  summary: MEMORY_SUMMARY_LIMIT,
  history: REQUEST_HISTORY_LIMIT,
  message: MESSAGE_CONTENT_LIMIT,
} as const;
