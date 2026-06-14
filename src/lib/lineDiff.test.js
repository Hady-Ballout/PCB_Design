import { describe, expect, it } from 'vitest';
import { changedLineIndexes } from './lineDiff.js';

describe('line diff', () => {
  it('marks added and edited lines in the proposed text', () => {
    const changed = changedLineIndexes('alpha\nbeta\ngamma', 'alpha\nbeta edited\nadded\ngamma');
    expect([...changed]).toEqual([1, 2]);
  });

  it('does not mark unchanged text', () => {
    expect([...changedLineIndexes('alpha\nbeta', 'alpha\nbeta')]).toEqual([]);
  });
});
