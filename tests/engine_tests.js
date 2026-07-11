/**
 * engine_tests.js — engine unit tests against circuits with known
 * analytical answers. No framework: each test computes a number and
 * compares it to a hand-derivable expected value via assertClose.
 *
 * Runs in two places:
 *   - tests/test_runner.html (browser, renders a results table)
 *   - any Node ≥ 18: `node --input-type=module -e "import('<path>').then(...)"`
 * because the engine is pure JS with zero DOM access.
 *
 * Every expected value's derivation is written out in the comments — the
 * point of this file is that a human can check the simulator against
 * paper, not just against itself.
 */

import { dcOperatingPoint } from "../js/engine/dc.js";
import { transientAnalysis } from "../js/engine/transient.js";
import { acSweep } from "../js/engine/ac.js";
import { SingularMatrixError } from "../js/engine/solver.js";

/**
 * Run every test; return an array of result rows:
 *   { name, pass, actual, expected, tol, error? }
 * Individual tests are wrapped in try/catch so one crash doesn't hide the
 * rest of the results.
 */
export function runEngineTests() {
  const results = [];

  const assertClose = (actual, expected, tol, name) => {
    const pass =
      Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
    results.push({ name, pass, actual, expected, tol });
  };

  const assertThrows = (fn, errClass, name) => {
    try {
      fn();
      results.push({ name, pass: false, error: "no error thrown" });
    } catch (e) {
      const pass = e instanceof errClass;
      results.push({
        name, pass,
        error: pass ? undefined : `threw ${e.name}: ${e.message}`,
      });
    }
  };

  const guard = (name, fn) => {
    try { fn(); }
    catch (e) { results.push({ name: `${name} (crashed)`, pass: false, error: String(e) }); }
  };

  // ------------------------------------------------------------------
  // Test 1 — Voltage divider.
  // 10 V source, two 1 kΩ resistors in series to ground.
  //   Node 1 = source +, node 2 = midpoint.
  //   V(2) = 10 · R2/(R1+R2) = 10 · 1k/2k = 5 V exactly.
  //   Current through the loop: 10 V / 2 kΩ = 5 mA.
  // ------------------------------------------------------------------
  guard("voltage divider", () => {
    const net = {
      nodeCount: 2,
      components: [
        { id: "V1", type: "V", value: 10, nodes: [1, 0] },
        { id: "R1", type: "R", value: 1000, nodes: [1, 2] },
        { id: "R2", type: "R", value: 1000, nodes: [2, 0] },
      ],
    };
    const { voltages, currents } = dcOperatingPoint(net);
    assertClose(voltages[2], 5, 1e-9, "divider: V(mid) = 5 V");
    assertClose(currents.R1, 5e-3, 1e-12, "divider: I(R1) = 5 mA");
    // MNA convention: source branch current flows +→− inside the source,
    // so a source *delivering* 5 mA reads −5 mA. Same as SPICE.
    assertClose(currents.V1, -5e-3, 1e-12, "divider: I(V1) = −5 mA");
  });

  // ------------------------------------------------------------------
  // Test 2 — Two sources, two resistors: solvable by superposition.
  //
  //   V1 = 10 V at node 1, V2 = 5 V at node 3,
  //   R1 = 2 kΩ from node 1 to node 2, R2 = 3 kΩ from node 2 to node 3,
  //   R3 = 6 kΩ from node 2 to ground.
  //
  // Hand solution by superposition at node 2:
  //   V1 alone (V2 shorted): V = 10 · (R2∥R3)/(R1 + R2∥R3)
  //       R2∥R3 = 3k·6k/9k = 2k  →  10 · 2k/4k = 5 V
  //   V2 alone (V1 shorted): V = 5 · (R1∥R3)/(R2 + R1∥R3)
  //       R1∥R3 = 2k·6k/8k = 1.5k →  5 · 1.5k/4.5k = 5/3 V
  //   Total: 5 + 5/3 = 20/3 ≈ 6.6667 V
  // ------------------------------------------------------------------
  guard("superposition network", () => {
    const net = {
      nodeCount: 3,
      components: [
        { id: "V1", type: "V", value: 10, nodes: [1, 0] },
        { id: "V2", type: "V", value: 5, nodes: [3, 0] },
        { id: "R1", type: "R", value: 2000, nodes: [1, 2] },
        { id: "R2", type: "R", value: 3000, nodes: [2, 3] },
        { id: "R3", type: "R", value: 6000, nodes: [2, 0] },
      ],
    };
    const { voltages } = dcOperatingPoint(net);
    assertClose(voltages[2], 20 / 3, 1e-9, "superposition: V(2) = 20/3 V");
  });

  // ------------------------------------------------------------------
  // Test 3 — Ideal op-amp inverting amplifier: gain = −R2/R1.
  //
  //   Vin = 1 V at node 1. R1 = 1 kΩ from node 1 to node 2 (the virtual
  //   ground / inverting input). R2 = 10 kΩ from node 2 to node 3 (output).
  //   Op-amp: in+ = ground, in− = node 2, out = node 3.
  //
  //   Nullor forces V(2) = V(in+) = 0 and takes no input current, so all
  //   of I = 1 V/1 kΩ = 1 mA flows on through R2:
  //   V(out) = 0 − 1 mA · 10 kΩ = −10 V. Gain = −R2/R1 = −10.
  // ------------------------------------------------------------------
  guard("inverting op-amp", () => {
    const net = {
      nodeCount: 3,
      components: [
        { id: "V1", type: "V", value: 1, nodes: [1, 0] },
        { id: "R1", type: "R", value: 1000, nodes: [1, 2] },
        { id: "R2", type: "R", value: 10000, nodes: [2, 3] },
        { id: "U1", type: "OPAMP", nodes: [0, 2, 3] }, // [in+, in−, out]
      ],
    };
    const { voltages } = dcOperatingPoint(net);
    assertClose(voltages[3], -10, 1e-9, "op-amp: Vout = −10 V (gain −R2/R1)");
    assertClose(voltages[2], 0, 1e-9, "op-amp: virtual ground V(in−) = 0");
  });

  // ------------------------------------------------------------------
  // Test 4 — RC step response: v(t) = V·(1 − e^(−t/RC)).
  //
  //   10 V step → R = 1 kΩ → node 2 → C = 1 µF → ground. τ = RC = 1 ms.
  //   At t = τ the capacitor sits at 1 − 1/e = 63.212 % of 10 V = 6.3212 V.
  //
  //   Backward Euler with h = τ/1000 lands within a couple of mV of the
  //   exponential (BE's accumulated error is O(h): (1+h/τ)^(−τ/h) → 1/e).
  // ------------------------------------------------------------------
  guard("RC step response", () => {
    const net = {
      nodeCount: 2,
      components: [
        { id: "V1", type: "V", value: 10, waveform: "step", delay: 0, nodes: [1, 0] },
        { id: "R1", type: "R", value: 1000, nodes: [1, 2] },
        { id: "C1", type: "C", value: 1e-6, nodes: [2, 0] },
      ],
    };
    const tau = 1e-3;
    const { voltages } = transientAnalysis(net, { tStop: tau, dt: tau / 1000, method: "be" });
    const vAtTau = voltages[2][1000]; // last sample = t = τ
    assertClose(vAtTau, 10 * (1 - Math.exp(-1)), 0.01, "RC: v(τ) = 63.21% of 10 V (BE)");

    const trap = transientAnalysis(net, { tStop: tau, dt: tau / 1000, method: "trap" });
    assertClose(trap.voltages[2][1000], 10 * (1 - Math.exp(-1)), 1e-4,
      "RC: v(τ), trapezoidal is ~100× closer");
  });

  // ------------------------------------------------------------------
  // Test 5 — Series RLC, underdamped: ringing frequency = ω_d.
  //
  //   10 V step → R = 10 Ω → L = 1 mH → node 3 → C = 1 µF → ground.
  //   ω₀ = 1/√(LC)      = 31 623 rad/s
  //   α  = R/(2L)       =  5 000 s⁻¹        (α < ω₀ → underdamped, rings)
  //   ω_d = √(ω₀² − α²) = 31 225 rad/s  →  T_d = 2π/ω_d = 201.24 µs
  //
  //   The cap voltage rings around its final value (10 V). We measure the
  //   period as the spacing between successive upward crossings of 10 V
  //   (linear interpolation between samples). Trapezoidal integration is
  //   used because backward Euler's artificial damping also warps the
  //   apparent frequency slightly.
  // ------------------------------------------------------------------
  guard("RLC ringing frequency", () => {
    const net = {
      nodeCount: 3,
      components: [
        { id: "V1", type: "V", value: 10, waveform: "step", delay: 0, nodes: [1, 0] },
        { id: "R1", type: "R", value: 10, nodes: [1, 2] },
        { id: "L1", type: "L", value: 1e-3, nodes: [2, 3] },
        { id: "C1", type: "C", value: 1e-6, nodes: [3, 0] },
      ],
    };
    const { t, voltages } = transientAnalysis(net, { tStop: 1e-3, dt: 2e-7, method: "trap" });
    const v = voltages[3], FINAL = 10;
    const crossings = [];
    for (let i = 1; i < v.length; i++) {
      if (v[i - 1] < FINAL && v[i] >= FINAL) {
        const frac = (FINAL - v[i - 1]) / (v[i] - v[i - 1]);
        crossings.push(t[i - 1] + frac * (t[i] - t[i - 1]));
      }
    }
    const omega0 = 1 / Math.sqrt(1e-3 * 1e-6);
    const alpha = 10 / (2 * 1e-3);
    const Td = (2 * Math.PI) / Math.sqrt(omega0 ** 2 - alpha ** 2);
    // need at least two crossings to measure a period
    assertClose(crossings.length >= 2 ? 1 : 0, 1, 0, "RLC: circuit actually rings");
    const measured = crossings[1] - crossings[0];
    assertClose(measured, Td, Td * 0.01, "RLC: ringing period = 2π/ω_d (±1%)");
  });

  // ------------------------------------------------------------------
  // Test 6 — RC lowpass AC: −3 dB and −45° at f_c = 1/(2πRC).
  //
  //   1 V sine → R = 1 kΩ → node 2 → C = 100 nF → ground.
  //   H(jω) = 1 / (1 + jωRC), f_c = 1/(2π·10⁻⁴) = 1591.55 Hz.
  //   At f_c:   |H| = 1/√2  →  20·log10(1/√2) = −3.0103 dB, phase −45°.
  //   At 10f_c: |H| = 1/√101 → −20.0432 dB, phase −84.29° (−20 dB/decade).
  //
  //   We start the sweep exactly at f_c so the first sample needs no
  //   interpolation; one decade at 10 pts/decade puts 10·f_c at the end.
  // ------------------------------------------------------------------
  guard("RC lowpass AC sweep", () => {
    const net = {
      nodeCount: 2,
      components: [
        { id: "V1", type: "V", value: 1, waveform: "sine", amplitude: 1, freq: 1000, nodes: [1, 0] },
        { id: "R1", type: "R", value: 1000, nodes: [1, 2] },
        { id: "C1", type: "C", value: 1e-7, nodes: [2, 0] },
      ],
    };
    const fc = 1 / (2 * Math.PI * 1000 * 1e-7);
    const { freqs, magDb, phaseDeg } = acSweep(net, {
      fStart: fc, fStop: 10 * fc, pointsPerDecade: 10,
    });
    assertClose(magDb[2][0], 20 * Math.log10(1 / Math.SQRT2), 1e-6, "AC: |H(f_c)| = −3.01 dB");
    assertClose(phaseDeg[2][0], -45, 1e-6, "AC: ∠H(f_c) = −45°");
    const last = freqs.length - 1;
    assertClose(magDb[2][last], -10 * Math.log10(101), 1e-6, "AC: |H(10·f_c)| = −20.04 dB");
    assertClose(phaseDeg[2][last], (-Math.atan(10) * 180) / Math.PI, 1e-6, "AC: ∠H(10·f_c) = −84.29°");
    // the input node is driven directly: 0 dB, 0° at every point
    assertClose(magDb[1][0], 0, 1e-9, "AC: input node = 0 dB");
  });

  // ------------------------------------------------------------------
  // Test 7 — Singular circuit (floating node) → clean error, no crash.
  //
  //   A resistor dangling between two nodes with no path to ground.
  //   Its two KCL rows are linearly dependent (and there is no reference),
  //   so the MNA matrix is singular. We demand SingularMatrixError, whose
  //   message is what the UI shows the user.
  // ------------------------------------------------------------------
  guard("singular circuit", () => {
    const net = {
      nodeCount: 3,
      components: [
        { id: "V1", type: "V", value: 10, nodes: [1, 0] },
        { id: "R1", type: "R", value: 1000, nodes: [1, 0] },
        { id: "R2", type: "R", value: 1000, nodes: [2, 3] }, // floating!
      ],
    };
    assertThrows(
      () => dcOperatingPoint(net),
      SingularMatrixError,
      "floating node raises SingularMatrixError"
    );
  });

  return results;
}
