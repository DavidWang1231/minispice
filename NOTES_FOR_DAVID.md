# Notes for David — implementer → owner handoff

This file exists because the spec said: *never hide complexity from the
owner*. Everything below is what you need to genuinely own this project —
the file map, the three concepts you must be able to whiteboard cold, every
design decision that was made on your behalf, and hand-calculation
exercises to verify the simulator independently.

---

## 1. File-by-file map (plain language)

| File | What it actually does |
|---|---|
| `index.html` | Static app shell: toolbar, canvas, sidebar panels, plot area. No logic. |
| `css/style.css` | The PCB theme. Palette constants are duplicated in `schematic.js` (canvas can't read CSS variables cheaply) — change both together. |
| `js/main.js` | Bootstrap + glue. The **only** file that imports both editor and engine. Reads UI fields, calls the engine, routes results to schematic annotations / plots / status bar. |
| `js/editor/components.js` | The part catalogue: how each component looks (canvas paths), where its pins are, its default parameters. Also `parseValue`/`formatValue` for engineering notation (`4.7k` ↔ 4700). |
| `js/editor/schematic.js` | All mouse/keyboard interaction and rendering: place, move, rotate, delete, wire drawing, probes, the double-click property editor, DC annotations. Knows nothing about math. |
| `js/editor/netlist.js` | Geometry → topology. Union-find over pin/wire coordinates decides which points are the same electrical node. GND symbols force node 0. Read this when a circuit "isn't connected" — the bug is always coordinates not matching. |
| `js/engine/mna.js` | The heart. `MNASystem` holds the `(N+M)×(N+M)` matrix; each element type has a `stamp*` method. The op-amp stamp comment is the longest in the repo for a reason. |
| `js/engine/solver.js` | LU decomposition with partial pivoting + forward/back substitution, generic over real/complex arithmetic. Throws `SingularMatrixError` with the user-facing message. |
| `js/engine/dc.js` | DC operating point: C open, L short (as 0 V source), solve once. |
| `js/engine/transient.js` | Time stepping. Companion models (derived in the header comment), backward Euler + trapezoidal, the BE startup step, LU reuse across steps. |
| `js/engine/ac.js` | Phasor sweep: same stamps, complex field, one solve per frequency point. |
| `js/plot/waveform.js` | Time-domain canvas plot (ticks, autoscale, legend, crosshair). `niceTicks` lives here. |
| `js/plot/bode.js` | Two stacked panels, log-x, decade grid, per-trace −3 dB marker. |
| `js/util/complex.js` | `Complex` class + the `realField`/`complexField` objects the solver is generic over. |
| `tests/` | Framework-free test page; every expected value is derived by hand in a comment. Also runs in Node (the engine has zero DOM access). |
| `examples/` | Five preset circuits as plain JSON (the same format Save/Load uses). |

---

## 2. The three concepts you must be able to whiteboard

### 2a. MNA stamps — and why voltage sources need extra rows

Plain nodal analysis: write KCL at every non-ground node. For each element
expressed as a conductance g between nodes a and b, current leaving a is
`g·(V(a) − V(b))`, which contributes:

```
        col a   col b
row a [  +g     −g  ]
row b [  −g     +g  ]        →  G·v = i   (N equations, N unknowns)
```

**The problem:** an ideal voltage source has no conductance — its current
is whatever the circuit demands, so you cannot write its current as a
function of its voltage. KCL at its nodes has an unknown you can't express.

**The fix (the "M" in MNA):** stop trying to eliminate that current —
*promote it to an unknown* `j_k`. Now you have N+1 unknowns, so you need
one more equation — and the source hands you one for free, its own
definition: `V(a) − V(b) = E`. In matrix form, branch k adds:

- column N+k: `+1` in row a, `−1` in row b (current j_k leaves a, enters b)
- row N+k: `+1` in col a, `−1` in col b, RHS `E` (the constraint)

One extra unknown + one extra equation per source → square again.
Op-amps (nullor) work the same way, except the extra *row* constrains the
**input** pair (`V(in+) − V(in−) = 0`) while the extra *column* carries the
**output** current — an asymmetric stamp, which is why the matrix stops
being symmetric the moment an op-amp appears.

Ground: node 0's KCL row is minus the sum of all others (redundant), so
row/col 0 are simply never built. That's also *why* every circuit needs a
ground: without it there's no reference and the matrix is singular.

### 2b. Capacitor companion model (derive it, don't memorize it)

Start from the element law and discretize the derivative (backward Euler —
evaluate at the NEW time):

```
i = C·dv/dt   ≈   i(t+h) = C · (v(t+h) − v(t)) / h
             →    i(t+h) = (C/h)·v(t+h)  −  (C/h)·v(t)
                           ─────────────    ────────────
                           looks like a     a KNOWN number:
                           conductance      a current source
                           G_eq = C/h       I_eq = (C/h)·v(t)
```

So *at each time step* the capacitor is replaced by a resistor `h/C` in
parallel with a current source remembering last step's voltage — and the
whole time step becomes an ordinary resistive DC solve. Sanity checks that
should feel right physically:

- h → 0: G_eq → ∞ — over a tiny interval a cap is a short (its voltage
  can't move instantly).
- h → ∞: G_eq → 0 — over infinite time it's an open (DC behavior).

Trapezoidal is the same game with the average of old/new derivatives:
`G_eq = 2C/h`, `I_eq = (2C/h)·v(t) + i(t)` — note it needs the previous
*current* too, which is exactly what causes the startup subtlety described
in `transient.js` (first step must be BE or the error never decays).

The inductor is the perfect dual: `v = L·di/dt` → `G_eq = h/L`,
`I_eq = i(t)`.

### 2c. Why AC analysis is just MNA over complex numbers

Assume single-frequency sinusoidal steady state and write every signal as
a phasor: `v(t) = Re{V·e^(jωt)}` where complex `V` encodes amplitude and
phase. Then differentiation becomes multiplication:

```
d/dt (V·e^(jωt)) = jω·V·e^(jωt)      i.e.   d/dt  ≡  ×jω
```

Apply to the element laws: `i = C·dv/dt` → `I = (jωC)·V`. That has the
*form* of Ohm's law with a complex conductance (admittance) `Y = jωC`.
Same for the inductor: `Y = 1/(jωL)`. Resistors are unchanged.

Nothing else in MNA cared what the matrix entries *were* — stamps add,
LU solves. So AC analysis = the same assembly + the same solver, with
complex arithmetic plugged in. The output node's phasor **is** the
transfer function value H(jω) when the input amplitude is 1:
`|H|` in dB = `20·log10|V|`, phase = `atan2(Im V, Re V)`.

Check the limits: ω→0 gives Y_C→0 (open) and Y_L→∞ (short) — DC falls
out of the AC model, as it must.

---

## 3. Design decisions made on your behalf (own these before interviews)

1. **Default integration = backward Euler; trapezoidal selectable.**
   BE never oscillates numerically (L-stable) — safest default; trap is
   offered for accuracy. *(spec allowed either default)*
2. **Trapezoidal takes its first step with BE.** A step input makes the
   assumed initial current inconsistent; one BE step restores trap's
   2nd-order accuracy (measured in test 4: 1.5 µV vs 1.8 mV error).
3. **Op-amp = nullor** (input nullator + output norator), not a huge
   finite gain. Exact, well-conditioned; but it *assumes negative
   feedback* — open-loop circuits give unphysical answers or a singular
   matrix instead of saturating.
4. **Node numbering:** ground = 0, eliminated from the matrix; other
   nodes numbered 1..N in the order netlist extraction first meets them
   (arbitrary but stable). MNA branch indices are assigned *per analysis*
   because the set differs (DC gives inductors a branch; transient/AC
   don't).
5. **Inductor at DC = 0 V voltage source** (not a tiny resistor): exact
   short, and its branch current is the inductor current for free.
6. **Companion models use the Norton (parallel) form,** not Thevenin:
   no extra matrix rows, and we must track i_L anyway for plotting.
7. **Transient initial conditions are a "cold start"** (v_C = 0, i_L = 0,
   step sources are 0 at t=0). SPICE instead starts from the DC operating
   point. Cold start makes `v(t) = V(1−e^(−t/RC))` come out exactly and
   is easier to reason about; the DC-OP start is a natural v2 feature.
8. **AC source amplitudes:** sine sources inject their amplitude; DC,
   step and pulse sources inject 0. SPICE has a separate "AC magnitude"
   property per source; folding it into the waveform keeps the UI smaller.
9. **DC values of time-varying sources:** sine → its offset; step/pulse →
   0 (their pre-transition level).
10. **Sign conventions** (match SPICE): V-source branch current flows
    + → − *inside* the source, so a battery delivering power reads
    negative. I-source arrow = internal current direction (out of the
    terminal-1 side).
11. **Solver is generic over a "field" object** instead of a separate
    complex solver: one elimination code path, tested once, used thrice.
12. **Singularity test is relative** (pivot < 10⁻¹² × largest entry), so
    a circuit in mΩ and one in MΩ behave identically.
13. **Fixed time step, LU factored once** and reused every step (matrix
    is constant when h is constant) — O(n³) once, O(n²) per step.
14. **Engineering notation is case-sensitive only for m/M** (`m` = milli,
    `M`/`Meg` = mega), like SPICE-ish conventions; `u` and `µ` both work.
15. **Probes are stored as coordinates,** resolved to nodes at run time —
    they survive rewiring, and a probe left on a deleted net just warns.
16. **No localStorage** (spec constraint): save/load is file
    download/upload; presets are `fetch`ed JSON (needs HTTP, not file://).
17. **−3 dB marker is relative to each trace's own peak** (passband
    reference), first crossing only — correct for low/high/band-pass;
    meaningless for band-stop (known limitation).

---

## 4. Hand-calculation exercises (verify the tool independently)

Do these on paper *first*, then check against the simulator:

1. **Divider warm-up.** Change the divider preset to R1 = 2.2k, R2 = 4.7k.
   Predict V(mid) and the loop current; Run DC and compare.
2. **Superposition.** Solve tests/engine_tests.js test 2 by hand (both
   sources, three resistors — the derivation is in the comment; do it
   without looking). Build it in the editor and Run DC.
3. **Virtual ground.** For the inverting-opamp preset, derive
   V_out = −(R2/R1)·V_in from two facts only: no input current, and
   V(in−) = V(in+) = 0. Then change R2 to 4.7k and predict the new output
   amplitude before running.
4. **RC time constant.** For the rc-lowpass preset: compute τ = RC and
   f_c = 1/(2πRC). Switch the source to `step`, run transient, and use the
   crosshair to confirm 63.2% at t = τ. Run AC and check the −3 dB marker
   lands at your f_c.
5. **RLC ringing.** For series-rlc: compute α = R/2L, ω₀ = 1/√(LC),
   ω_d = √(ω₀² − α²). Predict the ringing period; measure peak-to-peak
   spacing with the crosshair. Then *double R* — predict whether the ring
   slows down or speeds up before running. Also: at what R does ringing
   stop entirely? (Critical damping: R = 2√(L/C).)
6. **Numerical damping.** Run series-rlc with dt = 5 µs under BE, then
   trapezoidal. Explain which envelope decays faster and why one of them
   is lying to you.
7. **Sallen-Key.** Verify f_c = 1/(2π√(R1R2C1C2)) = 703 Hz and
   Q = √(R1R2C1C2)/(C2(R1+R2)) = 0.707 for the preset values. Change C1
   to 100 nF: predict the new Q, and whether the knee gets sharper or
   softer, before running the sweep.
8. **Break it on purpose.** Delete the ground symbol from any preset and
   run — read the error. Wire two different voltage sources in parallel —
   read the error. Know *why* each matrix is singular (§2a).

---

## 5. Suggested next steps (v2 ideas, in difficulty order)

1. Start transient from the DC operating point (reuses `dc.js` almost
   verbatim; watch inductor currents as initial conditions).
2. Current probes (differential voltage probes across an element / branch
   current readout — the data is already computed).
3. Diode via Newton–Raphson: linearize `i = Is(e^(v/vT)−1)` around the
   present guess, stamp the linearized conductance + source, iterate to
   convergence. This is THE gateway to real SPICE.
4. Adaptive time stepping via the BE/trap LTE estimate.
