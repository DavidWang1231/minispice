/**
 * waveform.js — canvas time-domain plot: axes, autoscale, multiple traces,
 * legend, hover crosshair with numeric readout. No libraries.
 */

import { formatValue } from "../editor/components.js"; // pure fn, no DOM

const COLORS = {
  bg: "#072b1f",
  grid: "#14503b",
  axis: "#1c5a44",
  text: "#d8e6de",
  accent: "#d4af37",
  crosshair: "rgba(216, 230, 222, 0.5)",
};

const MARGIN = { left: 72, right: 16, top: 16, bottom: 34 };
const FONT = "11px ui-monospace, Menlo, monospace";

/**
 * "Nice" tick positions covering [min, max]: step is 1, 2, or 5 × 10^k,
 * chosen so we get roughly `target` ticks. The classic axis algorithm.
 */
export function niceTicks(min, max, target = 6) {
  const span = max - min;
  if (!(span > 0)) return { ticks: [min], step: 1 };
  const rawStep = span / target;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / mag; // in [1, 10)
  const step = (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v); // clean up -0 / 1e-21 noise
  }
  return { ticks, step };
}

export class WaveformPlot {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.t = null;
    this.traces = []; // [{label, color, data}]
    this.hoverX = null;
    this.xUnit = "s";
    this.yUnit = "V";

    canvas.addEventListener("mousemove", (e) => {
      const r = canvas.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      this.draw();
    });
    canvas.addEventListener("mouseleave", () => { this.hoverX = null; this.draw(); });
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }

  setData(t, traces, { xUnit = "s", yUnit = "V" } = {}) {
    this.t = t;
    this.traces = traces;
    this.xUnit = xUnit;
    this.yUnit = yUnit;
    this.draw();
  }

  resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = parent.clientWidth * dpr;
    this.canvas.height = parent.clientHeight * dpr;
    this.canvas.style.width = `${parent.clientWidth}px`;
    this.canvas.style.height = `${parent.clientHeight}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  /** Data range across all traces, padded 5% so lines don't hug the frame. */
  yRange() {
    let min = Infinity, max = -Infinity;
    for (const tr of this.traces) {
      for (const v of tr.data) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!Number.isFinite(min)) { min = 0; max = 1; }
    if (min === max) { min -= 1; max += 1; } // flat trace: give it air
    const pad = (max - min) * 0.05;
    return { min: min - pad, max: max + pad };
  }

  draw() {
    const ctx = this.ctx;
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);
    if (!this.t || this.t.length < 2) return;

    const px = { x0: MARGIN.left, x1: W - MARGIN.right, y0: H - MARGIN.bottom, y1: MARGIN.top };
    const tMin = this.t[0], tMax = this.t[this.t.length - 1];
    const { min: yMin, max: yMax } = this.yRange();
    const xOf = (t) => px.x0 + ((t - tMin) / (tMax - tMin)) * (px.x1 - px.x0);
    const yOf = (v) => px.y0 - ((v - yMin) / (yMax - yMin)) * (px.y0 - px.y1);

    ctx.font = FONT;

    // gridlines + tick labels
    const xt = niceTicks(tMin, tMax, 8);
    const yt = niceTicks(yMin, yMax, 5);
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = COLORS.text;
    for (const t of xt.ticks) {
      const x = Math.round(xOf(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, px.y1); ctx.lineTo(x, px.y0); ctx.stroke();
      ctx.textAlign = "center";
      ctx.fillText(formatValue(t, this.xUnit), x, px.y0 + 16);
    }
    for (const v of yt.ticks) {
      const y = Math.round(yOf(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(px.x0, y); ctx.lineTo(px.x1, y); ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(formatValue(v, this.yUnit), px.x0 - 6, y + 4);
    }

    // frame
    ctx.strokeStyle = COLORS.axis;
    ctx.strokeRect(px.x0 + 0.5, px.y1 + 0.5, px.x1 - px.x0, px.y0 - px.y1);

    // traces
    for (const tr of this.traces) {
      ctx.strokeStyle = tr.color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i < this.t.length; i++) {
        const x = xOf(this.t[i]), y = yOf(tr.data[i]);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // legend (top-right, one line)
    let lx = px.x1 - 8;
    ctx.textAlign = "right";
    for (let i = this.traces.length - 1; i >= 0; i--) {
      const tr = this.traces[i];
      ctx.fillStyle = tr.color;
      ctx.fillText(tr.label, lx, px.y1 + 14);
      lx -= ctx.measureText(tr.label).width + 16;
    }

    // crosshair + readout
    if (this.hoverX !== null && this.hoverX >= px.x0 && this.hoverX <= px.x1) {
      // invert xOf, then snap to the nearest sample index
      const tHover = tMin + ((this.hoverX - px.x0) / (px.x1 - px.x0)) * (tMax - tMin);
      let idx = 0;
      let lo = 0, hi = this.t.length - 1; // binary search: t is sorted
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        this.t[mid] < tHover ? (lo = mid) : (hi = mid);
      }
      idx = tHover - this.t[lo] < this.t[hi] - tHover ? lo : hi;

      const x = xOf(this.t[idx]);
      ctx.strokeStyle = COLORS.crosshair;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(x, px.y1); ctx.lineTo(x, px.y0); ctx.stroke();
      ctx.setLineDash([]);

      const lines = [`t = ${formatValue(this.t[idx], this.xUnit)}`];
      for (const tr of this.traces) {
        lines.push(`${tr.label} = ${formatValue(tr.data[idx], this.yUnit)}`);
        ctx.beginPath();
        ctx.arc(x, yOf(tr.data[idx]), 3, 0, Math.PI * 2);
        ctx.fillStyle = tr.color;
        ctx.fill();
      }
      // readout box, flipped to the left side when near the right edge
      const bw = Math.max(...lines.map((s) => ctx.measureText(s).width)) + 14;
      const bx = x + bw + 12 > px.x1 ? x - bw - 8 : x + 8;
      ctx.fillStyle = "rgba(7, 43, 31, 0.92)";
      ctx.fillRect(bx, px.y1 + 6, bw, lines.length * 15 + 8);
      ctx.strokeStyle = COLORS.accent;
      ctx.strokeRect(bx + 0.5, px.y1 + 6.5, bw, lines.length * 15 + 8);
      ctx.textAlign = "left";
      lines.forEach((s, i) => {
        ctx.fillStyle = i === 0 ? COLORS.text : this.traces[i - 1].color;
        ctx.fillText(s, bx + 7, px.y1 + 24 + i * 15);
      });
    }
  }
}
