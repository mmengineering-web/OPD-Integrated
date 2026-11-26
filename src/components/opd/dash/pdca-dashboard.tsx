"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, Loader2, RefreshCw, ShieldAlert, TrendingDown, TrendingUp } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { PROJECTS } from "@/lib/opd/config.js";
import { makeClient } from "@/lib/opd/session.js";
import { projectAccess } from "@/lib/opd/auth-core.js";
import * as ETL from "@/lib/opd/etl-client.js";
import { buildDash, dayDetail, daysBetween, explorerColumns, explorerSeries, PRESETS, rangeFor, TABLE_INFO } from "@/lib/opd/dash-model.js";
import { REPORTS, ReportsView, type ReportId } from "@/components/opd/dash/reports";
import { Bullet, C, DayChart, HBars, nf, Parts, Ring, SITE_COLOR, short, Spark, dlabel } from "@/components/opd/dash/charts";

type Access = Parameters<typeof projectAccess>[0];
type Tone = "good" | "pace" | "bad" | "none";
type K = { actual: number; plan: number; pct: number | null; verdict: { label: string; tone: Tone; pace: number | null } };
type Model = ReturnType<typeof buildDash>;
type Raw = Record<string, unknown>;
type Loader = (sites: string[], from: string, to: string) => Promise<{ sites: Raw; failed: Record<string, string> }>;

const TABS = [["overview", "Overview"], ["plan", "Plan"], ["do", "Do"], ["check", "Check"], ["act", "Act"], ["data", "All tables"]] as const;
type Tab = (typeof TABS)[number][0];
const PDCA_TAG: Record<string, string> = { Plan: "P", Do: "D", Check: "C", Act: "A" };
const TONE_CLS: Record<Tone, string> = { good: "border-[var(--success-border)] bg-[var(--success-bg)] text-[var(--success)]", pace: "border-[var(--info-border)] bg-[var(--info-bg)] text-[var(--info)]", bad: "border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger)]", none: "text-muted-foreground" };
const SEV_CLS: Record<string, string> = { critical: "border-[var(--danger-border)] bg-[var(--danger-bg)]", high: "border-[var(--danger-border)] bg-[var(--danger-bg)]", medium: "border-[var(--warning-border)] bg-[var(--warning-bg)]", info: "border-[var(--info-border)] bg-[var(--info-bg)]" };
const SEV_TXT: Record<string, string> = { critical: "text-[var(--danger)]", high: "text-[var(--danger)]", medium: "text-[var(--warning)]", info: "text-[var(--info)]" };
const tonne = (v: number | null | undefined) => (v == null ? "–" : v >= 1e6 ? `${(v / 1e6).toFixed(2)} Mt` : v >= 1e4 ? `${(v / 1e3).toFixed(0)} kt` : `${nf(v)} t`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

function Verdict({ v }: { v: K["verdict"] }) {
  const Icon = v.tone === "good" ? CheckCircle2 : v.tone === "bad" ? TrendingDown : v.tone === "pace" ? TrendingUp : null;
  return <span className={cn("inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold", TONE_CLS[v.tone])}>{Icon && <Icon className="size-3" aria-hidden />}{v.label}</span>;
}
function Title({ n, children, hint }: { n?: string; children: React.ReactNode; hint?: string }) {
  return <div className="mb-3"><h3 className="flex items-center gap-2 text-base font-semibold leading-snug">{n && <span className="grid size-5 place-items-center rounded bg-accent text-[11px] font-bold text-brand">{n}</span>}{children}</h3>{hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}</div>;
}
function Empty({ children }: { children: React.ReactNode }) { return <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{children}</p>; }

/** One headline number with its plan, whether it is achieved, and where it stands against the time that has passed. */
function KpiCard({ title, sub, k, series, color, note }: { title: string; sub: string; k: K; series?: (number | null)[]; color: string; note?: string }) {
  return (
    <Card className="gap-3 p-4" data-kpi={title}>
      <div className="flex items-start justify-between gap-2"><div><p className="text-xs font-medium text-muted-foreground">{title}</p><p className="text-[11px] text-muted-foreground">{sub}</p></div><Verdict v={k.verdict} /></div>
      <div className="flex items-end justify-between gap-3">
        <div><p className="text-[1.75rem] font-semibold leading-none tracking-tight tabular-nums">{tonne(k.actual)}</p><p className="mt-1.5 text-xs text-muted-foreground">of {k.plan > 0 ? tonne(k.plan) : "no plan"}{k.pct != null && <> · <b className="text-foreground">{k.pct.toFixed(1)}%</b></>}</p></div>
        {series && <Spark values={series} color={color} />}
      </div>
      <Bullet pct={k.pct} pace={k.verdict.pace} tone={k.verdict.tone} label={`${title}: ${k.pct == null ? "no plan" : k.pct.toFixed(1) + "% of plan"}`} />
      {note && <p className="text-[11px] text-muted-foreground">{note}</p>}
    </Card>
  );
}

export function PdcaDashboard({ access, load, now }: { access: Access | null; load?: Loader; now?: string }) {
  const targets = useMemo(() => (load ? ["WKM", "BM", "TMS"].map((s) => ({ site: s, project: { id: s } })) : ETL.reportTargets(PROJECTS, access, projectAccess)), [access, load]);
  const siteList: string[] = targets.map((t: { site: string }) => t.site);
  const [sel, setSel] = useState<string[] | null>(null);
  const chosen = sel ?? siteList;
  const [preset, setPreset] = useState("30d");
  const today = now ?? iso(new Date());
  const [custom, setCustom] = useState({ from: iso(new Date(Date.parse(today) - 29 * 864e5)), to: today });
  const [latest, setLatest] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab | ReportId>("overview");
  const [raw, setRaw] = useState<Raw>({});
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [kick, setKick] = useState(0);
  const cache = useRef(new Map<string, unknown>());

  const range = preset === "custom" ? custom : rangeFor(preset, latest ?? today);
  const tooLong = daysBetween(range.from, range.to) > 400, bad = daysBetween(range.from, range.to) < 0;
  const key = `${chosen.join(",")}|${range.from}|${range.to}|${kick}`;

  useEffect(() => {
    if (tooLong || bad || !chosen.length) return;
    let live = true;
    (async () => {
      setBusy(true);
      try {
        const want = chosen.filter((s) => !cache.current.has(`${s}|${range.from}|${range.to}|${kick}`));
        let fail: Record<string, string> = {};
        if (want.length) {
          const r = load ? await load(want, range.from, range.to) : await ETL.dashAll(targets.filter((t: { site: string }) => want.includes(t.site)), makeClient, range.from, range.to);
          want.forEach((s) => { if ((r.sites as Raw)[s]) cache.current.set(`${s}|${range.from}|${range.to}|${kick}`, (r.sites as Raw)[s]); });
          fail = r.failed as Record<string, string>;
        }
        if (!live) return;
        const next: Raw = {}; chosen.forEach((s) => { const v = cache.current.get(`${s}|${range.from}|${range.to}|${kick}`); if (v) next[s] = v; });
        setRaw(next); setFailed(fail);
        const lasts = Object.values(next).map((x) => (x as { last?: string }).last).filter(Boolean) as string[];
        const newest = lasts.sort().pop() ?? null;
        if (newest && newest !== latest) setLatest(newest);
      } catch (e) { if (live) setFailed({ All: e instanceof Error ? e.message : String(e) }); }
      finally { if (live) setBusy(false); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const m: Model = useMemo(() => buildDash(raw as never, range), [raw, range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const detail = useMemo(() => (picked ? dayDetail(raw as never, picked) : null), [raw, picked]);
  const toggle = (s: string) => { const cur = sel ?? siteList; const next = cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]; setSel(next.length === siteList.length ? null : next); setPicked(null); };
  const all = sel === null;
  const missing = Object.values(failed).some((v) => /not installed/i.test(v));

  return (
    <div className="space-y-4" data-pdca>
      {/* ---- filters ---- */}
      <Card className="gap-3 lg:sticky lg:top-[calc(var(--topbar-h,3.5rem)+0.25rem)] lg:z-[15] bg-card/95 p-3 backdrop-blur lg:flex-row lg:items-center" data-filters>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Sites">
          <button type="button" aria-pressed={all} onClick={() => { setSel(null); setPicked(null); }} className={cn("tap h-8 rounded-full border px-3 text-sm font-medium", all ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-accent")}>All sites</button>
          {siteList.map((s) => <button key={s} type="button" aria-pressed={chosen.includes(s) && !all} onClick={() => toggle(s)} className={cn("tap inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm font-medium", chosen.includes(s) && !all ? "border-primary bg-accent" : "bg-card hover:bg-accent")}><span className="size-2 rounded-full" style={{ background: SITE_COLOR[s] }} aria-hidden />{s}</button>)}
          {!siteList.length && <span className="text-sm text-muted-foreground">No site project is open to your account.</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
          <div className="inline-flex flex-wrap rounded-lg border bg-muted/50 p-0.5" role="group" aria-label="Date range">
            {PRESETS.map((p: { id: string; label: string }) => <button key={p.id} type="button" aria-pressed={preset === p.id} onClick={() => { if (p.id === "custom") setCustom(range); setPreset(p.id); setPicked(null); }} className={cn("tap h-7 rounded-md px-2.5 text-xs font-medium", preset === p.id ? "bg-card shadow-xs" : "text-muted-foreground hover:text-foreground")}>{p.label}</button>)}
          </div>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">From<input type="date" value={range.from} max={range.to} onChange={(e) => { setCustom({ from: e.target.value, to: range.to }); setPreset("custom"); }} className="h-8 rounded-md border bg-background px-2 text-sm text-foreground" /></label>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">to<input type="date" value={range.to} min={range.from} onChange={(e) => { setCustom({ from: range.from, to: e.target.value }); setPreset("custom"); }} className="h-8 rounded-md border bg-background px-2 text-sm text-foreground" /></label>
          <button type="button" onClick={() => { cache.current.clear(); setKick((k) => k + 1); }} aria-label="Reload data" className="tap grid size-8 place-items-center rounded-md border hover:bg-accent">{busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}</button>
        </div>
      </Card>
      {tooLong && <p role="alert" className="rounded-md border border-[var(--warning-border)] bg-[var(--warning-bg)] p-3 text-sm">The range is longer than 400 days. Shorten it.</p>}
      {bad && <p role="alert" className="rounded-md border border-[var(--warning-border)] bg-[var(--warning-bg)] p-3 text-sm">The start date is after the end date.</p>}
      {Object.entries(failed).map(([k, v]) => <p key={k} role="alert" className="flex items-start gap-2 rounded-md border border-[var(--danger-border)] bg-[var(--danger-bg)] p-3 text-sm"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--danger)]" aria-hidden /><span><b>{k}</b>: {v}</span></p>)}
      {missing && <p className="text-xs text-muted-foreground">Open the Supabase SQL Editor of that site and run <code className="font-mono">supabase/sql/etl_08_dashboard.sql</code> once (after <code className="font-mono">etl_07_report.sql</code>), then reload.</p>}

      {/* ---- story: one sentence for each step of the cycle ---- */}
      <div className={cn("min-w-0 transition-opacity", busy && "opacity-60")} aria-busy={busy}>
        <Card className="gap-1 border-0 bg-accent/60 p-5" data-story>
          <p className="text-xs font-medium uppercase tracking-wider text-brand">{range.from} to {range.to} · {chosen.join(" + ") || "no site"}{m.latest ? ` · data until ${m.latest}` : ""}</p>
          <h2 className="text-lg font-semibold leading-snug tracking-tight text-balance sm:text-xl">{busy && !m.last ? "Reading the site databases…" : m.story.headline}</h2>
        </Card>

        <nav className="mt-4 flex gap-1 overflow-x-auto rounded-xl border bg-card p-1" role="tablist" aria-label="Dashboard sections">
          {TABS.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} data-tab={id} onClick={() => setTab(id)} className={cn("tap h-9 shrink-0 rounded-lg px-3.5 text-sm font-medium", tab === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>{PDCA_TAG[label] && <span className="mr-1.5 opacity-70">{PDCA_TAG[label]}</span>}{label}</button>)}
        </nav>

        <nav className="mt-2 flex items-center gap-1 overflow-x-auto rounded-xl border bg-card p-1" role="tablist" aria-label="Reports by table">
          <span className="shrink-0 px-2.5 text-xs font-medium text-muted-foreground">By table</span>
          {REPORTS.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} data-tab={id} onClick={() => setTab(id)} className={cn("tap h-9 shrink-0 rounded-lg px-3.5 text-sm font-medium", tab === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>{label}</button>)}
        </nav>

        <div className="mt-4 min-w-0 space-y-4 [&_.grid>*]:min-w-0 [&_.grid]:min-w-0">
          {!m.last && !busy && <Empty>No production or shipment day is loaded in this range. Pick a wider range or load the days on the Uploads page.</Empty>}
          {m.last && tab === "overview" && <Overview m={m} setTab={setTab} picked={picked} setPicked={setPicked} detail={detail} />}
          {m.last && tab === "plan" && <PlanTab m={m} />}
          {m.last && tab === "do" && <DoTab m={m} picked={picked} setPicked={setPicked} />}
          {m.last && tab === "check" && <CheckTab m={m} />}
          {m.last && tab === "act" && <ActTab m={m} />}
          {tab === "data" && <DataTab raw={raw} m={m} />}
          {REPORTS.some(([id]) => id === tab) && <ReportsView raw={raw} range={range} id={tab as ReportId} onGo={setTab} dash={m} />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- overview
function Overview({ m, setTab, picked, setPicked, detail }: { m: Model; setTab: (t: Tab) => void; picked: string | null; setPicked: (d: string | null) => void; detail: ReturnType<typeof dayDetail> | null }) {
  const t = m.totals, tr = m.trend;
  const steps = [["Plan", m.story.plan, "plan"], ["Do", m.story.do, "do"], ["Check", m.story.check, "check"], ["Act", m.story.act, "act"]] as const;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard title="Shipment · range" sub={`${m.from} to ${m.to}`} k={t.ship.range as K} series={tr.ship} color={C.ship} />
        <KpiCard title="Production · range" sub="Ore LGO + MGO + HGO" k={t.prod.range as K} series={tr.prod} color={C.prod} />
        <KpiCard title="Shipment · year" sub="Against the Year Plan" k={t.ship.ytd as K} color={C.ship} note={`${((m.outlook[1].ytd / (m.outlook[1].plan || 1)) * 100).toFixed(0)}% done, ${(daysBetween(m.last!.slice(0, 4) + "-01-01", m.last!) + 1)} of the year's days passed`} />
        <KpiCard title="Production · year" sub="Against the Year Plan" k={t.prod.ytd as K} color={C.prod} />
      </div>

      <Card className="p-4" data-cycle>
        <Title hint="Plan, Do, Check, Act in one sentence each. Open a step for the numbers.">The cycle in four sentences</Title>
        <ol className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          {steps.map(([name, text, id]) => (
            <li key={name}><button type="button" onClick={() => setTab(id as Tab)} className="lift nudge group flex h-full w-full items-start gap-3 rounded-lg border bg-card p-3 text-left hover:bg-accent/50">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-sm font-bold text-brand">{PDCA_TAG[name]}</span>
              <span className="min-w-0 text-sm"><span className="flex items-center gap-1 font-semibold">{name}<ChevronRight className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden /></span><span className="mt-0.5 block text-muted-foreground">{text}</span></span>
            </button></li>
          ))}
        </ol>
      </Card>

      <Card className="min-w-0 p-4">
        <Title n="" hint="Dashed grey is the plan. The orange and blue lines are what was done. A line that falls under the grey one is behind plan.">Cumulative shipment and production against plan</Title>
        <DayChart aria="Cumulative production and shipment against plan" days={tr.days} unit=" t" onPick={(d) => setPicked(d === picked ? null : d)} picked={picked} series={[
          { name: "Shipment", color: C.ship, kind: "line", values: tr.cumShip }, { name: "Shipment plan", color: C.ship, kind: "line", dashed: true, values: tr.cumPlanShip },
          { name: "Production", color: C.prod, kind: "line", values: tr.cumProd }, { name: "Production plan", color: C.prod, kind: "line", dashed: true, values: tr.cumPlanProd },
        ]} />
        {detail && picked && (
          <div className="mt-3 overflow-x-auto rounded-lg border" data-day-detail>
            <table className="w-full min-w-[34rem] text-sm"><caption className="bg-muted/50 px-3 py-1.5 text-left text-xs font-semibold">{dlabel(picked)} {picked.slice(0, 4)}, site by site</caption>
              <thead><tr className="text-left text-xs text-muted-foreground"><th className="px-3 py-1.5">Site</th><th className="px-2 text-right">Production</th><th className="px-2 text-right">Plan</th><th className="px-2 text-right">Shipment</th><th className="px-2 text-right">Plan</th><th className="px-2 text-right">Work hrs</th><th className="px-2 text-right">Rain hrs</th><th className="px-2 text-right">Hazards</th></tr></thead>
              <tbody>{detail.map((r) => <tr key={r.site} className="border-t"><td className="px-3 py-1.5 font-medium">{r.site}{!r.loaded && <span className="ml-1.5 text-xs font-normal text-[var(--warning)]">not loaded</span>}</td><td className="px-2 text-right tabular-nums">{nf(r.prod)}</td><td className="px-2 text-right tabular-nums text-muted-foreground">{nf(r.planProd)}</td><td className="px-2 text-right tabular-nums">{nf(r.ship)}</td><td className="px-2 text-right tabular-nums text-muted-foreground">{nf(r.planShip)}</td><td className="px-2 text-right tabular-nums">{nf(r.ewh, 1)}</td><td className="px-2 text-right tabular-nums">{nf(r.rain, 1)}</td><td className="px-2 text-right tabular-nums">{r.hazards}</td></tr>)}</tbody></table>
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <Card className="min-w-0 p-4">
          <Title hint="Each site against its own plan. The thin tick is how much of the period has passed.">Where each site stands</Title>
          <div className="overflow-x-auto"><table className="w-full min-w-[30rem] text-sm">
            <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1.5">Site</th><th>Shipment · range</th><th>Production · range</th><th>Year to date</th><th>Data</th></tr></thead>
            <tbody>{m.siteRows.map((r) => (
              <tr key={r.site} className="border-t align-top"><td className="py-2 pr-2 font-semibold"><span className="mr-1.5 inline-block size-2 rounded-full" style={{ background: SITE_COLOR[r.site] }} aria-hidden />{r.site}</td>
                {[r.ship.range, r.prod.range].map((k, i) => <td key={i} className="py-2 pr-3"><div className="mb-1 flex items-center justify-between gap-2"><b className="tabular-nums">{k.pct == null ? "–" : k.pct.toFixed(0) + "%"}</b><Verdict v={k.verdict as K["verdict"]} /></div><Bullet pct={k.pct} pace={k.verdict.pace} tone={k.verdict.tone} label={`${r.site} ${i ? "production" : "shipment"} ${k.pct == null ? "no plan" : k.pct.toFixed(0) + "%"}`} /></td>)}
                <td className="py-2 pr-3"><div className="mb-1 text-xs text-muted-foreground">ship <b className="text-foreground">{r.ship.ytd.pct == null ? "–" : r.ship.ytd.pct.toFixed(0) + "%"}</b> · prod <b className="text-foreground">{r.prod.ytd.pct == null ? "–" : r.prod.ytd.pct.toFixed(0) + "%"}</b></div><Bullet pct={r.ship.ytd.pct} pace={r.ship.ytd.verdict.pace} tone={r.ship.ytd.verdict.tone} label={`${r.site} year to date shipment`} /></td>
                <td className="py-2 text-xs">{r.stale ? <span className="inline-flex items-center gap-1 text-[var(--warning)]"><AlertTriangle className="size-3" aria-hidden />until {r.last?.slice(5)}</span> : <span className="text-muted-foreground">{r.haveDays}/{r.spanDays} days</span>}</td></tr>
            ))}</tbody></table></div>
        </Card>
        <Card className="min-w-0 p-4">
          <Title hint="Ranked. The first lines are what to do first.">What to do first</Title>
          {m.acts.length ? <ul className="space-y-2">{m.acts.slice(0, 4).map((a, i) => (
            <li key={i} className={cn("rounded-lg border p-2.5 text-sm", SEV_CLS[a.sev])}><p className={cn("font-semibold", SEV_TXT[a.sev])}>{a.title}</p><p className="mt-0.5 text-xs text-foreground/80">{a.text}</p></li>))}
          </ul> : <Empty>Nothing needs action in this range.</Empty>}
          {m.acts.length > 4 && <button type="button" onClick={() => setTab("act")} className="mt-2 text-sm font-medium text-brand hover:underline">All {m.acts.length} actions</button>}
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- plan
function PlanTab({ m }: { m: Model }) {
  return (
    <>
      <Card className="gap-1 p-4"><Title n="P" hint="The Year Plan is the year column of the calendar. The range plan adds up the daily plan inside the dates you chose.">What we committed to</Title>
        <p className="text-sm text-muted-foreground">{m.story.plan}</p></Card>
      <div className="grid gap-4 lg:grid-cols-2">
        {m.outlook.map((o) => {
          const name = o.key === "prod" ? "Production" : "Shipment", col = o.key === "prod" ? C.prod : C.ship, pctV = o.projectedPct;
          const tone: Tone = pctV == null ? "none" : pctV >= 100 ? "good" : pctV >= 90 ? "pace" : "bad";
          return (
            <Card key={o.key} className="gap-3 p-4" data-outlook={o.key}>
              <div className="flex items-center gap-4"><Ring pct={o.plan > 0 ? (o.ytd / o.plan) * 100 : null} tone={tone} label={`${name} year to date`} />
                <div className="min-w-0"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{name} · Year Plan</p><p className="font-serif text-2xl tabular-nums">{tonne(o.plan)}</p><p className="text-xs text-muted-foreground">{tonne(o.ytd)} done · {o.left} days left in the year</p></div></div>
              <dl className="grid grid-cols-3 gap-2 text-center text-sm">
                <div className="rounded-lg bg-muted/50 p-2"><dt className="text-[11px] text-muted-foreground">Now doing</dt><dd className="font-semibold tabular-nums">{short(o.avgDay)} t/day</dd></div>
                <div className="rounded-lg bg-muted/50 p-2"><dt className="text-[11px] text-muted-foreground">Needs</dt><dd className="font-semibold tabular-nums">{o.needDay == null ? "–" : short(o.needDay) + " t/day"}</dd></div>
                <div className={cn("rounded-lg border p-2", TONE_CLS[tone])}><dt className="text-[11px] opacity-80">Year end at this rate</dt><dd className="font-semibold tabular-nums">{pctV == null ? "–" : pctV.toFixed(0) + "%"}</dd></div>
              </dl>
              <p className="text-xs text-muted-foreground" style={{ borderLeft: `3px solid ${col}`, paddingLeft: 8 }}>{o.needDay != null && o.avgDay > 0 ? (o.needDay > o.avgDay ? `To reach the plan the daily rate must rise by ${(((o.needDay - o.avgDay) / o.avgDay) * 100).toFixed(0)}%.` : "The current rate is enough to reach the plan.") : "No rate can be worked out for this range."}</p>
            </Card>
          );
        })}
      </div>
      <Card className="min-w-0 p-4"><Title hint="The plan of each site: annual, month and the range you picked.">Plan by site</Title>
        <div className="overflow-x-auto"><table className="w-full min-w-[34rem] text-sm"><thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1.5">Site</th><th className="text-right">Production · year</th><th className="text-right">Shipment · year</th><th className="text-right">Production · month</th><th className="text-right">Shipment · month</th><th className="text-right">Production · range</th><th className="text-right">Shipment · range</th></tr></thead>
          <tbody>{m.siteRows.map((r) => <tr key={r.site} className="border-t"><td className="py-1.5 font-semibold">{r.site}</td>{[r.prod.ytd.plan, r.ship.ytd.plan, r.prod.mtd.plan, r.ship.mtd.plan, r.prod.range.plan, r.ship.range.plan].map((v, i) => <td key={i} className="text-right tabular-nums">{v > 0 ? nf(v) : <span className="text-muted-foreground">no plan</span>}</td>)}</tr>)}
            <tr className="border-t bg-muted/40 font-semibold"><td className="py-1.5">Total</td>{[m.totals.prod.ytd.plan, m.totals.ship.ytd.plan, m.totals.prod.mtd.plan, m.totals.ship.mtd.plan, m.totals.prod.range.plan, m.totals.ship.range.plan].map((v, i) => <td key={i} className="text-right tabular-nums">{nf(v)}</td>)}</tr></tbody></table></div>
      </Card>
      <Card className="min-w-0 p-4"><Title hint="The daily plan next to what was done. Weekends and rain show as the dips.">Daily plan against daily result</Title>
        <DayChart aria="Daily shipment against plan" days={m.trend.days} unit=" t" series={[{ name: "Shipment", color: C.ship, kind: "bar", values: m.trend.ship }, { name: "Shipment plan", color: C.plan, kind: "line", dashed: true, values: m.trend.planShip }]} />
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- do
function DoTab({ m, picked, setPicked }: { m: Model; picked: string | null; setPicked: (d: string | null) => void }) {
  const tr = m.trend, cols: Record<string, string> = { L: C.c6, M: C.c3, H: C.prod };
  return (
    <>
      <Card className="gap-1 p-4"><Title n="D" hint="What was moved, shipped and spent. Click a bar to open its day on the Overview.">What we did</Title><p className="text-sm text-muted-foreground">{m.story.do}</p></Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="min-w-0 p-4"><Title hint="Ore by grade, per day.">Production by grade</Title>
          <DayChart aria="Daily production by grade" days={tr.days} unit=" t" onPick={(d) => setPicked(d)} picked={picked} series={(["L", "M", "H"] as const).map((g, i) => ({ name: ["LGO", "MGO", "HGO"][i], color: cols[g], kind: "bar" as const, stack: "p", values: tr.grade[g] }))} /></Card>
        <Card className="min-w-0 p-4"><Title hint="Shipment per day, split by site when more than one is open.">Shipment</Title>
          <DayChart aria="Daily shipment" days={tr.days} unit=" t" onPick={(d) => setPicked(d)} picked={picked} series={m.sites.length > 1 ? m.sites.map((s) => ({ name: s, color: SITE_COLOR[s], kind: "bar" as const, stack: "s", values: tr.bySite[s].ship })) : [{ name: "Shipment", color: C.ship, kind: "bar", values: tr.ship }]} /></Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="min-w-0 p-4"><Title hint={m.strip != null ? `Stripping ratio ${m.strip.toFixed(2)}: tonnes of overburden per tonne of ore.` : undefined}>Overburden and ore</Title>
          <Parts aria="Ore by grade and overburden" items={[...m.ore.map((o) => ({ name: o.label, value: o.value })), { name: "Overburden", value: m.obTotal }]} /></Card>
        <Card className="min-w-0 p-4"><Title>Production by contractor</Title><HBars aria="Production by contractor" items={m.contractors.prod} color={C.prod} fmt={tonne} /></Card>
        <Card className="min-w-0 p-4"><Title>Shipment by contractor</Title><HBars aria="Shipment by contractor" items={m.contractors.ship} color={C.ship} fmt={tonne} /></Card>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {m.stock ? (
          <Card className="p-4" data-stock><Title hint={m.stock.cover != null ? `At the range's shipment rate the register on ${m.stock.date} covers ${m.stock.cover.toFixed(1)} days.` : undefined}>Ore stock</Title>
            <DayChart aria="Ore stock by day" days={tr.days} unit=" t" series={[{ name: "At pit (ETO)", color: C.prod, kind: "area", values: m.stock.eto }, { name: "At port (EFO)", color: C.ship, kind: "line", values: m.stock.efo }]} height={200} />
            <div className="mt-3 grid gap-3 sm:grid-cols-2">{m.stock.groups.map((g) => <div key={g.key}><p className="mb-1 text-xs font-medium text-muted-foreground">{g.label}</p><Parts aria={g.label} items={g.items} /></div>)}</div></Card>
        ) : <Card className="min-w-0 p-4"><Title>Ore stock</Title><Empty>No stock register in this range.</Empty></Card>}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
          {m.fuel ? <Card className="p-4" data-fuel><Title hint="Fuel used per day, and the stock after it.">Fuel</Title><div className="mb-2 flex flex-wrap gap-x-6 gap-y-1 text-sm"><span>Used <b className="tabular-nums">{nf(m.fuel.used)} L</b></span>{m.fuel.per != null && <span>Per tonne moved <b className="tabular-nums">{m.fuel.per.toFixed(2)} L</b></span>}<span className={m.fuel.negative ? "text-[var(--danger)]" : ""}>Stock <b className="tabular-nums">{nf(m.fuel.stock.v)} L</b>{m.fuel.stock.d && <span className="text-xs text-muted-foreground"> on {m.fuel.stock.d.slice(5)}</span>}</span></div>
            <DayChart aria="Fuel used per day" days={tr.days} unit=" L" height={150} legend={false} series={[{ name: "Fuel used", color: C.c3, kind: "bar", values: m.fuel.values }]} /></Card> : null}
          {m.manpower ? <Card className="p-4" data-manpower><Title hint={`${m.manpower.joined} joined, ${m.manpower.left} left in the range.`}>Manpower</Title><div className="mb-2 flex items-end gap-3"><p className="font-serif text-3xl tabular-nums">{nf(m.manpower.total)}</p><Spark values={m.manpower.values} color={C.c4} w={160} h={34} /></div>
            <HBars aria="Manpower by role" items={m.manpower.roles} color={C.c4} rows={6} /></Card> : null}
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="min-w-0 p-4"><Title hint="Hauled volume per day.">Hauling</Title><DayChart aria="Hauling per day" days={tr.days} unit=" t" height={170} legend={false} series={[{ name: "Hauled", color: C.c5, kind: "bar", values: tr.haul }]} /></Card>
        <Card className="p-4" data-construction><Title hint={m.construction.avg != null ? `Average progress ${m.construction.avg.toFixed(0)}%, ${m.construction.open} items still open.` : undefined}>Construction</Title>
          {m.construction.items.length ? <ul className="space-y-1.5">{m.construction.items.slice(0, 8).map((c, i) => <li key={i} className="grid grid-cols-[minmax(6rem,1fr)_6rem_2.5rem] items-center gap-2 text-sm"><span className="truncate" title={`${c.item} · ${c.category}`}>{c.item}<span className="ml-1 text-xs text-muted-foreground">{c.site}</span></span><Bullet pct={c.progress} tone={c.progress >= 100 ? "good" : "pace"} label={`${c.item} ${c.progress}%`} /><span className="text-right tabular-nums">{c.progress.toFixed(0)}%</span></li>)}</ul> : <Empty>No construction item loaded.</Empty>}</Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="min-w-0 p-4"><Title hint="Planned against drilled.">Exploration</Title>{m.explo ? <ul className="space-y-2">{m.explo.map((e) => <li key={e.label} className="text-sm"><div className="flex justify-between"><span>{e.label}</span><b className="tabular-nums">{nf(e.actual)} / {nf(e.plan)}</b></div><Bullet pct={e.pct} tone={e.pct == null ? "none" : e.pct >= 100 ? "good" : e.pct >= 80 ? "pace" : "bad"} label={`${e.label}`} /></li>)}</ul> : <Empty>No exploration rows in this range.</Empty>}</Card>
        <Card className="min-w-0 p-4"><Title hint="Samples handled per type. ID, FD and AD are the lab table's day columns.">Laboratory</Title>{m.lab ? m.lab.map((f) => <div key={f.family} className="mb-2"><p className="mb-1 text-xs font-medium text-muted-foreground">{f.family}</p><HBars aria={`Lab ${f.family}`} items={f.items} color={C.c3} rows={4} /></div>) : <Empty>No lab rows in this range.</Empty>}</Card>
        <Card className="min-w-0 p-4"><Title hint="Barge list as loaded for the site.">Barges</Title>{m.barge.length ? <ul className="space-y-2 text-sm">{m.barge.slice(0, 6).map((b, i) => <li key={i} className="rounded-lg border p-2"><div className="flex justify-between gap-2"><b className="truncate">{b.vessel}</b><span className="text-xs text-muted-foreground">{b.status}</span></div><div className="mt-1 text-xs text-muted-foreground">{b.site} · {b.contractor} · {nf(b.actual)} of {nf(b.plan)} t</div><Bullet pct={b.plan > 0 ? (b.actual / b.plan) * 100 : null} tone="pace" label={b.vessel} /></li>)}</ul> : <Empty>No barge listed.</Empty>}</Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- check
function CheckTab({ m }: { m: Model }) {
  const c = m.check, tr = m.trend;
  const avc = [C.prod, C.ship, C.c3, C.c4];
  return (
    <>
      <Card className="gap-1 p-4"><Title n="C" hint="Achieved or not, in the day, the month and the year. Under 100% is judged against the share of the period that has passed.">Did we meet the plan</Title><p className="text-sm text-muted-foreground">{m.story.check}</p></Card>
      <Card className="p-4" data-achieve><Title>Achievement table</Title>
        <div className="overflow-x-auto"><table className="w-full min-w-[40rem] text-sm"><thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1.5">Site</th><th>Measure</th>{["Latest day", "Month to date", "Year to date"].map((h) => <th key={h} className="px-2 text-right">{h}</th>)}<th className="px-2 text-right">Range</th></tr></thead>
          <tbody>{[...m.siteRows.map((r) => ({ n: r.site, p: r.prod, s: r.ship })), { n: "All", p: m.totals.prod, s: m.totals.ship }].flatMap((r) => [["Shipment", r.s], ["Production", r.p]].map(([lab, b], i) => { const x = b as Record<string, K>; return (
            <tr key={r.n + lab} className={cn("border-t", r.n === "All" && "bg-muted/40")}>{i === 0 && <td rowSpan={2} className="py-1.5 pr-2 align-top font-semibold">{r.n}</td>}<td className="py-1.5 pr-2">{lab as string}</td>
              {[x.day, x.mtd, x.ytd, x.range].map((k, j) => <td key={j} className="px-2 py-1.5 text-right"><div className="tabular-nums"><b>{k.pct == null ? "–" : k.pct.toFixed(1) + "%"}</b> <span className="text-xs text-muted-foreground">{short(k.actual)}/{k.plan > 0 ? short(k.plan) : "–"}</span></div><Verdict v={k.verdict} /></td>)}</tr>); }))}</tbody></table></div>
        <p className="mt-2 text-xs text-muted-foreground">Latest day is each site&apos;s own newest loaded day. Month and year plans are the full-period targets.</p></Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="min-w-0 p-4"><Title hint={c.avail.length ? "Average over all sites and equipment groups. A fall inside the range shows in the action list." : undefined}>Availability and utilization</Title>
          {c.avail.length ? <DayChart aria="Availability and utilization per day" days={tr.days} unit="%" minZero={false} series={c.avail.map((a, i) => ({ name: a.key, color: avc[i % 4], kind: "line" as const, values: a.values, fmt: (v: number) => v.toFixed(1) }))} /> : <Empty>No availability rows in this range.</Empty>}
          {c.avail.length > 0 && <ul className="mt-1 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">{c.avail.map((a) => <li key={a.key} className="rounded-lg bg-muted/50 p-2"><p className="text-muted-foreground">{a.label}</p><p className="text-base font-semibold tabular-nums">{a.avg?.toFixed(1)}%</p>{a.shift != null && <p className={a.shift < -3 ? "text-[var(--danger)]" : "text-muted-foreground"}>{a.shift >= 0 ? "+" : ""}{a.shift.toFixed(1)} pts, 2nd half</p>}</li>)}</ul>}</Card>
        <Card className="min-w-0 p-4"><Title hint={`${nf(c.rainTotal, 0)} rain hours in the range.`}>Effective working hours and rain</Title>
          <DayChart aria="Effective working hours and rain per day" days={tr.days} unit=" h" series={[{ name: "Working hours", color: C.c3, kind: "bar", values: c.ewh }, { name: "Rain hours", color: C.info, kind: "line", values: c.rain }]} height={200} />
          <p className="mb-1 mt-2 text-xs font-medium text-muted-foreground">Where hours were lost</p><HBars aria="Hours lost by cause" items={c.delay} color={C.warn} fmt={(v) => `${nf(v, 0)} h`} rows={5} /></Card>
      </div>
      {c.equip && <Card className="min-w-0 p-4"><Title hint="Units per day. Groups are read from the equipment table: OP operating, S standby, B breakdown, P plan.">Equipment</Title>
        <DayChart aria="Equipment units per day" days={tr.days} height={190} series={c.equip.map((g, i) => ({ name: g.label, color: [C.good, C.info, C.bad, C.plan][i % 4], kind: "line" as const, dashed: g.key === "P", values: g.values }))} /></Card>}
      <Card className="p-4" data-hse><Title hint="Counts reported in the range. Red is a case that needs an investigation.">Health, safety and environment</Title>
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg bg-muted/50 p-3 text-sm">
          {c.safeDays != null ? <><ShieldAlert className={cn("size-5", c.lastBad ? "text-[var(--danger)]" : "text-[var(--success)]")} aria-hidden /><span><b className="text-xl tabular-nums">{c.safeDays}</b> day{c.safeDays === 1 ? "" : "s"} {c.lastBad ? `since the last fatality or lost time injury (${c.lastBad})` : "with no fatality or lost time injury in this range"}</span></> : <span className="text-muted-foreground">No safety rows in this range.</span>}</div>
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">{c.hse.map((h) => <li key={h.key} className={cn("rounded-lg border p-2.5", h.total > 0 && h.tone === "bad" ? "border-[var(--danger-border)] bg-[var(--danger-bg)]" : h.total > 0 && h.tone === "warn" ? "border-[var(--warning-border)] bg-[var(--warning-bg)]" : "")}><p className="text-xs text-muted-foreground">{h.label}</p><div className="flex items-end justify-between"><p className="font-serif text-2xl tabular-nums">{h.total}</p><Spark values={h.values} color={h.tone === "bad" ? C.bad : h.tone === "warn" ? C.warn : C.info} w={64} h={22} /></div></li>)}</ul>
        <div className="mt-4 grid gap-4 md:grid-cols-2"><div><p className="mb-1 text-xs font-medium text-muted-foreground">Hazard findings by risk · {c.hazard.total} total, {c.hazard.open} open</p><HBars aria="Hazard findings by risk" items={c.hazard.byRisk} colorOf={(n) => (/high|extreme/i.test(n) ? C.bad : /medium/i.test(n) ? C.warn : C.info)} rows={5} /></div>
          <div><p className="mb-1 text-xs font-medium text-muted-foreground">By category</p><HBars aria="Hazard findings by category" items={c.hazard.byCategory} color={C.c5} rows={5} /></div></div></Card>
      <Card className="min-w-0 p-4"><Title hint="A day counts when production or shipment is loaded.">Data completeness</Title>
        <ul className="grid gap-2 sm:grid-cols-3">{m.siteRows.map((r) => <li key={r.site} className="rounded-lg border p-3 text-sm"><div className="flex justify-between"><b>{r.site}</b><span className={r.stale ? "text-[var(--warning)]" : "text-muted-foreground"}>{r.haveDays} of {r.spanDays} days</span></div><Bullet pct={r.coverage * 100} tone={r.coverage >= 0.95 ? "good" : r.coverage >= 0.8 ? "pace" : "bad"} label={`${r.site} ${(r.coverage * 100).toFixed(0)}% of days loaded`} />{r.stale && <p className="mt-1 text-xs text-[var(--warning)]">Newest loaded day {r.lastLoaded}</p>}</li>)}</ul></Card>
    </>
  );
}

// ---------------------------------------------------------------- act
function ActTab({ m }: { m: Model }) {
  const h = m.check.hazard;
  return (
    <>
      <Card className="gap-1 p-4"><Title n="A" hint="Written from the numbers. Critical and high come first.">What to do next</Title><p className="text-sm text-muted-foreground">{m.story.act}</p></Card>
      {m.acts.length ? <ol className="space-y-2" data-actions>{m.acts.map((a, i) => (
        <li key={i} className={cn("flex gap-3 rounded-xl border p-3", SEV_CLS[a.sev])}>
          <span className={cn("mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-card text-xs font-bold", SEV_TXT[a.sev])} title={a.pdca}>{PDCA_TAG[a.pdca] ?? "A"}</span>
          <div className="min-w-0"><p className="flex flex-wrap items-center gap-x-2 text-sm font-semibold"><span className={SEV_TXT[a.sev]}>{a.title}</span><span className="rounded-full border bg-card px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{a.sev}</span><span className="text-xs font-normal text-muted-foreground">{a.site}</span></p><p className="mt-0.5 text-sm text-foreground/80">{a.text}</p></div>
        </li>))}</ol> : <Empty>Nothing needs action in this range.</Empty>}
      <Card className="p-4" data-hazards><Title hint={`${h.open} not closed of ${h.total} in the range. Highest risk first.`}>Open hazard findings and their corrective action</Title>
        {h.openList.length ? <div className="overflow-x-auto"><table className="w-full min-w-[40rem] text-sm"><thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1.5">Date</th><th>Site</th><th>Risk</th><th>Where</th><th>Hazard</th><th>Corrective action</th><th>Status</th></tr></thead>
          <tbody>{h.openList.map((x, i) => <tr key={i} className="border-t align-top"><td className="py-1.5 pr-2 tabular-nums">{x.date.slice(5)}</td><td className="pr-2">{x.site}</td><td className="pr-2"><span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-semibold", /high|extreme/i.test(x.risk) ? TONE_CLS.bad : /medium/i.test(x.risk) ? "border-[var(--warning-border)] bg-[var(--warning-bg)] text-[var(--warning)]" : TONE_CLS.pace)}>{x.risk}</span></td><td className="pr-2">{x.location}</td><td className="pr-2">{x.hazard}</td><td className="pr-2">{x.action}</td><td>{x.status}</td></tr>)}</tbody></table></div> : <Empty>No open hazard finding in this range.</Empty>}</Card>
    </>
  );
}

// ---------------------------------------------------------------- all tables
function DataTab({ raw, m }: { raw: Raw; m: Model }) {
  const [tbl, setTbl] = useState("tblRAWMNG");
  const cols: string[] = useMemo(() => explorerColumns(raw as never, tbl), [raw, tbl]);
  const [col, setCol] = useState("");
  const [q, setQ] = useState("");
  const use = cols.includes(col) ? col : cols[0] ?? "";
  const avg = /^(tblRAWUP)$/.test(tbl) || /PA\)|MA\)|UA\)|EU\)|-Ni$|-Fe$|-MC$/.test(use);
  const rows = useMemo(() => cols.filter((c) => c.toLowerCase().includes(q.toLowerCase())).map((c) => { const s = explorerSeries(raw as never, tbl, c, m.days, /^(tblRAWUP)$/.test(tbl) || /PA\)|MA\)|UA\)|EU\)|-Ni$|-Fe$|-MC$/.test(c)); const vals = s.values.filter((v: number | null): v is number => v != null); return { c, values: s.values, total: s.total, avg: vals.length ? vals.reduce((a: number, b: number) => a + b, 0) / vals.length : null, last: [...s.values].reverse().find((v: number | null) => v != null) ?? null }; }), [cols, q, raw, tbl, m.days]);
  const cur = useMemo(() => explorerSeries(raw as never, tbl, use, m.days, avg), [raw, tbl, use, m.days, avg]);
  return (
    <Card className="p-4" data-explorer>
      <Title hint="Every dashboard column of the 14 tables the site master keeps (tblRAW* and the calendar). Pick a table, then a column. Cumulative columns (MTD, YTD) are shown as the daily sum of the loaded rows; read them on one day.">All tables</Title>
      <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Table">{(TABLE_INFO as [string, string][]).map(([id, label]) => <button key={id} role="tab" aria-selected={tbl === id} onClick={() => { setTbl(id); setCol(""); setQ(""); }} className={cn("tap h-8 rounded-full border px-3 text-xs font-medium", tbl === id ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-accent")} title={id}>{label}</button>)}</div>
      {!cols.length ? <Empty>No loaded value for {tbl} in this range.</Empty> : (
        <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2"><label className="text-sm">Column <select value={use} onChange={(e) => setCol(e.target.value)} className="ml-1 h-8 max-w-[16rem] rounded-md border bg-background px-2 text-sm">{cols.map((c) => <option key={c}>{c}</option>)}</select></label><span className="text-xs text-muted-foreground">{avg ? "average per row" : "sum of rows"} · total {nf(cur.total, 1)}</span></div>
            <DayChart aria={`${tbl} ${use} per day`} days={m.days} legend={false} height={230} minZero={false} series={[{ name: use, color: C.ship, kind: "bar", values: cur.values }]} />
          </div>
          <div className="min-w-0"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${cols.length} columns`} aria-label="Filter columns" className="mb-2 h-8 w-full rounded-md border bg-background px-2 text-sm" />
            <div className="max-h-[22rem] overflow-auto rounded-lg border"><table className="w-full text-xs"><thead className="sticky top-0 bg-muted text-left"><tr><th className="px-2 py-1.5">Column</th><th className="px-2 text-right">Total</th><th className="px-2 text-right">Last</th><th className="px-2" /></tr></thead>
              <tbody>{rows.map((r) => <tr key={r.c} onClick={() => setCol(r.c)} className={cn("cursor-pointer border-t hover:bg-accent/50", r.c === use && "bg-accent")}><td className="px-2 py-1 font-medium">{r.c}</td><td className="px-2 text-right tabular-nums">{nf(r.total, 1)}</td><td className="px-2 text-right tabular-nums">{nf(r.last, 1)}</td><td className="px-2"><Spark values={r.values} w={54} h={16} /></td></tr>)}</tbody></table></div></div>
        </div>
      )}
    </Card>
  );
}
