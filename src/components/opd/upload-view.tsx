"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileText, Loader2, RotateCcw, ShieldCheck, Undo2, UploadCloud, XCircle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Breadcrumb } from "@/components/opd/breadcrumb";
import { CompareWeek } from "@/components/opd/compare-week";
import { AppFrame, PageHead, type Access } from "@/components/opd/app-frame";
import { PROJECTS } from "@/lib/opd/config.js";
import { projectAccess, canInput, ROLE_LABEL } from "@/lib/opd/auth-core.js";
import { makeClient } from "@/lib/opd/session.js";
import * as ETL from "@/lib/opd/etl-client.js";

/* Upload page (Phase 4). The PDF is read in this browser (Pyodide in a web worker). Only parsed rows go to the site database,
   and only after the person presses Load. The original file is not kept. */

type Row = { date: string; pit: string | null; contractor: string | null; shift: string | null; category: string; metric_group: string; metric: string; value: number | null; text_value: string | null };
type Issue = { severity: string; date?: string; table?: string; check?: string; message: string; pdf_value?: number | null; master_value?: number | null; diff?: number | null };
type BargeRow = { si: string; hist: Record<string, unknown>; old: Record<string, unknown> | null };
type StockItem = { contractor: string; date: string; last_db_date: string | null; status: "new" | "changed" | "same"; changes: { col: string; old: number | null; new: number | null }[]; total: number; old_total: number | null; gap_days: number | null; loaded: boolean };
type PlanChange = { contractor: string; column: string; old: number | null; new: number; from: string; to: string; days: number };
type ShipUpdate = { decision: string; kind: string; date: string; contractor: string; old: number | null; new: number | null; diff: number | null; caused_by: string | null };
type ShipCmp = { date: string; contractor: string; old: Record<string, number>; now: Record<string, number> };
const SHIP_COLS = ["DAY", "WTD", "MTD", "YTD"] as const;
type ShipOut = { rows: unknown[]; raw: Record<string, unknown[]>; changes: { date: string; contractor: string; old: number | null; new: number }[]; skipped: { DATE: string; CONTRACTOR: string; reason: string }[]; days: string[] };
type Parsed = { cons_new?: string[]; cons_choices?: string[]; ship_updates?: ShipUpdate[]; report_date: string; site: string; actual: Row[]; raw: Record<string, unknown[]>; barge?: BargeRow[]; stock?: StockItem[]; plan?: { changes: PlanChange[]; days: string[]; groups: string[]; rows: unknown[]; raw: Record<string, unknown[]> } | null; log: Issue[]; summary: { rows: number; by_category: Record<string, number> } };
type Target = { project: { id: string; site: string }; site: string; kind: string; role: string };
type LoadResult = { target?: string; actual_inserted?: number; actual_deleted?: number };
type Diff = { counts: { same: number; changed: number; only_portal: number; only_prod: number } };
type Batch = { batch_id: string; report_date: string; status: string; target: string | null; source_file: string | null };
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));
type Phase = "idle" | "starting" | "history" | "reading" | "parsed" | "loading" | "loaded" | "undone" | "queued" | "bulk" | "bulkdone";
type QState = "wait" | "reading" | "loading" | "loaded" | "blocked" | "failed" | "skipped";
type QItem = { key: string; file: File; date: string; state: QState; msg?: string; rows?: number; warn?: number; batch?: string; newCons?: number };
const Q_LABEL: Record<QState, string> = { wait: "Waiting", reading: "Reading", loading: "Loading", loaded: "Loaded", blocked: "Blocked", failed: "Failed", skipped: "Not run" };

const fmtDate = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const cell = (v: unknown) => (v == null || v === "" ? "–" : typeof v === "number" ? (Math.round(v * 100) / 100).toLocaleString("en-US") : String(v));
const num = (v: number | null | undefined) => (v == null ? "" : Math.abs(v) >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(Math.round(v * 1000) / 1000));
const SEV: Record<string, { label: string; cls: string }> = {
  ERROR: { label: "Error", cls: "border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger)]" },
  WARN: { label: "Warning", cls: "border-[var(--warning-border)] bg-[var(--warning-bg)] text-[var(--warning)]" },
  RECON: { label: "Check", cls: "border-[var(--info-border)] bg-[var(--info-bg)] text-[var(--info)]" },
  INFO: { label: "Note", cls: "bg-muted text-muted-foreground" },
};

function useReader() {
  const worker = useRef<Worker | null>(null);
  const pending = useRef(new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>());
  const ready = useRef<Promise<void> | null>(null);
  const seq = useRef(0);
  const [status, setStatus] = useState("");

  const start = useCallback(() => {
    if (ready.current) return ready.current;
    ready.current = (async () => {
      const m = await (await fetch("/etl/manifest.json", { cache: "no-cache" })).json();
      const w = new Worker(`/etl/etl-worker.js?v=${m.version}`);
      worker.current = w;
      await new Promise<void>((ok, fail) => {
        w.onmessage = (e) => {
          const d = e.data;
          if (d.type === "status") setStatus(d.msg);
          else if (d.type === "ready") ok();
          else if (d.type === "result") pending.current.get(d.id)?.ok(JSON.parse(d.data));
          else if (d.type === "error") (d.id ? pending.current.get(d.id)?.fail : fail)?.(new Error(d.message));
        };
        w.onerror = (e) => fail(new Error(e.message || "The reader could not start."));
        w.postMessage({ type: "init", base: location.origin + "/etl/", version: m.version });
      });
    })().catch((e) => { ready.current = null; worker.current?.terminate(); worker.current = null; throw e; });
    return ready.current;
  }, []);

  const ask = useCallback(async <T,>(msg: Record<string, unknown>): Promise<T> => {
    await start();
    const id = ++seq.current;
    return new Promise<T>((ok, fail) => { pending.current.set(id, { ok: ok as (v: unknown) => void, fail }); worker.current!.postMessage({ ...msg, id }); }).finally(() => pending.current.delete(id));
  }, [start]);

  useEffect(() => () => { worker.current?.terminate(); }, []);
  return { start, ask, status };
}

/** The three stages of reading one file, with the one that is running animated. */
function Steps({ phase, hist, note }: { phase: Phase; hist: { done: number; total: number }; note?: string }) {
  const order = ["starting", "history", "reading", "loading"];
  const at = order.indexOf(phase);
  const rows = [["starting", "Starting the reader"], ["history", hist.total ? `Reading the site history (${hist.done}/${hist.total})` : "Reading the site history"], ["reading", "Reading the report and working out totals"]];
  const pct = phase === "history" && hist.total ? Math.round((hist.done / hist.total) * 100) : phase === "reading" ? 92 : phase === "starting" ? 8 : 100;
  return (
    <div className="w-full max-w-[34rem] text-left" role="status" aria-live="polite">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${pct}%` }} /></div>
      <ul className="mt-3 space-y-1.5 text-sm">
        {rows.map(([k, label], i) => (
          <li key={k} className={`flex items-center gap-2 ${i === at ? "font-medium" : i < at ? "text-muted-foreground" : "text-muted-foreground/60"}`}>
            {i < at ? <CheckCircle2 className="size-4 text-[var(--success)]" aria-hidden /> : i === at ? <Loader2 className="size-4 animate-spin text-brand" aria-hidden /> : <span className="size-4 rounded-full border" aria-hidden />}{label}
          </li>
        ))}
      </ul>
      {note && <p className="mt-2 text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return <div className="rounded-lg border bg-card px-3 py-2"><div className="text-xs text-muted-foreground">{label}</div><div className={`mt-0.5 text-lg font-semibold tabular-nums ${tone ?? ""}`}>{value}</div></div>;
}

function View({ access }: { access: Access }) {
  const targets: Target[] = useMemo(() => ETL.uploadTargets(PROJECTS, access, projectAccess, canInput), [access]);
  const [ti, setTi] = useState(0);
  const t = targets[ti];
  const client = useMemo(() => (t ? makeClient(t.project) : null), [t]);
  const reader = useReader();
  const [phase, setPhase] = useState<Phase>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hist, setHist] = useState({ done: 0, total: 0 });
  const [last, setLast] = useState<string | null>(null);
  const [batch, setBatch] = useState<string | null>(null);
  const [result, setResult] = useState<LoadResult | null>(null);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [bdiff, setBdiff] = useState<Diff | null>(null);
  const [replacePlan, setReplacePlan] = useState(false);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [shipBatch, setShipBatch] = useState<string | null>(null);
  const [shipMsg, setShipMsg] = useState<string | null>(null);
  const [shipBusy, setShipBusy] = useState(false);
  const [shipCmp, setShipCmp] = useState<ShipCmp[]>([]);
  const [recent, setRecent] = useState<Batch[]>([]);
  const [cat, setCat] = useState<string>("");
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(150);
  const [sev, setSev] = useState<Record<string, boolean>>({ ERROR: true, WARN: true, RECON: false, INFO: false });
  const [drag, setDrag] = useState(false);
  const [consPick, setConsPick] = useState<Record<string, string>>({});
  const [queue, setQueue] = useState<QItem[]>([]);
  const stopBulk = useRef(false);
  const busy = ["starting", "history", "reading", "loading", "bulk"].includes(phase);

  const [tick, setTick] = useState(0);
  const refresh = () => setTick((n) => n + 1);
  useEffect(() => {
    if (!client) return;
    let live = true;
    (async () => {
      try {
        const [d, b] = await Promise.all([ETL.lastLoaded(client), ETL.recentBatches(client)]);
        if (live) { setLast(d); setRecent(b); }
      } catch { /* the page still works without this list */ }
    })();
    return () => { live = false; };
  }, [client, tick]);

  const reset = () => { setQueue([]); setConsPick({}); setPhase("idle"); setFile(null); setParsed(null); setError(null); setBatch(null); setResult(null); setDiff(null); setBdiff(null); setReplacePlan(false); setTicked({}); setShipBatch(null); setShipMsg(null); setShipCmp([]); setCat(""); setQ(""); setShown(150); };

  const okName = (f: File) => (t?.kind === "tms" ? /\.(xlsx|docx)$/i.test(f.name) : /\.pdf$/i.test(f.name));
  const badName = () => (t?.kind === "tms" ? "Choose a TMS report: the Daily Production Report, the barging file or the stock register (.xlsx), or the inspection report (.docx)." : "Choose the Daily Report as a PDF file.");

  /** Peek the day, read the site history and parse one file. The history is read again for every file, so a day always sees the days loaded before it. */
  async function readOne(f: File, report?: (p: Phase) => void): Promise<Parsed> {
    const bytes = await f.arrayBuffer();
    const pk = await reader.ask<{ report_date: string }>({ type: "peek", kind: t!.kind, bytes: bytes.slice(0), name: f.name });
    report?.("history"); setHist({ done: 0, total: 0 });
    const history = await ETL.readHistory(client!, pk.report_date, (done: number, total: number) => setHist({ done, total }), { stockAll: t!.kind === "tms" });
    report?.("reading");
    return reader.ask<Parsed>({ type: "parse", kind: t!.kind, bytes, history, name: f.name });
  }

  async function pick(list: FileList | File[] | null | undefined) {
    const files = Array.from(list ?? []);
    if (!files.length || !t || !client) return;
    reset();
    if (files.some((f) => !okName(f))) { setError(badName()); return; }
    if (files.length > 1) return pickMany(files);
    const f = files[0]; setFile(f);
    try {
      setPhase("starting");
      const out = await readOne(f, setPhase);
      setTicked(Object.fromEntries((out.ship_updates ?? []).map((u) => [`${u.date}|${u.contractor}`, u.decision === "Apply"])));
      setParsed(out); setCat(Object.keys(out.summary.by_category).sort()[0] ?? ""); setPhase("parsed");
    } catch (e) { setError(why(e)); setPhase("idle"); }
  }

  /** Several files: read the day of each, line them up oldest first and wait for one press of Load. */
  async function pickMany(files: File[]) {
    try {
      setPhase("starting");
      const dated: QItem[] = [];
      for (const f of files) {
        const pk = await reader.ask<{ report_date: string }>({ type: "peek", kind: t!.kind, bytes: (await f.arrayBuffer()), name: f.name });
        dated.push({ key: `${f.name}|${f.size}|${dated.length}`, file: f, date: pk.report_date, state: "wait" });
      }
      dated.sort((x, y) => x.date.localeCompare(y.date) || x.file.name.localeCompare(y.file.name));
      setQueue(dated); setPhase("queued");
    } catch (e) { setError(why(e)); setPhase("idle"); }
  }

  /** Load the queue in date order. A day that cannot load stops the run, because the later days build on it. */
  async function runBulk() {
    if (!client || !t) return;
    stopBulk.current = false; setError(null); setPhase("bulk");
    const patch = (key: string, p: Partial<QItem>) => setQueue((q) => q.map((x) => (x.key === key ? { ...x, ...p } : x)));
    let halted = false;
    for (const it of queue) {
      if (halted || stopBulk.current) { patch(it.key, { state: "skipped" }); continue; }
      try {
        patch(it.key, { state: "reading", msg: "Reading the report" });
        const out = await readOne(it.file, (p) => patch(it.key, { msg: p === "history" ? "Reading the site history" : "Working out the totals" }));
        const c = ETL.logCounts(out.log); const bl = ETL.blockers(out);
        if (bl.length) { patch(it.key, { state: "blocked", msg: bl[0], warn: c.WARN }); halted = true; continue; }
        patch(it.key, { state: "loading", msg: "Writing the rows", warn: c.WARN, rows: out.summary.rows, newCons: out.cons_new?.length });
        const st = await ETL.stage(client, { site: out.site, parsed: out, fileName: it.file.name, replacePlan: false });
        const res = await ETL.load(client, st.batch, { replacePlan: false });
        if (res.target === "shadow") await ETL.compareRecord(client, st.batch).catch(() => null);
        patch(it.key, { state: "loaded", msg: undefined, batch: st.batch });
      } catch (e) { patch(it.key, { state: "failed", msg: why(e) }); halted = true; }
    }
    setPhase("bulkdone"); refresh();
  }

  /** A construction item that is new has no category yet: the person picks one, and the rows to load carry it. "" keeps the master's blank "-". */
  function pickCons(item: string, category: string) {
    setConsPick((c) => ({ ...c, [item]: category }));
    setParsed((p) => p && {
      ...p,
      actual: p.actual.map((r) => (r.category === "CONS" && r.metric === item ? { ...r, metric_group: category || "-" } : r)),
      raw: { ...p.raw, tblRAWCONS: (p.raw.tblRAWCONS ?? []).map((r) => { const x = r as Record<string, unknown>; return x["CONSTRUCTION ITEM"] === item ? { ...x, CONSCATEGORY: category || null } : r; }) },
    });
  }

  async function doLoad() {
    if (!parsed || !file || !client) return;
    try {
      setPhase("loading"); setError(null);
      const withPlan = replacePlan && !!parsed.plan && canReplace;
      const st = await ETL.stage(client, { site: parsed.site, parsed, fileName: file.name, replacePlan: withPlan });
      const res = await ETL.load(client, st.batch, { replacePlan: withPlan });
      setBatch(st.batch); setResult(res); setPhase("loaded");
      if (res.target === "shadow") {
        await ETL.compareRecord(client, st.batch).catch(() => null);   // stored on the server for the compare week; the load itself is already done
        setDiff((await ETL.shadowDiff(client, st.batch).catch(() => null)) as Diff | null);
        if (st.bargeRows) setBdiff((await ETL.bargeDiff(client, st.batch).catch(() => null)) as Diff | null);
      }
      refresh();
    } catch (e) { setError(why(e)); setPhase("parsed"); }
  }

  async function doShip() {
    if (!parsed || !file || !client || !t) return;
    const entries = (parsed.ship_updates ?? []).filter((u) => ticked[`${u.date}|${u.contractor}`]).map((u) => ({ date: u.date, contractor: u.contractor, new: u.new }));
    if (!entries.length) return;
    try {
      setShipBusy(true); setError(null); setShipMsg(null);
      const history = { tblRAWSHIP: await ETL.readTable(client, "tblRAWSHIP", parsed.report_date) };
      const out = await reader.ask<ShipOut>({ type: "ship", kind: t.kind, history, entries, stamp: parsed.report_date });
      if (!out.rows.length) { setShipMsg(out.skipped.length ? `Nothing applied: ${out.skipped[0].reason} (${out.skipped[0].DATE} ${out.skipped[0].CONTRACTOR}).` : "Nothing to change: the stored values already match."); return; }
      const oldBy = new Map((history.tblRAWSHIP as Record<string, unknown>[]).map((r) => [`${String(r.DATE).slice(0, 10)}|${r.CONTRACTOR}`, r]));
      const cmp: ShipCmp[] = [];
      for (const r of out.raw.tblRAWSHIP as Record<string, unknown>[]) {
        const o = oldBy.get(`${String(r.DATE).slice(0, 10)}|${r.CONTRACTOR}`);
        if (!o) continue;
        const pick = (x: Record<string, unknown>) => Object.fromEntries(SHIP_COLS.map((c) => [c, Number(x[c] ?? 0)]));
        const a = pick(o), b = pick(r);
        if (SHIP_COLS.some((c) => Math.abs(a[c] - b[c]) > 0.000001)) cmp.push({ date: String(r.DATE).slice(0, 10), contractor: String(r.CONTRACTOR), old: a, now: b });
      }
      cmp.sort((x, y) => x.date.localeCompare(y.date) || x.contractor.localeCompare(y.contractor));
      setShipCmp(cmp);
      const st = await ETL.stageShip(client, { site: parsed.site, reportDate: parsed.report_date, fileName: file.name, out });
      await ETL.load(client, st.batch);
      setShipBatch(st.batch); refresh();
      setShipMsg(`Applied ${out.changes.length} ship update${out.changes.length > 1 ? "s" : ""}; ${out.days.length} day${out.days.length > 1 ? "s" : ""} recalculated${out.skipped.length ? `, ${out.skipped.length} skipped` : ""}.`);
    } catch (e) { setError(why(e)); } finally { setShipBusy(false); }
  }

  async function doUndo(id: string): Promise<boolean> {
    if (!client || !confirm("Undo this load? The rows it wrote are removed and the previous rows are put back.")) return false;
    try { setError(null); await ETL.undo(client, id); if (id === batch) setPhase("undone"); refresh(); return true; }
    catch (e) { setError(why(e)); return false; }
  }

  const canReplace = t?.role === "site_admin" || t?.role === "super_admin";
  const counts = useMemo(() => ETL.logCounts(parsed?.log), [parsed]);
  const blocked = useMemo(() => (parsed ? ETL.blockers(parsed) : []), [parsed]);
  const cats = useMemo(() => Object.entries(parsed?.summary.by_category ?? {}).sort(), [parsed]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (parsed?.actual ?? []).filter((r) => r.category === cat && (!needle || `${r.contractor} ${r.pit} ${r.metric_group} ${r.metric}`.toLowerCase().includes(needle)));
  }, [parsed, cat, q]);
  const issues = useMemo(() => (parsed?.log ?? []).filter((x) => sev[x.severity]), [parsed, sev]);
  const gap = parsed && last && parsed.report_date > last ? Math.round((Date.parse(parsed.report_date) - Date.parse(last)) / 86400000) : 0;

  if (!t) return <Card className="p-5 text-sm text-muted-foreground">No site you can upload to. Uploads need a Data entry, Site admin or Super admin account on WKM, BM or TMS.</Card>;

  return (
    <>
      <Breadcrumb className="mb-4" items={[{ label: "Home", href: "/" }, { label: "Production", href: "/production/" }, { label: "Uploads" }]} />
      <PageHead title="Uploads" tag="Daily report" lead={`Drop the ${t.kind === "tms" ? "TMS report (Excel or Word)" : "Daily Report PDF"}. Your browser reads it and checks it. Nothing is saved until you press Load, and a load can be undone.`} />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        {targets.length > 1 ? targets.map((x, i) => (
          <Button key={x.site} size="sm" variant={i === ti ? "default" : "outline"} onClick={() => { setTi(i); reset(); }} disabled={busy}>{x.site}</Button>
        )) : <span className="rounded-full border bg-card px-3 py-1 font-medium">{t.site}</span>}
        <span className="text-muted-foreground">{ROLE_LABEL[t.role as keyof typeof ROLE_LABEL]} · own site only{last ? ` · last day loaded: ${fmtDate(last)}` : ""}</span>
      </div>

      {error && <Card className="mb-4 flex gap-3 border-[var(--danger-border)] bg-[var(--danger-bg)] p-4 text-sm" role="alert"><XCircle className="mt-0.5 size-4 shrink-0 text-[var(--danger)]" /><div><div className="font-medium text-[var(--danger)]">This did not work</div><div className="mt-0.5">{error}</div></div></Card>}

      {client && <CompareWeek client={client} canExplain={canReplace} tick={tick} />}

      {(phase === "idle" || busy) && !parsed && !queue.length && (
        <label onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files); }}
          className={`flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-colors ${drag ? "border-primary bg-accent" : "bg-card"} ${busy ? "pointer-events-none opacity-80" : ""}`}>
          {busy ? <Loader2 className="size-8 animate-spin text-brand" /> : <UploadCloud className="size-8 text-brand" />}
          <div className="text-base font-medium">{busy ? (file?.name ?? "Working") : `Drop the ${t.site} ${t.kind === "tms" ? "reports (.xlsx / .docx)" : "Daily Reports"} here`}</div>
          {busy
            ? <Steps phase={phase} hist={hist} note={phase === "starting" ? (reader.status || "The first time takes about a minute; after that the reader is kept by your browser.") : undefined} />
            : <div className="max-w-[52ch] text-sm text-muted-foreground">or click to choose one or many {t.kind === "tms" ? "files" : "PDFs"}. Several files load oldest day first. The files stay in this browser and are not kept.</div>}
          <input type="file" accept={t.kind === "tms" ? ".xlsx,.docx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/pdf,.pdf"} className="sr-only" multiple disabled={busy} onChange={(e) => { pick(e.target.files); e.target.value = ""; }} />
        </label>
      )}

      {queue.length > 0 && (
        <Card className="mb-4 gap-3 p-4" data-bulk>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="mr-auto text-base font-semibold">{queue.length} files · {t.site} <span className="ml-1 text-sm font-normal text-muted-foreground">{queue.filter((x) => x.state === "loaded").length} of {queue.length} loaded</span></h2>
            {phase === "queued" && <><Button variant="outline" onClick={reset}>Cancel</Button><Button onClick={runBulk}>Load {queue.length} days into {t.site}</Button></>}
            {phase === "bulk" && <Button variant="outline" onClick={() => { stopBulk.current = true; }}>Stop after this day</Button>}
            {phase === "bulkdone" && <Button onClick={reset}>Upload more</Button>}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden><div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${Math.round((queue.filter((x) => ["loaded", "blocked", "failed", "skipped"].includes(x.state)).length / queue.length) * 100)}%` }} /></div>
          <p className="text-sm text-muted-foreground">{phase === "queued" ? "Days are loaded oldest first, each one after the one before it. A day with an error stops the run and the later days are not loaded. New construction items load with category \"-\"; set it later." : phase === "bulk" ? "Keep this page open until every day is loaded." : "Done. Each loaded day can be undone below."}</p>
          <ul className="divide-y rounded-lg border text-sm" aria-live="polite">
            {queue.map((x) => (
              <li key={x.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <span className="w-24 shrink-0 font-medium">{fmtDate(x.date)}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground" title={x.file.name}>{x.file.name}</span>
                <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${x.state === "loaded" ? "border-[var(--success-border)] bg-[var(--success-bg)] text-[var(--success)]" : x.state === "failed" || x.state === "blocked" ? "border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger)]" : x.state === "wait" || x.state === "skipped" ? "text-muted-foreground" : "border-[var(--info-border)] bg-[var(--info-bg)] text-[var(--info)]"}`}>
                  {(x.state === "reading" || x.state === "loading") && <Loader2 className="size-3 animate-spin" aria-hidden />}{x.state === "loaded" && <CheckCircle2 className="size-3" aria-hidden />}{Q_LABEL[x.state]}</span>
                {x.state === "loaded" && x.batch && <Button size="sm" variant="ghost" onClick={() => { doUndo(x.batch!).then((ok) => { if (ok) setQueue((q) => q.map((y) => (y.key === x.key ? { ...y, state: "skipped", batch: undefined, msg: "Undone" } : y))); }); }}><Undo2 />Undo</Button>}
                {(x.msg || x.warn || x.newCons) ? <span className="basis-full text-xs text-muted-foreground">{[x.msg, x.rows ? `${x.rows.toLocaleString("en-US")} rows` : "", x.warn ? `${x.warn} warning${x.warn > 1 ? "s" : ""}` : "", x.newCons ? `${x.newCons} new construction item${x.newCons > 1 ? "s" : ""} with no category` : ""].filter(Boolean).join(" · ")}</span> : null}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {parsed && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            <Stat label="Report day" value={fmtDate(parsed.report_date)} />
            <Stat label="Rows read" value={parsed.summary.rows.toLocaleString("en-US")} />
            <Stat label="Errors" value={counts.ERROR} tone={counts.ERROR ? "text-[var(--danger)]" : ""} />
            <Stat label="Warnings" value={counts.WARN} tone={counts.WARN ? "text-[var(--warning)]" : ""} />
            <Stat label="Checks" value={counts.RECON} />
          </div>

          {gap > 1 && <Card className="flex gap-3 border-[var(--warning-border)] bg-[var(--warning-bg)] p-3 text-sm"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />The last day loaded is {fmtDate(last!)}. This report is {gap} days later, so {gap - 1} day{gap > 2 ? "s are" : " is"} missing in between. Running totals start from the last day loaded.</Card>}
          {last && parsed.report_date <= last && <Card className="flex gap-3 border-[var(--info-border)] bg-[var(--info-bg)] p-3 text-sm"><RotateCcw className="mt-0.5 size-4 shrink-0 text-[var(--info)]" />{fmtDate(parsed.report_date)} is already loaded. Loading again replaces that day only; the days after it are not recalculated.</Card>}

          {!!parsed.cons_new?.length && (
            <Card className="gap-3 border-[var(--warning-border)] bg-[var(--warning-bg)] p-4">
              <h2 className="text-base font-semibold">New construction items need a category <span className="ml-1 text-sm font-normal text-muted-foreground">{parsed.cons_new.filter((i) => !consPick[i]).length} of {parsed.cons_new.length} still open</span></h2>
              <p className="text-sm text-muted-foreground">These items are not in the history yet. Choose the category each belongs to. Left open, an item loads with &quot;-&quot; and the category can be set in the master later.</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {parsed.cons_new.map((item) => (
                  <label key={item} className="flex items-center justify-between gap-3 rounded-md border bg-card px-3 py-2 text-sm">
                    <span className="min-w-0 truncate font-medium" title={item}>{item}</span>
                    <select value={consPick[item] ?? ""} onChange={(e) => pickCons(item, e.target.value)} disabled={phase !== "parsed"} aria-label={`Category of ${item}`}
                      className="h-8 rounded-md border bg-background px-2 text-sm">
                      <option value="">Decide later (-)</option>
                      {(parsed.cons_choices ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </label>
                ))}
              </div>
            </Card>
          )}

          <Card className="gap-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="mr-2 text-base font-semibold">Issues</h2>
              {(["ERROR", "WARN", "RECON", "INFO"] as const).map((k) => (
                <button key={k} onClick={() => setSev({ ...sev, [k]: !sev[k] })} aria-pressed={sev[k]}
                  className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${sev[k] ? SEV[k].cls : "text-muted-foreground"}`}>{SEV[k].label} {counts[k] ?? 0}</button>
              ))}
            </div>
            {issues.length === 0 ? <p className="text-sm text-muted-foreground">Nothing to show for the selected kinds.</p> : (
              <ul className="max-h-72 space-y-1.5 overflow-auto text-sm">
                {issues.slice(0, 200).map((x, i) => (
                  <li key={i} className="flex gap-2 rounded-md border px-2.5 py-1.5">
                    <span className={`mt-0.5 h-fit shrink-0 rounded-full border px-2 text-[11px] font-medium ${SEV[x.severity]?.cls ?? ""}`}>{SEV[x.severity]?.label ?? x.severity}</span>
                    <span className="min-w-0"><span className="text-muted-foreground">{x.table ? `${x.table.replace("tblRAW", "")} · ` : ""}</span>{x.message}
                      {x.diff != null && x.diff !== 0 && <span className="ml-1 font-mono text-xs text-muted-foreground">(report {num(x.pdf_value)} · expected {num(x.master_value)})</span>}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="gap-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="mr-2 text-base font-semibold">Preview</h2>
              {cats.map(([c, n]) => <button key={c} onClick={() => { setCat(c); setShown(150); }} aria-pressed={c === cat} className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${c === cat ? "bg-primary text-primary-foreground" : "bg-card"}`}>{c} {n}</button>)}
              <input value={q} onChange={(e) => { setQ(e.target.value); setShown(150); }} placeholder="Filter contractor, pit, metric" aria-label="Filter rows" className="ml-auto h-8 w-52 rounded-md border bg-card px-2 text-sm" />
            </div>
            <div className="max-h-96 overflow-auto rounded-md border">
              <table className="w-full text-sm"><thead className="sticky top-0 bg-muted text-left text-xs text-muted-foreground"><tr><th className="px-2 py-1.5">Contractor</th><th className="px-2">Pit</th><th className="px-2">Group</th><th className="px-2">Metric</th><th className="px-2 text-right">Value</th></tr></thead>
                <tbody>{rows.slice(0, shown).map((r, i) => <tr key={i} className="border-t"><td className="px-2 py-1">{r.contractor}</td><td className="px-2">{r.pit}</td><td className="px-2">{r.metric_group}</td><td className="px-2">{r.metric}</td><td className="px-2 text-right font-mono tabular-nums">{r.value == null ? r.text_value : num(r.value)}</td></tr>)}</tbody></table>
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground"><span>{rows.length.toLocaleString("en-US")} rows in {cat}</span>{rows.length > shown && <button className="font-medium text-link" onClick={() => setShown(shown + 300)}>Show more</button>}</div>
          </Card>

          {parsed.plan && (
            <Card className="gap-3 p-4">
              <h2 className="text-base font-semibold">Plan in the report differs from the calendar <span className="ml-1 text-sm font-normal text-muted-foreground">{parsed.plan.changes.length} value{parsed.plan.changes.length > 1 ? "s" : ""}</span></h2>
              <div className="max-h-64 overflow-auto rounded-md border">
                <table className="w-full text-sm"><thead className="sticky top-0 bg-muted text-left text-xs text-muted-foreground"><tr><th className="px-2 py-1.5">Contractor</th><th className="px-2">Plan</th><th className="px-2 text-right">Calendar now</th><th className="px-2 text-right">Report</th><th className="px-2">Applies</th></tr></thead>
                  <tbody>{parsed.plan.changes.map((c, i) => <tr key={i} className="border-t"><td className="px-2 py-1">{c.contractor}</td><td className="px-2 font-mono">{c.column}</td>
                    <td className="px-2 text-right font-mono tabular-nums">{cell(c.old)}</td><td className="px-2 text-right font-mono tabular-nums font-semibold">{cell(c.new)}</td>
                    <td className="px-2 text-xs text-muted-foreground">{fmtDate(c.from)} to {fmtDate(c.to)} ({c.days} days)</td></tr>)}</tbody></table>
              </div>
              <p className="text-xs text-muted-foreground">The plan printed in a report is the approved plan from that day until the next change. Replacing rewrites the calendar from the report day to the end of the stretch that had the old value (a month plan stops at the month end). Earlier days are not touched.</p>
              {canReplace
                ? <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={replacePlan} onChange={(e) => setReplacePlan(e.target.checked)} />Replace the plan when I load ({parsed.plan.days.length} days, groups {parsed.plan.groups.join(", ")})</label>
                : <p className="text-sm text-muted-foreground">Only a site admin can replace the plan. You can load the report now; ask a site admin to upload it again with the plan replaced.</p>}
            </Card>
          )}

          {!!parsed.barge?.length && (
            <Card className="gap-3 p-4">
              <h2 className="text-base font-semibold">Barge list <span className="ml-1 text-sm font-normal text-muted-foreground">{parsed.barge.filter((b) => !b.old).length} new · {parsed.barge.filter((b) => b.old).length} changed</span></h2>
              <div className="max-h-72 overflow-auto rounded-md border">
                <table className="w-full text-sm"><thead className="sticky top-0 bg-muted text-left text-xs text-muted-foreground"><tr><th className="px-2 py-1.5">SI</th><th className="px-2">Barge</th><th className="px-2">Contractor</th><th className="px-2">Status</th><th className="px-2">Finish</th><th className="px-2 text-right">Actual</th><th className="px-2 text-right">YTD</th></tr></thead>
                  <tbody>{parsed.barge.map((b) => {
                    const mark = (c: string) => (b.old && String(b.old[c] ?? "") !== String(b.hist[c] ?? "") ? "font-semibold text-[var(--warning)]" : "");
                    return <tr key={b.si} className="border-t"><td className="px-2 py-1 font-mono">{b.si}{!b.old && <span className="ml-1 rounded bg-[var(--info-bg)] px-1 text-[10px] text-[var(--info)]">new</span>}</td>
                      <td className="px-2">{cell(b.hist["VESSEL/BARGE"])}</td><td className="px-2">{cell(b.hist["CONTRACTOR"])}</td>
                      <td className={`px-2 ${mark("STATUS")}`}>{b.old && b.old["STATUS"] !== b.hist["STATUS"] ? `${cell(b.old["STATUS"])} → ` : ""}{cell(b.hist["STATUS"])}</td>
                      <td className={`px-2 ${mark("FINISHDATE")}`}>{cell(b.hist["FINISHDATE"])}</td>
                      <td className={`px-2 text-right font-mono tabular-nums ${mark("ACTUAL CAPACITY")}`}>{cell(b.hist["ACTUAL CAPACITY"])}</td>
                      <td className="px-2 text-right font-mono tabular-nums">{cell(b.hist["YTD"])}</td></tr>;
                  })}</tbody></table>
              </div>
              <p className="text-xs text-muted-foreground">Week, month, year and the running totals are recalculated for the whole list when you load.</p>
            </Card>
          )}

          {!!parsed.stock?.length && (
            <Card className="gap-3 p-4">
              <h2 className="text-base font-semibold">Stock register <span className="ml-1 text-sm font-normal text-muted-foreground">{parsed.stock.filter((s) => s.status === "new").length} new · {parsed.stock.filter((s) => s.status === "changed").length} changed · {parsed.stock.filter((s) => s.status === "same").length} same</span></h2>
              <div className="max-h-72 overflow-auto rounded-md border">
                <table className="w-full text-sm"><thead className="sticky top-0 bg-muted text-left text-xs text-muted-foreground"><tr><th className="px-2 py-1.5">Contractor</th><th className="px-2">Stock date</th><th className="px-2">Last in database</th><th className="px-2">Result</th><th className="px-2 text-right">Total t</th><th className="px-2">What differs</th></tr></thead>
                  <tbody>{parsed.stock.map((s) => (
                    <tr key={`${s.contractor}|${s.date}`} className="border-t align-top"><td className="px-2 py-1">{s.contractor}</td><td className="px-2">{fmtDate(s.date)}</td>
                      <td className="px-2">{s.last_db_date ? fmtDate(s.last_db_date) : "none"}{s.gap_days ? <span className="ml-1 text-xs text-muted-foreground">({s.gap_days} day{s.gap_days === 1 ? "" : "s"} with no row)</span> : null}</td>
                      <td className="px-2"><span className={`rounded px-1 text-xs ${s.status === "new" ? "bg-[var(--info-bg)] text-[var(--info)]" : s.status === "changed" ? "bg-[var(--warning-bg)] text-[var(--warning)]" : "text-muted-foreground"}`}>{s.status === "new" ? "insert" : s.status === "changed" ? "update" : "same, skipped"}</span></td>
                      <td className="px-2 text-right font-mono tabular-nums">{cell(s.old_total != null && s.old_total !== s.total ? `${s.old_total.toLocaleString("en-US")} → ${s.total.toLocaleString("en-US")}` : s.total.toLocaleString("en-US"))}</td>
                      <td className="px-2 text-xs">{s.changes.slice(0, 6).map((c) => <div key={c.col} className="font-mono">{c.col}: {cell(c.old)} → <span className="font-semibold">{cell(c.new)}</span></div>)}{s.changes.length > 6 && <div className="text-muted-foreground">+ {s.changes.length - 6} more</div>}</td></tr>))}</tbody></table>
              </div>
              <p className="text-xs text-muted-foreground">Only days that are new or differ are loaded. A day that is identical to the database is left alone. A load replaces a whole day of stock, so the other contractors of that day are copied unchanged.</p>
            </Card>
          )}

          {!!parsed.ship_updates?.length && (
            <Card className="gap-3 p-4">
              <h2 className="text-base font-semibold">Ship of earlier days <span className="ml-1 text-sm font-normal text-muted-foreground">{parsed.ship_updates.length} differ from the barge list</span></h2>
              <div className="max-h-64 overflow-auto rounded-md border">
                <table className="w-full text-sm"><thead className="sticky top-0 bg-muted text-left text-xs text-muted-foreground"><tr><th className="px-2 py-1.5">Apply</th><th className="px-2">Date</th><th className="px-2">Contractor</th><th className="px-2 text-right">Ship now</th><th className="px-2 text-right">Barge list</th><th className="px-2">Why</th></tr></thead>
                  <tbody>{parsed.ship_updates.map((u) => { const k = `${u.date}|${u.contractor}`; return (
                    <tr key={k} className="border-t"><td className="px-2 py-1"><input type="checkbox" aria-label={`Apply ${u.date} ${u.contractor}`} checked={!!ticked[k]} disabled={phase !== "loaded" || !canReplace || !!shipBatch} onChange={(e) => setTicked({ ...ticked, [k]: e.target.checked })} /></td>
                      <td className="px-2">{fmtDate(u.date)}</td><td className="px-2">{u.contractor}</td><td className="px-2 text-right font-mono tabular-nums">{cell(u.old)}</td><td className="px-2 text-right font-mono tabular-nums font-semibold">{cell(u.new)}</td>
                      <td className="px-2 text-xs text-muted-foreground">{u.kind === "Barge change" ? u.caused_by : "older difference, nothing changed in this report"}</td></tr>); })}</tbody></table>
              </div>
              {phase !== "loaded" && <p className="text-xs text-muted-foreground">Load the report first. Then a site admin can apply the ticked rows; the week, month and year totals of those days and the days after them are updated by the same amount.</p>}
              {phase === "loaded" && !canReplace && <p className="text-sm text-muted-foreground">Only a site admin can apply these. Ask one to open this report and apply them.</p>}
              {phase === "loaded" && canReplace && !shipBatch && <div><Button size="sm" onClick={doShip} disabled={shipBusy || !Object.values(ticked).some(Boolean)}>{shipBusy ? <><Loader2 className="animate-spin" />Applying</> : "Apply ticked rows"}</Button></div>}
              {shipCmp.length > 0 && (
                <div className="max-h-80 overflow-auto rounded-md border">
                  <table className="w-full text-sm"><thead className="sticky top-0 bg-muted text-left text-xs text-muted-foreground"><tr><th className="px-2 py-1.5">Date</th><th className="px-2">Contractor</th>{SHIP_COLS.map((c) => <th key={c} className="px-2 text-right">{c} before → after</th>)}</tr></thead>
                    <tbody>{shipCmp.map((r) => <tr key={`${r.date}|${r.contractor}`} className="border-t"><td className="px-2 py-1">{fmtDate(r.date)}</td><td className="px-2">{r.contractor}</td>
                      {SHIP_COLS.map((c) => { const d = r.now[c] - r.old[c]; return <td key={c} className="px-2 text-right font-mono text-xs tabular-nums">{Math.abs(d) > 0.000001 ? <><span className="text-muted-foreground">{cell(r.old[c])} → </span><span className="font-semibold">{cell(r.now[c])}</span> <span className="text-[var(--warning)]">({d > 0 ? "+" : ""}{cell(d)})</span></> : <span className="text-muted-foreground">{cell(r.now[c])}</span>}</td>; })}</tr>)}</tbody></table>
                </div>
              )}
              {shipMsg && <p className="text-sm font-medium">{shipMsg}{shipBatch && <Button size="sm" variant="ghost" className="ml-2" onClick={() => { doUndo(shipBatch).then((ok) => { if (ok) { setShipBatch(null); setShipCmp([]); setShipMsg("Ship updates undone."); } }); }}><Undo2 />Undo</Button>}</p>}
            </Card>
          )}

          {phase === "loaded" && result && (
            <Card className="gap-2 border-[var(--success-border)] bg-[var(--success-bg)] p-4">
              <div className="flex items-center gap-2 font-medium text-[var(--success)]"><CheckCircle2 className="size-5" />Loaded {fmtDate(parsed.report_date)}</div>
              <p className="text-sm">{result.actual_inserted?.toLocaleString("en-US")} rows written{result.actual_deleted ? `, ${result.actual_deleted.toLocaleString("en-US")} replaced` : ""}. {result.target === "shadow"
                ? "This site is still in test mode: the rows went to a safe copy that dashboards do not read."
                : "These rows are now in the live production data."}</p>
              {diff && <p className="text-sm"><ShieldCheck className="mr-1 inline size-4" />Against the current process for the same day: {diff.counts.same.toLocaleString("en-US")} same, {diff.counts.changed} different, {diff.counts.only_portal} only here, {diff.counts.only_prod} only there.</p>}
              {bdiff && <p className="text-sm"><ShieldCheck className="mr-1 inline size-4" />Barge list against the current process: {bdiff.counts.same} same, {bdiff.counts.changed} different, {bdiff.counts.only_portal} only here, {bdiff.counts.only_prod} only there.</p>}
              <div className="flex gap-2 pt-1"><Button size="sm" variant="outline" onClick={() => doUndo(batch!)}><Undo2 />Undo this load</Button><Button size="sm" onClick={reset}>Upload another</Button></div>
            </Card>
          )}
          {phase === "undone" && <Card className="gap-2 p-4 text-sm"><div className="font-medium">Load undone. The previous rows are back.</div><div><Button size="sm" onClick={reset}>Upload another</Button></div></Card>}

          {(phase === "parsed" || phase === "loading") && (
            <div className="sticky bottom-3 z-10 flex flex-wrap items-center gap-3 rounded-xl border bg-card p-3 shadow-md">
              <FileText className="size-5 text-brand" /><div className="min-w-0 flex-1 text-sm"><div className="truncate font-medium">{file?.name}</div>
                <div className="text-muted-foreground">{blocked.length ? `Cannot load: ${blocked[0]}` : counts.WARN ? `${counts.WARN} warning${counts.WARN > 1 ? "s" : ""} to look at, then load.` : "Ready to load."}</div></div>
              <Button variant="outline" onClick={reset} disabled={phase === "loading"}>Cancel</Button>
              <Button onClick={doLoad} disabled={phase === "loading" || blocked.length > 0}>{phase === "loading" ? <><Loader2 className="animate-spin" />Loading</> : `Load into ${t.site}`}</Button>
            </div>
          )}
        </div>
      )}

      {recent.length > 0 && (
        <Card className="mt-6 gap-2 p-4">
          <h2 className="text-base font-semibold">Recent uploads</h2>
          <ul className="divide-y text-sm">
            {recent.map((b) => (
              <li key={b.batch_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
                <span className="w-24 font-medium">{fmtDate(b.report_date)}</span>
                <span className="rounded-full border px-2 text-xs">{b.status}{b.status === "loaded" && b.target === "shadow" ? " (test mode)" : ""}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{b.source_file}</span>
                {b.status === "loaded" && b.batch_id !== batch && <Button size="sm" variant="ghost" onClick={() => doUndo(b.batch_id)}><Undo2 />Undo</Button>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

export const ProductionInputs = () => (
  <AppFrame active="production" gate="production" backHref="/production/" backLabel="Back to Production">{(a) => <View access={a as Access} />}</AppFrame>
);
