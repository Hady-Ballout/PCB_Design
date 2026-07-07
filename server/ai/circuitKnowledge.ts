import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const knowledgePath = resolve(process.cwd(), 'ai-context', 'pcb-circuit-expert.md');

export const loadCircuitKnowledge = (): string => {
  try {
    return readFileSync(knowledgePath, 'utf8').trim();
  } catch (error) {
    console.warn(`[circuit-knowledge] Could not load ${knowledgePath}: ${(error as Error).message}`);
    return '';
  }
};

export const circuitKnowledgePrompt = (): string => {
  const knowledge = loadCircuitKnowledge();
  return knowledge
    ? `Additional circuit design rules and examples:\n\n${knowledge}`
    : '';
};
