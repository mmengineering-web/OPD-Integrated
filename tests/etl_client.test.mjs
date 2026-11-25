// Upload page logic with a fake Supabase client: who may upload, history window, paging, blockers.
import assert from "node:assert/strict";
import * as C from "../src/lib/opd/etl-client.js";
import { projectAccess, canInput } from "../src/lib/opd/auth-core.js";

const P = [
  { id: "wkm-prod", module: "production", scope: "site", site: "WKM" }, { id: "bm-prod", module: "production", scope: "site", site: "BM" },
  { id: "tms-prod", module: "production", scope: "site", site: "TMS" }, { id: "hub-prod", module: "production", scope: "ho" },
  { id: "wkm-explo", module: "exploration", scope: "site", site: "WKM" },
];
const acc = (o) => ({ ok: true, projects: Object.fromEntries(Object.entries(o).map(([id, role]) => [id, { id, state: "ok", role }])) });
const ids = (a) => C.uploadTargets(P, a, projectAccess, canInput).map((t) => t.site).join(",");
assert.equal(ids(acc({ "wkm-prod": "data_entry" })), "WKM");
assert.equal(ids(acc({ "wkm-prod": "viewer", "bm-prod": "site_admin" })), "BM", "viewer cannot upload");
assert.equal(ids(acc({ "tms-prod": "super_admin" })), "TMS", "TMS reads the Excel report (4.4a)");
assert.equal(C.FILE_OF_KIND.tms, "xlsx");
assert.equal(ids(acc({ "hub-prod": "super_admin" })), "", "head office login alone is not a site");
assert.equal(ids(acc({ "wkm-explo": "data_entry" })), "", "exploration role does not count");

assert.deepEqual(C.historyWindow("2026-11-19"), { from: "2025-12-12", before: "2026-11-18", through: "2026-11-19", calUntil: "2027-12-24" });
assert.deepEqual(C.historyWindow("2026-01-05"), { from: "2025-11-21", before: "2026-01-04", through: "2026-01-05", calUntil: "2027-02-09" }, "early January reaches back 45 days");

assert.deepEqual(C.logCounts([{ severity: "WARN" }, { severity: "WARN" }, { severity: "ERROR" }]), { ERROR: 1, WARN: 2, RECON: 0, INFO: 0 });
assert.equal(C.blockers({ actual: [], log: [] }).length, 1);
assert.equal(C.blockers({ actual: [{}], log: [{ severity: "WARN", message: "x" }] }).length, 0);
assert.match(C.blockers({ actual: [], log: [], stock: [{ status: "same" }] })[0], /identical to the database/);
assert.equal(C.blockers({ actual: [{}], stock: [{ status: "changed" }], log: [] }).length, 0);
assert.match(C.blockers({ actual: [{}], log: [{ severity: "ERROR", table: "tblRAWMNG", message: "section not read" }] })[0], /section not read/);

// paging: 2,350 rows come back in 3 pages, and each table gets its own window
const calls = [];
const table = { tblRAWMNG: 2350, tblCALENDAR: 10, tblIDPIT: 3, tblRAWBARGE: 5 };
const client = { rpc: (fn, args) => {
  const b = { range: (a, z) => { calls.push([fn, args?.p_tbl, args?.p_from, args?.p_to, a]); const n = table[args.p_tbl]; return Promise.resolve({ data: Array.from({ length: Math.max(0, Math.min(z + 1, n) - a) }, (_, i) => ({ i: a + i })), error: null }); },
    then: (r) => r({ data: Object.keys(table).map((tbl) => ({ tbl, rows: table[tbl] })), error: null }) };
  return b; } };
const h = await C.readHistory(client, "2026-11-19");
assert.equal(h.tblRAWMNG.length, 2350); assert.equal(calls.filter((c) => c[1] === "tblRAWMNG").length, 3);
const w = (t) => calls.find((c) => c[1] === t);
assert.deepEqual(w("tblRAWMNG").slice(2, 4), ["2025-12-12", "2026-11-18"], "raw tables stop the day before the report");
table.tblRAWSTOCK = 4; calls.length = 0;
await C.readHistory(client, "2026-11-19");
assert.deepEqual(w("tblRAWSTOCK").slice(2, 4), ["2025-12-12", "2026-11-18"], "stock stops the day before the report for WKM and BM");
calls.length = 0;
await C.readHistory(client, "2026-11-19", () => {}, { stockAll: true });
assert.deepEqual(w("tblRAWSTOCK").slice(2, 4), ["2025-12-12", null], "TMS stock is read through the newest day (same-day compare)");
assert.deepEqual(w("tblCALENDAR").slice(2, 4), ["2025-12-12", "2027-12-24"], "the calendar is read about 400 days ahead (the plan is written for the whole year)");
assert.deepEqual(w("tblIDPIT").slice(2, 4), [null, null], "vocabulary lists are read whole");
await assert.rejects(C.readHistory({ rpc: () => ({ then: (r) => r({ data: [], error: null }) }) }, "2026-11-19"), /no history/);
// stage: plan and calendar rows are sent only when the plan is to be replaced; load passes the flag
const sent = [];
const sc = { rpc: (fn, args) => { sent.push([fn, args]); return Promise.resolve({ data: fn === "etl_stage" ? "B1" : fn === "etl_stage_barge" ? 2 : 5, error: null }); } };
const pr = { report_date: "2026-11-19", site: "S", actual: [{}], raw: { tblRAWMNG: [{ DATE: "2026-11-19" }] }, log: [],
  barge: [{ si: "1", hist: {}, fact: {}, old: null }], plan: { rows: [{ metric: "DAY" }], raw: { tblCALENDAR: [{ DATE: "2026-11-19" }] } } };
await C.stage(sc, { site: "S", parsed: pr, fileName: "f.pdf" });
assert.deepEqual(sent.find((x) => x[0] === "etl_stage")[1].p_plan, [], "no plan rows without the admin choice");
assert.deepEqual(Object.keys(sent.find((x) => x[0] === "etl_stage_raw")[1].p_raw), ["tblRAWMNG"]);
assert.equal(sent.find((x) => x[0] === "etl_stage_barge")[1].p_rows.length, 1);
sent.length = 0;
await C.stage(sc, { site: "S", parsed: pr, fileName: "f.pdf", replacePlan: true });
assert.equal(sent.find((x) => x[0] === "etl_stage")[1].p_plan.length, 1);
assert.deepEqual(Object.keys(sent.find((x) => x[0] === "etl_stage_raw")[1].p_raw), ["tblRAWMNG", "tblCALENDAR"]);
sent.length = 0; await C.load(sc, "B1", { replacePlan: true }); assert.equal(sent[0][1].p_replace_plan, true);
sent.length = 0; await C.load(sc, "B1"); assert.equal(sent[0][1].p_replace_plan, false);
console.log("etl_client: ok");
