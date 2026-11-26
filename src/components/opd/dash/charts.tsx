"use client";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/* Small SVG charts for the interactive dashboard. No chart library: each chart draws a few marks, labels them directly and
   gives every value to keyboard and touch users through a readout. Colors come from the design tokens (--chart-*). */

export const C = { prod: "var(--chart-2)", ship: "var(--chart-1)", plan: "var(--chart-plan)", good: "var(--success)", bad: "var(--danger)", warn: "var(--warning)", info: "var(--info)", ink: "var(--chart-text)", grid: "var(--chart-grid)", c3: "var(--chart-3)", c4: "var(--chart-4)", c5: "var(--chart-5)", c6: "var(--chart-6)" };
export const SITE_COLOR: Record<string, string> = { WKM: "var(--chart-1)", BM: "var(--chart-3)", TMS: "var(--chart-4)" };

export const nf = (v: number | null | undefined, dp = 0) => (v == null || !Number.isFinite(v) ? "–" : v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }));
export const short = (v: number | null | undefined) => { if (v == null || !Number.isFinite(v)) return "–"; const a = Math.abs(v); return a >= 1e6 ? `${(v / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M` : a >= 1e4 ? `${(v / 1e3).toFixed(0)}k` : a >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2); };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const dlabel = (iso: string) => `${+iso.slice(8, 10)} ${MON[+iso.slice(5, 7) - 1]}`;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(240, Math.round(el.getBoundingClientRect().width))));
    ro.observe(el); setW(Math.max(240, Math.round(el.getBoundingClientRect().width)));
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}
function niceMax(v: number) { if (!(v > 0)) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); const f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }

export type Serie = { name: string; color: string; values: (number | null)[]; kind?: "bar" | "line" | "area"; dashed?: boolean; stack?: string; fmt?: (v: number) => string };

/** Day chart: bars, lines and areas on one axis. Hover or touch reads a day; click or Enter picks it. */
export function DayChart({ days, series, height = 240, onPick, picked, unit = "", legend = true, minZero = true, aria }: { days: string[]; series: Serie[]; height?: number; onPick?: (d: string) => void; picked?: string | null; unit?: string; legend?: boolean; minZero?: boolean; aria: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [off, setOff] = useState<Record<string, boolean>>({});
  const live = series.filter((s) => !off[s.name]);
  const padL = 44, padR = 10, padT = 10, padB = 26, iw = Math.max(10, w - padL - padR), ih = height - padT - padB, n = Math.max(1, days.length);
  // stacked bars add up per day; everything else is read on its own
  const stacks = [...new Set(live.filter((s) => s.kind === "bar" && s.stack).map((s) => s.stack!))];
  let hi = 0, lo = 0;
  days.forEach((_, i) => {
    stacks.forEach((g) => { hi = Math.max(hi, live.filter((s) => s.stack === g && s.kind === "bar").reduce((a, s) => a + (s.values[i] || 0), 0)); });
    live.forEach((s) => { if (s.kind === "bar" && s.stack) return; const v = s.values[i]; if (v != null) { hi = Math.max(hi, v); lo = Math.min(lo, v); } });
  });
  const top = niceMax(hi), bottom = minZero ? Math.min(0, lo) : lo;
  const y = (v: number) => padT + ih - ((v - bottom) / (top - bottom || 1)) * ih;
  const bw = Math.max(1, (iw / n) * 0.72), x = (i: number) => padL + (iw / n) * (i + 0.5);
  const ticks = [0, 1, 2, 3, 4].map((k) => bottom + ((top - bottom) * k) / 4);
  const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 64))));
  const idxAt = (px: number) => Math.min(n - 1, Math.max(0, Math.floor(((px - padL) / iw) * n)));
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => { const r = e.currentTarget.getBoundingClientRect(); setHover(idxAt(e.clientX - r.left)); };
  const cum: Record<string, number> = {};
  const pathOf = (s: Serie) => { let d = "", pen = false; s.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`; pen = true; }); return d; };
  const sel = picked ? days.indexOf(picked) : -1;
  const hv = hover ?? (sel >= 0 ? sel : null);
  return (
    <div ref={ref} className="w-full">
      {legend && series.length > 1 && (
        <ul className="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Legend">
          {series.map((s) => (
            <li key={s.name}><button type="button" aria-pressed={!off[s.name]} onClick={() => setOff((o) => ({ ...o, [s.name]: !o[s.name] }))} className={cn("tap inline-flex items-center gap-1.5 rounded px-1 py-0.5", off[s.name] && "opacity-40 line-through")}>
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color, opacity: s.dashed ? 0.6 : 1 }} aria-hidden />{s.name}</button></li>
          ))}
        </ul>
      )}
      <svg width={w} height={height} role="img" aria-label={aria} onPointerMove={onMove} onPointerLeave={() => setHover(null)} onClick={() => hover != null && onPick?.(days[hover])} className="touch-pan-y select-none">
        {ticks.map((t, k) => (<g key={k}><line x1={padL} x2={w - padR} y1={y(t)} y2={y(t)} stroke={C.grid} strokeWidth={k === 0 ? 1.2 : 0.6} /><text x={padL - 6} y={y(t) + 3.5} textAnchor="end" fontSize="10.5" fill={C.ink}>{short(t)}</text></g>))}
        {days.map((d, i) => (i % step === 0 ? <text key={d} x={x(i)} y={height - 8} textAnchor="middle" fontSize="10.5" fill={C.ink}>{dlabel(d)}</text> : null))}
        {sel >= 0 && <rect x={x(sel) - (iw / n) / 2} y={padT} width={iw / n} height={ih} fill="var(--accent)" opacity={0.7} />}
        {days.map((_, i) => { Object.keys(cum).forEach((k) => delete cum[k]); return live.filter((s) => s.kind === "bar").map((s) => {
          const v = s.values[i]; if (v == null) return null;
          const base = s.stack ? (cum[s.stack] = cum[s.stack] || 0) : 0;
          if (s.stack) cum[s.stack] += v;
          const y0 = y(base), y1 = y(base + v);
          return <rect key={`${s.name}${i}`} x={x(i) - bw / 2} y={Math.min(y0, y1)} width={bw} height={Math.max(0.5, Math.abs(y0 - y1))} fill={s.color} rx={bw > 5 ? 1.5 : 0} opacity={hv != null && hv !== i ? 0.55 : 1} />;
        }); })}
        {live.filter((s) => s.kind === "area").map((s) => { const p = pathOf(s); const first = s.values.findIndex((v) => v != null); const lastI = s.values.length - 1 - [...s.values].reverse().findIndex((v) => v != null); return p ? <path key={s.name} d={`${p}L${x(lastI)} ${y(0)}L${x(first)} ${y(0)}Z`} fill={s.color} opacity={0.14} /> : null; })}
        {live.filter((s) => s.kind === "line" || s.kind === "area").map((s) => <path key={s.name} d={pathOf(s)} fill="none" stroke={s.color} strokeWidth={s.dashed ? 1.6 : 2.2} strokeDasharray={s.dashed ? "5 4" : undefined} strokeLinejoin="round" strokeLinecap="round" />)}
        {hv != null && <line x1={x(hv)} x2={x(hv)} y1={padT} y2={padT + ih} stroke={C.ink} strokeWidth={0.8} strokeDasharray="2 3" />}
        {hv != null && live.filter((s) => s.kind !== "bar" && s.values[hv] != null).map((s) => <circle key={s.name} cx={x(hv)} cy={y(s.values[hv]!)} r={3.6} fill="var(--card)" stroke={s.color} strokeWidth={2} />)}
      </svg>
      <div className="min-h-[2.75rem] text-xs" aria-live="polite">
        {hv != null ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 rounded-md bg-muted/60 px-2.5 py-1.5">
            <b className="tabular-nums">{dlabel(days[hv])} {days[hv].slice(0, 4)}</b>
            {live.map((s) => <span key={s.name} className="inline-flex items-center gap-1.5 tabular-nums"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} aria-hidden />{s.name} <b>{s.values[hv] == null ? "–" : s.fmt ? s.fmt(s.values[hv]!) : nf(s.values[hv], Math.abs(s.values[hv]!) < 10 ? 2 : 0)}{unit}</b></span>)}
          </div>
        ) : <span className="text-muted-foreground">{onPick ? "Hover or tap a day to read it. Click a day to open its detail." : "Hover or tap a day to read it."}</span>}
      </div>
    </div>
  );
}

/** Ranked horizontal bars with the value written at the end of each bar. */
export function HBars({ items, color = C.ship, fmt = (v: number) => nf(v), max, colorOf, aria, rows = 8 }: { items: { name: string; value: number; note?: string }[]; color?: string; fmt?: (v: number) => string; max?: number; colorOf?: (name: string) => string; aria: string; rows?: number }) {
  const list = items.slice(0, rows), m = max ?? Math.max(1, ...list.map((x) => x.value));
  if (!list.length) return <p className="py-6 text-center text-sm text-muted-foreground">No data in this range.</p>;
  return (
    <ul className="space-y-1.5" aria-label={aria}>
      {list.map((it) => (
        <li key={it.name} className="grid grid-cols-[minmax(5rem,9rem)_1fr_auto] items-center gap-2 text-sm">
          <span className="truncate" title={it.name}>{it.name}</span>
          <span className="h-3 rounded-sm bg-muted"><span className="block h-full rounded-sm" style={{ width: `${Math.max(1.5, (it.value / m) * 100)}%`, background: colorOf?.(it.name) ?? color }} /></span>
          <span className="min-w-[3.5rem] text-right font-medium tabular-nums">{fmt(it.value)}{it.note && <span className="ml-1 text-xs font-normal text-muted-foreground">{it.note}</span>}</span>
        </li>
      ))}
    </ul>
  );
}

/** Actual against plan on one bar. The tick at 100% is the plan; the thin tick is where the period's time has reached (pace). */
export function Bullet({ pct, pace, tone, label }: { pct: number | null; pace?: number | null; tone: string; label: string }) {
  const max = 130, v = pct == null ? 0 : Math.min(pct, max), col = tone === "good" ? C.good : tone === "pace" ? C.info : tone === "bad" ? C.bad : C.plan;
  return (
    <div role="img" aria-label={label} className="relative h-3 w-full rounded-full bg-muted">
      <div className="h-full rounded-full" style={{ width: `${(v / max) * 100}%`, background: col }} />
      <div className="absolute inset-y-[-3px] w-0.5 rounded bg-foreground" style={{ left: `${(100 / max) * 100}%` }} title="Plan" />
      {pace != null && pace < 100 && <div className="absolute inset-y-[-1px] w-px bg-foreground/60" style={{ left: `${(pace / max) * 100}%` }} title="Time passed" />}
    </div>
  );
}

export function Spark({ values, color = C.ship, w = 110, h = 30 }: { values: (number | null)[]; color?: string; w?: number; h?: number }) {
  const v = values.filter((x): x is number => x != null);
  if (v.length < 2) return <span className="text-xs text-muted-foreground">–</span>;
  const lo = Math.min(...v), hi = Math.max(...v), n = values.length;
  let d = "", pen = false;
  values.forEach((x, i) => { if (x == null) { pen = false; return; } d += `${pen ? "L" : "M"}${((i / (n - 1)) * (w - 4) + 2).toFixed(1)} ${(h - 3 - ((x - lo) / (hi - lo || 1)) * (h - 6)).toFixed(1)}`; pen = true; });
  return <svg width={w} height={h} aria-hidden><path d={d} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" /></svg>;
}

/** Share of a plan as a ring, for the headline numbers. */
export function Ring({ pct, tone, size = 76, label }: { pct: number | null; tone: string; size?: number; label: string }) {
  const r = size / 2 - 7, c = 2 * Math.PI * r, f = pct == null ? 0 : Math.min(pct, 100) / 100, col = tone === "good" ? C.good : tone === "pace" ? C.info : tone === "bad" ? C.bad : C.plan;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} className="shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--muted)" strokeWidth={7} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={col} strokeWidth={7} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - f)} style={{ transition: "stroke-dashoffset .6s var(--ease-out, ease)" }} />
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" className="rotate-90 origin-center" style={{ transformBox: "fill-box", fontSize: size * 0.24, fontWeight: 600 }} fill="var(--foreground)">{pct == null ? "–" : `${pct.toFixed(0)}%`}</text>
    </svg>
  );
}

/** Stacked share bar with direct labels, for stock groups and similar parts of a whole. */
export function Parts({ items, aria }: { items: { name: string; value: number }[]; aria: string }) {
  const t = items.reduce((a, x) => a + x.value, 0);
  const cols = [C.ship, C.prod, C.c3, C.c4, C.c5, C.c6];
  if (!(t > 0)) return <p className="py-4 text-center text-sm text-muted-foreground">No data in this range.</p>;
  return (
    <div role="img" aria-label={aria}>
      <div className="flex h-5 overflow-hidden rounded-md">{items.map((x, i) => <span key={x.name} style={{ width: `${(x.value / t) * 100}%`, background: cols[i % cols.length] }} title={`${x.name}: ${nf(x.value)}`} />)}</div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">{items.map((x, i) => <li key={x.name} className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: cols[i % cols.length] }} aria-hidden />{x.name} <b className="tabular-nums">{nf(x.value)}</b> <span className="text-muted-foreground">({((x.value / t) * 100).toFixed(0)}%)</span></li>)}</ul>
    </div>
  );
}

export type WfStep = { key: string; label: string; type: "total" | "delta"; value: number; start: number; end: number; note?: string; hours?: number; planHours?: number };

/** Waterfall: totals in blue, gains green, losses red. Every bar carries its value; a table below gives the same numbers to screen readers. */
export function Waterfall({ steps, unit = "BCM", aria, height = 300 }: { steps: WfStep[]; unit?: string; aria: string; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [sel, setSel] = useState<number | null>(null);
  const n = steps.length, minW = n * 46, W = Math.max(w, minW), padL = 52, padR = 8, padT = 22, padB = 96, ih = height - padT - padB, iw = W - padL - padR;
  // The causes are small next to the plan and actual totals, so the axis starts below the lowest running total, not at zero. A note says so.
  const runs = steps.filter((s) => s.type === "delta").flatMap((s) => [s.start, s.end]), tots = steps.filter((s) => s.type === "total").map((s) => s.value);
  const rHi = Math.max(...runs, ...tots, 1), rLo = Math.min(...runs, ...tots), span = Math.max(rHi - rLo, rHi * 0.02);
  const step0 = Math.pow(10, Math.floor(Math.log10(span))), floor0 = Math.max(0, Math.floor((rLo - span * 0.6) / step0) * step0), cut = floor0 > 0;
  const hi = rHi + span * 0.12, lo = cut ? floor0 : 0, top = hi, y = (v: number) => padT + ih - ((v - lo) / (top - lo || 1)) * ih, bw = Math.min(40, (iw / n) * 0.7), x = (i: number) => padL + (iw / n) * (i + 0.5);
  const col = (s: WfStep) => (s.type === "total" ? "var(--chart-1)" : s.value >= 0 ? "var(--success)" : "var(--danger)");
  const ticks = [0, 1, 2, 3, 4].map((k) => lo + ((top - lo) * k) / 4);
  return (
    <div ref={ref} className="w-full">
      <ul className="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-hidden>
        {[["Plan and actual", "var(--chart-1)"], ["Gain: less lost time than plan", "var(--success)"], ["Loss", "var(--danger)"]].map(([l, c]) => <li key={l} className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: c }} />{l}</li>)}
      </ul>
      <div className="overflow-x-auto">
        <svg width={W} height={height} role="img" aria-label={aria} className="block max-w-none">
          {ticks.map((t, i) => <g key={i}><line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" /><text x={padL - 6} y={y(t) + 4} textAnchor="end" fontSize="10.5" fill="var(--chart-text)">{short(t)}</text></g>)}
          {steps.map((s, i) => {
            const a = y(Math.max(s.start, s.end)), b = y(Math.max(lo, Math.min(s.start, s.end))), h = Math.max(2, b - a), on = sel === i;
            const nx = steps[i + 1];
            return (
              <g key={s.key} onPointerEnter={() => setSel(i)} onPointerLeave={() => setSel(null)} onClick={() => setSel(on ? null : i)} className="cursor-default">
                {nx && <line x1={x(i) + bw / 2} x2={x(i + 1) - bw / 2} y1={y(s.end)} y2={y(s.end)} stroke="var(--chart-text)" strokeDasharray="2 3" opacity=".5" />}
                <rect x={x(i) - bw / 2} y={a} width={bw} height={h} rx="3" fill={col(s)} opacity={sel == null || on ? 1 : 0.55} stroke={on ? "var(--foreground)" : "none"} />
                <text x={x(i)} y={(s.type === "total" || s.value >= 0 ? a : a) - 5} textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--foreground)">{s.type === "delta" && Math.abs(s.value) < 0.5 ? "–" : `${s.type === "delta" && s.value > 0 ? "+" : ""}${short(s.value)}`}</text>
                <text transform={`translate(${x(i)} ${height - padB + 12}) rotate(-38)`} textAnchor="end" fontSize="11" fill="var(--chart-text)">{s.label}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <p className="mt-1 min-h-[2.25rem] text-xs text-muted-foreground" aria-live="polite">
        {sel == null ? `Hover or tap a bar. Volume in ${unit}.${cut ? ` The axis starts at ${short(lo)}, not zero, so the causes can be read.` : ""}` : (() => { const s = steps[sel]; return <><b className="text-foreground">{s.label}</b>: {s.type === "delta" && s.value > 0 ? "+" : ""}{nf(s.value)} {unit}{s.hours != null && <> · {nf(s.hours, 1)} h actual against {nf(s.planHours ?? 0, 1)} h planned</>}{s.note && <> · {s.note}</>}</>; })()}
      </p>
      <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">Show as a table</summary>
        <table className="mt-1 w-full max-w-md"><thead><tr className="text-left text-muted-foreground"><th className="py-1">Step</th><th className="text-right">{unit}</th></tr></thead><tbody>{steps.map((s) => <tr key={s.key} className="border-t"><td className="py-1">{s.label}</td><td className="text-right tabular-nums">{s.type === "delta" && s.value > 0 ? "+" : ""}{nf(s.value)}</td></tr>)}</tbody></table></details>
    </div>
  );
}
