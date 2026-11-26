"use client";
import { Fragment, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { makeClient } from "@/lib/opd/session.js";
import * as ETL from "@/lib/opd/etl-client.js";

/* Compare week (Phase 4.5). While a site is in test mode the portal writes to a safe copy and the desktop ETL still feeds prod_v2.
   This panel shows, day by day, whether the two agree, and how many clean days in a row the site has. The numbers come from the
   database (etl_compare_status); nothing is computed here. */

type Counts = { same: number; changed: number; only_portal: number; only_prod: number };
type BatchInfo = { batch_id: string; source_file: string | null; kind: string; verdict: string; actual: Counts | null; barge: (Counts & { error?: string }) | null; checked_at: string | null; explained: boolean; note: string | null };
type Day = { report_date: string; verdict: string; actual: Counts; barge: Counts; batches: BatchInfo[] };
type Status = { site: string; live: boolean; need: number; streak: number; ready: boolean; newest_clean: string | null; missing_days: number; days: Day[] };
type DiffRow = { date: string; category: string; metric_group: string; pit: string | null; contractor: string | null; metric: string; prod_value: number | null; portal_value: number | null; state: string };
type BargeRow = { si: string; state: string; changed_columns: string | null };
type Detail = { rows: DiffRow[]; barge: BargeRow[] };

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fmtDate = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const fmtTime = (t: string | null) => (t ? new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "never");
const num = (v: number | null | undefined) => (v == null ? "–" : (Math.round(v * 1000) / 1000).toLocaleString("en-US"));
const TONE: Record<string, string> = {
  success: "border-[var(--success-border)] bg-[var(--success-bg)] text-[var(--success)]",
  info: "border-[var(--info-border)] bg-[var(--info-bg)] text-[var(--info)]",
  warning: "border-[var(--warning-border)] bg-[var(--warning-bg)] text-[var(--warning)]",
  danger: "border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger)]",
};
const Badge = ({ v }: { v: string }) => { const x = ETL.verdictOf(v); return <span title={x.help} className={`rounded-full border px-2 py-0.5 text-xs font-medium ${TONE[x.tone]}`}>{x.label}</span>; };
const sum = (c: Counts | null | undefined) => (c ? c.same + c.changed + c.only_portal + c.only_prod : 0);

export function CompareWeek({ client, canExplain, tick, onChange }: { client: NonNullable<ReturnType<typeof makeClient>>; canExplain: boolean; tick: number; onChange?: () => void }) {
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, Detail | "loading">>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});
  const [n, setN] = useState(0);

  useEffect(() => {
    let live = true;
    (async () => {
      try { const s = await ETL.compareStatus(client); if (live) { setSt(s); setErr(null); setMissing(false); } }
      catch (e) { if (live) { if (ETL.compareMissing(e)) setMissing(true); else setErr(why(e)); } }
    })();
    return () => { live = false; };
  }, [client, tick, n]);

  async function recheck(b: BatchInfo) {
    setBusy(b.batch_id);
    try { await ETL.compareRecord(client, b.batch_id); setDetail((d) => { const x = { ...d }; delete x[b.batch_id]; return x; }); setN((v) => v + 1); setErr(null); onChange?.(); }
    catch (e) { setErr(why(e)); } finally { setBusy(null); }
  }
  async function explain(b: BatchInfo, on: boolean) {
    setBusy(b.batch_id);
    try { await ETL.compareExplain(client, b.batch_id, on, on ? (note[b.batch_id] ?? "") : null); setN((v) => v + 1); setErr(null); onChange?.(); }
    catch (e) { setErr(why(e)); } finally { setBusy(null); }
  }
  async function look(b: BatchInfo) {
    if (detail[b.batch_id]) return;
    setDetail((d) => ({ ...d, [b.batch_id]: "loading" }));
    try {
      const a = await ETL.shadowDiff(client, b.batch_id);
      const g = b.barge ? await ETL.bargeDiff(client, b.batch_id).catch(() => null) : null;
      setDetail((d) => ({ ...d, [b.batch_id]: { rows: a.rows as DiffRow[], barge: (g?.rows ?? []) as BargeRow[] } }));
    } catch (e) { setErr(why(e)); setDetail((d) => { const x = { ...d }; delete x[b.batch_id]; return x; }); }
  }

  if (missing) return <Card className="mb-4 gap-1 p-4 text-sm"><h2 className="text-base font-semibold">Compare week</h2><p className="text-muted-foreground">Not installed on this site yet. Run <code className="font-mono">etl_06_compare.sql</code> in the SQL editor of this project, then reload.</p></Card>;
  if (!st) return err ? <Card className="mb-4 p-4 text-sm text-[var(--danger)]" role="alert">Compare week: {err}</Card> : null;
  if (st.live) return <Card className="mb-4 gap-1 border-[var(--success-border)] bg-[var(--success-bg)] p-4 text-sm"><h2 className="text-base font-semibold">Live</h2><p>This site is live. A load writes to the production data that dashboards read. Undo is in Recent uploads.</p></Card>;

  const pct = Math.min(100, Math.round((st.streak / st.need) * 100));
  const unchecked = st.days.filter((d) => d.verdict === "unchecked").length;
  return (
    <Card className="mb-4 gap-3 p-4" data-compare-week>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">Compare week</h2>
        <span className="text-sm text-muted-foreground">Test mode: the portal writes a safe copy. Each day is compared with the current process.</span>
      </div>
      <div>
        <div className="flex items-center justify-between text-sm"><span className="font-medium">{st.streak} of {st.need} clean days in a row</span>
          <span className={st.ready ? "font-medium text-[var(--success)]" : "text-muted-foreground"}>{st.ready ? "Ready to go live" : `${st.need - st.streak} more to go`}</span></div>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={st.streak} aria-valuemin={0} aria-valuemax={st.need} aria-label="Clean days in a row">
          <div className={`h-full rounded-full ${st.ready ? "bg-[var(--success)]" : "bg-primary"}`} style={{ width: `${pct}%` }} /></div>
        {st.missing_days > 0 && <p className="mt-1 text-xs text-[var(--warning)]">{st.missing_days} calendar day{st.missing_days > 1 ? "s" : ""} inside this run have no load. Check that the site really did not report.</p>}
        {unchecked > 0 && <p className="mt-1 text-xs text-[var(--warning)]">{unchecked} day{unchecked > 1 ? "s are" : " is"} loaded but not compared yet. Open the day and press Check again.</p>}
      </div>
      {err && <p className="text-sm text-[var(--danger)]" role="alert">{err}</p>}
      {st.days.length === 0 ? <p className="text-sm text-muted-foreground">No test-mode loads yet. Load a report below; the comparison appears here.</p> : (
        <div className="overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-xs text-muted-foreground"><tr><th className="w-8 px-2 py-1.5" /><th className="px-2">Day</th><th className="px-2">Result</th><th className="px-2 text-right">Same</th><th className="px-2 text-right">Different</th><th className="px-2 text-right">Only here</th><th className="px-2 text-right">Only there</th></tr></thead>
            <tbody>
              {st.days.map((d) => {
                const isOpen = open === d.report_date;
                const bg = d.barge; const hasB = d.batches.some((b) => b.barge);
                return (
                  <Fragment key={d.report_date}>
                    <tr className="cursor-pointer border-t hover:bg-muted/40" onClick={() => setOpen(isOpen ? null : d.report_date)}>
                      <td className="px-2 py-1.5">{isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</td>
                      <td className="px-2 font-medium">{fmtDate(d.report_date)}</td><td className="px-2"><Badge v={d.verdict} /></td>
                      <td className="px-2 text-right font-mono tabular-nums">{(d.actual.same + (hasB ? bg.same : 0)).toLocaleString("en-US")}</td>
                      <td className={`px-2 text-right font-mono tabular-nums ${d.actual.changed + bg.changed ? "font-semibold text-[var(--danger)]" : ""}`}>{d.actual.changed + bg.changed}</td>
                      <td className={`px-2 text-right font-mono tabular-nums ${d.actual.only_portal + bg.only_portal ? "font-semibold text-[var(--warning)]" : ""}`}>{d.actual.only_portal + bg.only_portal}</td>
                      <td className={`px-2 text-right font-mono tabular-nums ${d.actual.only_prod + bg.only_prod ? "font-semibold text-[var(--danger)]" : ""}`}>{d.actual.only_prod + bg.only_prod}</td>
                    </tr>
                    {isOpen && <tr className="border-t bg-muted/20"><td colSpan={7} className="space-y-3 px-3 py-3">
                      {d.batches.map((b) => {
                        const det = detail[b.batch_id];
                        const canReason = canExplain && (b.verdict === "only_here" || b.verdict === "explained");
                        return (
                          <div key={b.batch_id} className="rounded-md border bg-card p-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="min-w-0 flex-1 truncate text-sm font-medium">{b.source_file ?? "Report"}</span>
                              <Badge v={b.verdict} />
                              <span className="text-xs text-muted-foreground">checked {fmtTime(b.checked_at)}</span>
                              <Button size="sm" variant="outline" disabled={busy === b.batch_id} onClick={() => recheck(b)}>{busy === b.batch_id ? <Loader2 className="animate-spin" /> : <RefreshCw />}Check again</Button>
                              {b.actual && sum(b.actual) + sum(b.barge) > 0 && b.verdict !== "clean" && <Button size="sm" variant="ghost" onClick={() => look(b)} disabled={det === "loading"}>{det === "loading" ? "Reading" : "Show rows"}</Button>}
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">{ETL.verdictOf(b.verdict).help}
                              {b.barge && !("error" in b.barge) && ` Barge list: ${b.barge.same} same, ${b.barge.changed} different, ${b.barge.only_portal} only here, ${b.barge.only_prod} only there.`}
                              {b.barge && "error" in b.barge && ` Barge list could not be read: ${b.barge.error}`}</p>
                            {b.explained && b.note && <p className="mt-1 text-sm"><span className="font-medium">Reason:</span> {b.note}</p>}
                            {canReason && (
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                {b.explained
                                  ? <Button size="sm" variant="outline" disabled={busy === b.batch_id} onClick={() => explain(b, false)}>Remove reason</Button>
                                  : <>
                                    <input value={note[b.batch_id] ?? ""} onChange={(e) => setNote({ ...note, [b.batch_id]: e.target.value })} placeholder="Why are these rows only here?" aria-label="Reason" className="h-8 min-w-60 flex-1 rounded-md border bg-card px-2 text-sm" />
                                    <Button size="sm" disabled={busy === b.batch_id || (note[b.batch_id] ?? "").trim().length < 10} onClick={() => explain(b, true)}>Save reason</Button>
                                  </>}
                              </div>
                            )}
                            {!canExplain && b.verdict === "only_here" && <p className="mt-1 text-xs text-muted-foreground">Only a site admin can write the reason.</p>}
                            {det && det !== "loading" && (
                              <div className="mt-2 max-h-72 overflow-auto rounded-md border">
                                <table className="w-full text-xs"><thead className="sticky top-0 bg-muted text-left text-muted-foreground"><tr><th className="px-2 py-1">State</th><th className="px-2">Group</th><th className="px-2">Metric</th><th className="px-2">Contractor / pit</th><th className="px-2 text-right">Current process</th><th className="px-2 text-right">Portal</th></tr></thead>
                                  <tbody>
                                    {det.rows.slice(0, 200).map((r, i) => <tr key={i} className="border-t"><td className="px-2 py-1">{r.state === "only_portal" ? "only here" : r.state === "only_prod" ? "only there" : "different"}</td><td className="px-2">{r.metric_group}</td><td className="px-2">{r.metric}</td><td className="px-2">{[r.contractor, r.pit].filter(Boolean).join(" / ") || "–"}</td><td className="px-2 text-right font-mono tabular-nums">{num(r.prod_value)}</td><td className="px-2 text-right font-mono tabular-nums">{num(r.portal_value)}</td></tr>)}
                                    {det.barge.map((r) => <tr key={r.si} className="border-t"><td className="px-2 py-1">{r.state === "only_portal" ? "only here" : r.state === "only_prod" ? "only there" : "different"}</td><td className="px-2">Barge list</td><td className="px-2 font-mono">{r.si}</td><td className="px-2" colSpan={3}>{r.changed_columns ?? ""}</td></tr>)}
                                  </tbody></table>
                                {det.rows.length > 200 && <p className="p-2 text-xs text-muted-foreground">First 200 of {det.rows.length.toLocaleString("en-US")} rows.</p>}
                                {det.rows.length + det.barge.length === 0 && <p className="p-2 text-xs text-muted-foreground">No differing rows now. Press Check again to update the result.</p>}
                              </div>
                            )}
                          </div>);
                      })}
                    </td></tr>}
                  </Fragment>);
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">A day is clean when nothing differs. Rows only here are fine once a site admin writes why (for example the current process loads that day later). Different values and rows only there must be fixed, then the day loaded again. The current process often loads a day after the portal: press Check again then.</p>
    </Card>
  );
}
