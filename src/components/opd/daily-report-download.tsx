"use client";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FileImage, FileText, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PROJECTS } from "@/lib/opd/config.js";
import { makeClient } from "@/lib/opd/session.js";
import { projectAccess } from "@/lib/opd/auth-core.js";
import * as ETL from "@/lib/opd/etl-client.js";
import { compileDaily, shortDate, fileStem } from "@/lib/opd/daily-report.js";
import { summaryPng, reportPdf, saveBlob } from "@/lib/opd/daily-report-render.js";

type Access = Parameters<typeof projectAccess>[0];
type Report = ReturnType<typeof compileDaily>;

type JsPdf = new (o?: object) => { output(t: string): Blob };
let jspdfLoading: Promise<JsPdf> | null = null;
function loadJsPdf(): Promise<JsPdf> {
  const w = window as unknown as { jspdf?: { jsPDF: JsPdf } };
  if (w.jspdf) return Promise.resolve(w.jspdf.jsPDF);
  if (jspdfLoading) return jspdfLoading;
  jspdfLoading = new Promise((res, rej) => {
    const sc = document.createElement("script"); sc.src = "/vendor/jspdf.umd.min.js";
    sc.onload = () => res(w.jspdf!.jsPDF); sc.onerror = () => { jspdfLoading = null; rej(new Error("The PDF library could not be loaded.")); };
    document.head.appendChild(sc);
  });
  return jspdfLoading;
}

/** Download the compiled Daily Report: WhatsApp summary (PNG or PDF) and the full report (PDF). Compiled from the site projects, read only. */
export function DailyReportDownload({ access }: { access: Access | null }) {
  const targets = useMemo(() => ETL.reportTargets(PROJECTS, access, projectAccess), [access]);
  const [busy, setBusy] = useState<string | null>(null);
  const [rep, setRep] = useState<Report | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    let live = true;
    if (!targets.length) return;
    (async () => {
      setChecking(true);
      try { const r = await ETL.reportAll(targets, makeClient); if (live) { setRep(compileDaily(r.sites, r.failed)); setFailed(r.failed as Record<string, string>); } }
      catch { /* the buttons still try again and show the reason */ }
      finally { if (live) setChecking(false); }
    })();
    return () => { live = false; };
  }, [targets]);

  async function compile(): Promise<Report> {
    const r = await ETL.reportAll(targets, makeClient);
    const out = compileDaily(r.sites, r.failed);
    setRep(out); setFailed(r.failed as Record<string, string>);
    if (!out.report_date) throw new Error(Object.keys(r.failed).length ? "No site could be read. " + Object.values(r.failed)[0] : "No site has a loaded day yet.");
    return out;
  }
  async function go(kind: "png" | "summary-pdf" | "full-pdf") {
    setBusy(kind); setMsg(null);
    try {
      const out = await compile();
      const stem = fileStem(out.report_date);
      if (kind === "png") saveBlob(await summaryPng(out), `${stem}_Summary.png`);
      else if (kind === "summary-pdf") saveBlob(await reportPdf(await loadJsPdf(), out, false), `${stem}_Summary.pdf`);
      else saveBlob(await reportPdf(await loadJsPdf(), out, true), `${stem}.pdf`);
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }
  const b = (kind: "png" | "summary-pdf" | "full-pdf", label: string, short: string, icon: React.ReactNode, primary = false) => (
    <Button type="button" size="lg" variant={primary ? "default" : "outline"} disabled={!!busy || !targets.length} data-dl={kind} onClick={() => go(kind)}
      className="h-auto min-h-11 flex-col items-center gap-0.5 whitespace-normal px-3 py-2 text-center sm:flex-row sm:gap-2">
      {busy === kind ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      <span className="text-sm font-medium leading-tight">{label}</span><span className="text-[11px] font-normal opacity-80 sm:hidden">{short}</span>
    </Button>
  );
  const sites = rep?.rows ?? [];
  const missing = Object.values(failed).some(v => /not installed/i.test(v));
  return (
    <Card className="mb-4 gap-4 p-4 sm:p-5" id="daily-report">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent text-brand"><Download className="size-5" aria-hidden /></span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold leading-tight">Daily Report</h2>
          <p className="text-sm text-muted-foreground">Built from the loaded data of {targets.length ? targets.map((t: { site: string }) => t.site).join(", ") : "no site you can read"}. Each site shows its own cut-off day.</p>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {b("png", "Summary image", "PNG for WhatsApp", <FileImage className="size-4" aria-hidden />, true)}
        {b("summary-pdf", "Summary", "1 page PDF", <FileText className="size-4" aria-hidden />)}
        {b("full-pdf", "Full report", "8 page PDF", <FileText className="size-4" aria-hidden />)}
      </div>
      {(checking || sites.length > 0 || Object.keys(failed).length > 0) && (
        <ul className="flex flex-wrap gap-2 text-xs" aria-label="Site status">
          {checking && <li className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-muted-foreground"><Loader2 className="size-3 animate-spin" aria-hidden />Checking sites</li>}
          {sites.filter(r => r.data).map(r => {
            const cut = r.data?.cut_off ?? ""; const late = !!rep?.report_date && cut !== rep.report_date;
            return <li key={r.site} className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1", late ? "border-[var(--warning-border)] bg-[var(--warning-bg)] text-warning" : "border-[var(--success-border,var(--border))] text-foreground")}>
              {late ? <AlertTriangle className="size-3" aria-hidden /> : <CheckCircle2 className="size-3 text-[var(--success)]" aria-hidden />}<b>{r.company}</b> {shortDate(cut)}{late ? " (behind)" : ""}</li>;
          })}
          {Object.entries(failed).map(([k, v]) => <li key={k} className="inline-flex items-center gap-1.5 rounded-full border border-[var(--danger-border)] bg-[var(--danger-bg)] px-2.5 py-1 text-danger"><AlertTriangle className="size-3" aria-hidden /><b>{k}</b> {/not installed/i.test(v) ? "report reader missing" : v}</li>)}
        </ul>
      )}
      {missing && <p role="alert" className="rounded-md border border-[var(--warning-border)] bg-[var(--warning-bg)] p-3 text-xs">The report reader is not installed in some site projects. Open the Supabase SQL Editor of each site listed above, run <code className="font-mono">supabase/sql/etl_07_report.sql</code> once, then reload this page.</p>}
      {rep && rep.stale.length > 0 && <p role="status" className="text-xs text-amber-700 dark:text-amber-400">Behind {shortDate(rep.report_date)}: {rep.stale.map(s => `${s.company} (${shortDate(s.cut_off)})`).join(", ")}. Load that day on the Upload page, then download again.</p>}
      {msg && !missing && <p role="alert" className="text-xs text-destructive">{msg}</p>}
    </Card>
  );
}
