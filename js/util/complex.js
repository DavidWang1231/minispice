/**
 * complex.js — minimal complex-number arithmetic for AC analysis.
 *
 * WHY THIS EXISTS
 * ---------------
 * AC (small-signal, sinusoidal steady-state) analysis is *exactly* the same
 * Modified Nodal Analysis we use for DC — except every quantity becomes a
 * phasor (a complex number) and reactive elements become complex admittances:
 *
 *     capacitor C  →  admittance Y = jωC
 *     inductor  L  →  admittance Y = 1/(jωL)
 *
 * So instead of writing a second solver, we make the LU solver generic over a
 * small "field" object (see solver.js) and plug in either real or complex
 * arithmetic. This file supplies the complex half.
 *
 * Complex numbers are represented as plain immutable instances { re, im }.
 * All operations return NEW Complex objects — no in-place mutation. That
 * costs some garbage-collector pressure but keeps the math code readable,
 * which matters more here (the matrices are small: a schematic rarely has
 * more than a few dozen nodes).
 */

export class Complex {
  constructor(re, im = 0) {
    this.re = re;
    this.im = im;
  }

  /** Coerce a plain number (or pass through a Complex) into a Complex. */
  static from(x) {
    return x instanceof Complex ? x : new Complex(x, 0);
  }

  add(b) { return new Complex(this.re + b.re, this.im + b.im); }
  sub(b) { return new Complex(this.re - b.re, this.im - b.im); }

  /** (a+jb)(c+jd) = (ac − bd) + j(ad + bc) */
  mul(b) {
    return new Complex(
      this.re * b.re - this.im * b.im,
      this.re * b.im + this.im * b.re
    );
  }

  /**
   * Division: multiply numerator and denominator by the conjugate of the
   * denominator, so the denominator becomes the real number |b|².
   *
   *   a / b = a·conj(b) / |b|²
   */
  div(b) {
    const d = b.re * b.re + b.im * b.im;
    return new Complex(
      (this.re * b.re + this.im * b.im) / d,
      (this.im * b.re - this.re * b.im) / d
    );
  }

  neg() { return new Complex(-this.re, -this.im); }

  /** Magnitude |z| = sqrt(re² + im²). Math.hypot avoids overflow. */
  abs() { return Math.hypot(this.re, this.im); }

  /** Phase angle in radians, range (−π, π]. */
  arg() { return Math.atan2(this.im, this.re); }

  toString() {
    const sign = this.im >= 0 ? "+" : "-";
    return `${this.re} ${sign} j${Math.abs(this.im)}`;
  }
}

/**
 * The "field" interfaces consumed by the generic LU solver (solver.js).
 * Each field bundles the arithmetic ops the solver needs, so the same
 * elimination code runs on real numbers (DC, transient) or complex
 * numbers (AC) without duplication.
 *
 * `mag` is used only for pivot selection and singularity detection —
 * partial pivoting picks the row whose pivot has the largest magnitude.
 */
export const realField = {
  zero: () => 0,
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
  mag: (a) => Math.abs(a),
};

export const complexField = {
  zero: () => new Complex(0, 0),
  add: (a, b) => a.add(b),
  sub: (a, b) => a.sub(b),
  mul: (a, b) => a.mul(b),
  div: (a, b) => a.div(b),
  mag: (a) => a.abs(),
};
