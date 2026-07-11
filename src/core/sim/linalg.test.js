import { describe, expect, it } from 'vitest';
import { clearMatrix, makeMatrix, solveDense } from './linalg.js';

const matrixFrom = (rows) => rows.map((row) => Float64Array.from(row));

describe('solveDense', () => {
  it('solves a known 3x3 system', () => {
    const A = matrixFrom([
      [2, 1, -1],
      [-3, -1, 2],
      [-2, 1, 2],
    ]);
    const b = Float64Array.from([8, -11, -3]);
    const x = solveDense(A, b);
    expect(x[0]).toBeCloseTo(2, 10);
    expect(x[1]).toBeCloseTo(3, 10);
    expect(x[2]).toBeCloseTo(-1, 10);
  });

  it('solves a 5x5 system against a known product', () => {
    // Build A x = b from a chosen x so the expected answer is exact.
    const A = matrixFrom([
      [4, 1, 0, 0, 2],
      [1, 5, 1, 0, 0],
      [0, 1, 6, 1, 0],
      [0, 0, 1, 7, 1],
      [2, 0, 0, 1, 8],
    ]);
    const chosen = [1, -2, 3, -4, 5];
    const b = Float64Array.from(A.map((row) => row.reduce((sum, value, j) => sum + value * chosen[j], 0)));
    const x = solveDense(A, b);
    chosen.forEach((expected, i) => expect(x[i]).toBeCloseTo(expected, 9));
  });

  it('pivots past a zero on the diagonal', () => {
    const A = matrixFrom([
      [0, 1],
      [1, 0],
    ]);
    const b = Float64Array.from([3, 7]);
    const x = solveDense(A, b);
    expect(x[0]).toBeCloseTo(7, 12);
    expect(x[1]).toBeCloseTo(3, 12);
  });

  it('handles a wide conductance spread (1 mΩ vs 10 MΩ)', () => {
    // Two independent resistive nodes: g1 = 1000 S, g2 = 1e-7 S.
    const A = matrixFrom([
      [1000, 0],
      [0, 1e-7],
    ]);
    const b = Float64Array.from([5, 5e-7]);
    const x = solveDense(A, b);
    expect(x[0]).toBeCloseTo(0.005, 9);
    expect(x[1]).toBeCloseTo(5, 6);
  });

  it('returns null for a singular matrix', () => {
    const A = matrixFrom([
      [1, 2],
      [2, 4],
    ]);
    const b = Float64Array.from([1, 2]);
    expect(solveDense(A, b)).toBeNull();
  });

  it('returns null for an all-zero row', () => {
    const A = matrixFrom([
      [1, 0],
      [0, 0],
    ]);
    const b = Float64Array.from([1, 0]);
    expect(solveDense(A, b)).toBeNull();
  });
});

describe('makeMatrix / clearMatrix', () => {
  it('allocates and zeroes reusable rows', () => {
    const A = makeMatrix(3);
    A[1][2] = 4;
    clearMatrix(A);
    expect(A[1][2]).toBe(0);
    expect(A.length).toBe(3);
    expect(A[0].length).toBe(3);
  });
});
