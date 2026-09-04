import { describe, expect, it } from 'vitest';
import { placeholderAt } from './typingPlaceholder.js';

const examples = ['ab', 'cde'];
const opts = { typeMs: 10, holdMs: 50, eraseMs: 5 };

describe('placeholderAt', () => {
  it('types the first example one character per tick', () => {
    expect(placeholderAt(examples, 0, opts)).toBe('');
    expect(placeholderAt(examples, 10, opts)).toBe('a');
    expect(placeholderAt(examples, 20, opts)).toBe('ab');
  });

  it('holds the full example, then erases it', () => {
    expect(placeholderAt(examples, 20 + 49, opts)).toBe('ab');
    expect(placeholderAt(examples, 20 + 50 + 5, opts)).toBe('a');
    expect(placeholderAt(examples, 20 + 50 + 10, opts)).toBe('');
  });

  it('moves on to the next example and wraps around', () => {
    const cycle1 = 2 * 10 + 50 + 2 * 5; // 80
    expect(placeholderAt(examples, cycle1 + 10, opts)).toBe('c');
    expect(placeholderAt(examples, cycle1 + 30, opts)).toBe('cde');
    const cycle2 = 3 * 10 + 50 + 3 * 5; // 95
    expect(placeholderAt(examples, cycle1 + cycle2 + 10, opts)).toBe('a');
  });

  it('is empty for no examples', () => {
    expect(placeholderAt([], 1234, opts)).toBe('');
  });
});
