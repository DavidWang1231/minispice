/**
 * mna.js — Modified Nodal Analysis matrix assembly ("stamps").
 *
 * BACKGROUND: WHAT MNA IS
 * -----------------------
 * Plain nodal analysis writes Kirchhoff's Current Law (KCL) at every
 * non-ground node: "currents leaving through conductances = currents
 * injected by sources", giving  G·v = i  with one row per node.
 *
 * That works for resistors and current sources, but an *ideal voltage
 * source* breaks it: its current is not a function of its voltage (it will
 * supply whatever current the circuit demands), so there is nothing to put
 * in G for it. MNA's fix — the "Modified" part — is to promote that unknown
 * current to a first-class variable:
 *
 *   - add one extra UNKNOWN per voltage source: its branch current i_k
 *   - add one extra EQUATION per voltage source: its defining constraint
 *     V(a) − V(b) = E
 *
 * So with N non-ground nodes and M voltage-source-like branches the system
 * is (N+M)×(N+M):
 *
 *         ┌         ┐ ┌   ┐   ┌   ┐
 *         │  G   B  │ │ v │   │ i │   ← KCL rows (one per node)
 *         │  C   D  │ │ j │ = │ e │   ← source-constraint rows (one per branch)
 *         └         ┘ └   ┘   └   ┘
 *
 * where v = node voltages, j = branch currents, B/C encode which nodes each
 * branch touches, and D is (for our ideal elements) zero.
 *
 * GROUND ELIMINATION
 * ------------------
 * Node 0 is ground, defined as V=0. Its KCL row is redundant (it's minus
 * the sum of all the others), so we simply never build row/column 0:
 * external node number k maps to matrix index k−1, and any stamp aimed at
 * ground is silently dropped. That is what the `if (i >= 0)` guards below do.
 *
 * "STAMPS"
 * --------
 * Each element contributes a small fixed pattern of entries — its stamp.
 * Assembly is just: start from zeros, iterate the netlist, add every
 * element's stamp. Order doesn't matter because addition commutes. This is
 * the whole reason MNA is beloved by simulator writers.
 *
 * This class is generic over the scalar field (see util/complex.js): DC and
 * transient stamp real numbers; AC stamps complex admittances. Stamp
 * methods accept plain JS numbers and coerce them via `field.from`, so DC
 * code stays free of Complex noise.
 */

import { realField, complexField, Complex } from "../util/complex.js";

export class MNASystem {
  /**
   * @param {number} numNodes    N — non-ground nodes, numbered 1..N
   * @param {number} numBranches M — voltage-source-like branches (independent
   *                             V sources + op-amp outputs), indexed 0..M−1
   * @param {object} field       realField or complexField
   */
  constructor(numNodes, numBranches, field = realField) {
    this.n = numNodes;
    this.m = numBranches;
    this.field = field;
    const size = numNodes + numBranches;
    this.A = Array.from({ length: size }, () =>
      Array.from({ length: size }, () => field.zero())
    );
    this.z = Array.from({ length: size }, () => field.zero());
  }

  /** Coerce a plain number into a field element (numbers pass through the
   *  real field untouched; the complex field wraps them as re + j0). */
  coerce(x) {
    if (this.field === complexField) return Complex.from(x);
    return x;
  }

  /** External node number (0 = ground) → matrix row index (−1 = dropped). */
  nodeIndex(node) { return node - 1; }

  /** Branch index k → matrix row/col index N+k. */
  branchIndex(k) { return this.n + k; }

  /** A[r][c] += val, skipping any index that refers to ground. */
  addA(r, c, val) {
    if (r < 0 || c < 0) return;
    this.A[r][c] = this.field.add(this.A[r][c], val);
  }

  /** z[r] += val, skipping ground. */
  addZ(r, val) {
    if (r < 0) return;
    this.z[r] = this.field.add(this.z[r], val);
  }

  /**
   * CONDUCTANCE (resistor) stamp — element with conductance g between
   * nodes a and b.
   *
   * KCL at node a gets a term +g·V(a) − g·V(b) (current leaving a through
   * the element), and symmetrically at node b:
   *
   *        col a   col b
   * row a [  +g     −g  ]
   * row b [  −g     +g  ]
   *
   * For a resistor call with g = 1/R. AC analysis reuses this same stamp
   * for capacitors (g = jωC) and inductors (g = 1/(jωL)) because an
   * admittance stamps identically to a conductance — that symmetry is the
   * entire magic of phasor analysis.
   */
  stampConductance(a, b, g) {
    g = this.coerce(g);
    const ia = this.nodeIndex(a), ib = this.nodeIndex(b);
    this.addA(ia, ia, g);
    this.addA(ib, ib, g);
    this.addA(ia, ib, this.field.sub(this.field.zero(), g));
    this.addA(ib, ia, this.field.sub(this.field.zero(), g));
  }

  /**
   * INDEPENDENT CURRENT SOURCE stamp — I flowing FROM node a TO node b
   * (through the source; i.e. it pulls current out of a and pushes it
   * into b).
   *
   * Sources live on the right-hand side: KCL says Σ(conductance currents)
   * = injected current, so a source pulling I out of node a contributes
   * −I to z[a] and +I to z[b]. No matrix entries at all.
   */
  stampCurrentSource(a, b, i) {
    i = this.coerce(i);
    this.addZ(this.nodeIndex(a), this.field.sub(this.field.zero(), i));
    this.addZ(this.nodeIndex(b), i);
  }

  /**
   * INDEPENDENT VOLTAGE SOURCE stamp — branch k, value E, positive terminal
   * at node a, negative at node b.
   *
   * Two things happen (this is the "modified" in MNA):
   *
   * 1. The branch current j_k is a new unknown. It LEAVES node a and
   *    ENTERS node b, so KCL rows get:  A[a][N+k] = +1, A[b][N+k] = −1.
   *    (Sign convention: j_k > 0 means conventional current flows a→b
   *    *inside* the source, i.e. the source is being charged; for a lone
   *    source driving a resistive load you'll see j_k < 0. SPICE uses the
   *    same convention.)
   *
   * 2. The constraint row N+k encodes the source's defining equation
   *    V(a) − V(b) = E:  A[N+k][a] = +1, A[N+k][b] = −1, z[N+k] = E.
   *
   * Note the matrix stays structurally symmetric (B = Cᵀ) for independent
   * sources — but NOT for the op-amp below.
   */
  stampVoltageSource(a, b, k, e) {
    e = this.coerce(e);
    const ia = this.nodeIndex(a), ib = this.nodeIndex(b);
    const ik = this.branchIndex(k);
    const one = this.coerce(1), negOne = this.coerce(-1);
    this.addA(ia, ik, one);
    this.addA(ib, ik, negOne);
    this.addA(ik, ia, one);
    this.addA(ik, ib, negOne);
    this.addZ(ik, e);
  }

  /**
   * IDEAL OP-AMP stamp (nullor model) — branch k, inputs inP/inN, output out.
   *
   * THIS IS THE LEAST OBVIOUS STAMP. Read carefully.            [DAVID]
   *
   * An ideal op-amp has infinite gain. In a circuit with negative feedback,
   * infinite gain forces the input differential voltage to zero — the
   * "virtual short". We model the limit directly instead of using a huge
   * finite gain (which would wreck the matrix conditioning):
   *
   *   - INPUTS = "nullator": V(in+) − V(in−) = 0, AND no current flows
   *     into either input. So the inputs contribute ONE equation but NO
   *     current unknowns — we add nothing to the input nodes' KCL rows.
   *
   *   - OUTPUT = "norator": the output delivers whatever current the
   *     circuit needs (op-amp output impedance ≈ 0, supply rails = ±∞).
   *     So the output contributes ONE unknown (the output current j_k)
   *     but NO equation of its own.
   *
   * One extra equation + one extra unknown → the system stays square.
   * The pairing of a nullator and a norator is called a "nullor".
   *
   * Concretely, with branch index k:
   *   Constraint row N+k:   A[N+k][inP] = +1, A[N+k][inN] = −1, z[N+k] = 0
   *       (reads: V(in+) − V(in−) = 0)
   *   Output KCL column:    A[out][N+k] = +1
   *       (reads: unknown current j_k flows out of the op-amp INTO the
   *        rest of the circuit at the output node — the sign here only
   *        flips the reported current's sign, not the voltages)
   *
   * Note the asymmetry: the row mentions the INPUT nodes, the column
   * mentions the OUTPUT node. This makes the MNA matrix non-symmetric —
   * which is fine for LU, but it's why you can't solve op-amp circuits
   * with methods that assume symmetric matrices.
   *
   * CAVEAT (document for users): this model assumes negative feedback is
   * actually present. Hook the op-amp up open-loop or with positive
   * feedback and the math happily returns the (physically unreachable)
   * solution of the constraint equations, or a singular matrix. Real
   * op-amps would saturate at the rails instead — saturation is nonlinear
   * and out of scope for v1.
   */
  stampOpAmp(inP, inN, out, k) {
    const ip = this.nodeIndex(inP), im = this.nodeIndex(inN);
    const io = this.nodeIndex(out), ik = this.branchIndex(k);
    const one = this.coerce(1), negOne = this.coerce(-1);
    this.addA(ik, ip, one);   // row N+k: V(in+) ...
    this.addA(ik, im, negOne); //          ... − V(in−) = 0 (z[N+k] stays 0)
    this.addA(io, ik, one);   // output node KCL: + j_k (norator current)
  }
}
