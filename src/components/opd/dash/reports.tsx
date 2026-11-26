"use client";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { buildReports } from "@/lib/opd/dash-reports.js";
import { C, DayChart, HBars, nf, short } from "@/components/opd/dash/charts";
import { MoreReports } from "@/components/opd/dash/reports-more";
import { Head, Kpi, Panel, Related, DayWhy, WorstDays, WaterfallCard, RainPanel, pc, wfOf, type Range } from "@/components/opd/dash/report-ui";

export type ReportId = "mining" | "shipment" | "hours" | "equipment" | "availability" | "hauling" | "stock" | "safety" | "fuel" | "manpower" | "lab" | "exploration" | "geomap";
export const REPORTS: [ReportId, string][] = [["mining", "Mining"], ["shipment", "Shipment"], ["hours", "Working hours"], ["equipment", "Equipment"], ["availability", "Availability"], ["hauling", "Hauling"], ["stock", "Ore stock"], ["safety", "Safety"], ["fuel", "Fuel"], ["manpower", "Manpower"], ["lab", "Lab"], ["exploration", "Exploration"], ["geomap", "Geological map"]];
const ewhHint = "Rain and slippery hours are drawn on the hours chart so a dip in volume can be read against them.";

export function ReportsView({ raw, range, id, onGo, dash }: { raw: Record<string, unknown>; range: Range; id: ReportId; onGo: (id: ReportId) => void; dash: Parameters<typeof MoreReports>[0]["dash"] }) {
  const m = useMemo(() => buildReports(raw as never, range), [raw, range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const [picked, setPicked] = useState<string | null>(null);
  const d = m.days, s = m.s, t = m.totals;
  if (!m.prodDays.length && !m.loaded.length) return <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No data is loaded in this range.</p>;
  const pick = (x: string) => setPicked(x === picked ? null : x);
  if (["stock", "safety", "fuel", "manpower", "lab", "exploration", "geomap"].includes(id)) return <MoreReports id={id} m={m} dash={dash} picked={picked} pick={pick} onGo={onGo} />;
  const volume = <DayChart aria="Overburden per day against plan" days={d} unit=" BCM" onPick={pick} picked={picked} height={190} series={[{ name: "Overburden", color: C.prod, kind: "bar", values: s.ob }, { name: "Plan", color: C.plan, kind: "line", dashed: true, values: s.planOb }]} />;
  const hours = <DayChart aria="Working hours with rain and slippery hours" days={d} unit=" h" onPick={pick} picked={picked} height={170} series={[{ name: "Working hours", color: C.c3, kind: "bar", values: s.ewh }, { name: "Rain + slippery", color: C.info, kind: "line", values: s.wet }, { name: "Other delay", color: C.warn, kind: "line", values: s.other }]} />;
  const units = <DayChart aria="Units operating, standing by and in breakdown" days={d} onPick={pick} picked={picked} height={170} series={[{ name: "Operating", color: C.good, kind: "line", values: s.OP }, { name: "Standby", color: C.info, kind: "line", values: s.S }, { name: "Breakdown", color: C.bad, kind: "line", values: s.B }]} />;
  const stack = (
    <div className="space-y-3" data-linked>
      <div><p className="mb-0.5 text-xs font-medium text-muted-foreground">1. What was moved</p>{volume}</div>
      <div><p className="mb-0.5 text-xs font-medium text-muted-foreground">2. Time available to move it</p>{hours}</div>
      <div><p className="mb-0.5 text-xs font-medium text-muted-foreground">3. Machines that could do it</p>{units}</div>
      <DayWhy m={m} picked={picked} />
    </div>
  );
  const obP = pc(t.ob, t.planOb);

  if (id === "mining") return (
    <div className="space-y-4" data-report="mining">
      <Head k="Mining · overburden and ore">{t.planOb > 0 ? `Overburden reached ${nf(obP, 0)}% of plan (${short(t.ob)} of ${short(t.planOb)} BCM). ` : `${short(t.ob)} BCM of overburden moved. `}{wfOf(m) && wfOf(m)!.worst.value < 0 ? `The biggest drag was ${wfOf(m)!.worst.label.toLowerCase()}, ${short(wfOf(m)!.worst.value)} BCM.` : wfOf(m) ? "No cause cost volume against plan." : ""}</Head>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
        <Kpi label="Overburden" value={short(t.ob)} unit="BCM" pct={obP} sub={t.planOb > 0 ? `plan ${short(t.planOb)}` : "no plan loaded"} />
        <Kpi label="Ore" value={short(t.ore)} unit="t" pct={pc(t.ore, t.planOre)} sub={t.planOre > 0 ? `plan ${short(t.planOre)}` : "no plan loaded"} />
        <Kpi label="Stripping ratio" value={t.stripping == null ? "–" : t.stripping.toFixed(2)} sub="BCM of overburden per tonne of ore" accent={C.c3} />
        <Kpi label="Volume per working hour" value={t.perHour == null ? "–" : nf(t.perHour, 1)} unit="BCM/h" sub={`${nf(t.ewh, 0)} working hours`} accent={C.c4} />
        <Kpi label="Rain and slippery" value={nf(t.wet, 0)} unit="h" sub={`${t.wetDays} of ${m.prodDays.length} days affected`} accent={C.info} />
      </div>
      <Panel title="Why the days went up and down" hint={`Three charts on the same days. ${ewhHint} Click any bar to open that day.`}>{stack}</Panel>
      <WaterfallCard m={m} />
      <div className="grid gap-4 xl:grid-cols-2"><WorstDays m={m} onPick={setPicked} /><RainPanel m={m} only={["Overburden moved", "Ore produced", "Effective working hours", "Units operating", "Units on standby", "Units in breakdown", "Physical availability"]} /></div>
      <Related onGo={onGo} items={[["hours", "Working hours", "Every hour lost to rain, meetings or shift change."], ["equipment", "Equipment", "Units operating, standing by or broken down."], ["availability", "Availability", "How much of the fleet was fit to work."], ["hauling", "Hauling", "Volume moved by the trucks and what it cost in fuel."], ["shipment", "Shipment", "What left the site after it was mined."]]} />
    </div>
  );

  if (id === "shipment") {
    const ratio = t.ore > 0 ? (t.ship / t.ore) * 100 : null, lastStock = [...s.stock].reverse().find((x) => x != null) ?? null;
    return (
      <div className="space-y-4" data-report="shipment">
        <Head k="Shipment · what left the site">{t.planShip > 0 ? `Shipment reached ${nf(pc(t.ship, t.planShip), 0)}% of plan. ` : `${short(t.ship)} t shipped. `}{ratio != null ? `It was ${ratio.toFixed(0)}% of what the pit produced, so the ore stock ${ratio < 100 ? "grew" : "shrank"} over the range.` : ""}</Head>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <Kpi label="Shipment" value={short(t.ship)} unit="t" pct={pc(t.ship, t.planShip)} sub={t.planShip > 0 ? `plan ${short(t.planShip)}` : "no plan loaded"} />
          <Kpi label="Ore produced" value={short(t.ore)} unit="t" pct={pc(t.ore, t.planOre)} sub={t.planOre > 0 ? `plan ${short(t.planOre)}` : "no plan loaded"} />
          <Kpi label="Shipped over produced" value={ratio == null ? "–" : ratio.toFixed(0)} unit="%" sub="Under 100% means the stock is building" accent={C.ship} />
          <Kpi label="Ore stock on the last day" value={short(lastStock)} unit="t" sub="Pit (ETO) plus port (EFO)" accent={C.c4} />
        </div>
        <Panel title="Why shipment moved" hint="Shipment, then the ore that fed it, then the stock between them, then the weather.">
          <div className="space-y-3">
            <div><p className="mb-0.5 text-xs font-medium text-muted-foreground">1. Shipment against plan</p><DayChart aria="Shipment per day against plan" days={d} unit=" t" onPick={pick} picked={picked} height={180} series={[{ name: "Shipment", color: C.ship, kind: "bar", values: s.ship }, { name: "Plan", color: C.plan, kind: "line", dashed: true, values: s.planShip }]} /></div>
            <div><p className="mb-0.5 text-xs font-medium text-muted-foreground">2. Ore produced against shipped</p><DayChart aria="Ore produced and shipped per day" days={d} unit=" t" onPick={pick} picked={picked} height={170} series={[{ name: "Ore produced", color: C.prod, kind: "area", values: s.ore }, { name: "Shipped", color: C.ship, kind: "line", values: s.ship }]} /></div>
            <div><p className="mb-0.5 text-xs font-medium text-muted-foreground">3. Ore stock</p><DayChart aria="Ore stock per day" days={d} unit=" t" onPick={pick} picked={picked} height={150} legend={false} series={[{ name: "Ore stock", color: C.c4, kind: "area", values: s.stock }]} /></div>
            <div><p className="mb-0.5 text-xs font-medium text-muted-foreground">4. Rain and slippery hours</p><DayChart aria="Rain and slippery hours per day" days={d} unit=" h" onPick={pick} picked={picked} height={120} legend={false} series={[{ name: "Rain + slippery", color: C.info, kind: "bar", values: s.wet }]} /></div>
            <DayWhy m={m} picked={picked} />
          </div>
        </Panel>
        <RainPanel m={m} only={["Ore produced", "Shipment", "Effective working hours", "Hauled volume"]} />
        <Related onGo={onGo} items={[["mining", "Mining", "What fed the shipment."], ["hours", "Working hours", "Rain also stops barge loading days."], ["hauling", "Hauling", "Ore moved from pit to stockpile and port."]]} />
      </div>
    );
  }

  if (id === "hours") {
    const top = m.causes.slice(0, 6), rest = m.causes.slice(6);
    const palette = [C.info, "var(--chart-4)", C.warn, "var(--chart-3)", "var(--chart-5)", "var(--chart-6)"];
    const stackSeries = [...top.map((c, i) => ({ name: c.label, color: palette[i % 6], kind: "bar" as const, stack: "h", values: c.values })), ...(rest.length ? [{ name: "Other causes", color: C.plan, kind: "bar" as const, stack: "h", values: d.map((_, i) => rest.reduce((a, c) => a + (c.values[i] || 0), 0)) }] : [])];
    return (
      <div className="space-y-4" data-report="hours">
        <Head k="Working hours · where the time went">{nf(t.ewh, 0)} hours were worked and {nf(t.wet + t.other, 0)} were lost. {m.causes[0] ? `${m.causes[0].label} took the most, ${nf(m.causes[0].hours, 0)} h.` : ""}</Head>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <Kpi label="Effective working hours" value={nf(t.ewh, 0)} unit="h" sub={`${nf(t.ewh / Math.max(1, m.prodDays.length), 1)} h per day`} accent={C.c3} />
          <Kpi label="Rain and slippery" value={nf(t.wet, 0)} unit="h" sub={`${t.wetDays} days with 1 h or more`} accent={C.info} />
          <Kpi label="Other delay" value={nf(t.other, 0)} unit="h" sub="Meetings, meals, P2H, shift change and the rest" accent={C.warn} />
          <Kpi label="Volume per working hour" value={t.perHour == null ? "–" : nf(t.perHour, 1)} unit="BCM/h" sub="Overburden per effective hour" accent={C.prod} />
        </div>
        <Panel title="Lost hours per day, by cause" hint="Stacked bars are lost time. Click a day to see what else happened that day."><DayChart aria="Lost hours per day by cause" days={d} unit=" h" onPick={pick} picked={picked} height={230} series={stackSeries} /><div className="mt-3"><p className="mb-0.5 text-xs font-medium text-muted-foreground">Overburden on the same days</p>{volume}</div><div className="mt-3"><DayWhy m={m} picked={picked} /></div></Panel>
        <div className="grid gap-4 xl:grid-cols-2"><Panel title="Which causes cost the most hours"><HBars aria="Lost hours by cause" items={m.causes.map((c) => ({ name: c.label, value: c.hours }))} color={C.warn} fmt={(v) => `${nf(v, 0)} h`} rows={10} /></Panel><RainPanel m={m} /></div>
        <WaterfallCard m={m} />
        <Related onGo={onGo} items={[["mining", "Mining", "Hours turn into overburden at the rate above."], ["equipment", "Equipment", "Rain sends units to standby or breakdown."], ["hauling", "Hauling", "Fewer hours, fewer trips."]]} />
      </div>
    );
  }

  if (id === "equipment") {
    const mean = (a: (number | null)[]) => { const v = a.filter((x): x is number => x != null); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
    const op = mean(s.OP), sb = mean(s.S), bd = mean(s.B), pl = mean(s.P);
    return (
      <div className="space-y-4" data-report="equipment">
        <Head k="Equipment · units in the field">{op != null ? `${nf(op, 0)} units worked on an average day, ${nf(sb, 0)} stood by and ${nf(bd, 0)} were in breakdown.` : "No equipment rows are loaded in this range."}{m.rainEffect.ok && " Rain days are compared with dry days below."}</Head>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <Kpi label="Operating" value={nf(op, 0)} unit="units" pct={pl ? pc(op ?? 0, pl) : undefined} sub={pl ? `of ${nf(pl, 0)} in plan` : undefined} accent={C.good} />
          <Kpi label="Standby" value={nf(sb, 0)} unit="units" sub="Ready but not working" accent={C.info} />
          <Kpi label="Breakdown" value={nf(bd, 0)} unit="units" sub="Not available to work" accent={C.bad} />
          <Kpi label="Trucks operating" value={nf(mean(s.dtOP), 0)} unit="units" sub={`${nf(mean(s.dtB), 1)} in breakdown`} accent={C.prod} />
        </div>
        <Panel title="Units against the weather" hint="Standby and breakdown on the same days as rain and slippery hours."><div className="space-y-3">
          <div><p className="mb-0.5 text-xs font-medium text-muted-foreground">1. Units by status</p><DayChart aria="Units by status per day" days={d} onPick={pick} picked={picked} height={200} series={[{ name: "Operating", color: C.good, kind: "bar", stack: "u", values: s.OP }, { name: "Standby", color: C.info, kind: "bar", stack: "u", values: s.S }, { name: "Breakdown", color: C.bad, kind: "bar", stack: "u", values: s.B }, { name: "Plan", color: C.plan, kind: "line", dashed: true, values: s.P }]} /></div>
          <div><p className="mb-0.5 text-xs font-medium text-muted-foreground">2. Rain and slippery hours</p><DayChart aria="Rain and slippery hours per day" days={d} unit=" h" onPick={pick} picked={picked} height={120} legend={false} series={[{ name: "Rain + slippery", color: C.info, kind: "bar", values: s.wet }]} /></div>
          <div><p className="mb-0.5 text-xs font-medium text-muted-foreground">3. Overburden</p>{volume}</div>
          <DayWhy m={m} picked={picked} />
        </div></Panel>
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="By machine group" hint="Average units per day."><div className="overflow-x-auto"><table className="w-full min-w-[24rem] text-sm"><thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1.5">Group</th><th className="text-right">Operating</th><th className="text-right">Standby</th><th className="text-right">Breakdown</th><th className="text-right">Plan</th><th className="text-right">Used</th></tr></thead>
            <tbody>{(m.eqTypes as unknown as { label: string; op: number | null; s: number | null; b: number | null; p: number | null; use: number | null }[]).map((r: { label: string; op: number | null; s: number | null; b: number | null; p: number | null; use: number | null }) => <tr key={r.label} className="border-t"><td className="py-1.5 font-medium">{r.label}</td><td className="text-right tabular-nums">{nf(r.op, 1)}</td><td className="text-right tabular-nums">{nf(r.s, 1)}</td><td className={cn("text-right tabular-nums", (r.b ?? 0) >= 2 && "font-semibold text-[var(--danger)]")}>{nf(r.b, 1)}</td><td className="text-right tabular-nums text-muted-foreground">{nf(r.p, 1)}</td><td className="text-right tabular-nums">{r.use == null ? "–" : r.use.toFixed(0) + "%"}</td></tr>)}</tbody></table></div></Panel>
          <RainPanel m={m} only={["Units operating", "Units on standby", "Units in breakdown", "Trucks operating", "Trucks in breakdown", "Physical availability", "Utilization of availability", "Overburden moved"]} />
        </div>
        <Related onGo={onGo} items={[["availability", "Availability", "PA, MA, UA and EU of each machine group."], ["hours", "Working hours", "Hours lost with the units idle."], ["hauling", "Hauling", "Trucks operating decide how much can be hauled."], ["mining", "Mining", "The volume these units produced."]]} />
      </div>
    );
  }

  if (id === "availability") {
    const mean = (a: (number | null)[]) => { const v = a.filter((x): x is number => x != null); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
    const p = mean(s.pa), pl = mean(s.paPlan);
    return (
      <div className="space-y-4" data-report="availability">
        <Head k="Availability · how fit the fleet was">{p != null ? `Physical availability averaged ${p.toFixed(1)}%${pl != null ? `, against a plan of ${pl.toFixed(1)}%` : ""}. ` : "No availability rows are loaded. "}{p != null && pl != null ? (p >= pl ? "The fleet was fit enough for the plan." : `That is ${(pl - p).toFixed(1)} points short, which costs volume in the waterfall.`) : ""}</Head>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {([["Physical (PA)", s.pa, "Fit to work"], ["Mechanical (MA)", s.ma, "Not in workshop"], ["Utilization (UA)", s.ua, "Used when available"], ["Effective (EU)", s.eu, "Time spent producing"]] as [string, (number | null)[], string][]).map(([l, v, sub]) => <Kpi key={l} label={l} value={mean(v) == null ? "–" : mean(v)!.toFixed(1)} unit="%" sub={sub} accent={C.c3} />)}
        </div>
        <Panel title="Availability next to what it cost" hint="Fleet average over excavators, dump trucks, dozers, graders and compactors."><div className="space-y-3">
          <div><p className="mb-0.5 text-xs font-medium text-muted-foreground">1. PA, MA, UA and EU</p><DayChart aria="Availability measures per day" days={d} unit="%" minZero={false} onPick={pick} picked={picked} height={210} series={[{ name: "PA", color: C.good, kind: "line", values: s.pa }, { name: "MA", color: C.info, kind: "line", values: s.ma }, { name: "UA", color: C.warn, kind: "line", values: s.ua }, { name: "EU", color: C.c4, kind: "line", values: s.eu }, { name: "PA plan", color: C.plan, kind: "line", dashed: true, values: s.paPlan }]} /></div>
          <div><p className="mb-0.5 text-xs font-medium text-muted-foreground">2. Units in breakdown</p><DayChart aria="Units in breakdown per day" days={d} onPick={pick} picked={picked} height={120} legend={false} series={[{ name: "Breakdown", color: C.bad, kind: "bar", values: s.B }]} /></div>
          <div><p className="mb-0.5 text-xs font-medium text-muted-foreground">3. Overburden</p>{volume}</div>
          <DayWhy m={m} picked={picked} />
        </div></Panel>
        <Panel title="By machine group" hint="Average over the range."><div className="overflow-x-auto"><table className="w-full min-w-[26rem] text-sm"><thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1.5">Group</th><th className="text-right">PA</th><th className="text-right">MA</th><th className="text-right">UA</th><th className="text-right">EU</th></tr></thead>
          <tbody>{m.availGroups.map((r: { key: string; label: string; pa: number | null; ma: number | null; ua: number | null; eu: number | null }) => <tr key={r.key} className="border-t"><td className="py-1.5 font-medium">{r.label}</td>{[r.pa, r.ma, r.ua, r.eu].map((v, i) => <td key={i} className={cn("text-right tabular-nums", i === 0 && pl != null && v != null && v < pl - 3 && "font-semibold text-[var(--danger)]")}>{v == null ? "–" : v.toFixed(1) + "%"}</td>)}</tr>)}</tbody></table></div></Panel>
        <WaterfallCard m={m} compact />
        <Related onGo={onGo} items={[["equipment", "Equipment", "The units behind the percentages."], ["hours", "Working hours", "Time lost to the weather and routine."], ["mining", "Mining", "Volume against plan."]]} />
      </div>
    );
  }

  const haulT = t.haul, perDt = s.haulPerDt.filter((x): x is number => x != null), mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return (
    <div className="space-y-4" data-report="hauling">
      <Head k="Hauling · moving the volume">{haulT > 0 ? `${short(haulT)} BCM was hauled, ${t.ewh > 0 ? `${nf(haulT / t.ewh, 0)} per working hour` : "hours not loaded"}${t.fuel > 0 ? ` and ${(t.fuel / Math.max(1, haulT)).toFixed(2)} L of fuel per BCM` : ""}.` : "No hauling is loaded in this range."}</Head>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Kpi label="Hauled" value={short(haulT)} unit="BCM" sub={`${short(t.ob + t.ore)} mined (overburden + ore)`} accent={C.c5} />
        <Kpi label="Per working hour" value={t.ewh > 0 ? nf(haulT / t.ewh, 0) : "–"} unit="BCM/h" sub="Falls when hours are lost" accent={C.c3} />
        <Kpi label="Per operating truck" value={nf(mean(perDt), 0)} unit="BCM/day" sub="Average over the days with trucks" accent={C.good} />
        <Kpi label="Fuel per BCM" value={t.fuel > 0 && haulT > 0 ? (t.fuel / haulT).toFixed(2) : "–"} unit="L/BCM" sub={`${short(t.fuel)} L used`} accent={C.warn} />
      </div>
      <Panel title="What hauling depends on" hint="Hauled volume, then the trucks and hours behind it, then what it burned."><div className="space-y-3">
        <div><p className="mb-0.5 text-xs font-medium text-muted-foreground">1. Hauled volume</p><DayChart aria="Hauled volume per day" days={d} unit=" BCM" onPick={pick} picked={picked} height={180} legend={false} series={[{ name: "Hauled", color: C.c5, kind: "bar", values: s.haul }]} /></div>
        <div><p className="mb-0.5 text-xs font-medium text-muted-foreground">2. Trucks operating and in breakdown</p><DayChart aria="Trucks operating and in breakdown per day" days={d} onPick={pick} picked={picked} height={150} series={[{ name: "Trucks operating", color: C.good, kind: "line", values: s.dtOP }, { name: "Trucks in breakdown", color: C.bad, kind: "line", values: s.dtB }]} /></div>
        <div><p className="mb-0.5 text-xs font-medium text-muted-foreground">3. Working hours, rain and slippery</p>{hours}</div>
        <div><p className="mb-0.5 text-xs font-medium text-muted-foreground">4. Fuel used and fuel per BCM</p><DayChart aria="Fuel used per day" days={d} unit=" L" onPick={pick} picked={picked} height={140} legend={false} series={[{ name: "Fuel used", color: C.warn, kind: "bar", values: s.fuel }]} /></div>
        <DayWhy m={m} picked={picked} />
      </div></Panel>
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Productivity of the haul" hint="BCM hauled per working hour and per operating truck."><DayChart aria="Hauled per working hour and per truck" days={d} height={190} series={[{ name: "BCM per working hour", color: C.c3, kind: "line", values: s.haulPerEwh }, { name: "BCM per operating truck (÷10)", color: C.c5, kind: "line", values: s.haulPerDt.map((x: number | null) => (x == null ? null : x / 10)) }]} /></Panel>
        <RainPanel m={m} only={["Hauled volume", "Trucks operating", "Trucks in breakdown", "Effective working hours", "Fuel per BCM"]} />
      </div>
      <Related onGo={onGo} items={[["equipment", "Equipment", "Trucks operating decide the haul capacity."], ["availability", "Availability", "Dump truck PA and MA."], ["hours", "Working hours", "Hours available to haul."], ["mining", "Mining", "What had to be hauled."]]} />
    </div>
  );
}
