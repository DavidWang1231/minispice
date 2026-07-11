/**
 * dc.js — DC operating point analysis.
 *
 * WHAT "DC OPERATING POINT" MEANS
 * -------------------------------
 * All sources are held at their DC values and the circuit is given infinite
 * time to settle. In that steady state nothing changes with time, so:
 *
 *   - capacitor:  i = C·dv/dt = 0  → behaves as an OPEN circuit (no stamp)
 *   - inductor:   v = L·di/dt = 0  → behaves as a SHORT circuit
 *
 * We model the inductor-short as a 0 V ideal voltage source. That costs one
 * extra MNA branch per inductor but buys us the inductor's DC current for
 * free (it pops out as that branch's current unknown) — which transient
 * analysis can also use as an initial condition, and which we report to
 * the user.
 *
 * BRANCH NUMBERING
 * ----------------
 * Each analysis assigns MNA branch indices itself, because *which* elements
 * need a branch differs per analysis (here L needs one; in transient/AC it
 * does not). The assignment is simply "in netlist order".
 *
 * INPUT NETLIST SHAPE (engine-side contract, produced by editor/netlist.js):
 *   {
 *     nodeCount: N,                     // non-ground nodes, numbered 1..N
 *     components: [
 *       { id, type: "R"|"C"|"L"|"V"|"I"|"OPAMP", value, nodes: [...],
 *         waveform?, amplitude?, freq?, offset?, delay?, period?, width? }
 *     ]
 *   }
 * Node arrays: R/C/L/V/I → [a, b] with a the "+" terminal;
 *              OPAMP     → [inP, inN, out].
 *
 * OUTPUT:
 *   {
 *     voltages: number[N+1]   // indexed by node number; voltages[0] = 0
 *     currents: { [componentId]: amps }   // sign: current a→b through the
 *                                         // element (into "+" terminal)
 *   }
 */

import { MNASystem } from "./mna.js";
import { solve } from "./solver.js";
import { realField } from "../util/complex.js";

/**
 * The value an independent source contributes at DC.
 *
 * Time-varying waveforms need a convention here; ours (documented in
 * NOTES_FOR_DAVID.md as a design decision):
 *   dc    → value
 *   sine  → its offset (the average value; a pure sine averages to 0)
 *   step  → 0   (the pre-step level; transient starts from this state)
 *   pulse → 0   (idle level)
 */
export function dcSourceValue(comp) {
  switch (comp.waveform ?? "dc") {
    case "dc": return comp.value;
    case "sine": return comp.offset ?? 0;
    case "step":
    case "pulse": return 0;
    default: return comp.value;
  }
}

export function dcOperatingPoint(netlist) {
  const { nodeCount, components } = netlist;

  // Pass 1: assign branch indices to every element that needs an extra
  // MNA row/column at DC: independent V sources, op-amp outputs, and
  // inductors (modelled as 0 V sources — see header comment).
  const branchOf = new Map();
  let m = 0;
  for (const c of components) {
    if (c.type === "V" || c.type === "OPAMP" || c.type === "L") {
      branchOf.set(c.id, m++);
    }
  }

  // Pass 2: stamp everything.
  const sys = new MNASystem(nodeCount, m, realField);
  for (const c of components) {
    const [a, b] = c.nodes;
    switch (c.type) {
      case "R":
        sys.stampConductance(a, b, 1 / c.value);
        break;
      case "C":
        break; // open at DC: contributes nothing
      case "L":
        sys.stampVoltageSource(a, b, branchOf.get(c.id), 0); // short at DC
        break;
      case "V":
        sys.stampVoltageSource(a, b, branchOf.get(c.id), dcSourceValue(c));
        break;
      case "I":
        sys.stampCurrentSource(a, b, dcSourceValue(c));
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

  // Solve A·x = z. x = [ V(1)..V(N), j(0)..j(M−1) ].
  const x = solve(sys.A, sys.z, realField);

  // Unpack node voltages, re-inserting ground as index 0 for convenience.
  const voltages = new Array(nodeCount + 1).fill(0);
  for (let i = 0; i < nodeCount; i++) voltages[i + 1] = x[i];

  // Branch currents for every component (a→b through the element).
  const currents = {};
  for (const c of components) {
    const [a, b] = c.nodes;
    switch (c.type) {
      case "R":
        currents[c.id] = (voltages[a] - voltages[b]) / c.value;
        break;
      case "C":
        currents[c.id] = 0;
        break;
      case "I":
        currents[c.id] = dcSourceValue(c);
        break;
      case "L":
      case "V": {
        // MNA's branch current convention is a→b *inside* the element.
        currents[c.id] = x[nodeCount + branchOf.get(c.id)];
        break;
      }
      case "OPAMP":
        currents[c.id] = x[nodeCount + branchOf.get(c.id)]; // output current
        break;
    }
  }

  return { voltages, currents };
}
