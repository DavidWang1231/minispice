/**
 * bode.js — Bode plot: two stacked panels (magnitude in dB, phase in
 * degrees) over a log frequency axis, with per-decade gridlines and a
 * −3 dB marker relative to each trace's passband peak.
 */

import { formatValue } from "../editor/components.js";
import { niceTicks } from "./waveform.js";

const COLORS = {
  bg: "#072b1f",
  grid: "#14503b",
  gridMinor: "#0e4232",
  axis: "#1c5a44",
  text: "#d8e6de",
  accent: "#d4af37",
  crosshair: "rgba(216, 230, 222, 0.5)",
};

const MARGIN = { left: 72, right: 16, top: 16, bottom: 34, betweenPanels: 12 };
const FONT = "11px ui-monospace, Menlo, monospace";

export class BodePlot {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.freqs = null;
    this.traces = []; // [{label, color, magDb, phaseDeg}]
    this.hoverX = null;

    canvas.addEventListener("mousemove", (e) => {
      const r = canvas.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      this.draw();
    });
    canvas.addEventListener("mouseleave", () => { this.hoverX = null; this.draw(); });
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }

  setData(freqs, traces) {
    this.freqs = freqs;
    this.traces = traces;
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

  draw() {
    const ctx = this.ctx;
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);
    if (!this.freqs || this.freqs.length < 2) return;
    ctx.font = FONT;

    const x0 = MARGIN.left, x1 = W - MARGIN.right;
    // magnitude panel gets slightly more room than phase
    const plotH = H - MARGIN.top - MARGIN.bottom - MARGIN.betweenPanels;
    const magPanel = { y1: MARGIN.top, y0: MARGIN.top + plotH * 0.55 };
    const phPanel = { y1: magPanel.y0 + MARGIN.betweenPanels, y0: H - MARGIN.bottom };

    const fMin = this.freqs[0], fMax = this.freqs[this.freqs.length - 1];
    const logSpan = Math.log10(fMax / fMin);
    const xOf = (f) => x0 + (Math.log10(f / fMin) / logSpan) * (x1 - x0);

    // ---- shared log-x gridlines: major per decade, minor at 2..9 ----
    const dec0 = Math.floor(Math.log10(fMin)), dec1 = Math.ceil(Math.log10(fMax));
    for (let d = dec0; d <= dec1; d++) {
      for (let mant = 1; mant <= 9; mant++) {
        const f = mant * 10 ** d;
        if (f < fMin * 0.999 || f > fMax * 1.001) continue;
        const x = Math.round(xOf(f)) + 0.5;
        ctx.strokeStyle = mant === 1 ? COLORS.grid : COLORS.gridMinor;
        ctx.beginPath();
        ctx.moveTo(x, magPanel.y1); ctx.lineTo(x, magPanel.y0);
        ctx.moveTo(x, phPanel.y1); ctx.lineTo(x, phPanel.y0);
        ctx.stroke();
        if (mant === 1) {
          ctx.fillStyle = COLORS.text;
          ctx.textAlign = "center";
          ctx.fillText(formatValue(f, "Hz"), x, phPanel.y0 + 16);
        }
      }
    }

    // ---- one sub-panel drawer used for both mag and phase ----
    const drawPanel = (panel, getData, unit, yLabel) => {
      let min = Infinity, max = -Infinity;
      for (const tr of this.traces) {
        for (const v of getData(tr)) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      if (!Number.isFinite(min)) { min = -1; max = 1; }
      if (max - min < 1e-9) { min -= 1; max += 1; }
      const pad = (max - min) * 0.08;
      min -= pad; max += pad;
      const yOf = (v) => panel.y0 - ((v - min) / (max - min)) * (panel.y0 - panel.y1);

      ctx.strokeStyle = COLORS.grid;
      ctx.fillStyle = COLORS.text;
      for (const v of niceTicks(min, max, 4).ticks) {
        const y = Math.round(yOf(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
        ctx.textAlign = "right";
        ctx.fillText(`${Number(v.toPrecision(4))}${unit}`, x0 - 6, y + 4);
      }
      ctx.strokeStyle = COLORS.axis;
      ctx.strokeRect(x0 + 0.5, panel.y1 + 0.5, x1 - x0, panel.y0 - panel.y1);
      ctx.save();
      ctx.fillStyle = COLORS.accent;
      ctx.translate(14, (panel.y0 + panel.y1) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "center";
      ctx.fillText(yLabel, 0, 0);
      ctx.restore();

      for (const tr of this.traces) {
        const data = getData(tr);
        ctx.strokeStyle = tr.color;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        for (let i = 0; i < this.freqs.length; i++) {
          const x = xOf(this.freqs[i]), y = yOf(data[i]);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      return yOf;
    };

    const yOfMag = drawPanel(magPanel, (tr) => tr.magDb, "dB", "magnitude");
    drawPanel(phPanel, (tr) => tr.phaseDeg, "°", "phase");

    // ---- −3 dB marker: where each trace first drops 3 dB below its own
    // peak (the passband reference). Interpolate in log-f for accuracy. ----
    for (const tr of this.traces) {
      const peak = Math.max(...tr.magDb);
      const target = peak - 3;
      for (let i = 1; i < this.freqs.length; i++) {
        if (tr.magDb[i - 1] > target && tr.magDb[i] <= target) {
          const frac = (tr.magDb[i - 1] - target) / (tr.magDb[i - 1] - tr.magDb[i]);
          const logF = Math.log10(this.freqs[i - 1]) +
            frac * (Math.log10(this.freqs[i]) - Math.log10(this.freqs[i - 1]));
          const f3 = 10 ** logF;
          const x = xOf(f3), y = yOfMag(target);
          ctx.strokeStyle = COLORS.accent;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(x, magPanel.y1); ctx.lineTo(x, magPanel.y0);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(x, y, 3.5, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = COLORS.accent;
          ctx.textAlign = "left";
          ctx.fillText(`−3dB @ ${formatValue(f3, "Hz")}`, x + 6, y - 6);
          break; // first crossing only
        }
      }
    }

    // ---- legend (top-right of magnitude panel) ----
    let lx = x1 - 8;
    ctx.textAlign = "right";
    for (let i = this.traces.length - 1; i >= 0; i--) {
      ctx.fillStyle = this.traces[i].color;
      ctx.fillText(this.traces[i].label, lx, magPanel.y1 + 14);
      lx -= ctx.measureText(this.traces[i].label).width + 16;
    }

    // ---- crosshair with readout ----
    if (this.hoverX !== null && this.hoverX >= x0 && this.hoverX <= x1) {
      const logF = Math.log10(fMin) + ((this.hoverX - x0) / (x1 - x0)) * logSpan;
      // nearest sample index (freqs are log-spaced, compare in log domain)
      let idx = 0, bestD = Infinity;
      for (let i = 0; i < this.freqs.length; i++) {
        const d = Math.abs(Math.log10(this.freqs[i]) - logF);
        if (d < bestD) { bestD = d; idx = i; }
      }
      const x = xOf(this.freqs[idx]);
      ctx.strokeStyle = COLORS.crosshair;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, magPanel.y1); ctx.lineTo(x, phPanel.y0);
      ctx.stroke();
      ctx.setLineDash([]);

      const lines = [`f = ${formatValue(this.freqs[idx], "Hz")}`];
      for (const tr of this.traces) {
        lines.push(
          `${tr.label}: ${tr.magDb[idx].toFixed(2)}dB ∠${tr.phaseDeg[idx].toFixed(1)}°`
        );
      }
      const bw = Math.max(...lines.map((s) => ctx.measureText(s).width)) + 14;
      const bx = x + bw + 12 > x1 ? x - bw - 8 : x + 8;
      ctx.fillStyle = "rgba(7, 43, 31, 0.92)";
      ctx.fillRect(bx, magPanel.y1 + 6, bw, lines.length * 15 + 8);
      ctx.strokeStyle = COLORS.accent;
      ctx.strokeRect(bx + 0.5, magPanel.y1 + 6.5, bw, lines.length * 15 + 8);
      ctx.textAlign = "left";
      lines.forEach((s, i) => {
        ctx.fillStyle = i === 0 ? COLORS.text : this.traces[i - 1].color;
        ctx.fillText(s, bx + 7, magPanel.y1 + 24 + i * 15);
      });
    }
  }
}
