// Report-by-table model (Phase 4.8). Pure: builds the cause-and-effect story from etl_dash_data results.
// Waterfall (agreed method): Production plan -> one bar per cause -> Availability -> Productivity -> Actual.
//   volume = overburden BCM (tblRAWMNG OB-DAY against tblCALENDAR OB-DAY); rate = actual BCM per actual EWH of the period.
//   cause effect = (planned hours - actual hours) x rate. Rain and Slippery use their own calendar plan hours; the other delay causes
//   share (calendar TOTAL DELAY - RAIN - SLIPPERY) in proportion to their actual hours. A positive bar is a gain (less delay than plan).
//   Availability = volume after the causes x (actual PA / plan PA - 1). Productivity is what is left, so the bridge always closes on Actual.
import { sumBy, sumCols, avgBy, addMaps, arr, rowsOf, pctScale, DELAY_COLS, dayList } from "./dash-model.js";

export const EQ_TYPES = ["EXC1", "EXC2", "EXC3", "DT", "ADT", "DOZER", "BREAKER", "GRADER", "COMPAC", "FT", "WT", "LV", "LT"];
export const EQ_GROUPS = [["Excavators", ["EXC1", "EXC2", "EXC3"]], ["Dump trucks", ["DT", "ADT"]], ["Dozer, grader, compactor", ["DOZER", "GRADER", "COMPAC"]], ["Other support", ["BREAKER", "FT", "WT", "LV", "LT"]]];
export const CAUSE_LABEL = {
  "RAIN HOUR": "Rain", SLIPPERY: "Slippery", "DAILY MEETING (P5M)": "Daily meeting (P5M)", "GENERAL SAFETY TALK": "Safety talk", "FRIDAY PRAY": "Friday prayer", "REST & MEAL": "Rest & meal",
  "REFUELLING & DAILY SERVICE (P2H)": "Refuelling & P2H", RELOCATIONS: "Relocations", "PREPARE LOADING/DUMPING POINT": "Prepare loading/dumping", "SHIFT CHANGE": "Shift change",
  "SURVEY & GC": "Survey & GC", "PREPARE TOWER LAMP": "Prepare tower lamp", "BREAK FASTING": "Break fasting", OTHERS: "Others",
};
const LMH = ["L-DAY", "M-DAY", "H-DAY"];
const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);
const mean = (a) => { const v = a.filter((x) => x != null && Number.isFinite(x)); return v.length ? sum(v) / v.length : null; };
const meanOfMaps = (maps) => { const out = new Map(); const keys = new Set(); maps.forEach((m) => m.forEach((_, d) => keys.add(d))); keys.forEach((d) => { const v = maps.map((m) => m.get(d)).filter((x) => x != null); if (v.length) out.set(d, sum(v) / v.length); }); return out; };
const at = (m, days) => days.reduce((a, d) => a + (m.get(d) || 0), 0);

export function linreg(xs, ys) {
  const n = xs.length; if (n < 4) return null;
  const mx = sum(xs) / n, my = sum(ys) / n; let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  if (!(sxx > 0) || !(syy > 0)) return null;
  return { slope: sxy / sxx, intercept: my - (sxy / sxx) * mx, r: sxy / Math.sqrt(sxx * syy), n };
}

/** Opening + inflows - outflows +/- what is left = closing, read from a stock-like column. Returns null steps when fewer than two days have a stock. */
function flowBridge(stockMap, flows, days, labels, okDay = () => true) {
  const have = days.filter((d) => stockMap.has(d) && okDay(d));
  if (have.length < 2) return { ok: false, why: "Needs a stock value on at least two days of the range." };
  const first = have[0], last = have.at(-1), use = days.filter((d) => d > first && d <= last);
  const open = stockMap.get(first), close = stockMap.get(last);
  const steps = [{ key: "open", label: `${labels.open} ${first.slice(5)}`, type: "total", value: open }];
  let net = 0;
  flows.forEach((f) => { const v = at(f.map, use) * f.sign; net += v; steps.push({ key: f.key, label: f.label, type: "delta", value: v }); });
  const rest = close - open - net;
  steps.push({ key: "adj", label: labels.adj, type: "delta", value: rest, note: labels.adjNote });
  steps.push({ key: "close", label: `${labels.close} ${last.slice(5)}`, type: "total", value: close });
  let run = 0; steps.forEach((x) => { if (x.type === "total") { x.start = 0; x.end = x.value; run = x.value; } else { x.start = run; run += x.value; x.end = run; } });
  return { ok: true, steps, open, close, first, last, rest, days: use.length, skipped: days.filter((d) => d >= first && d <= last && stockMap.has(d) && !okDay(d)).length };
}

export function buildReports(raw, { from, to }) {
  const sites = Object.keys(raw || {}).filter((k) => raw[k]);
  const days = dayList(from, to);
  const R = (t) => sites.flatMap((s) => rowsOf(raw[s], t));
  const hse = R("tblRAWHSE"), mp = R("tblRAWMP"), lab = R("tblRAWLAB"), ex = R("tblRAWEXPLO"), geo = R("tblRAWGEOMAP");
  const mng = R("tblRAWMNG"), ship = R("tblRAWSHIP"), cal = R("tblCALENDAR"), haul = R("tblRAWHAUL"), we = R("tblRAWWEWH"), up = R("tblRAWUP"), eq = R("tblRAWEQ"), fuel = R("tblRAWFUEL"), stk = R("tblRAWSTOCK");
  const ore = sumCols(mng, LMH), ob = sumBy(mng, "OB-DAY"), planOb = sumBy(cal, "OB-DAY"), planOre = sumCols(cal, LMH);
  const shipM = sumBy(ship, "DAY"), planShip = sumBy(cal, "ST-DAY"), haulM = sumBy(haul, "DAY"), fuelM = sumBy(fuel, "DAY"), ewh = sumBy(we, "EWH");
  const cause = Object.fromEntries(DELAY_COLS.map((c) => [c, sumBy(we, c)]));
  const wet = addMaps([cause["RAIN HOUR"], cause.SLIPPERY]);
  const other = addMaps(DELAY_COLS.filter((c) => c !== "RAIN HOUR" && c !== "SLIPPERY").map((c) => cause[c]));
  const ewhP = sumBy(cal, "EFFECTIVE WORKING HOUR (EWH)"), rainP = sumBy(cal, "RAIN HOUR"), slipP = sumBy(cal, "SLIPPERY"), totP = sumBy(cal, "TOTAL DELAY");
  const grp = (sfx) => meanOfMaps(["EXC", "DT", "DZ", "GD", "CP"].map((g) => avgBy(up, `${g}-${sfx}`)));
  const pa = grp("PA"), ma = grp("MA"), ua = grp("UA"), eu = grp("EU"), paPlan = avgBy(cal, "PHYSICAL AVAILABILITY (PA)");
  const units = Object.fromEntries(["OP", "S", "B", "P"].map((st) => [st, sumCols(eq, EQ_TYPES.map((t) => `${st}-${t}`))]));
  const dtUnits = Object.fromEntries(["OP", "S", "B"].map((st) => [st, sumCols(eq, ["DT", "ADT"].map((t) => `${st}-${t}`))]));
  const stockKeys = new Set(); stk.forEach((r) => Object.keys(r.v || {}).forEach((k) => /^E[TF]O-[A-Z]+-TONAGE$/.test(k) && stockKeys.add(k)));
  const stock = sumCols(stk, [...stockKeys]);
  const HSE_K = ["NM", "MTI", "LTI", "FAI", "PD", "FC", "EC", "FATALITY"], LAB_T = ["FP", "QC", "SS", "SC", "FO", "DOME", "BARGE", "EXPLO"], ROLE_K = ["MANAGER", "SPT", "SPV", "DRIVER", "OPERATOR", "ETC"];
  const hseM = Object.fromEntries(HSE_K.map((k) => [k, sumBy(hse, k)])), inc = sumCols(hse, HSE_K), incSerious = sumCols(hse, ["MTI", "LTI", "FATALITY"]);
  const fuelStock = sumBy(fuel, "STOCK"), fuelAdd = sumBy(fuel, "STOCK ADD"), fuelFR = avgBy(fuel, "FR");
  const mpTotal = sumBy(mp, "TOTAL"), mpAdd = sumBy(mp, "ADD"), mpRes = sumBy(mp, "RESIGN"), roles = Object.fromEntries(ROLE_K.map((k) => [k, sumBy(mp, k)]));
  const labM = Object.fromEntries(["ID", "FD", "AD"].map((f) => [f, Object.fromEntries(LAB_T.map((t) => [t, sumBy(lab, `${f}-${t}`)]))]));
  const labTotal = sumCols(lab, ["ID", "FD", "AD"].flatMap((f) => LAB_T.map((t) => `${f}-${t}`)));
  const xm = Object.fromEntries(["SO-PLAN", "SO-ACTUAL", "PUH-PLAN", "PUH-ACTUAL", "P-DH", "A-DH", "P-SAMPLE", "A-SAMPLE", "P-DEPTH", "A-DEPTH"].map((k) => [k, sumBy(ex, k)]));
  const geoM = sumBy(geo, "TOTAL COVERED AREA");
  const GRADES = [["H", "HGO"], ["M", "MGO"], ["L", "LGO"], ["LB", "LGO-B"]];
  const oreStock = sumCols(stk, GRADES.flatMap(([g]) => [`ETO-${g}-TONAGE`, `EFO-${g}-TONAGE`]));
  const gradeStock = Object.fromEntries(GRADES.map(([g]) => [g, sumCols(stk, [`ETO-${g}-TONAGE`, `EFO-${g}-TONAGE`])]));
  const gradeNi = Object.fromEntries(GRADES.map(([g]) => [g, meanOfMaps([avgBy(stk, `ETO-${g}-Ni`), avgBy(stk, `EFO-${g}-Ni`)])]));
  const pitStock = sumCols(stk, GRADES.map(([g]) => `ETO-${g}-TONAGE`)), portStock = sumCols(stk, GRADES.map(([g]) => `EFO-${g}-TONAGE`));
  const loaded = days.filter((d) => ob.has(d) || ore.has(d) || shipM.has(d));
  const prodDays = days.filter((d) => ob.has(d) || ore.has(d));
  const A = (m) => arr(m, days);
  // a day counts for a bridge only when every chosen site has loaded that table, otherwise a late site looks like a stock drop
  const full = (t) => { const sets = sites.map((x) => new Set(rowsOf(raw[x], t).map((r) => String(r.d).slice(0, 10)))); return (d) => sets.every((z) => z.has(d)); };

  // ---- waterfall ----
  const wf = (() => {
    const use = prodDays;
    const vPlan = at(planOb, use), vAct = at(ob, use), hAct = at(ewh, use);
    if (!(vPlan > 0)) return { ok: false, why: "No overburden plan is loaded in the Calendar for this range." };
    if (!(hAct > 0)) return { ok: false, why: "No effective working hours are loaded for this range." };
    const rate = vAct / hAct;
    const rainPlan = at(rainP, use), slipPlan = at(slipP, use), otherPlan = Math.max(0, at(totP, use) - rainPlan - slipPlan);
    const others = DELAY_COLS.filter((c) => c !== "RAIN HOUR" && c !== "SLIPPERY");
    const act = Object.fromEntries(DELAY_COLS.map((c) => [c, at(cause[c], use)]));
    const otherAct = sum(others.map((c) => act[c]));
    const rows = DELAY_COLS.map((c) => {
      const plan = c === "RAIN HOUR" ? rainPlan : c === "SLIPPERY" ? slipPlan : otherAct > 0 ? (otherPlan * act[c]) / otherAct : 0;
      return { key: c, label: CAUSE_LABEL[c], planHours: plan, hours: act[c], value: (plan - act[c]) * rate };
    });
    const v1 = vPlan + sum(rows.map((r) => r.value));
    const paA = mean(use.map((d) => pa.get(d))), paP = mean(use.map((d) => paPlan.get(d)));
    const paAp = pctScale(paA), pap = pctScale(paP);
    const availOk = paAp != null && pap != null && pap > 0;
    const avail = availOk ? v1 * (paAp / pap - 1) : 0;
    const prod = vAct - v1 - avail;
    const steps = [{ key: "plan", label: "Production plan", type: "total", value: vPlan }, ...rows.map((r) => ({ ...r, type: "delta" })),
      { key: "avail", label: "Availability (PA)", type: "delta", value: avail, note: availOk ? `PA ${paAp.toFixed(1)}% against plan ${pap.toFixed(1)}%` : "No PA plan or actual loaded" },
      { key: "prod", label: "Productivity", type: "delta", value: prod, note: "What is left: BCM per working hour against the plan" },
      { key: "actual", label: "Actual production", type: "total", value: vAct }];
    let run = 0; steps.forEach((s) => { if (s.type === "total") { s.start = 0; s.end = s.value; run = s.value; } else { s.start = run; run += s.value; s.end = run; } });
    return { ok: true, rate, hours: hAct, steps, vPlan, vAct, gap: vAct - vPlan, availOk, days: use.length, worst: [...rows, { key: "avail", label: "Availability (PA)", value: avail }, { key: "prod", label: "Productivity", value: prod }].sort((a, b) => a.value - b.value)[0] };
  })();

  // ---- rain days against dry days ----
  const rainEffect = (() => {
    const use = prodDays.filter((d) => wet.has(d) || cause["RAIN HOUR"].has(d));
    const rainD = use.filter((d) => (wet.get(d) || 0) >= 1), dryD = use.filter((d) => (wet.get(d) || 0) < 1);
    if (rainD.length < 1 || dryD.length < 1) return { ok: false, nRain: rainD.length, nDry: dryD.length };
    const m = (map, ds) => mean(ds.map((d) => map.get(d)).filter((x) => x != null));
    const row = (label, unit, map, goodUp, conv) => { const a = m(map, dryD), b = m(map, rainD); const f = conv || ((x) => x); const dry = a == null ? null : f(a), rain = b == null ? null : f(b); return { label, unit, dry, rain, change: dry != null && rain != null && dry !== 0 ? ((rain - dry) / Math.abs(dry)) * 100 : null, goodUp }; };
    const perBcm = (map1, map2) => { const o = new Map(); for (const d of prodDays) { const a = map1.get(d), b = map2.get(d); if (a != null && b > 0) o.set(d, a / b); } return o; };
    const rows = [
      row("Overburden moved", "BCM/day", ob, true), row("Ore produced", "t/day", ore, true), row("Shipment", "t/day", shipM, true), row("Hauled volume", "BCM/day", haulM, true),
      row("Effective working hours", "h/day", ewh, true), row("Units operating", "units", units.OP, true), row("Units on standby", "units", units.S, false), row("Units in breakdown", "units", units.B, false),
      row("Trucks operating", "units", dtUnits.OP, true), row("Trucks in breakdown", "units", dtUnits.B, false), row("Physical availability", "%", pa, true, pctScale), row("Utilization of availability", "%", ua, true, pctScale),
      row("Fuel per BCM", "L/BCM", perBcm(fuelM, ob), false), row("Fuel used", "L/day", fuelM, false), row("Incidents and near misses", "per day", inc, false),
      row("Drill holes drilled", "holes/day", xm["A-DH"], true), row("Samples drilled", "samples/day", xm["A-SAMPLE"], true), row("Lab samples", "samples/day", labTotal, true),
    ].filter((r) => r.dry != null && r.rain != null);
    return { ok: true, nRain: rainD.length, nDry: dryD.length, rows };
  })();

  const link = (() => {
    const xs = [], ys = [], hs = [];
    prodDays.forEach((d) => { if (ob.has(d) && ewh.has(d)) { xs.push(wet.get(d) || 0); ys.push(ob.get(d)); hs.push(ewh.get(d)); } });
    const lr = linreg(xs, ys), le = linreg(hs, ys);
    return { rain: lr, ewh: le };
  })();

  // ---- why was a day low ----
  const avgOf = (map) => mean(prodDays.map((d) => map.get(d)).filter((x) => x != null));
  const avg = { ob: avgOf(ob), ewh: avgOf(ewh), wet: avgOf(wet), other: avgOf(other), B: avgOf(units.B), S: avgOf(units.S), OP: avgOf(units.OP), pa: avgOf(pa), haul: avgOf(haulM) };
  function explainDay(d) {
    const v = (m) => (m.has(d) ? m.get(d) : null), reasons = [];
    const o = v(ob), planD = v(planOb);
    const push = (w, text) => reasons.push({ w, text });
    const wetH = v(wet), e = v(ewh), b = v(units.B), s = v(units.S), p = v(pa), oth = v(other), op = v(units.OP);
    if (wetH != null && avg.wet != null && wetH >= 1 && wetH > avg.wet + 0.5) push((wetH - avg.wet) / Math.max(1, avg.ewh || 12) * 3, `rain and slippery roads took ${wetH.toFixed(1)} h (range average ${avg.wet.toFixed(1)} h)`);
    if (e != null && avg.ewh > 0 && e < avg.ewh * 0.9) push((avg.ewh - e) / avg.ewh * 2, `effective working hours were ${e.toFixed(1)} h, ${(((avg.ewh - e) / avg.ewh) * 100).toFixed(0)}% under the average`);
    if (b != null && avg.B != null && b > avg.B + 1) push((b - avg.B) / Math.max(1, avg.OP || 10), `${b.toFixed(0)} units were in breakdown (average ${avg.B.toFixed(1)})`);
    if (s != null && avg.S != null && s > avg.S + 1) push((s - avg.S) / Math.max(1, avg.OP || 10) * 0.8, `${s.toFixed(0)} units stood by (average ${avg.S.toFixed(1)})`);
    if (op != null && avg.OP > 0 && op < avg.OP * 0.88) push((avg.OP - op) / avg.OP, `only ${op.toFixed(0)} units operated (average ${avg.OP.toFixed(1)})`);
    if (p != null && avg.pa != null && pctScale(p) < pctScale(avg.pa) - 3) push((pctScale(avg.pa) - pctScale(p)) / 20, `physical availability was ${pctScale(p).toFixed(1)}% (average ${pctScale(avg.pa).toFixed(1)}%)`);
    if (oth != null && avg.other > 0 && oth > avg.other * 1.25) push((oth - avg.other) / Math.max(1, avg.ewh || 12), `other delay hours were ${oth.toFixed(1)} h (average ${avg.other.toFixed(1)} h)`);
    reasons.sort((a, b2) => b2.w - a.w);
    return { day: d, ob: o, plan: planD, pctPlan: o != null && planD > 0 ? (o / planD) * 100 : null, vsAvg: o != null && avg.ob > 0 ? ((o - avg.ob) / avg.ob) * 100 : null, reasons: reasons.map((r) => r.text) };
  }
  const worst = prodDays.filter((d) => ob.has(d)).map((d) => ({ d, score: planOb.get(d) > 0 ? ob.get(d) / planOb.get(d) : ob.get(d) / (avg.ob || 1) })).sort((a, b) => a.score - b.score).slice(0, 5).map((x) => explainDay(x.d));

  // ---- by equipment type and group ----
  const eqTypes = EQ_GROUPS.map(([label, types]) => {
    const g = (st) => mean(prodDays.map((d) => { const vals = types.map((t) => { const m = sumBy(eq, `${st}-${t}`); return m.get(d); }).filter((x) => x != null); return vals.length ? sum(vals) : null; }).filter((x) => x != null));
    const op = g("OP"), s = g("S"), b = g("B"), p = g("P");
    return { label, op, s, b, p, use: p > 0 ? ((op || 0) / p) * 100 : null };
  }).filter((r) => r.op != null || r.p != null);
  const availGroups = [["EXC", "Excavators"], ["DT", "Dump trucks"], ["DZ", "Dozers"], ["GD", "Graders"], ["CP", "Compactors"]].map(([k, label]) => ({ key: k, label, pa: pctScale(mean(prodDays.map((d) => avgBy(up, `${k}-PA`).get(d)))), ma: pctScale(mean(prodDays.map((d) => avgBy(up, `${k}-MA`).get(d)))), ua: pctScale(mean(prodDays.map((d) => avgBy(up, `${k}-UA`).get(d)))), eu: pctScale(mean(prodDays.map((d) => avgBy(up, `${k}-EU`).get(d)))) })).filter((r) => r.pa != null || r.ma != null);

  const causes = DELAY_COLS.map((c) => ({ key: c, label: CAUSE_LABEL[c], hours: at(cause[c], prodDays), values: A(cause[c]) })).filter((c) => c.hours > 0).sort((a, b) => b.hours - a.hours);
  const tot = (m) => at(m, prodDays);
  const perHour = tot(ewh) > 0 ? tot(ob) / tot(ewh) : null;
  return {
    from, to, days, loaded, prodDays, sites, wf, rainEffect, link, worst, explainDay, avg, eqTypes, availGroups, causes,
    totals: { ob: tot(ob), ore: tot(ore), planOb: tot(planOb), planOre: tot(planOre), ship: at(shipM, loaded), planShip: at(planShip, loaded), haul: tot(haulM), fuel: tot(fuelM), ewh: tot(ewh), wet: tot(wet), other: tot(other), perHour, stripping: tot(ore) > 0 ? tot(ob) / tot(ore) : null, wetDays: prodDays.filter((d) => (wet.get(d) || 0) >= 1).length },
    s: {
      ob: A(ob), ore: A(ore), planOb: A(planOb), planOre: A(planOre), ship: A(shipM), planShip: A(planShip), haul: A(haulM), fuel: A(fuelM), ewh: A(ewh), wet: A(wet), rain: A(cause["RAIN HOUR"]), slip: A(cause.SLIPPERY), other: A(other),
      ewhPlan: A(ewhP), OP: A(units.OP), S: A(units.S), B: A(units.B), P: A(units.P), dtOP: A(dtUnits.OP), dtB: A(dtUnits.B), dtS: A(dtUnits.S),
      pa: A(pa).map(pctScale), ma: A(ma).map(pctScale), ua: A(ua).map(pctScale), eu: A(eu).map(pctScale), paPlan: A(paPlan).map(pctScale), stock: A(stock),
      haulPerEwh: days.map((d) => (haulM.has(d) && ewh.get(d) > 0 ? haulM.get(d) / ewh.get(d) : null)),
      haulPerDt: days.map((d) => (haulM.has(d) && dtUnits.OP.get(d) > 0 ? haulM.get(d) / dtUnits.OP.get(d) : null)),
      fuelPerBcm: days.map((d) => (fuelM.has(d) && ob.get(d) > 0 ? fuelM.get(d) / ob.get(d) : null)),
      strip: days.map((d) => (ob.has(d) && ore.get(d) > 0 ? ob.get(d) / ore.get(d) : null)),
      shipOverProd: days.map((d) => (shipM.has(d) && ore.get(d) > 0 ? shipM.get(d) / ore.get(d) : null)),
    },
    cause: Object.fromEntries(DELAY_COLS.map((c) => [c, A(cause[c])])),
    bridges: {
      stock: flowBridge(oreStock, [{ key: "prod", label: "Ore produced", map: ore, sign: 1 }, { key: "ship", label: "Shipped", map: shipM, sign: -1 }], days, { open: "Stock", close: "Stock", adj: "Moves and adjustments", adjNote: "Stock that the mined and shipped tonnes do not explain: rehandling, drying losses, survey corrections" }, full("tblRAWSTOCK")),
      fuel: flowBridge(fuelStock, [{ key: "add", label: "Fuel received", map: fuelAdd, sign: 1 }, { key: "use", label: "Fuel used", map: fuelM, sign: -1 }], days, { open: "Stock", close: "Stock", adj: "Unexplained", adjNote: "Stock change that deliveries and use do not explain: transfers, measurement, loss" }, full("tblRAWFUEL")),
      people: flowBridge(mpTotal, [{ key: "add", label: "Joined", map: mpAdd, sign: 1 }, { key: "res", label: "Left", map: mpRes, sign: -1 }], days, { open: "Headcount", close: "Headcount", adj: "Transfers and other", adjNote: "Headcount change that joiners and leavers do not explain" }, full("tblRAWMP")),
    },
    x: {
      stock: A(oreStock), pit: A(pitStock), port: A(portStock), grade: Object.fromEntries(GRADES.map(([g]) => [g, A(gradeStock[g])])), ni: Object.fromEntries(GRADES.map(([g]) => [g, A(gradeNi[g])])),
      hse: Object.fromEntries(HSE_K.map((k) => [k, A(hseM[k])])), inc: A(inc), incSerious: A(incSerious),
      fuelStock: A(fuelStock), fuelAdd: A(fuelAdd), fuelFR: A(fuelFR), fuelPerEwh: days.map((d) => (fuelM.has(d) && ewh.get(d) > 0 ? fuelM.get(d) / ewh.get(d) : null)),
      mp: A(mpTotal), mpAdd: A(mpAdd), mpRes: A(mpRes), roles: Object.fromEntries(ROLE_K.map((k) => [k, A(roles[k])])),
      bcmPerHead: days.map((d) => (ob.has(d) && mpTotal.get(d) > 0 ? ob.get(d) / mpTotal.get(d) : null)),
      crewPerUnit: days.map((d) => (units.OP.get(d) > 0 && mpTotal.get(d) > 0 ? ((roles.DRIVER.get(d) || 0) + (roles.OPERATOR.get(d) || 0)) / units.OP.get(d) : null)),
      lab: Object.fromEntries(["ID", "FD", "AD"].map((f) => [f, Object.fromEntries(LAB_T.map((t) => [t, A(labM[f][t])]))])), labTotal: A(labTotal),
      explo: Object.fromEntries(Object.keys(xm).map((k) => [k, A(xm[k])])), geo: A(geoM),
    },
    labTypes: LAB_T, roleKeys: ROLE_K, grades: GRADES, hseKeys: HSE_K,
  };
}
