import { describe, expect, it } from 'vitest';
import {
  chatMemoryLimits,
  normalizeChatMemory,
  sanitizeConversationHistory,
  updateChatMemory,
} from './chatMemory.js';

const circuit = {
  title: 'Divider',
  type: 'voltage_divider',
  supplyVoltage: 12,
  components: [
    { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VIN', 'OUT'] },
    { ref: 'R2', kind: 'resistor', value: '3.9k', nodes: ['OUT', '0'] },
  ],
  notes: ['Use through-hole parts'],
};

describe('chat memory', () => {
  it('normalizes missing and oversized memory', () => {
    expect(normalizeChatMemory(null)).toEqual({ summary: '', updatedAt: 0 });
    expect(normalizeChatMemory({ summary: 'x'.repeat(7000), updatedAt: 4 }).summary)
      .toHaveLength(chatMemoryLimits.summary);
  });

  it('keeps the recent server-owned history window', () => {
    const history = Array.from({ length: 15 }, (_, index) => ({ role: 'user' as const, content: `Turn ${index + 1}` }));
    const sanitized = sanitizeConversationHistory(history);

    expect(sanitized).toHaveLength(chatMemoryLimits.history);
    expect(sanitized[0].content).toBe('Turn 4');
  });

  it('drops assistant clarification turns that carry no circuit', () => {
    const history = [
      { role: 'user' as const, content: 'blink an LED' },
      {
        role: 'assistant' as const,
        content: 'A few quick questions before I design this:',
        clarification: { questions: [{ id: 'q1', question: 'Supply?', options: ['5V'] }] },
      } as never,
      { role: 'assistant' as const, content: 'Done', circuit: circuit as never },
    ];

    expect(sanitizeConversationHistory(history)).toEqual([
      { role: 'user', content: 'blink an LED' },
      { role: 'assistant', content: 'Done', circuit },
    ]);
  });

  it('retains older requirements while recording the latest confirmed design', () => {
    let memory = { summary: 'Latest request: Requirement 1', updatedAt: 1 };
    for (let index = 2; index <= 8; index += 1) {
      memory = updateChatMemory(memory, `Requirement ${index}`, circuit as any, index);
    }

    expect(memory.summary).toContain('Requirement 1');
    expect(memory.summary).toContain('Requirement 8');
    expect(memory.summary).toContain('R1:resistor:10k:VIN-OUT');
    expect(memory.updatedAt).toBe(8);
  });
});
