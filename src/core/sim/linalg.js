// Minimal dense linear algebra for the interactive breadboard simulator.
// Circuits here stay well under ~100 unknowns, so dense Gaussian elimination
// with scaled partial pivoting beats pulling in a matrix library.

const SINGULAR_EPS = 1e-13;

export const makeMatrix = (n) => Array.from({ length: n }, () => new Float64Array(n));

export const clearMatrix = (matrix) => {
  for (const row of matrix) row.fill(0);
};

// Solve A x = b. Mutates A and b (callers restamp both every solve anyway).
// Returns a Float64Array solution, or null when the system is singular.
export const solveDense = (matrix, rhs) => {
  const n = rhs.length;
  if (n === 0) return new Float64Array(0);
  const rows = matrix.slice(0, n);
  // Scale each pivot comparison by its row's largest magnitude so a row of
  // tiny conductances (10 MΩ switches) competes fairly with a 1 mΩ shunt row.
  const scale = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let max = 0;
    for (let j = 0; j < n; j += 1) max = Math.max(max, Math.abs(rows[i][j]));
    if (max === 0) return null;
    scale[i] = max;
  }
  const perm = new Int32Array(n);
  for (let i = 0; i < n; i += 1) perm[i] = i;

  for (let col = 0; col < n; col += 1) {
    let best = col;
    let bestRatio = Math.abs(rows[perm[col]][col]) / scale[perm[col]];
    for (let row = col + 1; row < n; row += 1) {
      const ratio = Math.abs(rows[perm[row]][col]) / scale[perm[row]];
      if (ratio > bestRatio) {
        bestRatio = ratio;
        best = row;
      }
    }
    if (bestRatio < SINGULAR_EPS) return null;
    if (best !== col) {
      const swap = perm[col];
      perm[col] = perm[best];
      perm[best] = swap;
    }
    const pivotRow = rows[perm[col]];
    const pivot = pivotRow[col];
    for (let row = col + 1; row < n; row += 1) {
      const target = rows[perm[row]];
      const factor = target[col] / pivot;
      if (factor === 0) continue;
      target[col] = 0;
      for (let j = col + 1; j < n; j += 1) target[j] -= factor * pivotRow[j];
      rhs[perm[row]] -= factor * rhs[perm[col]];
    }
  }

  const solution = new Float64Array(n);
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = rows[perm[i]];
    let sum = rhs[perm[i]];
    for (let j = i + 1; j < n; j += 1) sum -= row[j] * solution[j];
    solution[i] = sum / row[i];
  }
  return solution;
};
