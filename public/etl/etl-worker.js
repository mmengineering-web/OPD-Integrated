/* Web worker of the Upload page (One Portal Data, Phase 4).
   Runs the report reader in Pyodide (CPython compiled to WebAssembly). The PDF the person picks is written to the
   worker's in-memory file system and is read here; it is never sent anywhere. Only the parsed rows go to the site database,
   and only when the person presses Load. The original file is not kept.

   Messages in : {type:"init", base, version}
                 {type:"peek",  id, kind, bytes, name}      kind "tms" = an Excel file (.xlsx); the others are PDF
                 {type:"parse", id, kind, bytes, history, name}      history = {table: [row, ...]} read from etl_history_read
   Messages out: {type:"status", msg} {type:"ready"} {type:"result", id, data} {type:"error", id, message} */
"use strict";
const PYODIDE_VERSIONS = ["0.27.2", "0.26.4"];     // first one that loads is used (0.26.4 ships the same package names)
const PACKAGES = ["numpy", "pandas", "cryptography", "pillow", "charset-normalizer"];
let py = null, wp = null, base = "", version = "0", ready = null;
const cache = {};

const status = (msg) => postMessage({ type: "status", msg });

function friendly(err) {
  // a Python exception arrives as a whole traceback: keep its last line
  const lines = String((err && err.message) || err).trim().split("\n");
  return lines[lines.length - 1].replace(/^(ValueError|KeyError|RuntimeError|Exception|PythonError|AttributeError|TypeError): /, "");
}

async function loadRuntime() {
  let last = null;
  for (const v of PYODIDE_VERSIONS) {
    const index = `https://cdn.jsdelivr.net/pyodide/v${v}/full/`;
    try {
      importScripts(index + "pyodide.js");
      return await loadPyodide({ indexURL: index });
    } catch (e) { last = e; }
  }
  throw new Error("Could not load the Python runtime from cdn.jsdelivr.net (" + ((last && last.message) || last) +
                  "). Check the internet connection, or ask IT to allow cdn.jsdelivr.net.");
}

async function get(path, type) {
  const r = await fetch(new URL(path + "?v=" + version, base).href);
  if (!r.ok) throw new Error(`could not load ${path} (${r.status})`);
  return type === "text" ? r.text() : r.arrayBuffer();
}

async function init(msg) {
  base = msg.base; version = msg.version || "0";
  const manifest = JSON.parse(await get("manifest.json", "text"));
  status("Loading the Python runtime (about 10 MB the first time, then kept by the browser) ...");
  py = await loadRuntime();
  status("Loading the data and PDF libraries (about 25 MB the first time) ...");
  await py.loadPackage(PACKAGES);
  // pure-Python wheels that ship with this page are unpacked straight into site-packages (no micropip, no network)
  for (const w of manifest.wheels) py.unpackArchive(new Uint8Array(await get("wheels/" + w, "buf")), "wheel");
  py.FS.mkdirTree("/etl");
  for (const f of manifest.python) py.FS.writeFile("/etl/" + f, await get("py/" + f, "text"));
  // pdfplumber only needs pypdfium2 to draw page images, which this page never does
  py.runPython("import sys, types\nsys.path.insert(0, '/etl')\nsys.modules.setdefault('pypdfium2', types.ModuleType('pypdfium2'))");
  wp = py.pyimport("web_parse");
  status("Ready.");
}

const text = async (p) => (cache[p] = cache[p] || await get(p, "text"));

// TMS reads Excel and Word files: Word needs python-docx (a small pure-Python wheel) and lxml (from the Pyodide set). Loaded once, only for TMS.
let tmsReady = null;
function needTms() {
  if (!tmsReady) tmsReady = (async () => {
    status("Loading the Word / Excel libraries for TMS ...");
    await py.loadPackage(["lxml", "typing-extensions"]);
    py.unpackArchive(new Uint8Array(await get("wheels/python_docx-1.2.0-py3-none-any.whl", "buf")), "wheel");
  })();
  return tmsReady;
}

async function run(msg) {
  if (msg.type === "ship") {      // no PDF: apply ship updates to the stored SHIP days
    const cfg = await text(`config/config_${msg.kind}.json`), schema = await text(`config/schema_${msg.kind}.json`);
    return wp.ship(msg.kind, cfg, schema, JSON.stringify(msg.history || {}), JSON.stringify(msg.entries || []), msg.stamp);
  }
  if (msg.kind === "tms") await needTms();
  const pdf = `/report_${msg.id}.${msg.kind === "tms" ? "xlsx" : "pdf"}`;
  py.FS.writeFile(pdf, new Uint8Array(msg.bytes));
  try {
    if (msg.type === "peek") return msg.kind === "tms" ? wp.peek(msg.kind, pdf, await text(`config/config_tms.json`), msg.name || "") : wp.peek(msg.kind, pdf);
    const cfg = await text(`config/config_${msg.kind}.json`), schema = await text(`config/schema_${msg.kind}.json`);
    return wp.parse(msg.kind, pdf, cfg, schema, JSON.stringify(msg.history || {}), msg.name || "");
  } finally {
    try { py.FS.unlink(pdf); } catch (e) { /* already gone */ }
  }
}

onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      ready = init(msg);
      await ready;
      postMessage({ type: "ready" });
      return;
    }
    await ready;
    const data = await run(msg);
    postMessage({ type: "result", id: msg.id, data });
  } catch (err) {
    postMessage({ type: "error", id: msg.id, message: friendly(err) });
  }
};
