import { describe, expect, it } from 'vitest';
import { PENDING_PROMPT_KEY, stashPendingPrompt, takePendingPrompt } from './pendingPrompt.js';

const memory = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
};

describe('pending prompt handoff', () => {
  it('round-trips trimmed text and clears it on take', () => {
    const storage = memory();
    stashPendingPrompt('  blink an LED  ', storage);
    expect(storage.getItem(PENDING_PROMPT_KEY)).toBe('blink an LED');
    expect(takePendingPrompt(storage)).toBe('blink an LED');
    expect(takePendingPrompt(storage)).toBe('');
  });

  it('ignores blank input and survives a missing storage', () => {
    const storage = memory();
    stashPendingPrompt('   ', storage);
    expect(storage.getItem(PENDING_PROMPT_KEY)).toBeNull();
    expect(() => stashPendingPrompt('x', null)).not.toThrow();
    expect(takePendingPrompt(null)).toBe('');
  });
});
