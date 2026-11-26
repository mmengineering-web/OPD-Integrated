// Upload page logic (Phase 4): history read, stage, load, undo. No DOM. The Supabase client is passed in, so this is tested with a fake.
// Everything goes through the etl_* functions of the site's own project. No table is read or written directly.

/** Report kinds the browser reader can do today. WKM and BM read a PDF; TMS reads the Excel Daily Production Report (step 4.4a). */
export const KIND_OF_SITE = { WKM: "wkm", BM: "bm", TMS: "tms" };
export const FILE_OF_KIND = { wkm: "pdf", bm: "pdf", tms: "xlsx" };
export const PAGE = 1000;                 // PostgREST returns at most 1000 rows per request: read in pages
const PARALLEL = 4;

/** Production projects this person can upload to: own site only, data_entry or above, and a reader that exists. */
export function uploadTargets(projects, access, projectAccess, canInput) {
  return projects
    .filter((p) => p.module === "production" && p.scope === "site" && KIND_OF_SITE[p.site])
    .map((p) => ({ project: p, a: projectAccess(access, p.id) }))
    .filter((x) => x.a.usable && canInput(x.a.role))
    .map((x) => ({ project: x.project, site: x.project.site, kind: KIND_OF_SITE[x.project.site], role: x.a.role }));
}

const iso = (d) => d.toISOString().slice(0, 10);
const utc = (y, m, d) => new Date(Date.UTC(y, m, d));
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

/**
 * Days of history the reader needs before the report day: from the start of the report year (running totals of a contractor that
 * was idle for weeks still come from its last row) with 20 days before that for a week crossing New Year, and never less than 45 days.
 */
export function historyWindow(reportDate) {
  const d = utc(+reportDate.slice(0, 4), +reportDate.slice(5, 7) - 1, +reportDate.slice(8, 10));
  const jan1 = utc(d.getUTCFullYear(), 0, 1);
  const lo = new Date(Math.min(addDays(jan1, -20).getTime(), addDays(d, -45).getTime()));
  return { from: iso(lo), before: iso(addDays(d, -1)), through: iso(d), calUntil: iso(addDays(d, 400)) };
}

async function rpcRows(client, fn, args) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client.rpc(fn, args).range(from, from + PAGE - 1);
    if (error) throw new Error(`${fn}: ${error.message}`);
    const rows = data || [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/**
 * Read the history the reader needs. Returns {table: rows[]}.
 * @param {(done: number, total: number, table: string) => void} [onProgress]
 * @param {{stockAll?: boolean}} [opts] stockAll (TMS): read the stock table through to the newest day, not only up to the day before the report
 */
export async function readHistory(client, reportDate, onProgress = () => {}, opts = {}) {
  const { data: sum, error } = await client.rpc("etl_history_summary");
  if (error) throw new Error(`etl_history_summary: ${error.message}`);
  const tables = (sum || []).map((s) => s.tbl);
  if (!tables.includes("tblRAWMNG")) throw new Error("This site has no history yet. The history must be loaded first (seed step).");
  const w = historyWindow(reportDate);
  const todo = tables.map((t) => ({
    t,
    // the barge list is a whole list (latest state), not a dated table: read all of it
    args: t === "tblRAWBARGE" ? { p_tbl: t, p_from: null, p_to: null }
      : t === "tblRAWSTOCK" && opts.stockAll    // TMS stock: also the report day and later, to tell new from same from changed
        ? { p_tbl: t, p_from: w.from, p_to: null }
        : { p_tbl: t, p_from: t.startsWith("tblRAW") || t === "tblCALENDAR" ? w.from : null, p_to: t === "tblCALENDAR" ? w.calUntil : t.startsWith("tblRAW") ? w.before : null },
  }));
  const hist = {}; let done = 0, i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const job = todo[i++];
      hist[job.t] = await rpcRows(client, "etl_history_read", job.args);
      onProgress(++done, todo.length, job.t);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, worker));
  return hist;
}

/** One table of the history from the start of the history window up to the report day (used by the ship updates, which run after the report is loaded). */
export async function readTable(client, table, reportDate) {
  const w = historyWindow(reportDate);
  return rpcRows(client, "etl_history_read", { p_tbl: table, p_from: w.from, p_to: w.through });
}

/**
 * Stage the result of "apply ship updates" as its own batch (kind ship-sync, site admin only). out = what the reader returned:
 * {rows (fact rows), raw: {tblRAWSHIP: rows}}. Returns the batch id; load it with load(). Undo works like any other batch.
 */
export async function stageShip(client, { site, reportDate, fileName, out }) {
  const { data: batch, error } = await client.rpc("etl_stage_ship", { p_site: site, p_report_date: reportDate, p_source_file: `ship updates after ${fileName}`, p_actual: out.rows });
  if (error) throw new Error(error.message.replace(/^ETL: /, ""));
  const r = await client.rpc("etl_stage_raw", { p_batch: batch, p_raw: out.raw });
  if (r.error) throw new Error(r.error.message.replace(/^ETL: /, ""));
  return { batch, rawRows: r.data };
}

/** Last day in the history, for "last loaded" on the page. */
export async function lastLoaded(client) {
  const { data, error } = await client.rpc("etl_history_summary");
  if (error) return null;
  const d = (data || []).filter((r) => r.tbl === "tblRAWMNG")[0];
  return d?.last_date ?? null;
}

export function logCounts(log) {
  const c = { ERROR: 0, WARN: 0, RECON: 0, INFO: 0 };
  for (const x of log || []) c[x.severity] = (c[x.severity] || 0) + 1;
  return c;
}

/** Rows the database refuses to take: section errors mean the report was only half read, so loading is blocked until the person looks. */
export function blockers(parsed) {
  const out = [];
  if (!parsed?.actual?.length && !parsed?.barge?.length) {   // a barging file alone has no day rows, only barge changes
    const st = parsed?.stock || [];
    out.push(st.length && st.every((x) => x.status === "same")
      ? "Nothing to load: the stock in this file is identical to the database."
      : "No rows were read from the report.");
  }
  for (const x of parsed?.log || []) if (x.severity === "ERROR") out.push(`${x.table || ""} ${x.message}`.trim());
  return out;
}

/** Send the parsed rows to staging. Returns the batch id. Nothing is written to a fact table here. */
export async function stage(client, { site, parsed, fileName, replacePlan = false }) {
  const plan = replacePlan && parsed.plan ? parsed.plan : null;
  const { data: batch, error } = await client.rpc("etl_stage", {
    p_site: site, p_report_date: parsed.report_date, p_kind: /\.docx$/i.test(String(fileName)) ? "docx" : /\.xlsx?$/i.test(String(fileName)) ? "xlsx" : "pdf", p_source_file: fileName,
    p_actual: parsed.actual, p_plan: plan ? plan.rows : [], p_sections: {}, p_issues: (parsed.log || []).slice(0, 500),
  });
  if (error) throw new Error(error.message.replace(/^ETL: /, ""));
  const r = await client.rpc("etl_stage_raw", { p_batch: batch, p_raw: plan ? { ...parsed.raw, ...plan.raw } : parsed.raw });
  if (r.error) throw new Error(r.error.message.replace(/^ETL: /, ""));
  let barge = 0;
  if (parsed.barge?.length) {
    const b = await client.rpc("etl_stage_barge", { p_batch: batch, p_rows: parsed.barge.map((x) => ({ si: x.si, hist: x.hist, fact: x.fact, old: x.old })) });
    if (b.error) throw new Error(b.error.message.replace(/^ETL: /, ""));
    barge = b.data;
  }
  return { batch, rawRows: r.data, bargeRows: barge };
}

export async function load(client, batch, { replacePlan = false } = {}) {
  const { data, error } = await client.rpc("etl_load", { p_batch: batch, p_replace_plan: replacePlan });
  if (error) throw new Error(error.message.replace(/^ETL: /, ""));
  return data;                                  // row_counts incl. target, actual_deleted, actual_inserted ...
}

export async function undo(client, batch) {
  const { data, error } = await client.rpc("etl_undo", { p_batch: batch });
  if (error) throw new Error(error.message.replace(/^ETL: /, ""));
  return data;
}

/** Portal rows versus what the desktop ETL has in prod_v2 for the same days. Counts by state: same, changed, only_portal, only_prod. */
export async function shadowDiff(client, batch) {
  const rows = await rpcRows(client, "etl_shadow_diff", { p_batch: batch });
  const counts = { same: 0, changed: 0, only_portal: 0, only_prod: 0 };
  for (const r of rows) counts[r.state] = (counts[r.state] || 0) + 1;
  return { counts, rows: rows.filter((r) => r.state !== "same") };
}

/** Barge rows the portal wrote versus the real fact_barge of the desktop ETL. Counts by state; rows lists what differs. */
export async function bargeDiff(client, batch) {
  const rows = await rpcRows(client, "etl_barge_diff", { p_batch: batch });
  const counts = { same: 0, changed: 0, only_portal: 0, only_prod: 0 };
  for (const r of rows) counts[r.state] = (counts[r.state] || 0) + 1;
  return { counts, rows: rows.filter((r) => r.state !== "same") };
}

/** Recent batches of this site, newest first (RLS limits this to people who can load). */
export async function recentBatches(client, limit = 8) {
  const { data, error } = await client.from("etl_batch").select("batch_id,report_date,status,target,source_file,created_at,loaded_at,row_counts")
    .order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}

// ---- Compare week (step 4.5) ---------------------------------------------------------------------------------------------------
// The portal writes to a safe copy while the desktop ETL keeps feeding prod_v2. For about two weeks both run on the same files, and each
// day is compared. Everything is computed on the server (etl_compare_*); the browser only asks and shows.

/** Clean days in a row needed before a site may go live (supabase/sql/etl_06_compare.sql uses the same default). */
export const NEED_CLEAN_DAYS = 10;

/** How a compared day reads on the page. pass = counts towards the clean days in a row. */
export const VERDICTS = {
  clean:     { label: "Clean",         pass: true,  tone: "success", help: "Every row matches the current process." },
  explained: { label: "Explained",     pass: true,  tone: "info",    help: "Rows only in the portal, and a site admin wrote why." },
  only_here: { label: "Needs a reason", pass: false, tone: "warning", help: "Rows exist only in the portal. A site admin must write why, or load again after the current process has the day." },
  different: { label: "Different",     pass: false, tone: "danger",  help: "A value differs, or rows exist only in the current process. Fix the cause and load the day again." },
  unchecked: { label: "Not checked",   pass: false, tone: "warning", help: "Loaded, but not compared yet. Press Check again." },
  unknown:   { label: "Nothing to compare", pass: false, tone: "warning", help: "No rows were compared, or the barge list could not be read." },
};
export const verdictOf = (v) => VERDICTS[v] || VERDICTS.unknown;

/** Compare a loaded test-mode batch with prod_v2 and store the result. Safe to repeat: use it again once the desktop has loaded the same day. */
export async function compareRecord(client, batch) {
  const { data, error } = await client.rpc("etl_compare_record", { p_batch: batch });
  if (error) throw new Error(error.message.replace(/^ETL: /, ""));
  return data;
}

/** The daily table, the clean days in a row and whether the site is ready. */
export async function compareStatus(client, need = NEED_CLEAN_DAYS) {
  const { data, error } = await client.rpc("etl_compare_status", { p_need: need });
  if (error) throw new Error(error.message.replace(/^ETL: /, ""));
  return data;
}

/**
 * Site admin only: write (or remove) the reason why rows exist only in the portal.
 * @param {string | null} [note] at least 10 characters when explained is true
 */
export async function compareExplain(client, batch, explained, note = null) {
  const { data, error } = await client.rpc("etl_compare_explain", { p_batch: batch, p_explained: explained, p_note: note });
  if (error) throw new Error(error.message.replace(/^ETL: /, ""));
  return data;
}

/** True when the error means etl_06_compare.sql has not been run in this project yet. */
export const compareMissing = (e) => /etl_compare_status|Could not find the function|does not exist|schema cache/i.test(String(e?.message ?? e));

// ---- Daily Report download (Phase 4.6) ----
/** Site production projects the person can read (any role, a usable login), one per site that has a reader. */
export function reportTargets(projects, access, projectAccess) {
  return projects
    .filter((p) => p.module === "production" && p.scope === "site" && KIND_OF_SITE[p.site])
    .filter((p) => projectAccess(access, p.id).usable)
    .map((p) => ({ project: p, site: p.site }));
}

/** Newest loaded day of one site (etl_report_data, read only). */
export async function reportData(client, date = null) {
  const { data, error } = await client.rpc("etl_report_data", { p_date: date });
  if (error) throw new Error(`etl_report_data: ${error.message}`);
  return data;
}

/** All reachable sites in parallel. A site that fails does not stop the others. Returns {sites: {WKM: raw}, failed: {BM: message}}. */
export async function reportAll(targets, makeClient, date = null) {
  const sites = {}, failed = {};
  await Promise.all(targets.map(async (t) => {
    try { sites[t.site] = await reportData(makeClient(t.project), date); }
    catch (e) { failed[t.site] = /Could not find the function|does not exist|schema cache/i.test(String(e?.message)) ? "report reader not installed on this project" : String(e?.message ?? e); }
  }));
  return { sites, failed };
}

// ---- Interactive dashboard (Phase 4.7) ----
/** One site, one date range (etl_dash_data, read only, at most 400 days). */
export async function dashData(client, from, to) {
  const { data, error } = await client.rpc("etl_dash_data", { p_from: from, p_to: to });
  if (error) throw new Error(`etl_dash_data: ${error.message}`);
  return data;
}

/** The chosen sites in parallel. A site that fails does not stop the others. Returns {sites: {WKM: raw}, failed: {BM: message}}. */
export async function dashAll(targets, makeClient, from, to) {
  const sites = {}, failed = {};
  await Promise.all(targets.map(async (t) => {
    try { sites[t.site] = await dashData(makeClient(t.project), from, to); }
    catch (e) { failed[t.site] = /Could not find the function|does not exist|schema cache/i.test(String(e?.message)) ? "dashboard reader not installed on this project (run etl_08_dashboard.sql)" : String(e?.message ?? e); }
  }));
  return { sites, failed };
}
