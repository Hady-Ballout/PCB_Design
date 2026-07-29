import { describe, expect, it } from 'vitest';
import {
  chatMemoryLimits,
  normalizeChatMemory,
  sanitizeConversationHistory,
  sanitizeReplyHistory,
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

  it('keeps assistant text-only turns in the reply history', () => {
    const history = [
      { role: 'user' as const, content: 'blink an LED' },
      { role: 'assistant' as const, content: 'I built a blinker with R1 and DLED1.' },
      { role: 'user' as const, content: 'make it faster' },
    ];

    expect(sanitizeReplyHistory(history)).toEqual([
      { role: 'user', content: 'blink an LED' },
      { role: 'assistant', content: 'I built a blinker with R1 and DLED1.' },
      { role: 'user', content: 'make it faster' },
    ]);
  });

  it('keeps only the recent reply-history window and truncates long messages', () => {
    const history = Array.from({ length: 12 }, (_, index) => ({
      role: 'user' as const,
      content: `Turn ${index + 1} ${'x'.repeat(2000)}`,
    }));
    const sanitized = sanitizeReplyHistory(history);

    expect(sanitized).toHaveLength(chatMemoryLimits.replyHistory);
    expect(sanitized[0].content).toContain('Turn 5');
    expect(sanitized[0].content).toHaveLength(chatMemoryLimits.replyMessage);
  });

  it('summarizes circuit-bearing turns with empty text and drops content-less turns', () => {
    const history = [
      { role: 'assistant' as const, content: '', circuit: circuit as never },
      { role: 'assistant' as const, content: '   ' },
      { role: 'user' as const, content: 'change R2' },
    ];

    expect(sanitizeReplyHistory(history)).toEqual([
      { role: 'assistant', content: 'Delivered circuit "Divider" (2 components).' },
      { role: 'user', content: 'change R2' },
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
