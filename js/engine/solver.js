/**
 * solver.js — dense LU decomposition with partial pivoting, generic over a
 * scalar "field" (real for DC/transient, complex for AC — see util/complex.js).
 *
 * THE PROBLEM WE ARE SOLVING
 * --------------------------
 * MNA hands us a square linear system  A·x = z, where A is the (N+M)×(N+M)
 * MNA matrix, z holds source contributions, and x stacks the unknown node
 * voltages and voltage-source branch currents. We need x.
 *
 * WHY LU AND NOT PLAIN GAUSSIAN ELIMINATION
 * -----------------------------------------
 * LU decomposition IS Gaussian elimination — we just remember the row
 * multipliers (the L factors) instead of throwing them away. Same cost,
 * and if we ever solve the same matrix with several right-hand sides
 * (transient analysis with a fixed time step does exactly this when the
 * matrix doesn't change), we can reuse the factorization.
 *
 * WHY PARTIAL PIVOTING
 * --------------------
 * At each elimination column we swap up the row whose pivot entry has the
 * largest magnitude. Two reasons:
 *   1. Numerical stability — dividing by a tiny pivot amplifies rounding
 *      error catastrophically.
 *   2. Correctness — MNA matrices legitimately contain structural zeros on
 *      the diagonal (a voltage-source row has 0 there!), so without row
 *      swaps the elimination would divide by zero on perfectly valid
 *      circuits.
 *
 * SINGULAR MATRICES
 * -----------------
 * If even the best available pivot is (near) zero, the matrix is singular:
 * the circuit has no unique solution. Classic causes:
 *   - a floating node (no DC path to ground → its row is all zeros)
 *   - a loop of ideal voltage sources (contradictory / redundant KVL rows)
 * We throw SingularMatrixError with a user-facing message rather than
 * returning NaNs. The UI catches this and tells the user what to check.
 */

export class SingularMatrixError extends Error {
  constructor() {
    super(
      "Circuit is singular — check for floating nodes (every node needs a " +
      "DC path to ground) or loops of ideal voltage sources."
    );
    this.name = "SingularMatrixError";
  }
}

/**
 * Relative threshold for declaring a pivot "zero". We compare each pivot
 * against the largest magnitude seen anywhere in the original matrix, so
 * the test is scale-invariant (a circuit in MΩ and one in mΩ behave the
 * same). 1e-12 of the max entry is far below anything a physically
 * meaningful circuit produces, but far above accumulated float64 noise.
 */
const PIVOT_RTOL = 1e-12;

/**
 * Factor A in place into P·A = L·U (Doolittle, partial pivoting).
 *
 * @param {Array<Array>} A  n×n matrix of field elements. MUTATED: on return
 *                          it holds U in the upper triangle and the L
 *                          multipliers (unit diagonal implied) below it.
 * @param {object} field    arithmetic ops {zero,add,sub,mul,div,mag}
 * @returns {number[]}      perm — row permutation applied (perm[i] = original
 *                          row index now living at row i), needed by luSolve.
 * @throws {SingularMatrixError}
 */
export function luFactor(A, field) {
  const n = A.length;
  const f = field;
  const perm = Array.from({ length: n }, (_, i) => i);

  // Scale reference for the singularity test (see PIVOT_RTOL comment).
  let maxMag = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) maxMag = Math.max(maxMag, f.mag(A[i][j]));
  if (maxMag === 0) throw new SingularMatrixError(); // all-zero matrix
  const pivotFloor = maxMag * PIVOT_RTOL;

  for (let col = 0; col < n; col++) {
    // --- Partial pivoting: find the largest |entry| in this column at or
    // below the diagonal, and swap that row up to the diagonal position.
    let best = col;
    let bestMag = f.mag(A[col][col]);
    for (let row = col + 1; row < n; row++) {
      const m = f.mag(A[row][col]);
      if (m > bestMag) { best = row; bestMag = m; }
    }
    if (bestMag <= pivotFloor) throw new SingularMatrixError();
    if (best !== col) {
      [A[col], A[best]] = [A[best], A[col]];
      [perm[col], perm[best]] = [perm[best], perm[col]];
    }

    // --- Eliminate below the pivot. For each lower row we compute the
    // multiplier m = A[row][col] / pivot, store it (that's the L entry),
    // and subtract m × (pivot row) from the row.
    const pivot = A[col][col];
    for (let row = col + 1; row < n; row++) {
      const m = f.div(A[row][col], pivot);
      A[row][col] = m; // store L factor in the zeroed-out position
      for (let j = col + 1; j < n; j++) {
        A[row][j] = f.sub(A[row][j], f.mul(m, A[col][j]));
      }
    }
  }
  return perm;
}

/**
 * Solve L·U·x = P·z given the factorization from luFactor.
 *
 * @param {Array<Array>} LU  output of luFactor (not modified)
 * @param {number[]} perm    permutation from luFactor
 * @param {Array} z          right-hand side (not modified)
 * @param {object} field
 * @returns {Array} x        solution vector of field elements
 */
export function luSolve(LU, perm, z, field) {
  const n = LU.length;
  const f = field;

  // Forward substitution: solve L·y = P·z. L has an implied unit diagonal,
  // so y[i] = z[perm[i]] − Σ_{j<i} L[i][j]·y[j].
  const y = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = z[perm[i]];
    for (let j = 0; j < i; j++) s = f.sub(s, f.mul(LU[i][j], y[j]));
    y[i] = s;
  }

  // Back substitution: solve U·x = y.
  // x[i] = (y[i] − Σ_{j>i} U[i][j]·x[j]) / U[i][i].
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let j = i + 1; j < n; j++) s = f.sub(s, f.mul(LU[i][j], x[j]));
    x[i] = f.div(s, LU[i][i]);
  }
  return x;
}

/**
 * Convenience one-shot: factor + solve. Copies A so the caller's matrix
 * survives (assembly code often wants to reuse or inspect it).
 */
export function solve(A, z, field) {
  const copy = A.map((row) => row.slice());
  const perm = luFactor(copy, field);
  return luSolve(copy, perm, z, field);
}
