/**
 * transient.js — time-domain analysis via companion models.
 *
 * THE BIG IDEA
 * ------------
 * MNA solves *resistive* circuits. Capacitors and inductors are not
 * resistive — their equations involve d/dt. The trick: DISCRETIZE TIME.
 * Replace the derivative with a finite difference, and each reactive
 * element turns into a resistor + current source whose values depend on
 * the previous time step. That pair is the element's "companion model".
 * Then every time step is just a DC solve of the companion circuit.
 *
 * CAPACITOR COMPANION MODEL (backward Euler)          [DAVID: derive this]
 * -------------------------------------------------------------------
 * Element law:        i = C · dv/dt
 * Backward Euler:     dv/dt ≈ (v(t+h) − v(t)) / h      (uses the NEW value)
 * Substitute:         i(t+h) = (C/h)·v(t+h) − (C/h)·v(t)
 *                              ^^^^^^^^^^^^   ^^^^^^^^^^
 *                              conductance     known constant
 *                              G_eq = C/h      I_eq = (C/h)·v(t)
 * So at each step the cap is a conductance C/h in parallel with a current
 * source (C/h)·v_prev pushing current INTO its + node (it "remembers" its
 * old voltage). Large C or small h → big conductance → voltage can't move
 * fast. Exactly the physics, visible in the numbers.
 *
 * INDUCTOR COMPANION MODEL (backward Euler)
 * -------------------------------------------------------------------
 * Element law:        v = L · di/dt  →  i(t+h) = i(t) + (h/L)·v(t+h)
 *                                        ^^^^^^          ^^^^^^^^^^
 *                                        I_eq = i_prev   G_eq = h/L
 * A conductance h/L in parallel with a current source carrying the old
 * current i_prev (flowing in the direction of the inductor current).
 * We chose the Norton (parallel) form over the Thevenin (series V source)
 * form because it needs NO extra MNA branch row — the matrix stays N+M
 * with M counting only real voltage sources. (Cost: we must track i_L
 * ourselves between steps, which we'd want anyway for plotting.)
 *
 * TRAPEZOIDAL RULE (selectable, better accuracy)
 * -------------------------------------------------------------------
 * Backward Euler is only 1st-order accurate: local truncation error (LTE)
 * ~ O(h²) per step, O(h) accumulated. It is also artificially LOSSY — it
 * damps oscillations that physics says should ring forever (try an ideal
 * LC tank: BE spirals inward). Trapezoidal averages the old and new
 * derivatives:
 *     v: i_new = (2C/h)(v_new − v_prev) − i_prev
 *        → G_eq = 2C/h,  I_eq = (2C/h)·v_prev + i_prev
 *     i: i_new = i_prev + (h/2L)(v_new + v_prev)
 *        → G_eq = h/2L,  I_eq = i_prev + (h/2L)·v_prev
 * LTE ~ O(h³) per step (2nd-order accurate) and NO artificial damping
 * (it's "A-stable but not L-stable" — the flip side is it can ring at the
 * Nyquist rate on discontinuities where BE would smooth them out).
 * Default is backward Euler for robustness; trapezoidal is offered in the
 * UI for accuracy.       [DAVID: run the RLC preset with both, compare]
 *
 * TRAPEZOIDAL STARTUP SUBTLETY (found the hard way — see the RC test):
 * trap needs the element's previous CURRENT, but at t = 0 we only assumed
 * i = 0. If the input has a discontinuity at t = 0 (a step source), the
 * true i(0+) is NOT zero — e.g. an RC circuit slams to V/R instantly —
 * and feeding trap the wrong i₀ bakes in a persistent O(h) error, wiping
 * out its accuracy advantage. Standard cure (SPICE does a variant): take
 * the FIRST step with backward Euler, which never looks at i_prev, then
 * switch to trap with a now-consistent current. One BE step costs O(h²)
 * locally — negligible — and restores trap's ~100× accuracy edge.
 *
 * TIME STEPPING
 * -------------
 * Fixed step h chosen by the user (default T_stop/1000). No adaptive
 * stepping in v1. Initial conditions: all capacitor voltages and inductor
 * currents start at 0 ("cold start"), and step/pulse sources are 0 at
 * t = 0 — so an RC charging curve matches v(t) = V·(1 − e^(−t/RC))
 * exactly. (SPICE instead starts from the DC operating point; design
 * decision documented in NOTES_FOR_DAVID.md.)
 */

import { MNASystem } from "./mna.js";
import { luFactor, luSolve } from "./solver.js";
import { realField } from "../util/complex.js";

/** Value of an independent source at time t (transient waveforms). */
export function sourceValueAt(comp, t) {
  switch (comp.waveform ?? "dc") {
    case "dc":
      return comp.value;
    case "sine": {
      const { amplitude = 1, freq = 1000, offset = 0 } = comp;
      return offset + amplitude * Math.sin(2 * Math.PI * freq * t);
    }
    case "step": {
      // 0 until the delay, then the full value. Strict '>' so t=0 with
      // delay 0 is still the pre-step level (see "cold start" above).
      return t > (comp.delay ?? 0) ? comp.value : 0;
    }
    case "pulse": {
      const { amplitude = 1, period = 1e-3, width = 5e-4, delay = 0 } = comp;
      if (t <= delay) return 0;
      const phase = (t - delay) % period;
      return phase < width ? amplitude : 0;
    }
    default:
      return comp.value;
  }
}

/**
 * @param {object} netlist  engine netlist (see dc.js input contract)
 * @param {object} params   { tStop, dt?, method? "be"|"trap" }
 * @returns {{ t: number[], voltages: Float64Array[], sourceCurrents: object }}
 *   voltages[n] is the waveform of node n (index 0 = ground, all zeros);
 *   sourceCurrents[id] is the branch-current waveform of each V source.
 */
export function transientAnalysis(netlist, params) {
  const { nodeCount, components } = netlist;
  const method = params.method ?? "be";
  const tStop = params.tStop;
  const h = params.dt ?? tStop / 1000;
  if (!(h > 0) || !(tStop > 0)) throw new Error("Transient needs tStop > 0 and dt > 0.");
  const steps = Math.ceil(tStop / h);

  // Branch rows: only independent V sources and op-amps (companion models
  // are Norton form — no extra rows for L or C).
  const branchOf = new Map();
  let m = 0;
  for (const c of components) {
    if (c.type === "V" || c.type === "OPAMP") branchOf.set(c.id, m++);
  }

  // Companion-model state, keyed by component id.
  const capV = new Map();  // capacitor voltage v(a)−v(b) at previous step
  const indI = new Map();  // inductor current a→b at previous step
  const capI = new Map();  // capacitor current (trapezoidal needs it)
  for (const c of components) {
    if (c.type === "C") { capV.set(c.id, 0); capI.set(c.id, 0); }
    if (c.type === "L") indI.set(c.id, 0);
  }

  // Result storage. voltages[node][step]; row 0 (ground) stays zero.
  const t = new Array(steps + 1);
  const voltages = Array.from({ length: nodeCount + 1 }, () => new Float64Array(steps + 1));
  const sourceCurrents = {};
  for (const c of components) {
    if (c.type === "V" || c.type === "L" || c.type === "C") {
      sourceCurrents[c.id] = new Float64Array(steps + 1);
    }
  }
  t[0] = 0;

  // PERFORMANCE NOTE: with a fixed step, the MNA *matrix* is identical at
  // every time step — only the right-hand side changes (source values and
  // companion current sources). So we factor A once (LU) and only re-do
  // the cheap forward/back substitution per step. This is why LU beats
  // "just call gaussian elimination each step": O(n³) once, O(n²) per step.
  let LU = null, perm = null;

  for (let step = 1; step <= steps; step++) {
    const tn = step * h;
    t[step] = tn;

    // BE startup step for trapezoidal (see header comment): step 1 runs
    // backward Euler so the companion currents become self-consistent.
    const meth = method === "trap" && step === 1 ? "be" : method;

    const sys = new MNASystem(nodeCount, m, realField);
    for (const c of components) {
      const [a, b] = c.nodes;
      switch (c.type) {
        case "R":
          sys.stampConductance(a, b, 1 / c.value);
          break;
        case "V":
          sys.stampVoltageSource(a, b, branchOf.get(c.id), sourceValueAt(c, tn));
          break;
        case "I":
          sys.stampCurrentSource(a, b, sourceValueAt(c, tn));
          break;
        case "OPAMP": {
          const [inP, inN, out] = c.nodes;
          sys.stampOpAmp(inP, inN, out, branchOf.get(c.id));
          break;
        }
        case "C": {
          // companion: G_eq ∥ I_eq (see derivation at top of file)
          const vPrev = capV.get(c.id);
          const geq = (meth === "trap" ? 2 : 1) * c.value / h;
          const ieq = meth === "trap"
            ? geq * vPrev + capI.get(c.id)
            : geq * vPrev;
          sys.stampConductance(a, b, geq);
          // I_eq drives current INTO node a (helps v hold its old value):
          // stampCurrentSource(from, to, i) pulls from `from`, so b→a.
          sys.stampCurrentSource(b, a, ieq);
          break;
        }
        case "L": {
          const iPrev = indI.get(c.id);
          const geq = meth === "trap" ? h / (2 * c.value) : h / c.value;
          const ieq = meth === "trap"
            ? iPrev + geq * (voltages[a][step - 1] - voltages[b][step - 1])
            : iPrev;
          sys.stampConductance(a, b, geq);
          // Old current keeps flowing a→b: pull out of a, push into b.
          sys.stampCurrentSource(a, b, ieq);
          break;
        }
        default:
          throw new Error(`Unknown component type "${c.type}" (${c.id})`);
      }
    }

    // Factor once and reuse — the matrix only changes between step 1 and
    // step 2 when the trapezoidal method's BE startup step swaps G_eq.
    if (LU === null || (method === "trap" && step === 2)) {
      LU = sys.A.map((row) => row.slice());
      perm = luFactor(LU, realField);
    }
    const x = luSolve(LU, perm, sys.z, realField);

    // Record node voltages.
    for (let n = 1; n <= nodeCount; n++) voltages[n][step] = x[n - 1];

    // Update companion state from the fresh solution.
    for (const c of components) {
      const [a, b] = c.nodes;
      const vNew = (a ? voltages[a][step] : 0) - (b ? voltages[b][step] : 0);
      if (c.type === "C") {
        const vPrev = capV.get(c.id);
        const iNew = meth === "trap"
          ? (2 * c.value / h) * (vNew - vPrev) - capI.get(c.id)
          : (c.value / h) * (vNew - vPrev);
        capV.set(c.id, vNew);
        capI.set(c.id, iNew);
        sourceCurrents[c.id][step] = iNew;
      } else if (c.type === "L") {
        const iNew = meth === "trap"
          ? indI.get(c.id) + (h / (2 * c.value)) * (vNew + (voltages[a][step - 1] ?? 0) - (voltages[b][step - 1] ?? 0))
          : indI.get(c.id) + (h / c.value) * vNew;
        indI.set(c.id, iNew);
        sourceCurrents[c.id][step] = iNew;
      } else if (c.type === "V") {
        sourceCurrents[c.id][step] = x[nodeCount + branchOf.get(c.id)];
      }
    }
  }

  return { t, voltages, sourceCurrents };
}
