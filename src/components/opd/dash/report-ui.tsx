"use client";
import { ArrowRight, CloudRain } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { buildReports } from "@/lib/opd/dash-reports.js";
import { Bullet, nf, Waterfall, dlabel, type WfStep } from "@/components/opd/dash/charts";
import type { ReportId } from "@/components/opd/dash/reports";

export type M = ReturnType<typeof buildReports>;
export type WfOk = { ok: true; rate: number; days: number; gap: number; steps: WfStep[]; worst: { label: string; value: number } };
export const wfOf = (m: M) => (m.wf.ok ? (m.wf as unknown as WfOk) : null);
export type Range = { from: string; to: string };
export const tone = (p: number | null): "good" | "pace" | "bad" | "none" => (p == null ? "none" : p >= 100 ? "good" : p >= 90 ? "pace" : "bad");
export const pc = (a: number, b: number) => (b > 0 ? (a / b) * 100 : null);

export function Head({ k, children }: { k: string; children: React.ReactNode }) {
  return <Card className="gap-1 border-0 bg-accent/60 p-5"><p className="text-xs font-medium uppercase tracking-wider text-brand">{k}</p><h2 className="text-lg font-semibold leading-snug tracking-tight text-balance sm:text-xl">{children}</h2></Card>;
}
export function Kpi({ label, value, unit, sub, pct, accent }: { label: string; value: string; unit?: string; sub?: string; pct?: number | null; accent?: string }) {
  return (
    <Card className="min-w-0 gap-2 p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-[1.6rem] font-semibold leading-none tracking-tight tabular-nums">{value}{unit && <span className="ml-1 text-sm font-normal text-muted-foreground">{unit}</span>}</p>
      {pct !== undefined ? <Bullet pct={pct} tone={tone(pct)} label={`${label} ${pct == null ? "no plan" : pct.toFixed(0) + "% of plan"}`} /> : accent ? <div className="h-1.5 rounded-full" style={{ background: accent, opacity: 0.5 }} aria-hidden /> : null}
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </Card>
  );
}
export function Panel({ title, hint, children, className }: { title: string; hint?: string; children: React.ReactNode; className?: string }) {
  return <Card className={cn("min-w-0 p-4", className)}><div className="mb-2"><h3 className="text-base font-semibold">{title}</h3>{hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}</div>{children}</Card>;
}
export function Related({ items, onGo }: { items: [ReportId, string, string][]; onGo: (id: ReportId) => void }) {
  return (
    <Panel title="What it is linked with" hint="Open the related report to see the other side of the story.">
      <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{items.map(([id, name, why]) => (
        <li key={id}><button type="button" onClick={() => onGo(id)} className="lift nudge group flex h-full w-full items-start gap-2 rounded-lg border p-3 text-left hover:bg-accent/50"><span className="min-w-0 text-sm"><span className="flex items-center gap-1 font-semibold">{name}<ArrowRight className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden /></span><span className="mt-0.5 block text-xs text-muted-foreground">{why}</span></span></button></li>
      ))}</ul>
    </Panel>
  );
}

/** One day picked in any chart is explained below it: how far it was from the average and which causes line up with that. */
export function DayWhy({ m, picked }: { m: M; picked: string | null }) {
  if (!picked) return <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">Click a bar in any chart above to see why that day was high or low.</p>;
  const e = m.explainDay(picked);
  return (
    <div className="rounded-lg border bg-muted/40 p-3 text-sm" data-day-why>
      <p className="font-semibold">{dlabel(picked)}: {e.ob != null ? `${nf(e.ob)} BCM` : "no overburden loaded"}{e.pctPlan != null && <span className="font-normal text-muted-foreground"> · {e.pctPlan.toFixed(0)}% of plan</span>}{e.vsAvg != null && <span className="font-normal text-muted-foreground"> · {e.vsAvg >= 0 ? "+" : ""}{e.vsAvg.toFixed(0)}% against the range average</span>}</p>
      {e.reasons.length ? <ul className="mt-1 list-disc space-y-0.5 pl-5">{e.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : <p className="mt-1 text-muted-foreground">Nothing in the loaded hours or units stands out for this day.</p>}
    </div>
  );
}
export function WorstDays({ m, onPick }: { m: M; onPick: (d: string) => void }) {
  if (!m.worst.length) return null;
  return (
    <Panel title="The five weakest days and why" hint="Lowest overburden against plan. The reasons are the causes that sit furthest from the range average that day.">
      <ol className="space-y-2" data-worst>{m.worst.map((e) => (
        <li key={e.day} className="rounded-lg border p-3"><button type="button" onClick={() => onPick(e.day)} className="text-left"><b className="text-sm">{dlabel(e.day)}</b> <span className="text-sm text-muted-foreground">{nf(e.ob)} BCM{e.pctPlan != null && ` · ${e.pctPlan.toFixed(0)}% of plan`}</span></button>
          <p className="mt-0.5 text-sm">{e.reasons.length ? e.reasons.join("; ") + "." : "No single cause stands out."}</p></li>
      ))}</ol>
    </Panel>
  );
}
export function WaterfallCard({ m, compact }: { m: M; compact?: boolean }) {
  if (!m.wf.ok) return <Panel title="Where the plan was won or lost"><p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{m.wf.why}</p></Panel>;
  const w = wfOf(m)!, worst = w.worst;
  return (
    <Panel title="Where the plan was won or lost" hint={`Overburden in BCM, ${w.days} days. Each bar is the hours against plan times ${nf(w.rate, 1)} BCM per working hour. Availability uses plan against actual PA. Productivity is what is left.`}>
      <p className="mb-2 text-sm">{w.gap >= 0 ? "Ahead of plan by" : "Behind plan by"} <b className="tabular-nums">{nf(Math.abs(w.gap))} BCM</b>. {worst && worst.value < 0 && <>The biggest loss is <b>{worst.label}</b> at {nf(worst.value)} BCM.</>}</p>
      <Waterfall steps={w.steps} aria="Waterfall from production plan to actual production by cause" height={compact ? 270 : 320} />
    </Panel>
  );
}
export function RainPanel({ m, only }: { m: M; only?: string[] }) {
  const r = m.rainEffect;
  if (!r.ok) return <Panel title="What rain does to everything else"><p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Needs at least one rainy day (rain and slippery 1 h or more) and one dry day in this range. Found {r.nRain} rainy and {r.nDry} dry.</p></Panel>;
  const rows = (only ? (r.rows ?? []).filter((x: { label: string }) => only.includes(x.label)) : r.rows ?? []) as { label: string; unit: string; dry: number; rain: number; change: number | null; goodUp: boolean }[];
  return (
    <Panel title="What rain does to everything else" hint={`${r.nRain} rainy days (rain and slippery 1 h or more) against ${r.nDry} dry days. Daily averages.`}>
      <div className="overflow-x-auto"><table className="w-full min-w-[26rem] text-sm" data-rain><thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1.5">Measure</th><th className="text-right">Dry day</th><th className="text-right">Rainy day</th><th className="text-right">Change</th></tr></thead>
        <tbody>{rows.map((x) => { const bad = x.change != null && Math.abs(x.change) >= 5 && (x.goodUp ? x.change < 0 : x.change > 0); return (
          <tr key={x.label} className="border-t"><td className="py-1.5">{x.label} <span className="text-xs text-muted-foreground">{x.unit}</span></td><td className="text-right tabular-nums">{nf(x.dry, x.dry < 20 ? 1 : 0)}</td><td className="text-right tabular-nums">{nf(x.rain, x.rain < 20 ? 1 : 0)}</td>
            <td className={cn("text-right font-semibold tabular-nums", bad ? "text-[var(--danger)]" : "text-muted-foreground")}>{x.change == null ? "–" : `${x.change > 0 ? "+" : ""}${x.change.toFixed(0)}%`}</td></tr>); })}</tbody></table></div>
      {m.link.rain && <p className="mt-2 flex items-start gap-2 text-xs text-muted-foreground"><CloudRain className="mt-0.5 size-3.5 shrink-0" aria-hidden />Across {m.link.rain.n} days, each rain or slippery hour goes with {m.link.rain.slope >= 0 ? "+" : "−"}{nf(Math.abs(m.link.rain.slope))} BCM of overburden (correlation {m.link.rain.r.toFixed(2)}). A pattern, not proof.</p>}
    </Panel>
  );
}

export type Flow = { ok: boolean; why?: string; steps?: WfStep[]; first?: string; last?: string; rest?: number; skipped?: number };
/** A stock-like column explained by what came in and went out. The last bar is whatever those flows do not explain. */
export function FlowCard({ title, hint, b, unit, aria, labels }: { title: string; hint: string; b: Flow; unit: string; aria: string; labels: [string, string, string] }) {
  if (!b.ok || !b.steps) return <Panel title={title}><p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{b.why}</p></Panel>;
  const open = b.steps[0].value, close = b.steps[b.steps.length - 1].value, adj = b.steps[b.steps.length - 2];
  return (
    <Panel title={title} hint={hint}>
      <p className="mb-2 text-sm">From {b.first?.slice(5)} to {b.last?.slice(5)} the figure went from <b className="tabular-nums">{nf(open)}</b> to <b className="tabular-nums">{nf(close)}</b> {unit}. {Math.abs(adj.value) > Math.abs(close - open) * 0.5 && Math.abs(adj.value) > 0.02 * Math.max(open, close, 1) ? <>More than half of the change is <b>{adj.label.toLowerCase()}</b>, which the flows above do not explain. Check that column.</> : <>The flows explain most of the change.</>}</p>
      <Waterfall steps={b.steps} unit={unit} aria={aria} height={260} labels={labels} />
    </Panel>
  );
}
