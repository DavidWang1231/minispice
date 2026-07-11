/**
 * ac.js — AC small-signal sweep (frequency response / Bode data).
 *
 * WHY AC ANALYSIS IS "JUST MNA OVER COMPLEX NUMBERS"     [DAVID: whiteboard]
 * -------------------------------------------------------------------------
 * Assume every signal in the circuit is a sinusoid at one frequency ω, and
 * write each as a PHASOR: v(t) = Re{ V·e^(jωt) } where V is a complex
 * number carrying amplitude and phase. Differentiation becomes algebra:
 *
 *     d/dt [ V·e^(jωt) ] = jω · V·e^(jωt)      →   "d/dt" ≡ "×jω"
 *
 * Apply that to the element laws:
 *     capacitor  i = C·dv/dt   →   I = jωC·V        admittance Y = jωC
 *     inductor   v = L·di/dt   →   V = jωL·I        admittance Y = 1/(jωL)
 *     resistor   unchanged                          admittance Y = 1/R
 *
 * Every element is now just a (complex) conductance, so the SAME stamps
 * and the SAME solver produce the answer — we only swap the real field
 * for the complex one. There is genuinely nothing else to it; that's why
 * solver.js was written generic from day one.
 *
 * At ω → 0 the capacitor admittance → 0 (open) and the inductor
 * admittance → ∞ (short): the DC behaviors fall out as limits, a good
 * sanity check that the model is coherent.
 *
 * SOURCES IN AC
 * -------------
 * AC analysis is linear around the operating point; each independent
 * source contributes its small-signal amplitude at phase 0:
 *   - sine sources: their amplitude (the natural interpretation)
 *   - dc sources:   0 (a battery is AC ground — it holds its node still)
 *   - step/pulse:   0 (not periodic; they have no single-frequency content)
 * With one sine source of amplitude 1 V, the output node voltage IS the
 * transfer function H(jω). (SPICE instead has a separate "AC magnitude"
 * property; folding it into the waveform keeps our UI smaller —
 * documented design decision.)
 *
 * SWEEP & OUTPUT
 * --------------
 * Log-spaced points (pointsPerDecade, default 10) from fStart to fStop.
 * For each node we report magnitude in dB (20·log10|V|) and phase in
 * degrees — exactly what a Bode plot wants.
 */

import { MNASystem } from "./mna.js";
import { solve } from "./solver.js";
import { Complex, complexField } from "../util/complex.js";

/** Small-signal amplitude a source injects in AC (see header). */
export function acSourceValue(comp) {
  return (comp.waveform ?? "dc") === "sine" ? (comp.amplitude ?? 1) : 0;
}

/**
 * @param {object} netlist  engine netlist (see dc.js input contract)
 * @param {object} params   { fStart, fStop, pointsPerDecade? }
 * @returns {{
 *   freqs: number[],
 *   magDb: Float64Array[],   // magDb[node][pt]  (node 0 = ground row)
 *   phaseDeg: Float64Array[] // unwrapped? no — raw atan2, (−180, 180]
 * }}
 */
export function acSweep(netlist, params) {
  const { nodeCount, components } = netlist;
  const { fStart, fStop, pointsPerDecade = 10 } = params;
  if (!(fStart > 0) || !(fStop > fStart)) {
    throw new Error("AC sweep needs 0 < fStart < fStop.");
  }

  // log-spaced frequency grid, endpoints included
  const decades = Math.log10(fStop / fStart);
  const nPts = Math.max(2, Math.round(decades * pointsPerDecade) + 1);
  const freqs = Array.from({ length: nPts }, (_, i) =>
    fStart * 10 ** ((i * decades) / (nPts - 1))
  );

  // branch rows: V sources and op-amps (L is an admittance here, not a short)
  const branchOf = new Map();
  let m = 0;
  for (const c of components) {
    if (c.type === "V" || c.type === "OPAMP") branchOf.set(c.id, m++);
  }

  const magDb = Array.from({ length: nodeCount + 1 }, () => new Float64Array(nPts));
  const phaseDeg = Array.from({ length: nodeCount + 1 }, () => new Float64Array(nPts));

  for (let pt = 0; pt < nPts; pt++) {
    const omega = 2 * Math.PI * freqs[pt];

    // The matrix depends on ω, so each frequency point is its own
    // assembly + factorization. (No LU reuse across points — unlike
    // transient, where the fixed step kept the matrix constant.)
    const sys = new MNASystem(nodeCount, m, complexField);
    for (const c of components) {
      const [a, b] = c.nodes;
      switch (c.type) {
        case "R":
          sys.stampConductance(a, b, 1 / c.value);
          break;
        case "C":
          // Y = jωC — a purely imaginary "conductance"
          sys.stampConductance(a, b, new Complex(0, omega * c.value));
          break;
        case "L":
          // Y = 1/(jωL) = −j/(ωL)
          sys.stampConductance(a, b, new Complex(0, -1 / (omega * c.value)));
          break;
        case "V":
          sys.stampVoltageSource(a, b, branchOf.get(c.id), acSourceValue(c));
          break;
        case "I":
          sys.stampCurrentSource(a, b, acSourceValue(c));
          break;
        case "OPAMP": {
          const [inP, inN, out] = c.nodes;
          sys.stampOpAmp(inP, inN, out, branchOf.get(c.id));
          break;
        }
        default:
          throw new Error(`Unknown component type "${c.type}" (${c.id})`);
      }
    }

    const x = solve(sys.A, sys.z, complexField);

    for (let n = 1; n <= nodeCount; n++) {
      const v = x[n - 1];
      // dB floor at −300: log10(0) is −∞, which poisons plot autoscale.
      magDb[n][pt] = Math.max(20 * Math.log10(v.abs() + 1e-300), -300);
      phaseDeg[n][pt] = (v.arg() * 180) / Math.PI;
    }
  }

  return { freqs, magDb, phaseDeg };
}
