/**
 * netlist.js — schematic → netlist extraction.
 *
 * THE PROBLEM
 * -----------
 * The editor stores *geometry*: components with pin positions, and wire
 * segments. The engine wants *topology*: "R1 connects node 2 to node 0".
 * The bridge is: two points are the same electrical node iff they are
 * connected by wires (or are literally the same coordinates).
 *
 * ALGORITHM: UNION-FIND over points
 * ---------------------------------
 * 1. Collect every "electrical point": each component pin and each wire
 *    endpoint. Points are keyed by their snapped coordinates "x,y" — two
 *    pins at the same coordinates are inherently connected.
 * 2. For each wire, union its two endpoints.
 * 3. T-junctions: if any electrical point lies ON a wire segment (not just
 *    at its ends), union it with that segment. Wires are axis-aligned so
 *    the on-segment test is trivial. This lets a pin tap into the middle
 *    of a wire without the user having to split it.
 * 4. Every pin of every GND symbol is unioned into one special "ground"
 *    bucket → node 0.
 * 5. Number the remaining connected groups 1..N.
 *
 * Union-find gives near-O(1) merges with path compression; for schematic
 * sizes it's overkill, but it is THE textbook tool for connectivity and
 * worth knowing.
 *
 * OUTPUT: { netlist, nodeOfPoint, warnings }
 *   netlist      — engine-ready (see engine/dc.js input contract)
 *   nodeOfPoint  — Map "x,y" → node number, used by the UI to hit-test
 *                  probes and place voltage annotations
 *   warnings     — non-fatal issues (e.g. no ground symbol)
 */

import { terminalPositions } from "./components.js";

const key = (p) => `${p.x},${p.y}`;
const GROUND_KEY = "__ground__";

class UnionFind {
  constructor() { this.parent = new Map(); }

  /** Find the set representative for k, compressing the path as we go. */
  find(k) {
    if (!this.parent.has(k)) this.parent.set(k, k);
    let root = k;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    // path compression: point everything we walked over straight at root
    let cur = k;
    while (cur !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a, b) { this.parent.set(this.find(a), this.find(b)); }
}

/** Is point p on the axis-aligned segment a—b (inclusive)? */
function pointOnSegment(p, a, b) {
  if (a.x === b.x) {
    return p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
  }
  if (a.y === b.y) {
    return p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x);
  }
  // Diagonal wires shouldn't exist (editor draws L-shapes), but degrade
  // gracefully: only endpoint coincidence connects them.
  return false;
}

/**
 * @param {object[]} components  editor components (incl. GND symbols)
 * @param {object[]} wires       [{a:{x,y}, b:{x,y}}, ...]
 */
export function extractNetlist(components, wires) {
  const uf = new UnionFind();
  const warnings = [];

  // 1. Collect electrical points (pins + wire endpoints).
  const points = new Map(); // key → {x,y}
  const addPoint = (p) => { points.set(key(p), p); uf.find(key(p)); };

  const pinsOf = new Map(); // component id → [{x,y}, ...]
  for (const c of components) {
    const pins = terminalPositions(c);
    pinsOf.set(c.id, pins);
    pins.forEach(addPoint);
  }
  for (const w of wires) { addPoint(w.a); addPoint(w.b); }

  // 2. Wires connect their endpoints.
  for (const w of wires) uf.union(key(w.a), key(w.b));

  // 3. Points landing mid-wire join that wire (T-junctions, taps).
  for (const p of points.values()) {
    for (const w of wires) {
      if (pointOnSegment(p, w.a, w.b)) uf.union(key(p), key(w.a));
    }
  }

  // 4. Ground symbols pull their group to node 0.
  let sawGround = false;
  for (const c of components) {
    if (c.type === "GND") {
      sawGround = true;
      uf.union(key(pinsOf.get(c.id)[0]), GROUND_KEY);
    }
  }
  if (!sawGround) {
    warnings.push("No ground symbol — add a GND; node voltages need a 0 V reference.");
  }

  // 5. Number the groups: ground root → 0, everything else 1..N.
  const groundRoot = sawGround ? uf.find(GROUND_KEY) : null;
  const nodeOfRoot = new Map();
  if (groundRoot !== null) nodeOfRoot.set(groundRoot, 0);
  let nextNode = 1;
  const nodeOf = (p) => {
    const root = uf.find(key(p));
    if (!nodeOfRoot.has(root)) nodeOfRoot.set(root, nextNode++);
    return nodeOfRoot.get(root);
  };

  // Build the engine netlist. GND symbols are pure geometry — skip them.
  // Electrical parameters are copied over verbatim; the engine ignores
  // anything it doesn't know (pos/rotation are NOT copied: the engine
  // must stay blind to geometry).
  const netComponents = [];
  for (const c of components) {
    if (c.type === "GND") continue;
    const { pos, rotation, ...electrical } = c;
    netComponents.push({ ...electrical, nodes: pinsOf.get(c.id).map(nodeOf) });
  }

  // The UI needs node numbers for every point (probe hit-testing).
  const nodeOfPoint = new Map();
  for (const p of points.values()) nodeOfPoint.set(key(p), nodeOf(p));

  return {
    netlist: { nodeCount: nextNode - 1, components: netComponents },
    nodeOfPoint,
    warnings,
  };
}
