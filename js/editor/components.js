/**
 * components.js — component catalogue for the schematic editor.
 *
 * Each entry in COMPONENT_DEFS describes one placeable part:
 *   - prefix       reference-designator prefix ("R" → R1, R2, ...)
 *   - terminals    pin positions in LOCAL coordinates (rotation 0), all
 *                  grid-aligned so pins always land on the 20 px grid
 *   - bodyRect     local-frame hit-test box {x0,y0,x1,y1}
 *   - defaults()   initial electrical parameters for a fresh part
 *   - draw(ctx,comp,style)  symbol drawing in the local frame; the editor
 *                  translates to comp.pos and rotates before calling
 *   - summary(comp) short human string shown under the designator
 *
 * LOCAL FRAME CONVENTION: components are drawn lying along the x-axis,
 * terminal 0 on the left (−x), terminal 1 on the right (+x). For sources,
 * terminal 0 is the "+" terminal (matches the engine's node order — see
 * engine/dc.js input contract). Rotation is 0/90/180/270° clockwise
 * (canvas y grows downward).
 */

export const GRID = 20;

/** Rotate a local point by a component rotation (clockwise degrees). */
export function rotatePoint(p, rotation) {
  switch (rotation) {
    case 90: return { x: -p.y, y: p.x };
    case 180: return { x: -p.x, y: -p.y };
    case 270: return { x: p.y, y: -p.x };
    default: return { x: p.x, y: p.y };
  }
}

/** Absolute pin positions of a placed component. */
export function terminalPositions(comp) {
  return COMPONENT_DEFS[comp.type].terminals.map((t) => {
    const r = rotatePoint(t, comp.rotation);
    return { x: comp.pos.x + r.x, y: comp.pos.y + r.y };
  });
}

/* ------------------------------------------------------------------ *
 *  Engineering notation                                               *
 * ------------------------------------------------------------------ */

/**
 * Parse "4.7k", "100n", "2.2Meg", "10m", "1e-6", "50" → number.
 * SPICE-flavored, case matters only for m/M:
 *   f p n u(µ) m  k  M(or Meg/meg)  G  T
 * Returns NaN on garbage (caller decides how to complain).
 */
export function parseValue(str) {
  if (typeof str === "number") return str;
  const s = str.trim().replace("µ", "u");
  const m = s.match(/^([-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)\s*([a-zA-Z]*)$/);
  if (!m) return NaN;
  const num = parseFloat(m[1]);
  const suffix = m[2];
  if (!suffix) return num;
  if (/^meg/i.test(suffix)) return num * 1e6;
  const mult = {
    T: 1e12, G: 1e9, M: 1e6, k: 1e3, K: 1e3,
    m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15,
  }[suffix[0]];
  return mult === undefined ? NaN : num * mult;
}

/** Format a number back into engineering notation, e.g. 4700 → "4.7k". */
export function formatValue(x, unit = "") {
  if (x === 0) return `0${unit}`;
  const steps = [
    [1e12, "T"], [1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""],
    [1e-3, "m"], [1e-6, "u"], [1e-9, "n"], [1e-12, "p"], [1e-15, "f"],
  ];
  const mag = Math.abs(x);
  for (const [mult, suffix] of steps) {
    if (mag >= mult * 0.9999) {
      const v = x / mult;
      // up to 4 significant digits, trailing zeros trimmed
      return `${Number(v.toPrecision(4))}${suffix}${unit}`;
    }
  }
  return `${x.toExponential(2)}${unit}`;
}

/* ------------------------------------------------------------------ *
 *  Symbol drawing helpers (copper traces, gold accents)               *
 * ------------------------------------------------------------------ */

function lead(ctx, x0, y0, x1, y1) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

/* ------------------------------------------------------------------ *
 *  The catalogue                                                      *
 * ------------------------------------------------------------------ */

export const COMPONENT_DEFS = {
  R: {
    prefix: "R",
    name: "Resistor",
    unit: "Ω",
    terminals: [{ x: -40, y: 0 }, { x: 40, y: 0 }],
    bodyRect: { x0: -30, y0: -12, x1: 30, y1: 12 },
    defaults: () => ({ value: 1000 }),
    summary: (c) => formatValue(c.value, "Ω"),
    draw(ctx) {
      lead(ctx, -40, 0, -24, 0);
      lead(ctx, 24, 0, 40, 0);
      // classic zigzag: 6 half-cycles across 48 px
      ctx.beginPath();
      ctx.moveTo(-24, 0);
      const pts = [-20, -12, -4, 4, 12, 20];
      pts.forEach((x, i) => ctx.lineTo(x, i % 2 === 0 ? -9 : 9));
      ctx.lineTo(24, 0);
      ctx.stroke();
    },
  },

  C: {
    prefix: "C",
    name: "Capacitor",
    unit: "F",
    terminals: [{ x: -40, y: 0 }, { x: 40, y: 0 }],
    bodyRect: { x0: -12, y0: -14, x1: 12, y1: 14 },
    defaults: () => ({ value: 1e-6 }),
    summary: (c) => formatValue(c.value, "F"),
    draw(ctx) {
      lead(ctx, -40, 0, -4, 0);
      lead(ctx, 4, 0, 40, 0);
      lead(ctx, -4, -12, -4, 12); // plates
      lead(ctx, 4, -12, 4, 12);
    },
  },

  L: {
    prefix: "L",
    name: "Inductor",
    unit: "H",
    terminals: [{ x: -40, y: 0 }, { x: 40, y: 0 }],
    bodyRect: { x0: -30, y0: -14, x1: 30, y1: 6 },
    defaults: () => ({ value: 1e-3 }),
    summary: (c) => formatValue(c.value, "H"),
    draw(ctx) {
      lead(ctx, -40, 0, -24, 0);
      lead(ctx, 24, 0, 40, 0);
      ctx.beginPath(); // three humps
      for (let i = 0; i < 3; i++) {
        ctx.arc(-16 + i * 16, 0, 8, Math.PI, 0, false);
      }
      ctx.stroke();
    },
  },

  V: {
    prefix: "V",
    name: "Voltage source",
    unit: "V",
    terminals: [{ x: -40, y: 0 }, { x: 40, y: 0 }], // t0 = "+"
    bodyRect: { x0: -16, y0: -16, x1: 16, y1: 16 },
    defaults: () => ({
      value: 5,            // DC level (or step height)
      waveform: "dc",      // dc | sine | step | pulse
      amplitude: 5, freq: 1000, offset: 0, // sine
      delay: 0,                            // step / pulse
      period: 1e-3, width: 5e-4,           // pulse
    }),
    summary(c) {
      switch (c.waveform) {
        case "sine": return `~${formatValue(c.amplitude, "V")} ${formatValue(c.freq, "Hz")}`;
        case "step": return `step ${formatValue(c.value, "V")}`;
        case "pulse": return `pulse ${formatValue(c.amplitude, "V")}`;
        default: return formatValue(c.value, "V");
      }
    },
    draw(ctx, comp, style) {
      lead(ctx, -40, 0, -14, 0);
      lead(ctx, 14, 0, 40, 0);
      ctx.beginPath();
      ctx.arc(0, 0, 14, 0, Math.PI * 2);
      ctx.stroke();
      // polarity marks in gold: "+" toward terminal 0
      ctx.save();
      ctx.strokeStyle = style.accent;
      lead(ctx, -9, 0, -3, 0);
      lead(ctx, -6, -3, -6, 3);
      lead(ctx, 3, 0, 9, 0);
      ctx.restore();
    },
  },

  I: {
    prefix: "I",
    name: "Current source",
    unit: "A",
    terminals: [{ x: -40, y: 0 }, { x: 40, y: 0 }],
    bodyRect: { x0: -16, y0: -16, x1: 16, y1: 16 },
    defaults: () => ({ value: 1e-3, waveform: "dc" }),
    summary: (c) => formatValue(c.value, "A"),
    draw(ctx, comp, style) {
      lead(ctx, -40, 0, -14, 0);
      lead(ctx, 14, 0, 40, 0);
      ctx.beginPath();
      ctx.arc(0, 0, 14, 0, Math.PI * 2);
      ctx.stroke();
      // arrow shows internal current direction: enters t0, exits t1,
      // i.e. the source pushes conventional current out of terminal 1.
      ctx.save();
      ctx.strokeStyle = style.accent;
      lead(ctx, -8, 0, 8, 0);
      lead(ctx, 8, 0, 3, -4);
      lead(ctx, 8, 0, 3, 4);
      ctx.restore();
    },
  },

  OPAMP: {
    prefix: "U",
    name: "Ideal op-amp",
    unit: "",
    // [in+, in−, out] — matches engine/mna.js stampOpAmp order
    terminals: [{ x: -40, y: -20 }, { x: -40, y: 20 }, { x: 40, y: 0 }],
    bodyRect: { x0: -30, y0: -32, x1: 32, y1: 32 },
    defaults: () => ({}),
    summary: () => "ideal",
    draw(ctx, comp, style) {
      lead(ctx, -40, -20, -28, -20);
      lead(ctx, -40, 20, -28, 20);
      lead(ctx, 30, 0, 40, 0);
      ctx.beginPath(); // triangle body
      ctx.moveTo(-28, -30);
      ctx.lineTo(-28, 30);
      ctx.lineTo(30, 0);
      ctx.closePath();
      ctx.stroke();
      ctx.save();
      ctx.strokeStyle = style.accent;
      lead(ctx, -23, -20, -15, -20); // "+" at in+ (terminal 0)
      lead(ctx, -19, -24, -19, -16);
      lead(ctx, -23, 20, -15, 20);   // "−" at in−
      ctx.restore();
    },
  },

  GND: {
    prefix: "GND",
    name: "Ground",
    unit: "",
    terminals: [{ x: 0, y: 0 }],
    bodyRect: { x0: -12, y0: 0, x1: 12, y1: 18 },
    defaults: () => ({}),
    summary: () => "",
    draw(ctx) {
      lead(ctx, 0, 0, 0, 8);
      lead(ctx, -10, 8, 10, 8);
      lead(ctx, -6, 13, 6, 13);
      lead(ctx, -2, 18, 2, 18);
    },
  },
};

/** Create a fresh component instance at a (snapped) canvas position. */
export function makeComponent(type, id, x, y) {
  const def = COMPONENT_DEFS[type];
  return {
    id,
    type,
    pos: { x, y },
    rotation: 0,
    ...def.defaults(),
  };
}
