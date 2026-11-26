"use client";
import { buildDash } from "@/lib/opd/dash-model.js";
import { C, DayChart, HBars, nf, short, type Serie } from "@/components/opd/dash/charts";
import { FlowCard, type Flow, Head, Kpi, Panel, RainPanel, Related, pc, type M } from "@/components/opd/dash/report-ui";
import type { ReportId } from "@/components/opd/dash/reports";

type Dash = ReturnType<typeof buildDash>;
type A = (number | null)[];
const lastV = (a: A) => [...a].reverse().find((v) => v != null) ?? null, firstV = (a: A) => a.find((v) => v != null) ?? null;
const sumA = (a: A) => a.reduce<number>((x, y) => x + (y || 0), 0), cum = (a: A) => { let c = 0; return a.map((v) => (c += v || 0)); };
const Sub = ({ children }: { children: React.ReactNode }) => <p className="mb-0.5 text-xs font-medium text-muted-foreground">{children}</p>;
const Hrs = ({ m, pick, picked, h = 120 }: { m: M; pick: (d: string) => void; picked: string | null; h?: number }) => <DayChart aria="Rain and slippery hours per day" days={m.days} unit=" h" onPick={pick} picked={picked} height={h} legend={false} series={[{ name: "Rain + slippery", color: C.info, kind: "bar", values: m.s.wet }]} />;
const pal = [C.c3, C.c4, C.c5, C.c6, C.info, C.warn, C.good, C.bad];

export function MoreReports({ id, m, dash, picked, pick, onGo }: { id: ReportId; m: M; dash: Dash; picked: string | null; pick: (d: string) => void; onGo: (id: ReportId) => void }) {
  const d = m.days, x = m.x, t = m.totals;

  if (id === "stock") {
    const b = m.bridges.stock as unknown as Flow,  now = lastV(x.stock), then = firstV(x.stock), rate = t.ship > 0 ? t.ship / Math.max(1, m.loaded.length) : 0, cover = now != null && rate > 0 ? now / rate : null;
    const pit = lastV(x.pit), port = lastV(x.port);
    return (
      <div className="space-y-4" data-report="stock">
        <Head k="Ore stock · what is waiting to be shipped">{now == null ? "No stock register is loaded in this range." : `${short(now)} t of ore sits in stock${then != null && then !== now ? `, ${now > then ? "up" : "down"} ${short(Math.abs(now - then))} t over the range` : ""}. ${t.ore > 0 ? `Shipments were ${nf((t.ship / t.ore) * 100, 0)}% of the ore mined.` : ""}`}</Head>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <Kpi label="Ore stock on the last day" value={short(now)} unit="t" sub="Pit (ETO) plus port (EFO), waste not counted" accent={C.c4} />
          <Kpi label="Days of cover" value={cover == null ? "–" : cover.toFixed(1)} unit="days" sub="At the shipment rate of this range" accent={C.ship} />
          <Kpi label="At the pit" value={short(pit)} unit="t" sub="ETO, waiting to be hauled" accent={C.prod} />
          <Kpi label="At the port" value={short(port)} unit="t" sub="EFO, waiting for a barge" accent={C.c3} />
        </div>
        <Panel title="Why the stock moved" hint="Stock by grade, then what was mined against what was shipped, then the weather that holds up barges.">
          <div className="space-y-3">
            <div><Sub>1. Stock by grade</Sub><DayChart aria="Ore stock by grade per day" days={d} unit=" t" onPick={pick} picked={picked} height={200} series={(m.grades as string[][]).map(([g, label], i) => ({ name: label, color: pal[i], kind: "bar", stack: "s", values: x.grade[g] })) as Serie[]} /></div>
            <div><Sub>2. Ore mined against shipped</Sub><DayChart aria="Ore mined and shipped per day" days={d} unit=" t" onPick={pick} picked={picked} height={170} series={[{ name: "Ore mined", color: C.prod, kind: "bar", values: m.s.ore }, { name: "Shipped", color: C.ship, kind: "line", values: m.s.ship }]} /></div>
            <div><Sub>3. Rain and slippery hours</Sub><Hrs m={m} pick={pick} picked={picked} /></div>
          </div>
        </Panel>
        <FlowCard title="Where the stock came from and went" hint="Opening stock, plus ore mined, minus ore shipped. The grey-red bar is what those two do not explain." b={b} unit="t" aria="Ore stock bridge" labels={["Stock", "Added", "Removed"]} />
        <Panel title="Nickel grade in stock" hint="Average of pit and port per grade, as loaded."><DayChart aria="Nickel grade by grade per day" days={d} unit="" minZero={false} height={180} series={(m.grades as string[][]).map(([g, label], i) => ({ name: label, color: pal[i], kind: "line", values: x.ni[g] })) as Serie[]} /></Panel>
        <Related onGo={onGo} items={[["shipment", "Shipment", "What took the stock out."], ["mining", "Mining", "What put the stock in."], ["hours", "Working hours", "Rain stops loading as well as digging."]]} />
      </div>
    );
  }

  if (id === "safety") {
    const c = dash.check, hz = c.hazard, ds = m.prodDays, wetDay = (i: number) => (m.s.wet[i] || 0) >= 1;
    const idx = d.map((_, i) => i).filter((i) => ds.includes(d[i])), incIdx = idx.filter((i) => (x.inc[i] || 0) > 0), incWet = incIdx.filter(wetDay).length, allWet = idx.filter(wetDay).length;
    const sumK = (k: string) => sumA(x.hse[k] as A);
    return (
      <div className="space-y-4" data-report="safety">
        <Head k="Safety · what happened and what is open">{c.safeDays != null ? `${c.safeDays} day${c.safeDays === 1 ? "" : "s"} ${c.lastBad ? `since the last fatality or lost time injury (${c.lastBad})` : "with no fatality or lost time injury in this range"}. ` : ""}{incIdx.length ? `${incWet} of ${incIdx.length} days with a reported event were rainy, against ${allWet} of ${idx.length} days overall.` : "No event is reported in this range."}</Head>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <Kpi label="Near misses" value={nf(sumK("NM"))} sub="Reported, nobody hurt" accent={C.info} />
          <Kpi label="Injuries" value={nf(sumK("MTI") + sumK("LTI") + sumK("FAI") + sumK("FATALITY"))} sub={`${nf(sumK("LTI") + sumK("FATALITY"))} lost time or fatal`} accent={C.bad} />
          <Kpi label="Damage, fire and environment" value={nf(sumK("PD") + sumK("FC") + sumK("EC"))} sub="Property, fire, environmental cases" accent={C.warn} />
          <Kpi label="Hazard findings open" value={nf(hz.open)} sub={`of ${nf(hz.total)} found in the range`} accent={C.c5} />
        </div>
        <Panel title="Events against the conditions that day" hint="Events by type, then the hours worked and the weather. Look for events that bunch on rainy or long days."><div className="space-y-3">
          <div><Sub>1. Events per day</Sub><DayChart aria="Safety events per day" days={d} onPick={pick} picked={picked} height={190} series={m.hseKeys.filter((k: string) => sumK(k) > 0).map((k: string, i: number) => ({ name: ({ NM: "Near miss", MTI: "Medical treatment", LTI: "Lost time", FAI: "First aid", PD: "Property damage", FC: "Fire", EC: "Environment", FATALITY: "Fatality" } as Record<string, string>)[k], color: k === "LTI" || k === "FATALITY" ? C.bad : pal[i % 8], kind: "bar" as const, stack: "h", values: x.hse[k] })) as Serie[]} /></div>
          <div><Sub>2. Hours worked and lost to weather</Sub><DayChart aria="Working hours and rain hours" days={d} unit=" h" onPick={pick} picked={picked} height={160} series={[{ name: "Working hours", color: C.c3, kind: "bar", values: m.s.ewh }, { name: "Rain + slippery", color: C.info, kind: "line", values: m.s.wet }]} /></div>
          <div><Sub>3. Units operating</Sub><DayChart aria="Units operating" days={d} onPick={pick} picked={picked} height={130} legend={false} series={[{ name: "Operating", color: C.good, kind: "line", values: m.s.OP }]} /></div>
        </div></Panel>
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="Hazard findings by risk"><HBars aria="Hazard findings by risk" items={hz.byRisk} colorOf={(n: string) => (/high|extreme/i.test(n) ? C.bad : /medium/i.test(n) ? C.warn : C.info)} rows={5} /></Panel>
          <Panel title="Hazard findings by category"><HBars aria="Hazard findings by category" items={hz.byCategory} color={C.c5} rows={6} /></Panel>
        </div>
        <Panel title="Open hazards that need a corrective action" hint="Highest risk first."><ul className="space-y-1.5 text-sm">{hz.openList.slice(0, 6).map((h: { date: string; site: string; risk: string; location: string; hazard: string; action: string }, i: number) => <li key={i} className="rounded-lg border p-2.5"><b>{h.date.slice(5)}</b> · {h.site} · <span className="font-medium">{h.risk}</span> · {h.location}<br /><span className="text-muted-foreground">{h.hazard}{h.action ? ` → ${h.action}` : ""}</span></li>)}{!hz.openList.length && <li className="rounded-lg border border-dashed p-3 text-muted-foreground">No open hazard finding.</li>}</ul></Panel>
        <RainPanel m={m} only={["Incidents and near misses", "Effective working hours", "Units operating", "Units in breakdown"]} />
        <Related onGo={onGo} items={[["hours", "Working hours", "Exposure: how long people worked and in what weather."], ["equipment", "Equipment", "Breakdowns and standby."], ["hauling", "Hauling", "Truck movements are where most road hazards sit."]]} />
      </div>
    );
  }

  if (id === "fuel") {
    const stock = lastV(x.fuelStock), use = t.fuel, perDay = use / Math.max(1, m.prodDays.length), cover = stock != null && perDay > 0 ? stock / perDay : null;
    return (
      <div className="space-y-4" data-report="fuel">
        <Head k="Fuel · what the work burned">{use > 0 ? `${short(use)} L was used${t.ob + t.ore > 0 ? `, ${(use / Math.max(1, t.haul || t.ob)).toFixed(2)} L per BCM hauled` : ""}. ` : "No fuel use is loaded. "}{cover != null ? `The stock on the last day covers ${cover.toFixed(1)} days at this rate.` : ""}</Head>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <Kpi label="Fuel used" value={short(use)} unit="L" sub={`${nf(perDay, 0)} L per day`} accent={C.warn} />
          <Kpi label="Per BCM hauled" value={t.haul > 0 ? (use / t.haul).toFixed(2) : "–"} unit="L/BCM" sub="Rises when trucks idle or queue" accent={C.c3} />
          <Kpi label="Per working hour" value={t.ewh > 0 ? nf(use / t.ewh, 0) : "–"} unit="L/h" sub="Fuel against hours worked" accent={C.c4} />
          <Kpi label="Stock on the last day" value={short(stock)} unit="L" sub={cover != null ? `${cover.toFixed(1)} days of cover` : undefined} accent={(stock ?? 1) < 0 ? C.bad : C.ship} />
        </div>
        <Panel title="What the fuel depends on" hint="Fuel used, then the work it paid for, the hours, and the stock behind it."><div className="space-y-3">
          <div><Sub>1. Fuel used</Sub><DayChart aria="Fuel used per day" days={d} unit=" L" onPick={pick} picked={picked} height={170} legend={false} series={[{ name: "Fuel used", color: C.warn, kind: "bar", values: m.s.fuel }]} /></div>
          <div><Sub>2. Fuel per BCM</Sub><DayChart aria="Fuel per BCM per day" days={d} unit=" L" onPick={pick} picked={picked} height={140} legend={false} minZero={false} series={[{ name: "L per BCM", color: C.c3, kind: "line", values: m.s.fuelPerBcm }]} /></div>
          <div><Sub>3. Volume hauled</Sub><DayChart aria="Volume hauled per day" days={d} unit=" BCM" onPick={pick} picked={picked} height={140} legend={false} series={[{ name: "Hauled", color: C.c5, kind: "bar", values: m.s.haul }]} /></div>
          <div><Sub>4. Rain and slippery hours</Sub><Hrs m={m} pick={pick} picked={picked} /></div>
          <div><Sub>5. Stock and deliveries</Sub><DayChart aria="Fuel stock and deliveries" days={d} unit=" L" onPick={pick} picked={picked} height={160} series={[{ name: "Stock", color: C.ship, kind: "line", values: x.fuelStock }, { name: "Received", color: C.good, kind: "bar", values: x.fuelAdd }]} /></div>
        </div></Panel>
        <FlowCard title="Where the fuel stock went" hint="Opening stock, plus fuel received, minus fuel used. The last red or green bar is what those do not explain." b={m.bridges.fuel as unknown as Flow} unit="L" aria="Fuel stock bridge" labels={["Stock", "Received", "Used"]} />
        <RainPanel m={m} only={["Fuel per BCM", "Fuel used", "Hauled volume", "Effective working hours", "Units operating"]} />
        <p className="text-xs text-muted-foreground">The FR column of the fuel table is not used above because its meaning is not confirmed. Tell me what it holds and I will add it.</p>
        <Related onGo={onGo} items={[["hauling", "Hauling", "Most fuel is burned by the trucks."], ["equipment", "Equipment", "Idle units still burn fuel."], ["availability", "Availability", "Breakdowns send work to fewer units."]]} />
      </div>
    );
  }

  if (id === "manpower") {
    const now = lastV(x.mp), joined = sumA(x.mpAdd), left = sumA(x.mpRes), avgHead = (() => { const v = (x.mp as A).filter((q): q is number => q != null); return v.length ? v.reduce((a: number, b: number) => a + b, 0) / v.length : null; })();
    const crew = lastV(x.crewPerUnit), per = lastV(x.bcmPerHead);
    return (
      <div className="space-y-4" data-report="manpower">
        <Head k="Manpower · who is on site">{now == null ? "No manpower row is loaded." : `${nf(now)} people on the last day. ${nf(joined)} joined and ${nf(left)} left in the range${avgHead ? `, a turnover of ${((left / avgHead) * 100).toFixed(1)}%` : ""}.`}</Head>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
          <Kpi label="Headcount" value={nf(now)} sub="Last loaded day" accent={C.c4} />
          <Kpi label="Joined" value={nf(joined)} accent={C.good} />
          <Kpi label="Left" value={nf(left)} accent={C.bad} />
          <Kpi label="Drivers and operators per operating unit" value={crew == null ? "–" : crew.toFixed(1)} sub="Under 1 means units without a crew" accent={C.c3} />
          <Kpi label="Overburden per person" value={nf(per, 0)} unit="BCM/day" accent={C.prod} />
        </div>
        <Panel title="People against the work" hint="Headcount and movements, who they are, and what each person moved."><div className="space-y-3">
          <div><Sub>1. Headcount</Sub><DayChart aria="Headcount per day" days={d} onPick={pick} picked={picked} height={150} minZero={false} legend={false} series={[{ name: "Headcount", color: C.c4, kind: "line", values: x.mp }]} /></div>
          <div><Sub>2. Joined and left</Sub><DayChart aria="People joined and left per day" days={d} onPick={pick} picked={picked} height={120} series={[{ name: "Joined", color: C.good, kind: "bar", values: x.mpAdd }, { name: "Left", color: C.bad, kind: "bar", values: x.mpRes }]} /></div>
          <div><Sub>3. By role</Sub><DayChart aria="Headcount by role per day" days={d} onPick={pick} picked={picked} height={190} series={m.roleKeys.map((k: string, i: number) => ({ name: k, color: pal[i], kind: "bar" as const, stack: "r", values: x.roles[k] })) as Serie[]} /></div>
          <div><Sub>4. Units operating and overburden</Sub><DayChart aria="Units operating per day" days={d} onPick={pick} picked={picked} height={130} legend={false} series={[{ name: "Operating units", color: C.good, kind: "line", values: m.s.OP }]} /></div>
        </div></Panel>
        <FlowCard title="Where the headcount came from" hint="Opening headcount, plus joiners, minus leavers. The last bar is any other change, for example transfers." b={m.bridges.people as unknown as Flow} unit="people" aria="Headcount bridge" labels={["Headcount", "Joined", "Left"]} />
        <Related onGo={onGo} items={[["equipment", "Equipment", "A unit needs a driver or operator."], ["mining", "Mining", "Volume per person."], ["safety", "Safety", "Exposure grows with people on site."]]} />
      </div>
    );
  }

  if (id === "lab") {
    const fam = ["ID", "FD", "AD"], tot = (f: string) => m.labTypes.reduce((a: number, tp: string) => a + sumA(x.lab[f][tp] as A), 0), all = sumA(x.labTotal);
    const bar = (f: string) => m.labTypes.filter((tp: string) => sumA(x.lab[f][tp] as A) > 0).map((tp: string, i: number) => ({ name: tp, color: pal[i % 8], kind: "bar" as const, stack: "l", values: x.lab[f][tp] }));
    return (
      <div className="space-y-4" data-report="lab">
        <Head k="Laboratory · samples handled">{all > 0 ? `${nf(all)} samples were handled in the range${t.ship > 0 ? `, ${nf((all / t.ship) * 1000, 1)} per 1,000 t shipped` : ""}.` : "No lab row is loaded in this range."}</Head>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <Kpi label="All samples" value={nf(all)} accent={C.c3} />
          {fam.map((f) => <Kpi key={f} label={`Family ${f}`} value={nf(tot(f))} sub="As loaded in the lab table" accent={C.c4} />)}
        </div>
        <Panel title="Samples per day, by type" hint="One chart per family. The meaning of ID, FD and AD is shown as loaded and is not confirmed."><div className="space-y-3">
          {fam.map((f) => <div key={f}><Sub>{f}</Sub><DayChart aria={`Lab samples ${f} per day`} days={d} onPick={pick} picked={picked} height={140} series={bar(f) as Serie[]} /></div>)}
        </div></Panel>
        <Panel title="What the samples follow" hint="Barge samples should follow shipment, exploration samples should follow drilling, production samples should follow ore mined."><div className="space-y-3">
          <div><Sub>Barge samples against shipment</Sub><DayChart aria="Barge samples and shipment per day" days={d} height={150} series={[{ name: "Shipment (t)", color: C.ship, kind: "bar", values: m.s.ship }, { name: "Barge samples ×1000", color: C.warn, kind: "line", values: m.labTypes.includes("BARGE") ? d.map((_: string, i: number) => { const v = fam.reduce((a, f) => a + (x.lab[f].BARGE[i] || 0), 0); return v ? v * 1000 : null; }) : [] }]} /></div>
          <div><Sub>Exploration samples against samples drilled</Sub><DayChart aria="Exploration lab samples and samples drilled" days={d} height={150} series={[{ name: "Samples drilled", color: C.c5, kind: "bar", values: x.explo["A-SAMPLE"] }, { name: "Lab exploration samples", color: C.c3, kind: "line", values: d.map((_: string, i: number) => { const v = fam.reduce((a, f) => a + (x.lab[f].EXPLO[i] || 0), 0); return v || null; }) }]} /></div>
        </div></Panel>
        <RainPanel m={m} only={["Lab samples", "Samples drilled", "Ore produced", "Shipment"]} />
        <Related onGo={onGo} items={[["exploration", "Exploration", "Drilling creates the samples."], ["shipment", "Shipment", "Every barge needs its sample."], ["mining", "Mining", "Grade control samples follow ore mined."]]} />
      </div>
    );
  }

  if (id === "exploration") {
    const e = x.explo, a = (k: string) => sumA(e[k] as A), dh = pc(a("A-DH"), a("P-DH")), sm = pc(a("A-SAMPLE"), a("P-SAMPLE")), dp = pc(a("A-DEPTH"), a("P-DEPTH"));
    const lines = (pl: string, ac: string, name: string): Serie[] => [{ name: `${name} actual`, color: C.c5, kind: "bar", values: e[ac] }, { name: `${name} plan`, color: C.plan, kind: "line", dashed: true, values: e[pl] }];
    return (
      <div className="space-y-4" data-report="exploration">
        <Head k="Exploration · drilling against plan">{a("P-DH") + a("P-DEPTH") > 0 ? `Drilling reached ${nf(dp ?? dh, 0)}% of the planned ${dp != null ? "depth" : "holes"}, with ${nf(sm, 0)}% of the planned samples. ` : "No exploration plan is loaded. "}{m.rainEffect.ok ? (() => { const r = m.rainEffect.rows?.find((q: { label: string }) => q.label === "Drill holes drilled"); return r && r.change != null ? `On rainy days drilling was ${r.change > 0 ? "up" : "down"} ${Math.abs(r.change).toFixed(0)}%.` : ""; })() : ""}</Head>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <Kpi label="Drill holes" value={nf(a("A-DH"))} pct={dh} sub={`plan ${nf(a("P-DH"))}`} />
          <Kpi label="Samples" value={nf(a("A-SAMPLE"))} pct={sm} sub={`plan ${nf(a("P-SAMPLE"))}`} />
          <Kpi label="Depth" value={nf(a("A-DEPTH"))} unit="m" pct={dp} sub={`plan ${nf(a("P-DEPTH"))}`} />
          <Kpi label="SO and PUH" value={`${nf(a("SO-ACTUAL"))} / ${nf(a("PUH-ACTUAL"))}`} sub={`plan ${nf(a("SO-PLAN"))} / ${nf(a("PUH-PLAN"))}, shown as loaded`} accent={C.c3} />
        </div>
        <Panel title="Plan against actual, day by day" hint="Bars are drilled, the dashed line is the plan. A bar under the line is a day behind."><div className="space-y-3">
          <div><Sub>1. Drill holes</Sub><DayChart aria="Drill holes per day against plan" days={d} unit=" holes" onPick={pick} picked={picked} height={150} series={lines("P-DH", "A-DH", "Holes")} /></div>
          <div><Sub>2. Depth</Sub><DayChart aria="Drilled depth per day against plan" days={d} unit=" m" onPick={pick} picked={picked} height={150} series={lines("P-DEPTH", "A-DEPTH", "Depth")} /></div>
          <div><Sub>3. Samples</Sub><DayChart aria="Samples per day against plan" days={d} onPick={pick} picked={picked} height={150} series={lines("P-SAMPLE", "A-SAMPLE", "Samples")} /></div>
          <div><Sub>4. Rain and slippery hours</Sub><Hrs m={m} pick={pick} picked={picked} /></div>
        </div></Panel>
        <Panel title="Running total against plan"><DayChart aria="Cumulative depth against plan" days={d} unit=" m" height={190} series={[{ name: "Depth actual", color: C.c5, kind: "line", values: cum(e["A-DEPTH"]) }, { name: "Depth plan", color: C.plan, kind: "line", dashed: true, values: cum(e["P-DEPTH"]) }]} /></Panel>
        <RainPanel m={m} only={["Drill holes drilled", "Samples drilled", "Effective working hours"]} />
        <Related onGo={onGo} items={[["lab", "Laboratory", "Where the samples go."], ["geomap", "Geological map", "Drilling widens the mapped area."], ["hours", "Working hours", "Rain stops drilling too."]]} />
      </div>
    );
  }

  const area = x.geo as A, now = lastV(area), then = firstV(area), step = area.map((v, i) => (v != null && i > 0 && area[i - 1] != null ? v - (area[i - 1] as number) : null));
  return (
    <div className="space-y-4" data-report="geomap">
      <Head k="Geological map · area covered">{now == null ? "No mapped area is loaded in this range." : `${nf(now, 1)} of area is covered${then != null && then !== now ? `, ${now > then ? "up" : "down"} ${nf(Math.abs(now - then), 1)} over the range` : ""}. The unit is as loaded in the table.`}</Head>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Kpi label="Total covered area" value={nf(now, 1)} accent={C.c3} />
        <Kpi label="Added in the range" value={then != null && now != null ? nf(now - then, 1) : "–"} accent={C.good} />
        <Kpi label="Drill holes in the range" value={nf(sumA(x.explo["A-DH"]))} sub="Drilling is what widens the map" accent={C.c5} />
        <Kpi label="Samples in the range" value={nf(sumA(x.explo["A-SAMPLE"]))} accent={C.c4} />
      </div>
      <Panel title="Area next to the drilling that feeds it"><div className="space-y-3">
        <div><Sub>1. Total covered area</Sub><DayChart aria="Covered area per day" days={d} height={170} minZero={false} legend={false} series={[{ name: "Covered area", color: C.c3, kind: "line", values: area }]} /></div>
        <div><Sub>2. Area added per day</Sub><DayChart aria="Area added per day" days={d} height={130} legend={false} series={[{ name: "Added", color: C.good, kind: "bar", values: step }]} /></div>
        <div><Sub>3. Drill holes</Sub><DayChart aria="Drill holes per day" days={d} height={130} legend={false} series={[{ name: "Drill holes", color: C.c5, kind: "bar", values: x.explo["A-DH"] }]} /></div>
      </div></Panel>
      <Related onGo={onGo} items={[["exploration", "Exploration", "The drilling behind the map."], ["lab", "Laboratory", "Assays that confirm what is mapped."], ["mining", "Mining", "Where the mapped ore is mined."]]} />
    </div>
  );
}
