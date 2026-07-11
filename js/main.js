/**
 * main.js — application bootstrap and event wiring.
 *
 * This is the ONLY file that talks to both worlds: it pulls a netlist out
 * of the editor (geometry side) and feeds it to the engine (math side),
 * then routes results back into the editor/plots for display. Keeping the
 * marshalling here means editor and engine stay import-independent.
 */

import { SchematicEditor, PROBE_COLORS } from "./editor/schematic.js";
import { parseValue, formatValue } from "./editor/components.js";
import { dcOperatingPoint } from "./engine/dc.js";
import { transientAnalysis } from "./engine/transient.js";
import { WaveformPlot } from "./plot/waveform.js";

/* ---------------- status bar ---------------- */

const statusEl = document.getElementById("status");
function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = isError ? "error" : "";
}

/* ---------------- editor ---------------- */

const editor = new SchematicEditor(document.getElementById("schematic"), {
  onChange: () => {
    // Any edit invalidates displayed results.
    document.getElementById("dc-results").innerHTML = "";
  },
  onStatus: setStatus,
});

/* ---------------- toolbar ---------------- */

const toolButtons = document.querySelectorAll("#toolbar button[data-tool]");
for (const btn of toolButtons) {
  btn.addEventListener("click", () => {
    toolButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    editor.setTool(btn.dataset.tool);
  });
}
// Esc resets the visual state too.
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    toolButtons.forEach((b) => b.classList.toggle("active", b.dataset.tool === "select"));
  }
});

/* ---------------- run DC ---------------- */

document.getElementById("btn-dc").addEventListener("click", () => {
  const { netlist, nodeOfPoint, warnings } = editor.extract();
  if (netlist.components.length === 0) {
    setStatus("Nothing to simulate — place some components first.", true);
    return;
  }
  if (warnings.length) {
    setStatus(warnings.join(" "), true);
    return;
  }
  try {
    const { voltages, currents } = dcOperatingPoint(netlist);
    editor.setNodeVoltages(voltages, nodeOfPoint);

    // side-panel table: node voltages then element currents
    const rows = [];
    for (let n = 1; n <= netlist.nodeCount; n++) {
      rows.push(`<tr><td>V(node ${n})</td><td>${formatValue(voltages[n], "V")}</td></tr>`);
    }
    for (const c of netlist.components) {
      rows.push(`<tr><td>I(${c.id})</td><td>${formatValue(currents[c.id], "A")}</td></tr>`);
    }
    document.getElementById("dc-results").innerHTML = `<table>${rows.join("")}</table>`;
    setStatus(`DC solved: ${netlist.nodeCount} nodes, ${netlist.components.length} components.`);
  } catch (err) {
    setStatus(err.message, true);
  }
});

/* ---------------- probes → traces ---------------- */

/**
 * Resolve the editor's probes to node numbers. Probes sitting on ground
 * or on nothing are skipped (with a status warning) rather than fatal.
 */
function resolveProbes(nodeOfPoint) {
  const probes = [];
  editor.probes.forEach((p, i) => {
    const node = nodeOfPoint.get(`${p.x},${p.y}`);
    if (node === undefined || node === 0) {
      setStatus(`Probe P${i + 1} is not on a live node — skipped.`, true);
      return;
    }
    probes.push({ label: `P${i + 1}`, node, color: PROBE_COLORS[i % PROBE_COLORS.length] });
  });
  return probes;
}

/* ---------------- plot panel ---------------- */

const plotPanel = document.getElementById("plot-panel");
const plot = new WaveformPlot(document.getElementById("plot"));
let bode = null; // created lazily in M4 (shares the canvas slot)

function showPlot(title) {
  document.getElementById("plot-title").textContent = title;
  plotPanel.hidden = false;
  plot.resize(); // the canvas was 0×0 while hidden
}

document.getElementById("btn-close-plot").addEventListener("click", () => {
  plotPanel.hidden = true;
});

/* ---------------- run transient ---------------- */

document.getElementById("btn-tran").addEventListener("click", () => {
  const { netlist, nodeOfPoint, warnings } = editor.extract();
  if (warnings.length) return setStatus(warnings.join(" "), true);

  const probes = resolveProbes(nodeOfPoint);
  if (probes.length === 0) {
    return setStatus("Add a voltage probe (PROBE tool) to choose what to plot.", true);
  }

  const tStop = parseValue(document.getElementById("tran-tstop").value);
  const dtRaw = document.getElementById("tran-dt").value.trim();
  const dt = dtRaw ? parseValue(dtRaw) : tStop / 1000;
  if (Number.isNaN(tStop) || Number.isNaN(dt)) {
    return setStatus("Transient: can't parse stop time / time step.", true);
  }
  const method = document.getElementById("tran-method").value;

  try {
    const t0 = performance.now();
    const { t, voltages } = transientAnalysis(netlist, { tStop, dt, method });
    const ms = (performance.now() - t0).toFixed(0);
    showPlot(`Transient — ${method === "trap" ? "trapezoidal" : "backward Euler"}, ${t.length - 1} steps`);
    plot.setData(
      t,
      probes.map((p) => ({ label: p.label, color: p.color, data: voltages[p.node] })),
      { xUnit: "s", yUnit: "V" }
    );
    setStatus(`Transient solved in ${ms} ms.`);
  } catch (err) {
    setStatus(err.message, true);
  }
});

/* ---------------- run AC (wired in M4) ---------------- */

document.getElementById("btn-ac").addEventListener("click", () => {
  setStatus("AC sweep lands in milestone 4.", true);
});

/* ---------------- save / load / clear ---------------- */

document.getElementById("btn-save").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(editor.getState(), null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "circuit.json";
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus("Circuit downloaded as circuit.json.");
});

const fileInput = document.getElementById("file-input");
document.getElementById("btn-load").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  try {
    editor.loadState(JSON.parse(await file.text()));
    setStatus(`Loaded ${file.name}.`);
  } catch (err) {
    setStatus(`Could not load: ${err.message}`, true);
  }
  fileInput.value = "";
});

document.getElementById("btn-clear").addEventListener("click", () => {
  if (editor.components.length && !confirm("Clear the whole schematic?")) return;
  editor.clearAll();
  setStatus("Cleared.");
});

/* ---------------- examples (presets populated in M5) ---------------- */

const exampleSelect = document.getElementById("examples");
exampleSelect.addEventListener("change", async () => {
  const name = exampleSelect.value;
  if (!name) return;
  try {
    const resp = await fetch(`examples/${name}.json`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    editor.loadState(await resp.json());
    setStatus(`Loaded preset: ${name}.`);
  } catch (err) {
    setStatus(`Could not fetch preset (${err.message}). Serve over HTTP, not file://`, true);
  }
  exampleSelect.value = "";
});

/** The preset list is static — GitHub Pages can't list directories.
 *  Names must match files in examples/. */
const EXAMPLES = ["voltage-divider", "rc-lowpass"];
for (const n of EXAMPLES) {
  const opt = document.createElement("option");
  opt.value = n;
  opt.textContent = n.replaceAll("-", " ");
  exampleSelect.appendChild(opt);
}

/* ---------------- shareable URLs ---------------- */

// ?load=<preset-name> opens a preset directly; &run=dc|tran|ac also solves
// it on load. Handy for sharing links ("look at this circuit").
const params = new URLSearchParams(location.search);
if (params.get("load")) {
  (async () => {
    try {
      const resp = await fetch(`examples/${params.get("load")}.json`);
      editor.loadState(await resp.json());
      setStatus(`Loaded preset: ${params.get("load")}.`);
      const runBtn = { dc: "btn-dc", tran: "btn-tran", ac: "btn-ac" }[params.get("run")];
      if (runBtn) document.getElementById(runBtn).click();
    } catch (err) {
      setStatus(`Could not load preset: ${err.message}`, true);
    }
  })();
} else {
  setStatus("ready — place components, wire them up, hit Run DC");
}
