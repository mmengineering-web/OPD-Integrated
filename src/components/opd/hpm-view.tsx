"use client";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, FileDown, Scale } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { MaskedInput } from "@/components/ui/masked-input";
import { maskDecimal, maskPercent } from "@/lib/opd/masks.js";
import { Breadcrumb } from "@/components/opd/breadcrumb";
import { AppFrame, PageHead } from "@/components/opd/app-frame";
import { cn } from "@/lib/utils";
import { FALLBACK_HMA, SHEET_URL, computeHpm, defaultPick, parseSheet, cfNickel, cfCobalt, NI_TIER, FE_MAX, CO_MIN } from "@/lib/core/hpm.js";

type Ore = "saprolite" | "limonite";
type Row = { month: string; period: string; nikel: number; kobalt: number; besi: number; krom: number };
const DEFAULTS: Record<Ore, Record<string, string>> = {
  saprolite: { ni: "1.80", fe: "14.00", co: "0.05", cr: "1.00", mc: "30" },
  limonite: { ni: "0.90", fe: "35.00", co: "0.08", cr: "0.50", mc: "35" },
};
const num = (v: string) => (v.trim() === "" ? NaN : Number(v.replace(",", ".")));
const maskGrade = (v: string) => maskPercent(v, 3);
const maskPrice = (v: string) => maskDecimal(v, { int: 6, dec: 3 });
const f = (n: number, d = 2) => (Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "–");

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1.5 text-sm font-medium"><span>{label}</span>{children}{hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}</label>;
}
function Seg<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { v: T; t: string }[]; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg border bg-muted/50 p-0.5">
      {options.map(o => (
        <button key={o.v} type="button" aria-pressed={value === o.v} data-seg={o.v} onClick={() => onChange(o.v)}
          className={cn("tap h-8 rounded-md px-4 text-sm font-medium", value === o.v ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}>{o.t}</button>
      ))}
    </div>
  );
}
function Line({ label, sub, value, id, zero }: { label: string; sub: string; value: string; id: string; zero?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b py-2.5 last:border-0">
      <div className="text-sm font-medium">{label}<small className="mt-0.5 block text-xs font-normal text-muted-foreground">{sub}</small></div>
      <div className={cn("shrink-0 text-sm font-semibold tabular-nums", zero && "text-muted-foreground")} id={id}>{value}</div>
    </div>
  );
}

let jspdfLoading: Promise<any> | null = null;
function loadJsPdf(): Promise<any> {
  const w = window as any;
  if (w.jspdf) return Promise.resolve(w.jspdf.jsPDF);
  if (jspdfLoading) return jspdfLoading;
  jspdfLoading = new Promise((res, rej) => {
    const sc = document.createElement("script"); sc.src = "/vendor/jspdf.umd.min.js";
    sc.onload = () => res(w.jspdf.jsPDF); sc.onerror = () => { jspdfLoading = null; rej(new Error("The PDF library could not be loaded.")); };
    document.head.appendChild(sc);
  });
  return jspdfLoading;
}

function Calculator() {
  const [ore, setOre] = useState<Ore>("saprolite");
  const [expert, setExpert] = useState(false);
  const [vals, setVals] = useState(DEFAULTS);
  const [rows, setRows] = useState<Row[]>(FALLBACK_HMA as unknown as Row[]);
  const [source, setSource] = useState("Built-in table");
  const [pick, setPick] = useState<{ month: string; period: string }>(() => defaultPick(FALLBACK_HMA as unknown as Row[]));
  const [hma, setHma] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  // live reference prices from the public HMA sheet; the built-in table is the fallback (offline, blocked)
  useEffect(() => {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 6000);
    fetch(SHEET_URL, { signal: ctl.signal }).then(r => { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
      .then(txt => { const p = parseSheet(txt) as Row[]; if (p.length) { setRows(p); setPick(defaultPick(p)); setSource("Google Sheet (live)"); } })
      .catch(() => {}).finally(() => clearTimeout(t));
    return () => { clearTimeout(t); ctl.abort(); };
  }, []);

  const months = useMemo(() => [...new Set(rows.map(r => r.month))], [rows]);
  const periods = useMemo(() => rows.filter(r => r.month === pick.month).map(r => r.period), [rows, pick.month]);
  const sel = rows.find(r => r.month === pick.month && r.period === pick.period) ?? rows[rows.length - 1];
  // choosing a period fills the four prices; expert mode lets you overwrite them
  useEffect(() => { if (sel) setHma({ nikel: sel.nikel.toFixed(2), kobalt: sel.kobalt.toFixed(2), besi: sel.besi.toFixed(2), krom: sel.krom.toFixed(2) }); }, [sel]);

  const v = vals[ore];
  const set = (k: string, x: string) => setVals(s => ({ ...s, [ore]: { ...s[ore], [k]: x } }));
  const inp = { ni: num(v.ni), fe: num(v.fe), co: num(v.co), cr: num(v.cr), mc: num(v.mc) };
  const h = { nikel: num(hma.nikel ?? ""), kobalt: num(hma.kobalt ?? ""), besi: num(hma.besi ?? ""), krom: num(hma.krom ?? "") };
  const r = computeHpm(inp, h) as any;
  const ok = !r.error;
  const cfNi = Number.isFinite(inp.ni) ? cfNickel(inp.ni) : NaN, cfCo = Number.isFinite(inp.ni) ? cfCobalt(inp.ni) : NaN;
  const label = sel ? `${sel.month} (${sel.period})` : "–";

  async function pdf() {
    if (!ok) return;
    setBusy(true);
    try {
      const J = await loadJsPdf(), d = new J({ unit: "mm", format: "a4" });
      let y = 20; const L = 18, R = 192;
      const t = (s: string, size = 10, bold = false, x = L, align: "left" | "right" = "left") => { d.setFontSize(size); d.setFont("helvetica", bold ? "bold" : "normal"); d.text(s, align === "right" ? R : x, y, { align }); };
      const row = (a: string, b: string, sub?: string) => { t(a, 10, true); t(b, 10, false, L, "right"); y += 5; if (sub) { d.setTextColor(110); t(sub, 8); d.setTextColor(0); y += 5; } y += 1; };
      t("One Portal Data · Mining Tools", 9); y += 8;
      t("HPM Nickel Calculation Report", 18, true); y += 7;
      t(`Reference prices (HMA): ${label}`, 10); y += 10;
      t("Nickel ore HPM", 10); y += 9;
      t(`${f(r.hpm)} USD / WMT`, 22, true); y += 6;
      t("USD per wet metric ton", 9); y += 10;
      row("Ore type", ore === "saprolite" ? "Saprolite" : "Limonite");
      row("Grades", `Ni ${inp.ni}%  Fe ${inp.fe}%  Co ${inp.co}%  Cr ${inp.cr}%`);
      row("Moisture content", `${inp.mc}%`);
      row("HMA prices", `Ni ${f(h.nikel)}  Co ${f(h.kobalt)}  Fe ${f(h.besi)}  Cr ${f(h.krom)}`);
      y += 3; t("Corrective factors", 12, true); y += 7;
      row("Nickel ore CF", `${r.cfNi.toFixed(1)}% (Ni ${r.low ? "<=" : ">"} ${NI_TIER}%)`);
      row("Associated cobalt CF", `${r.cfCo}%`);
      row("Associated iron CF", "30% fixed");
      row("Associated chromium CF", "10% fixed");
      y += 3; t("Calculation", 12, true); y += 7;
      row("Nickel component", `${f(r.ni)} USD`, `(${inp.ni}/100) x ${r.cfNi.toFixed(1)}% x ${f(h.nikel)}`);
      row("Iron component", `${f(r.fe)} USD`, r.feOn ? `(${inp.fe}/100) x 30% x ${f(h.besi)} x 100` : `Fe above ${FE_MAX}%: not counted`);
      row("Cobalt component", `${f(r.co)} USD`, r.coOn ? `(${inp.co}/100) x ${r.cfCo}% x ${f(h.kobalt)}` : `Co below ${CO_MIN}%: not counted`);
      row("Chromium component", `${f(r.cr)} USD`, `(${inp.cr}/100) x 10% x ${f(h.krom)} x 100`);
      row("Subtotal before moisture", `${f(r.subtotal)} USD`);
      row("x (1 - MC)", `${r.factor.toFixed(2)}`);
      t("HPM final", 12, true); t(`${f(r.hpm)} USD/WMT`, 12, true, L, "right"); y += 12;
      d.setTextColor(110); d.setFontSize(8);
      d.text(d.splitTextToSize("Based on Kepmen ESDM No.363.K/MB.01/MEM.B/2026 (second amendment of 268/2025, with 144/2026), Lampiran points 6 and 8, nickel ore. A calculation aid: check against the official HMA before using a figure in a contract or report.", R - L), L, y);
      d.save(`HPM_Nickel_${pick.month.replace(/\s+/g, "_")}_${pick.period.replace(/\s+/g, "_")}.pdf`);
    } finally { setBusy(false); }
  }

  const Inp = (k: string, label: string, hint?: string) => <Field label={label} hint={hint}><MaskedInput mask={maskGrade} inputMode="decimal" placeholder="0 to 100" value={v[k]} onValueChange={x => set(k, x)} id={`hpm-${k}`} /></Field>;
  const Hma = (k: string, label: string, hint?: string) => <Field label={label} hint={hint}><MaskedInput mask={maskPrice} inputMode="decimal" placeholder="USD" value={hma[k] ?? ""} onValueChange={x => setHma(s => ({ ...s, [k]: x }))} id={`hpm-h-${k}`} /></Field>;

  return (
    <div className="flex flex-col gap-4" data-tool="hpm">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Seg label="Ore type" value={ore} onChange={setOre} options={[{ v: "saprolite", t: "Saprolite" }, { v: "limonite", t: "Limonite" }]} />
        <div className="flex items-center gap-2 text-sm text-muted-foreground">Inputs <Seg label="Input detail" value={expert ? "expert" : "simple"} onChange={x => setExpert(x === "expert")} options={[{ v: "simple", t: "Simple" }, { v: "expert", t: "Expert" }]} /></div>
        <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-muted-foreground"><Scale className="size-3.5" aria-hidden />Kepmen ESDM 363.K/2026, effective 15 Sep 2026</span>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="flex flex-col gap-4">
          <Card>
            <h2 className="text-base font-semibold">Ore grades and moisture</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {Inp("ni", "%Ni (nickel)", ore === "saprolite" ? "Saprolite is 1.6% Ni and above." : "Limonite is below 1.6% Ni. At 1.2% and below a different CF segment applies.")}
              {Inp("mc", "Moisture content (%)")}
              {expert && <>
                {Inp("fe", "%Fe (iron)", `Counted only when Fe is ${FE_MAX}% or less.`)}
                {Inp("co", "%Co (cobalt)", `Counted only when Co is ${CO_MIN}% or more.`)}
                {Inp("cr", "%Cr (chromium)")}
              </>}
            </div>
            <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/40 px-3 py-2.5">
              <div><div className="text-xs text-muted-foreground">Nickel ore CF (automatic)</div><div className="font-serif text-2xl" id="hpm-cf">{Number.isFinite(cfNi) ? `${cfNi.toFixed(1)}%` : "–"}</div></div>
              <p className="max-w-[18rem] text-right text-xs text-muted-foreground">{Number.isFinite(cfNi) ? (inp.ni > NI_TIER ? `Ni ${inp.ni}%: 30% at 1.6% Ni, plus or minus 1% per 0.1% Ni.` : `Ni ${inp.ni}%: 14% at 1.2% Ni, down 1% per 0.1% Ni.`) : ""} Cobalt CF {Number.isFinite(cfCo) ? `${cfCo}%` : "–"}.</p>
            </div>
          </Card>

          <Card>
            <h2 className="text-base font-semibold">HMA reference prices</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="HMA month"><Select value={pick.month} id="hpm-month" onChange={e => { const m = e.target.value; setPick({ month: m, period: rows.find(x => x.month === m)?.period ?? "" }); }}>{months.map(m => <option key={m}>{m}</option>)}</Select></Field>
              <Field label="HMA period"><Select value={pick.period} id="hpm-period" onChange={e => setPick(p => ({ ...p, period: e.target.value }))}>{periods.map(p => <option key={p}>{p}</option>)}</Select></Field>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2.5 text-sm">
              <div><span className="text-xs text-muted-foreground">Selected </span><strong id="hpm-label">{label}</strong></div>
              <div className="text-xs text-muted-foreground">Source: <span id="hpm-source">{source}</span></div>
            </div>
            {expert
              ? <div className="grid gap-3 sm:grid-cols-2">{Hma("nikel", "HMA nickel")}{Hma("kobalt", "HMA cobalt")}{Hma("besi", "HMA iron ore", "Raw value, multiplied by 100 in the formula.")}{Hma("krom", "HMA chrome ore", "Raw value, multiplied by 100 in the formula.")}</div>
              : <p className="text-sm text-muted-foreground" id="hpm-sum">Ni {f(h.nikel)} · Co {f(h.kobalt)} · Fe {f(h.besi)} · Cr {f(h.krom)}. Switch to Expert to edit these.</p>}
          </Card>

          <Card>
            <h2 className="text-base font-semibold">Formula and corrective factors</h2>
            <p className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">HPM = [(%Ni × CF<sub>Ni</sub> × HMA<sub>Ni</sub>) + (%Fe × CF<sub>Fe</sub> × HMA<sub>Fe</sub> × 100) + (%Co × CF<sub>Co</sub> × HMA<sub>Co</sub>) + (%Cr × CF<sub>Cr</sub> × HMA<sub>Cr</sub> × 100)] × (1 − MC)</p>
            <div className="overflow-x-auto text-sm">
              <table className="w-full min-w-[28rem] text-left">
                <thead className="text-xs text-muted-foreground"><tr><th className="py-1.5 pr-3 font-medium">Component</th><th className="py-1.5 pr-3 font-medium">CF</th><th className="py-1.5 font-medium">Rule</th></tr></thead>
                <tbody className="[&_td]:border-t [&_td]:py-2 [&_td]:pr-3 align-top">
                  <tr><td>Nickel</td><td className="font-semibold tabular-nums" id="hpm-t-ni">{ok ? `${r.cfNi.toFixed(1)}%` : "–"}</td><td className="text-muted-foreground">Ni above 1.2%: 30% at 1.6% Ni, ±1% per 0.1% Ni. Ni 1.2% or below: 14% at 1.2% Ni, down 1% per 0.1% Ni.</td></tr>
                  <tr><td>Associated iron</td><td className="font-semibold">30%</td><td className="text-muted-foreground">Fixed. Counted when Fe is {FE_MAX}% or less.</td></tr>
                  <tr><td>Associated cobalt</td><td className="font-semibold tabular-nums" id="hpm-t-co">{ok ? `${r.cfCo}%` : "–"}</td><td className="text-muted-foreground">30% when Ni is above 1.2%, 17% otherwise. Counted when Co is {CO_MIN}% or more.</td></tr>
                  <tr><td>Associated chromium</td><td className="font-semibold">10%</td><td className="text-muted-foreground">Fixed.</td></tr>
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-20">
          <Card className="gap-5" data-result>
            <div>
              <div className="text-xs text-muted-foreground">Nickel ore HPM</div>
              <div className="mt-1 font-serif text-5xl leading-none tracking-tight" id="hpm-out">{ok ? f(r.hpm) : "–"}</div>
              <div className="mt-1.5 text-sm text-muted-foreground">USD per wet metric ton (WMT)</div>
            </div>
            {!ok && <div role="alert" id="hpm-err" className="flex items-start gap-2 rounded-md border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-sm text-danger"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{r.error}</div>}
            {ok && (
              <div>
                <Line label="Nickel component" sub={`(${inp.ni}/100) × ${r.cfNi.toFixed(1)}% × ${f(h.nikel)}${r.low ? " [Ni ≤ 1.2% segment]" : ""}`} value={`${f(r.ni)} USD`} id="hpm-r-ni" />
                <Line label="Iron component" sub={r.feOn ? `(${inp.fe}/100) × 30% × ${f(h.besi)} × 100` : `Fe above ${FE_MAX}%: not counted`} value={`${f(r.fe)} USD`} id="hpm-r-fe" zero={!r.feOn} />
                <Line label="Cobalt component" sub={r.coOn ? `(${inp.co}/100) × ${r.cfCo}% × ${f(h.kobalt)}` : `Co below ${CO_MIN}%: not counted`} value={`${f(r.co)} USD`} id="hpm-r-co" zero={!r.coOn} />
                <Line label="Chromium component" sub={`(${inp.cr}/100) × 10% × ${f(h.krom)} × 100`} value={`${f(r.cr)} USD`} id="hpm-r-cr" />
                <Line label="Subtotal before moisture" sub="" value={`${f(r.subtotal)} USD`} id="hpm-r-sub" />
                <Line label="× (1 − MC)" sub={`Moisture ${inp.mc}%`} value={r.factor.toFixed(2)} id="hpm-r-mc" />
                <div className="mt-1 flex items-baseline justify-between border-t pt-3"><span className="text-sm font-semibold">HPM final</span><span className="font-serif text-xl tabular-nums" id="hpm-final">{f(r.hpm)} USD/WMT</span></div>
              </div>
            )}
            {ok && (
              <ul className="flex flex-col gap-2 text-xs text-muted-foreground" id="hpm-notes">
                <li className="flex gap-2"><CheckCircle2 className="mt-px size-3.5 shrink-0 text-[var(--success,#16a34a)]" aria-hidden />Using HMA {label}.</li>
                {r.low && <li className="flex gap-2"><AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />Ni is 1.2% or below, so the lower segment applies (14% at 1.2% Ni). The CF jumps at 1.2% instead of continuing the upper line.</li>}
                {!r.feOn && <li className="flex gap-2"><AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />Iron is not counted because Fe is above {FE_MAX}%.</li>}
                {!r.coOn && <li className="flex gap-2"><AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />Cobalt is not counted because Co is below {CO_MIN}%.</li>}
                {!expert && <li className="flex gap-2"><CheckCircle2 className="mt-px size-3.5 shrink-0 text-[var(--success,#16a34a)]" aria-hidden />Simple mode: Fe, Co, Cr and the HMA prices still use their saved values.</li>}
              </ul>
            )}
            <Button onClick={pdf} disabled={!ok || busy} id="hpm-pdf" variant="outline"><FileDown />{busy ? "Preparing PDF…" : "Download PDF"}</Button>
          </Card>
          <p className="text-xs text-muted-foreground">A calculation aid. Check against the official HMA at minerba.esdm.go.id before using a figure in a contract or report.</p>
        </div>
      </div>
    </div>
  );
}

export const HpmView = () => (
  <AppFrame active="tools">{() => (
    <>
      <Breadcrumb className="mb-4" items={[{ label: "Home", href: "/" }, { label: "Tools", href: "/tools/" }, { label: "HPM Nickel Calculator" }]} />
      <PageHead title="HPM Nickel Calculator" tag="Kepmen ESDM 363/2026" lead="Benchmark price of nickel ore (HPM) for saprolite and limonite, from the HMA reference prices of the chosen period." />
      <Calculator />
    </>
  )}</AppFrame>
);
