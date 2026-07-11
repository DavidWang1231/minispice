/**
 * main.js — application bootstrap and event wiring.
 *
 * This is the ONLY file that talks to both worlds: it pulls a netlist out
 * of the editor (geometry side) and feeds it to the engine (math side),
 * then routes results back into the editor/plots for display. Keeping the
 * marshalling here means editor and engine stay import-independent.
 */

import { SchematicEditor } from "./editor/schematic.js";
import { parseValue, formatValue } from "./editor/components.js";
import { dcOperatingPoint } from "./engine/dc.js";

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

/* ---------------- transient & AC (wired in M3/M4) ---------------- */

document.getElementById("btn-tran").addEventListener("click", () => {
  setStatus("Transient analysis lands in milestone 3.", true);
});
document.getElementById("btn-ac").addEventListener("click", () => {
  setStatus("AC sweep lands in milestone 4.", true);
});
document.getElementById("btn-close-plot").addEventListener("click", () => {
  document.getElementById("plot-panel").hidden = true;
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
const EXAMPLES = ["voltage-divider"];
for (const n of EXAMPLES) {
  const opt = document.createElement("option");
  opt.value = n;
  opt.textContent = n.replaceAll("-", " ");
  exampleSelect.appendChild(opt);
}

/* ---------------- shareable URLs ---------------- */

// ?load=<preset-name> opens a preset directly; &run=dc solves it on load.
// Handy for sharing links ("look at this circuit") and for screenshots.
const params = new URLSearchParams(location.search);
if (params.get("load")) {
  (async () => {
    try {
      const resp = await fetch(`examples/${params.get("load")}.json`);
      editor.loadState(await resp.json());
      setStatus(`Loaded preset: ${params.get("load")}.`);
      if (params.get("run") === "dc") document.getElementById("btn-dc").click();
    } catch (err) {
      setStatus(`Could not load preset: ${err.message}`, true);
    }
  })();
} else {
  setStatus("ready — place components, wire them up, hit Run DC");
}
