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
