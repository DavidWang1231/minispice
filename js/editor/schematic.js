/**
 * schematic.js — the canvas schematic editor.
 *
 * Owns all editor state (components, wires, probes, selection) and all
 * mouse/keyboard interaction. It knows NOTHING about analyses — main.js
 * asks it for a netlist (via editor/netlist.js) and hands it results to
 * display. The engine never sees this file, and this file never sees the
 * engine. That boundary is deliberate and non-negotiable (testability).
 *
 * INTERACTION MODEL
 * -----------------
 *   Toolbar arms a tool:
 *     select    — click selects; drag on a component body moves it; drag
 *                 starting ON A PIN draws a wire (so you rarely need the
 *                 wire tool); R rotates, Delete deletes, double-click edits.
 *     wire      — drag anywhere draws an L-shaped (H-then-V) wire pair.
 *     probe     — click on any wired point adds a voltage probe.
 *     place:X   — each click drops a component of type X (stays armed so
 *                 you can sprinkle several; Esc or Select disarms).
 *
 * Everything snaps to a 20 px grid, so pins/wires connect by coordinate
 * equality — which is exactly what netlist extraction assumes.
 */

import {
  GRID, COMPONENT_DEFS, makeComponent, terminalPositions,
  parseValue, formatValue,
} from "./components.js";
import { extractNetlist } from "./netlist.js";

/** Probe trace colors — exported so plots color traces identically to the
 *  probe markers on the schematic (probe i ↔ color i). */
export const PROBE_COLORS = ["#7ddf9a", "#5ab8ff", "#ff9de2", "#ffd166", "#9d8cff", "#4dd8c0"];

/* PCB palette (mirrors css/style.css custom properties) */
const STYLE = {
  board: "#0a3d2c",
  grid: "#14503b",
  copper: "#c87533",
  copperBright: "#e8965a",
  accent: "#d4af37",  // ENIG gold
  silk: "#d8e6de",
  error: "#ff6b6b",
  probeColors: PROBE_COLORS,
};

const snap = (v) => Math.round(v / GRID) * GRID;
const key = (p) => `${p.x},${p.y}`;
const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

export class SchematicEditor {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts  { onChange(), onStatus(msg, isError) }
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onChange = opts.onChange ?? (() => {});
    this.onStatus = opts.onStatus ?? (() => {});

    // --- document state (what save/load serializes)
    this.components = [];
    this.wires = [];       // [{a:{x,y}, b:{x,y}}]
    this.probes = [];      // [{x,y}] — node resolved at analysis time

    // --- ephemeral UI state
    this.tool = "select";
    this.selection = null; // {kind:"component"|"wire"|"probe", ref}
    this.hoverPin = null;  // {x,y} pin/endpoint under cursor
    this.drag = null;      // {kind:"move"|"wire", ...}
    this.mouse = { x: 0, y: 0 };
    this.annotations = []; // [{x,y,text}] node-voltage labels from Run DC
    this.idCounters = {};  // prefix → last used number

    this.installEvents();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
  }

  /* ---------------- document mutation plumbing ---------------- */

  /** Called after every edit: stale results must vanish. */
  changed() {
    this.annotations = [];
    this.onChange();
    this.draw();
  }

  nextId(type) {
    const prefix = COMPONENT_DEFS[type].prefix;
    this.idCounters[prefix] = (this.idCounters[prefix] ?? 0) + 1;
    return `${prefix}${this.idCounters[prefix]}`;
  }

  getState() {
    return { components: this.components, wires: this.wires, probes: this.probes };
  }

  loadState(state) {
    this.components = state.components ?? [];
    this.wires = state.wires ?? [];
    this.probes = state.probes ?? [];
    this.selection = null;
    // Rebuild id counters so new parts don't collide with loaded ids.
    this.idCounters = {};
    for (const c of this.components) {
      const m = c.id.match(/^([A-Za-z]+)(\d+)$/);
      if (m) {
        this.idCounters[m[1]] = Math.max(this.idCounters[m[1]] ?? 0, +m[2]);
      }
    }
    this.changed();
  }

  clearAll() {
    this.components = [];
    this.wires = [];
    this.probes = [];
    this.idCounters = {};
    this.selection = null;
    this.changed();
  }

  extract() {
    return extractNetlist(this.components, this.wires);
  }

  /** Show node voltages on the schematic (called by main.js after Run DC). */
  setNodeVoltages(voltages, nodeOfPoint) {
    this.annotations = [];
    const seen = new Set();
    for (const [k, node] of nodeOfPoint) {
      if (node === 0 || seen.has(node)) continue;
      seen.add(node);
      const [x, y] = k.split(",").map(Number);
      this.annotations.push({ x, y, text: formatValue(voltages[node], "V") });
    }
    this.draw();
  }

  setTool(tool) {
    this.tool = tool;
    this.drag = null;
    this.onStatus(
      tool.startsWith("place:")
        ? `Placing ${COMPONENT_DEFS[tool.slice(6)].name} — click to drop, Esc to stop`
        : `Tool: ${tool}`
    );
    this.draw();
  }

  /* ---------------- hit testing ---------------- */

  /** All pin + wire-endpoint positions (for wire starts & hover). */
  *electricalPoints() {
    for (const c of this.components) yield* terminalPositions(c);
    for (const w of this.wires) { yield w.a; yield w.b; }
  }

  pinAt(p, radius = 8) {
    let best = null, bestD = radius * radius;
    for (const pt of this.electricalPoints()) {
      const d = dist2(p, pt);
      if (d <= bestD) { best = { x: pt.x, y: pt.y }; bestD = d; }
    }
    return best;
  }

  componentAt(p) {
    // Iterate topmost-last so recently placed parts win.
    for (let i = this.components.length - 1; i >= 0; i--) {
      const c = this.components[i];
      // transform click into the component's local frame (undo rotation)
      const dx = p.x - c.pos.x, dy = p.y - c.pos.y;
      let lx, ly;
      switch (c.rotation) {
        case 90: lx = dy; ly = -dx; break;
        case 180: lx = -dx; ly = -dy; break;
        case 270: lx = -dy; ly = dx; break;
        default: lx = dx; ly = dy;
      }
      const r = COMPONENT_DEFS[c.type].bodyRect;
      if (lx >= r.x0 && lx <= r.x1 && ly >= r.y0 && ly <= r.y1) return c;
    }
    return null;
  }

  wireAt(p, tol = 5) {
    for (const w of this.wires) {
      const minX = Math.min(w.a.x, w.b.x) - tol, maxX = Math.max(w.a.x, w.b.x) + tol;
      const minY = Math.min(w.a.y, w.b.y) - tol, maxY = Math.max(w.a.y, w.b.y) + tol;
      if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) return w;
    }
    return null;
  }

  probeAt(p, radius = 10) {
    return this.probes.find((pr) => dist2(pr, p) <= radius * radius) ?? null;
  }

  /* ---------------- events ---------------- */

  installEvents() {
    const c = this.canvas;
    c.addEventListener("mousedown", (e) => this.onMouseDown(this.evtPos(e), e));
    c.addEventListener("mousemove", (e) => this.onMouseMove(this.evtPos(e)));
    window.addEventListener("mouseup", () => this.onMouseUp());
    c.addEventListener("dblclick", (e) => {
      const comp = this.componentAt(this.evtPos(e));
      if (comp && comp.type !== "GND") this.openPropertyEditor(comp);
    });
    // Keyboard shortcuts — ignored while typing in a form field.
    window.addEventListener("keydown", (e) => {
      if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
      if (e.key === "r" || e.key === "R") this.rotateSelection();
      else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); this.deleteSelection(); }
      else if (e.key === "Escape") this.setTool("select");
    });
  }

  evtPos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  onMouseDown(p, e) {
    const sp = { x: snap(p.x), y: snap(p.y) };

    if (this.tool.startsWith("place:")) {
      const type = this.tool.slice(6);
      const comp = makeComponent(type, this.nextId(type), sp.x, sp.y);
      this.components.push(comp);
      this.selection = { kind: "component", ref: comp };
      this.changed();
      return;
    }

    if (this.tool === "wire") {
      this.drag = { kind: "wire", from: sp, to: sp };
      return;
    }

    if (this.tool === "probe") {
      this.addProbe(sp);
      return;
    }

    // --- select tool ---
    const pin = this.pinAt(p);
    if (pin) { // drag from a pin = draw a wire, Falstad-style
      this.drag = { kind: "wire", from: pin, to: pin };
      return;
    }
    const comp = this.componentAt(p);
    if (comp) {
      this.selection = { kind: "component", ref: comp };
      this.drag = {
        kind: "move", comp,
        offset: { x: comp.pos.x - p.x, y: comp.pos.y - p.y },
      };
      this.draw();
      return;
    }
    const probe = this.probeAt(p);
    if (probe) { this.selection = { kind: "probe", ref: probe }; this.draw(); return; }
    const wire = this.wireAt(p);
    if (wire) { this.selection = { kind: "wire", ref: wire }; this.draw(); return; }
    this.selection = null;
    this.draw();
  }

  onMouseMove(p) {
    this.mouse = p;
    if (this.drag?.kind === "move") {
      const c = this.drag.comp;
      const nx = snap(p.x + this.drag.offset.x), ny = snap(p.y + this.drag.offset.y);
      if (nx !== c.pos.x || ny !== c.pos.y) { c.pos = { x: nx, y: ny }; this.changed(); }
      return;
    }
    if (this.drag?.kind === "wire") {
      this.drag.to = { x: snap(p.x), y: snap(p.y) };
      this.draw();
      return;
    }
    const pin = this.pinAt(p);
    const changed = key(pin ?? { x: -1, y: -1 }) !== key(this.hoverPin ?? { x: -1, y: -1 });
    this.hoverPin = pin;
    if (changed) this.draw();
  }

  onMouseUp() {
    if (this.drag?.kind === "wire") {
      const { from, to } = this.drag;
      // L-shaped routing: horizontal leg first, then vertical. Two
      // axis-aligned segments keeps extraction (and rendering) trivial.
      if (from.x !== to.x || from.y !== to.y) {
        const corner = { x: to.x, y: from.y };
        if (from.x !== corner.x) this.wires.push({ a: { ...from }, b: { ...corner } });
        if (corner.y !== to.y) this.wires.push({ a: { ...corner }, b: { ...to } });
        this.changed();
      }
    }
    this.drag = null;
    this.draw();
  }

  rotateSelection() {
    const sel = this.selection;
    if (sel?.kind === "component") {
      sel.ref.rotation = (sel.ref.rotation + 90) % 360;
      this.changed();
    }
  }

  deleteSelection() {
    const sel = this.selection;
    if (!sel) return;
    if (sel.kind === "component") {
      this.components = this.components.filter((c) => c !== sel.ref);
    } else if (sel.kind === "wire") {
      this.wires = this.wires.filter((w) => w !== sel.ref);
    } else if (sel.kind === "probe") {
      this.probes = this.probes.filter((p) => p !== sel.ref);
    }
    this.selection = null;
    this.changed();
  }

  addProbe(sp) {
    // Only meaningful on an electrical point (pin or wire); check by
    // running extraction and asking "does this point have a node?"
    const { nodeOfPoint } = this.extract();
    if (!nodeOfPoint.has(key(sp))) {
      // also accept clicks on the middle of a wire
      const wire = this.wireAt(sp);
      if (!wire) {
        this.onStatus("Probe must be placed on a wire or pin.", true);
        return;
      }
      sp = { ...wire.a };
    }
    if (this.probes.some((pr) => key(pr) === key(sp))) return; // no dupes
    this.probes.push(sp);
    this.changed();
  }

  /* ---------------- property editor (double-click) ---------------- */

  /**
   * A small floating form next to the component. Fields depend on type;
   * V sources get a waveform selector with per-waveform parameters.
   * Values accept engineering notation ("4.7k", "100n", "2Meg").
   */
  openPropertyEditor(comp) {
    document.querySelector(".prop-editor")?.remove();

    const fieldsFor = (c) => {
      if (c.type === "V") {
        const wf = c.waveform ?? "dc";
        const per = {
          dc: [["value", "Value (V)"]],
          sine: [["amplitude", "Amplitude (V)"], ["freq", "Frequency (Hz)"], ["offset", "DC offset (V)"]],
          step: [["value", "Step height (V)"], ["delay", "Delay (s)"]],
          pulse: [["amplitude", "Amplitude (V)"], ["period", "Period (s)"], ["width", "Pulse width (s)"], ["delay", "Delay (s)"]],
        };
        return per[wf];
      }
      const unit = COMPONENT_DEFS[c.type].unit;
      return [["value", `Value (${unit})`]];
    };

    const box = document.createElement("div");
    box.className = "prop-editor";
    const rect = this.canvas.getBoundingClientRect();
    box.style.left = `${Math.min(rect.left + comp.pos.x + 30, window.innerWidth - 240)}px`;
    box.style.top = `${rect.top + comp.pos.y + window.scrollY - 10}px`;

    const title = document.createElement("div");
    title.className = "prop-title";
    title.textContent = `${comp.id} — ${COMPONENT_DEFS[comp.type].name}`;
    box.appendChild(title);

    const body = document.createElement("div");
    box.appendChild(body);

    const renderFields = () => {
      body.innerHTML = "";
      if (comp.type === "V") {
        const label = document.createElement("label");
        label.textContent = "Waveform";
        const sel = document.createElement("select");
        for (const w of ["dc", "sine", "step", "pulse"]) {
          const opt = document.createElement("option");
          opt.value = w; opt.textContent = w;
          if ((comp.waveform ?? "dc") === w) opt.selected = true;
          sel.appendChild(opt);
        }
        sel.addEventListener("change", () => {
          comp.waveform = sel.value;
          renderFields();
        });
        label.appendChild(sel);
        body.appendChild(label);
      }
      for (const [prop, labelText] of fieldsFor(comp)) {
        const label = document.createElement("label");
        label.textContent = labelText;
        const input = document.createElement("input");
        input.type = "text";
        input.value = formatValue(comp[prop] ?? 0);
        input.dataset.prop = prop;
        label.appendChild(input);
        body.appendChild(label);
      }
    };
    renderFields();

    const buttons = document.createElement("div");
    buttons.className = "prop-buttons";
    const ok = document.createElement("button");
    ok.textContent = "OK";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    buttons.append(ok, cancel);
    box.appendChild(buttons);

    const close = () => box.remove();
    cancel.addEventListener("click", close);
    ok.addEventListener("click", () => {
      for (const input of body.querySelectorAll("input")) {
        const v = parseValue(input.value);
        if (Number.isNaN(v)) {
          this.onStatus(`Can't parse "${input.value}" — try forms like 4.7k, 100n, 2Meg`, true);
          input.focus();
          return;
        }
        comp[input.dataset.prop] = v;
      }
      close();
      this.changed();
    });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter") ok.click();
      if (e.key === "Escape") close();
    });

    document.body.appendChild(box);
    box.querySelector("input")?.focus();
  }

  /* ---------------- rendering ---------------- */

  resize() {
    const parent = this.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const w = parent.clientWidth, h = parent.clientHeight;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    // grid dots — like unplated drill hits on a bare board
    ctx.fillStyle = STYLE.grid;
    for (let x = 0; x <= w; x += GRID)
      for (let y = 0; y <= h; y += GRID) ctx.fillRect(x - 0.5, y - 0.5, 1.5, 1.5);

    // wires (copper traces)
    for (const wire of this.wires) {
      const selected = this.selection?.ref === wire;
      ctx.strokeStyle = selected ? STYLE.accent : STYLE.copper;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(wire.a.x, wire.a.y);
      ctx.lineTo(wire.b.x, wire.b.y);
      ctx.stroke();
    }

    // junction dots where ≥3 connections meet (solder blobs)
    const endpointCount = new Map();
    const bump = (p) => endpointCount.set(key(p), (endpointCount.get(key(p)) ?? 0) + 1);
    for (const wire of this.wires) { bump(wire.a); bump(wire.b); }
    for (const c of this.components) terminalPositions(c).forEach(bump);
    ctx.fillStyle = STYLE.copper;
    for (const [k, n] of endpointCount) {
      if (n >= 3) {
        const [x, y] = k.split(",").map(Number);
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // wire being dragged (preview, L-shaped)
    if (this.drag?.kind === "wire") {
      const { from, to } = this.drag;
      ctx.strokeStyle = STYLE.copperBright;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // components
    for (const c of this.components) {
      const def = COMPONENT_DEFS[c.type];
      const selected = this.selection?.ref === c;
      ctx.save();
      ctx.translate(c.pos.x, c.pos.y);
      ctx.rotate((c.rotation * Math.PI) / 180);
      ctx.strokeStyle = selected ? STYLE.accent : STYLE.copper;
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      def.draw(ctx, c, STYLE);
      ctx.restore();

      // pins as ENIG pads (gold rings)
      for (const t of terminalPositions(c)) {
        ctx.beginPath();
        ctx.arc(t.x, t.y, 3, 0, Math.PI * 2);
        ctx.strokeStyle = STYLE.accent;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // silkscreen labels (never rotated — text stays readable)
      if (c.type !== "GND") {
        ctx.font = "11px ui-monospace, Menlo, monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = STYLE.silk;
        const labelY = c.rotation % 180 === 0 ? c.pos.y - 18 : c.pos.y - 48;
        ctx.fillText(c.id, c.pos.x, labelY);
        ctx.fillStyle = STYLE.accent;
        ctx.fillText(def.summary(c), c.pos.x, labelY + 12);
      }
    }

    // hovered pin highlight
    if (this.hoverPin && !this.drag) {
      ctx.beginPath();
      ctx.arc(this.hoverPin.x, this.hoverPin.y, 6, 0, Math.PI * 2);
      ctx.strokeStyle = STYLE.copperBright;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // probes
    this.probes.forEach((p, i) => {
      const color = STYLE.probeColors[i % STYLE.probeColors.length];
      const selected = this.selection?.ref === p;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.strokeStyle = selected ? STYLE.accent : color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.font = "10px ui-monospace, Menlo, monospace";
      ctx.fillStyle = color;
      ctx.textAlign = "left";
      ctx.fillText(`P${i + 1}`, p.x + 8, p.y - 8);
    });

    // node-voltage annotations (Run DC results)
    ctx.font = "12px ui-monospace, Menlo, monospace";
    for (const a of this.annotations) {
      const text = a.text;
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = "rgba(10, 61, 44, 0.85)";
      ctx.fillRect(a.x + 6, a.y - 24, tw + 8, 16);
      ctx.strokeStyle = STYLE.accent;
      ctx.lineWidth = 1;
      ctx.strokeRect(a.x + 6, a.y - 24, tw + 8, 16);
      ctx.fillStyle = STYLE.accent;
      ctx.textAlign = "left";
      ctx.fillText(text, a.x + 10, a.y - 12);
    }
  }
}
