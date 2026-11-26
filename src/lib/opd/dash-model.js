// Interactive dashboard model (Phase 4.7). Pure: takes what etl_dash_data returned per site and builds the PDCA story. No DOM, no network.
// Mapping (same as the Daily Report): production = ore L + M + H, shipment = SHIP DAY, plans = tblCALENDAR (L/M/H-*, ST-*),
// calendar YTD = approved annual plan (RKAB), MTD = full-month target. Cumulative columns are read on one day only, never summed over days.
import { elapsed, verdict, pct } from "./daily-report.js";

export const SITES = ["WKM", "BM", "TMS"];
export const COLORS = { WKM: "#c2410c", BM: "#0e7490", TMS: "#7c3aed" };
const num = (v) => { const x = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/,/g, "")); return Number.isFinite(x) ? x : 0; };
const GR = [["L", "LGO (limonite)"], ["M", "MGO"], ["H", "HGO (saprolite)"]];

// ---- dates ----
const toT = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const toISO = (t) => new Date(t).toISOString().slice(0, 10);
export const addDays = (iso, n) => toISO(toT(iso) + n * 86400000);
export const daysBetween = (a, b) => Math.round((toT(b) - toT(a)) / 86400000);
export function dayList(from, to) { const n = daysBetween(from, to); return n < 0 ? [] : Array.from({ length: n + 1 }, (_, i) => addDays(from, i)); }
const monthStart = (iso) => iso.slice(0, 8) + "01";
const yearEnd = (iso) => iso.slice(0, 4) + "-12-31";

export const PRESETS = [
  { id: "7d", label: "7 days" }, { id: "30d", label: "30 days" }, { id: "mtd", label: "This month" },
  { id: "lm", label: "Last month" }, { id: "ytd", label: "Year to date" }, { id: "custom", label: "Custom" },
];
/** Range of a preset, counted back from the newest loaded day (not from today, so a late upload still shows its last days). */
export function rangeFor(preset, last) {
  const e = last || toISO(Date.now());
  if (preset === "7d") return { from: addDays(e, -6), to: e };
  if (preset === "30d") return { from: addDays(e, -29), to: e };
  if (preset === "mtd") return { from: monthStart(e), to: e };
  if (preset === "lm") { const first = monthStart(e); const lastDay = addDays(first, -1); return { from: monthStart(lastDay), to: lastDay }; }
  if (preset === "ytd") return { from: e.slice(0, 4) + "-01-01", to: e };
  return { from: addDays(e, -29), to: e };
}

// ---- reading the daily rows ----
const rowsOf = (raw, tbl) => (raw?.daily?.[tbl] || []);
/** Map date -> sum of a column over contractors. */
function sumBy(rows, col, filter) { const m = new Map(); for (const r of rows) { if (filter && !filter(r)) continue; const x = r.v?.[col]; if (x == null) continue; const d = String(r.d).slice(0, 10); m.set(d, (m.get(d) || 0) + num(x)); } return m; }
function sumCols(rows, cols, filter) { const m = new Map(); cols.forEach((c) => { for (const [d, v] of sumBy(rows, c, filter)) m.set(d, (m.get(d) || 0) + v); }); return m; }
function avgBy(rows, col) { const s = new Map(), n = new Map(); for (const r of rows) { const x = r.v?.[col]; if (x == null) continue; const d = String(r.d).slice(0, 10); s.set(d, (s.get(d) || 0) + num(x)); n.set(d, (n.get(d) || 0) + (r.n || 1)); } const m = new Map(); for (const [d, v] of s) m.set(d, v / n.get(d)); return m; }
const addMaps = (list) => { const m = new Map(); list.forEach((x) => { for (const [d, v] of x) m.set(d, (m.get(d) || 0) + v); }); return m; };
const total = (m, days) => days.reduce((a, d) => a + (m.get(d) || 0), 0);
const lastKey = (m, to) => { let k = null; for (const d of m.keys()) if (d <= to && (!k || d > k)) k = d; return k; };
const arr = (m, days) => days.map((d) => (m.has(d) ? m.get(d) : null));
const cumul = (m, days) => { let c = 0; return days.map((d) => (c += m.get(d) || 0)); };

/** One site's day series. */
function siteSeries(raw) {
  const mng = rowsOf(raw, "tblRAWMNG"), ship = rowsOf(raw, "tblRAWSHIP"), cal = rowsOf(raw, "tblCALENDAR"), haul = rowsOf(raw, "tblRAWHAUL");
  const ore = (rows, sfx) => sumCols(rows, GR.map(([g]) => `${g}-${sfx}`));
  const s = {
    prod: ore(mng, "DAY"), shipD: sumBy(ship, "DAY"), planProd: ore(cal, "DAY"), planShip: sumBy(cal, "ST-DAY"), ob: sumBy(mng, "OB-DAY"), haul: sumBy(haul, "DAY"),
    grade: Object.fromEntries(GR.map(([g]) => [g, sumBy(mng, `${g}-DAY`)])),
    prodMTD: ore(mng, "MTD"), prodYTD: ore(mng, "YTD"), planProdMTD: ore(cal, "MTD"), planProdYTD: ore(cal, "YTD"),
    shipMTD: sumBy(ship, "MTD"), shipYTD: sumBy(ship, "YTD"), planShipMTD: sumBy(cal, "ST-MTD"), planShipYTD: sumBy(cal, "ST-YTD"),
  };
  s.have = new Set([...sumBy(mng, "L-DAY").keys(), ...s.prod.keys(), ...s.shipD.keys()]);
  return s;
}
/** Value on the newest day on or before `to` that has any row. Returns {d, v}. */
function stateOn(m, to) { const d = lastKey(m, to); return d ? { d, v: m.get(d) } : { d: null, v: 0 }; }

function kpi(actual, plan, iso, period) { const b = { actual, plan, pct: pct(actual, plan) }; return { ...b, verdict: iso ? verdict(b, period, iso) : { label: "NO PLAN", tone: "none", pace: null } }; }

const DELAY_COLS = ["RAIN HOUR", "SLIPPERY", "DAILY MEETING (P5M)", "GENERAL SAFETY TALK", "FRIDAY PRAY", "REST & MEAL", "REFUELLING & DAILY SERVICE (P2H)", "RELOCATIONS", "PREPARE LOADING/DUMPING POINT", "SHIFT CHANGE", "SURVEY & GC", "PREPARE TOWER LAMP", "BREAK FASTING", "OTHERS"];
const HSE_COLS = [["FATALITY", "Fatality", "bad"], ["LTI", "Lost time injury", "bad"], ["MTI", "Medical treatment", "bad"], ["FAI", "First aid", "warn"], ["PD", "Property damage", "warn"], ["FC", "Fire case", "warn"], ["EC", "Environmental case", "warn"], ["NM", "Near miss", "info"]];
const STOCK_GROUPS = [["H", "HGO"], ["M", "MGO"], ["L", "LGO"], ["LB", "LGO-B"], ["WA", "Waste A"], ["WS", "Waste S"]];
const closedRe = /^\s*(closed|close|done|selesai|complete|completed|finish|finished)/i;
const pctScale = (v) => (v != null && v <= 1.5 ? v * 100 : v);

/**
 * raw: {WKM: etl_dash_data result, ...} for the chosen sites. opts: {from, to, sites?}.
 * Returns the whole model; the page only draws it.
 */
export function buildDash(raw, { from, to }) {
  const sites = Object.keys(raw).filter((k) => raw[k]);
  const days = dayList(from, to);
  const S = Object.fromEntries(sites.map((k) => [k, siteSeries(raw[k])]));
  const merge = (f) => addMaps(sites.map((k) => f(S[k])));
  const prod = merge((s) => s.prod), shipD = merge((s) => s.shipD), planProd = merge((s) => s.planProd), planShip = merge((s) => s.planShip);
  const last = sites.map((k) => lastKey(S[k].have, to)).filter(Boolean).sort().pop() || null;
  const first = sites.map((k) => raw[k].first).filter(Boolean).sort()[0] || null;
  const latest = sites.map((k) => raw[k].last).filter(Boolean).sort().pop() || null;

  // ---- PLAN / DO / CHECK numbers ----
  const siteRows = sites.map((k) => {
    const s = S[k], ld = lastKey(s.have, to), iso = ld || to;
    const pr = total(s.prod, days), pp = total(s.planProd, days), sh = total(s.shipD, days), sp = total(s.planShip, days);
    const yP = stateOn(s.prodYTD, to).v, yS = stateOn(s.shipYTD, to).v, ypP = stateOn(s.planProdYTD, to).v, ypS = stateOn(s.planShipYTD, to).v;
    const mP = stateOn(s.prodMTD, to).v, mS = stateOn(s.shipMTD, to).v, mpP = stateOn(s.planProdMTD, to).v, mpS = stateOn(s.planShipMTD, to).v;
    const covDays = days.filter((d) => d <= (ld || to));
    return {
      site: k, last: ld, lastLoaded: raw[k].last, stale: !!ld && ld < to && (!raw[k].last || raw[k].last < to),
      coverage: covDays.length ? covDays.filter((d) => s.have.has(d)).length / covDays.length : 0, haveDays: covDays.filter((d) => s.have.has(d)).length, spanDays: covDays.length,
      prod: { range: kpi(pr, pp, iso, "month"), mtd: kpi(mP, mpP, iso, "month"), ytd: kpi(yP, ypP, iso, "year"), day: kpi(s.prod.get(iso) || 0, s.planProd.get(iso) || 0, iso, "day") },
      ship: { range: kpi(sh, sp, iso, "month"), mtd: kpi(mS, mpS, iso, "month"), ytd: kpi(yS, ypS, iso, "year"), day: kpi(s.shipD.get(iso) || 0, s.planShip.get(iso) || 0, iso, "day") },
    };
  });
  const sumK = (key, per) => {
    const a = siteRows.reduce((x, r) => x + r[key][per].actual, 0), p = siteRows.reduce((x, r) => x + r[key][per].plan, 0);
    return kpi(a, p, last, per === "ytd" ? "year" : per === "day" ? "day" : "month");
  };
  const totals = { prod: { day: sumK("prod", "day"), range: sumK("prod", "range"), mtd: sumK("prod", "mtd"), ytd: sumK("prod", "ytd") }, ship: { day: sumK("ship", "day"), range: sumK("ship", "range"), mtd: sumK("ship", "mtd"), ytd: sumK("ship", "ytd") } };

  // year-end outlook: year to date plus the range's average day for the days that are left
  const dataDays = Math.max(1, days.filter((d) => sites.some((k) => S[k].have.has(d))).length);
  const left = last ? Math.max(0, daysBetween(last, yearEnd(last))) : 0;
  const outlook = ["prod", "ship"].map((key) => {
    const t = totals[key], avg = total(key === "prod" ? prod : shipD, days) / dataDays, proj = t.ytd.actual + avg * left;
    return { key, avgDay: avg, left, ytd: t.ytd.actual, plan: t.ytd.plan, projected: proj, projectedPct: pct(proj, t.ytd.plan), needDay: left > 0 && t.ytd.plan > 0 ? Math.max(0, (t.ytd.plan - t.ytd.actual) / left) : null };
  });

  // ---- series for charts ----
  const trend = {
    days, prod: arr(prod, days), ship: arr(shipD, days), planProd: arr(planProd, days), planShip: arr(planShip, days),
    cumProd: cumul(prod, days), cumShip: cumul(shipD, days), cumPlanProd: cumul(planProd, days), cumPlanShip: cumul(planShip, days),
    bySite: Object.fromEntries(sites.map((k) => [k, { prod: arr(S[k].prod, days), ship: arr(S[k].shipD, days) }])),
    grade: Object.fromEntries(GR.map(([g]) => [g, arr(merge((s) => s.grade[g]), days)])),
    ob: arr(merge((s) => s.ob), days), haul: arr(merge((s) => s.haul), days),
  };
  const ore = GR.map(([g, label]) => ({ key: g, label, value: total(merge((s) => s.grade[g]), days) }));
  const obT = total(merge((s) => s.ob), days), oreT = ore.reduce((a, x) => a + x.value, 0);
  const strip = oreT > 0 ? obT / oreT : null;

  const byContractor = (tbl, cols) => {
    const m = new Map();
    sites.forEach((k) => rowsOf(raw[k], tbl).forEach((r) => { const d = String(r.d).slice(0, 10); if (d < from || d > to) return; const c = r.c || "-"; const key = `${k} · ${c}`; m.set(key, (m.get(key) || 0) + cols.reduce((a, c2) => a + num(r.v?.[c2]), 0)); }));
    return [...m.entries()].map(([name, value]) => ({ name, value })).filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
  };
  const contractors = { prod: byContractor("tblRAWMNG", GR.map(([g]) => `${g}-DAY`)), ship: byContractor("tblRAWSHIP", ["DAY"]), ob: byContractor("tblRAWMNG", ["OB-DAY"]) };

  // ---- CHECK: time, availability, weather ----
  const ewhRows = sites.flatMap((k) => rowsOf(raw[k], "tblRAWWEWH"));
  const ewh = avgBy(ewhRows, "EWH"), rain = sumBy(ewhRows, "RAIN HOUR");
  const delay = DELAY_COLS.map((c) => ({ name: c.replace(/ \(.*\)/, ""), value: total(sumBy(ewhRows, c), days) })).filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
  const upRows = sites.flatMap((k) => rowsOf(raw[k], "tblRAWUP")), calRows = sites.flatMap((k) => rowsOf(raw[k], "tblCALENDAR"));
  const AV = [["PA", "Physical availability", "PHYSICAL AVAILABILITY (PA)"], ["MA", "Mechanical availability", "MECHANICAL AVAILABILITY (MA)"], ["UA", "Utilization of availability", "UTILIZATION OF AVAILABILITY (UA)"], ["EU", "Effective utilization", "EFFECTIVE UTILIZATION (EU)"]];
  const avail = AV.map(([k, label, calCol]) => {
    const upCols = ["EXC", "DT", "DZ", "GD", "CP"].map((p) => `${p}-${k}`);
    let m = new Map();
    const upm = upCols.map((c) => avgBy(upRows, c)).filter((x) => x.size);
    if (upm.length) { const ds = new Set(upm.flatMap((x) => [...x.keys()])); ds.forEach((d) => { const vs = upm.map((x) => x.get(d)).filter((v) => v != null); if (vs.length) m.set(d, vs.reduce((a, b) => a + b, 0) / vs.length); }); }
    else m = avgBy(calRows, calCol);
    const vals = days.map((d) => (m.has(d) ? pctScale(m.get(d)) : null));
    const got = vals.filter((v) => v != null), h = Math.floor(got.length / 2);
    const avg = got.length ? got.reduce((a, b) => a + b, 0) / got.length : null;
    const early = got.slice(0, h), late = got.slice(h);
    const mean = (x) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : null);
    return { key: k, label, values: vals, avg, shift: early.length && late.length ? mean(late) - mean(early) : null };
  }).filter((a) => a.avg != null);
  const equip = (() => {
    const eq = sites.flatMap((k) => rowsOf(raw[k], "tblRAWEQ"));
    if (!eq.length) return null;
    const cols = (p) => Object.keys(eq.reduce((o, r) => Object.assign(o, r.v || {}), {})).filter((c) => c.startsWith(p + "-"));
    const groups = [["OP", "Operating"], ["S", "Standby"], ["B", "Breakdown"], ["P", "Plan"]].map(([p, label]) => { const m = sumCols(eq, cols(p)); return { key: p, label, values: arr(m, days), last: stateOn(m, to).v }; });
    return groups.filter((g) => g.values.some((v) => v != null));
  })();

  // ---- CHECK: safety ----
  const hseRows = sites.flatMap((k) => rowsOf(raw[k], "tblRAWHSE"));
  const hse = HSE_COLS.map(([c, label, tone]) => ({ key: c, label, tone, total: total(sumBy(hseRows, c), days), values: arr(sumBy(hseRows, c), days) }));
  const hseDays = new Set(hseRows.map((r) => String(r.d).slice(0, 10)));
  const bad = (d) => ["FATALITY", "LTI"].reduce((a, c) => a + (sumBy(hseRows, c).get(d) || 0), 0) > 0;
  const lastBad = [...hseDays].filter(bad).sort().pop() || null;
  const safeDays = last && hseDays.size ? (lastBad ? daysBetween(lastBad, last) : daysBetween(from > (first || from) ? from : first || from, last) + 1) : null;
  const haz = sites.flatMap((k) => (raw[k].hazard || []).map((h) => ({ ...h, site: k }))).filter((h) => String(h.date).slice(0, 10) >= from && String(h.date).slice(0, 10) <= to);
  const risk = (h) => String(h["RISK LEVEL"] || "").trim() || "Unrated";
  const isOpen = (h) => !closedRe.test(String(h["REPAIR STATUS"] || ""));
  const rank = { high: 0, extreme: 0, medium: 1, low: 2 };
  const rkey = (h) => rank[risk(h).toLowerCase()] ?? 3;
  const hazard = {
    total: haz.length, open: haz.filter(isOpen).length, closed: haz.filter((h) => !isOpen(h)).length,
    byRisk: Object.entries(haz.reduce((o, h) => ((o[risk(h)] = (o[risk(h)] || 0) + 1), o), {})).map(([name, value]) => ({ name, value })).sort((a, b) => (rank[a.name.toLowerCase()] ?? 3) - (rank[b.name.toLowerCase()] ?? 3)),
    byCategory: Object.entries(haz.reduce((o, h) => { const c = String(h["HAZARD CATEGORY"] || "-"); o[c] = (o[c] || 0) + 1; return o; }, {})).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
    perDay: arr(new Map([...haz.reduce((m, h) => m.set(String(h.date).slice(0, 10), (m.get(String(h.date).slice(0, 10)) || 0) + 1), new Map())]), days),
    openList: haz.filter(isOpen).sort((a, b) => rkey(a) - rkey(b) || String(b.date).localeCompare(String(a.date))).slice(0, 12).map((h) => ({ date: String(h.date).slice(0, 10), site: h.site, risk: risk(h), location: h["HAZARD LOCATION"] || "-", hazard: h["IDENTIFIED HAZARD"] || "-", action: h["CORRECTIVE ACTION"] || "-", status: h["REPAIR STATUS"] || "-" })),
  };

  // ---- DO: stock, fuel, people, construction, exploration, lab ----
  const stockRows = sites.flatMap((k) => rowsOf(raw[k], "tblRAWSTOCK").map((r) => ({ ...r, site: k })));
  const stockTonCols = [...new Set(stockRows.flatMap((r) => Object.keys(r.v || {}).filter((c) => /TONAGE$/.test(c))))];
  const stockMap = (pfx) => sumCols(stockRows, stockTonCols.filter((c) => c.startsWith(pfx)));
  const etoM = stockMap("ETO-"), efoM = stockMap("EFO-"), stockAll = addMaps([etoM, efoM]);
  const stockLast = lastKey(stockAll, to);
  const stock = stockRows.length ? {
    date: stockLast, total: stockAll.get(stockLast) || 0, values: arr(stockAll, days), eto: arr(etoM, days), efo: arr(efoM, days),
    groups: ["ETO", "EFO"].map((p) => ({ key: p, label: p === "ETO" ? "ETO (ore stockpile at pit)" : "EFO (ore at port)", items: STOCK_GROUPS.map(([g, label]) => ({ name: label, value: stockRows.filter((r) => String(r.d).slice(0, 10) === stockLast).reduce((a, r) => a + num(r.v?.[`${p}-${g}-TONAGE`]), 0) })).filter((x) => x.value) })),
    cover: (() => { const avg = total(shipD, days) / dataDays; return avg > 0 ? (stockAll.get(stockLast) || 0) / avg : null; })(),
  } : null;
  const fuelRows = sites.flatMap((k) => rowsOf(raw[k], "tblRAWFUEL"));
  const fuelStock = sumBy(fuelRows, "STOCK"), fuelDay = sumBy(fuelRows, "DAY");
  const fuel = fuelRows.length ? { used: total(fuelDay, days), per: ore.length && oreT + obT > 0 ? total(fuelDay, days) / (oreT + obT) : null, stock: stateOn(fuelStock, to), values: arr(fuelDay, days), stockValues: arr(fuelStock, days), negative: [...fuelStock.entries()].some(([d, v]) => d >= from && d <= to && v < 0) } : null;
  const mpRows = sites.flatMap((k) => rowsOf(raw[k], "tblRAWMP"));
  const mpTot = sumBy(mpRows, "TOTAL"), mpLast = lastKey(mpTot, to);
  const manpower = mpRows.length ? {
    date: mpLast, total: mpTot.get(mpLast) || 0, values: arr(mpTot, days), joined: total(sumBy(mpRows, "ADD"), days), left: total(sumBy(mpRows, "RESIGN"), days),
    roles: ["MANAGER", "SPT", "SPV", "DRIVER", "OPERATOR", "ETC"].map((r) => ({ name: r === "SPT" ? "Superintendent" : r === "SPV" ? "Supervisor" : r[0] + r.slice(1).toLowerCase(), value: sumBy(mpRows, r).get(mpLast) || 0 })).filter((x) => x.value > 0),
  } : null;
  const cons = sites.flatMap((k) => (raw[k].cons || []).map((c) => ({ site: k, area: c.AREA || "-", item: c["CONSTRUCTION ITEM"] || "-", progress: num(c.PROGRESS), remark: c.REMARK || "", category: c.CONSCATEGORY || "-", date: String(c.date).slice(0, 10) })));
  const construction = { items: cons.sort((a, b) => a.progress - b.progress), avg: cons.length ? cons.reduce((a, c) => a + c.progress, 0) / cons.length : null, open: cons.filter((c) => c.progress < 100).length };
  const ex = sites.flatMap((k) => rowsOf(raw[k], "tblRAWEXPLO"));
  const exSum = (c) => total(sumBy(ex, c), days);
  const explo = ex.length ? [["Drill holes", "P-DH", "A-DH"], ["Samples", "P-SAMPLE", "A-SAMPLE"], ["Depth (m)", "P-DEPTH", "A-DEPTH"], ["Survey outcrop", "SO-PLAN", "SO-ACTUAL"], ["Pit / hole inspection", "PUH-PLAN", "PUH-ACTUAL"]].map(([label, p, a]) => ({ label, plan: exSum(p), actual: exSum(a), pct: pct(exSum(a), exSum(p)) })).filter((x) => x.plan || x.actual) : null;
  const labRows = sites.flatMap((k) => rowsOf(raw[k], "tblRAWLAB"));
  const labTypes = ["FP", "QC", "SS", "SC", "FO", "DOME", "BARGE", "EXPLO"];
  const lab = labRows.length ? ["ID", "FD", "AD"].map((fam) => ({ family: fam, items: labTypes.map((t) => ({ name: t, value: total(sumBy(labRows, `${fam}-${t}`), days) })).filter((x) => x.value > 0) })).filter((f) => f.items.length) : null;
  const geo = sites.flatMap((k) => rowsOf(raw[k], "tblRAWGEOMAP"));
  const geomap = geo.length ? { area: stateOn(sumBy(geo, "TOTAL COVERED AREA"), to).v } : null;
  const barge = sites.flatMap((k) => (raw[k].barge || []).map((b) => ({ site: k, vessel: b["VESSEL/BARGE"] || "-", contractor: b.CONTRACTOR || "-", status: b.STATUS || "-", plan: num(b["PLAN CAPACITY"]), actual: num(b["ACTUAL CAPACITY"]), month: b.MONTH || "" })));

  // ---- ACT: what to do, ranked ----
  const acts = [];
  const money = (v) => Math.round(v).toLocaleString("en-US");
  siteRows.forEach((r) => {
    if (r.stale) acts.push({ sev: "high", pdca: "Act", site: r.site, title: `${r.site} data stops at ${r.last}`, text: `Newest loaded day is ${r.lastLoaded || r.last}, the range ends ${to}. Load the missing days on the Uploads page.` });
    if (r.haveDays < r.spanDays && !r.stale) acts.push({ sev: "medium", pdca: "Act", site: r.site, title: `${r.site} has ${r.spanDays - r.haveDays} day${r.spanDays - r.haveDays > 1 ? "s" : ""} without production or shipment`, text: "Check that these are real stop days and not days that were never loaded." });
  });
  outlook.forEach((o) => {
    const label = o.key === "prod" ? "Production" : "Shipment";
    if (o.plan > 0 && o.projectedPct != null && o.projectedPct < 100) acts.push({ sev: o.projectedPct < 80 ? "high" : "medium", pdca: "Act", site: "All", title: `${label} is on course for ${o.projectedPct.toFixed(0)}% of the annual plan`, text: `At ${money(o.avgDay)} t/day the year ends near ${money(o.projected)} t against ${money(o.plan)} t. Reaching the plan needs ${money(o.needDay)} t/day for the ${o.left} days left.` });
  });
  siteRows.forEach((r) => ["prod", "ship"].forEach((key) => {
    const x = r[key].range, name = key === "prod" ? "production" : "shipment";
    if (x.plan > 0 && x.pct < 90) acts.push({ sev: x.pct < 70 ? "high" : "medium", pdca: "Check", site: r.site, title: `${r.site} ${name} is ${x.pct.toFixed(0)}% of plan in this range`, text: `${money(x.actual)} t against ${money(x.plan)} t. Look at the contractor split and the availability trend below.` });
  }));
  if (fuel?.negative) acts.push({ sev: "medium", pdca: "Check", site: "All", title: "Fuel stock went below zero", text: "A negative stock is almost always an entry or unit error. Correct the fuel input for that day." });
  if (stock?.cover != null && stock.cover < 3) acts.push({ sev: "high", pdca: "Act", site: "All", title: `Ore stock covers ${stock.cover.toFixed(1)} days of shipment`, text: "Stock at the latest register is below three days of the current shipment rate. Raise production or slow the shipment plan." });
  hse.filter((h) => (h.key === "FATALITY" || h.key === "LTI") && h.total > 0).forEach((h) => acts.push({ sev: "critical", pdca: "Act", site: "All", title: `${h.total} ${h.label.toLowerCase()} case${h.total > 1 ? "s" : ""} in this range`, text: "Confirm the investigation, the corrective action and the date it closes." }));
  if (hazard.open > 0) { const hi = hazard.openList.filter((h) => /high|extreme/i.test(h.risk)).length; acts.push({ sev: hi ? "high" : "medium", pdca: "Act", site: "All", title: `${hazard.open} hazard finding${hazard.open > 1 ? "s" : ""} not closed${hi ? `, ${hi} high risk` : ""}`, text: "Close each finding with an owner and a date. The list is in the Act tab." }); }
  avail.filter((a) => a.shift != null && a.shift < -3).forEach((a) => acts.push({ sev: "medium", pdca: "Check", site: "All", title: `${a.label} fell ${Math.abs(a.shift).toFixed(1)} points inside this range`, text: "Compare the first half of the range with the second half, then check the breakdown and standby hours of the equipment." }));
  const rainT = total(rain, days);
  if (rainT >= 24) acts.push({ sev: "info", pdca: "Check", site: "All", title: `${rainT.toFixed(0)} rain hours in this range`, text: "Weather took working hours. Compare the loss with the plan before treating the gap as a performance issue." });
  const sevRank = { critical: 0, high: 1, medium: 2, info: 3 };
  acts.sort((a, b) => sevRank[a.sev] - sevRank[b.sev]);

  // ---- the story, one sentence per step ----
  const p = totals.prod, s = totals.ship;
  const fmtT = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)} Mt` : v >= 1e3 ? `${(v / 1e3).toFixed(1)} kt` : `${Math.round(v)} t`);
  const story = last ? {
    headline: `${fmtT(s.range.actual)} shipped and ${fmtT(p.range.actual)} produced from ${from} to ${to}${s.range.plan > 0 ? ` — shipment ${s.range.pct >= 100 ? "reached" : "is at"} ${s.range.pct.toFixed(0)}% of plan` : ""}.`,
    plan: p.ytd.plan > 0 || s.ytd.plan > 0 ? `The approved plan for the year is ${fmtT(p.ytd.plan)} of production and ${fmtT(s.ytd.plan)} of shipment. ${((elapsed("year", last)) * 100).toFixed(0)}% of the year has passed.` : "No annual plan is loaded in the calendar for this range.",
    do: `${fmtT(oreT)} of ore and ${fmtT(obT)} of overburden moved${strip != null ? `, a stripping ratio of ${strip.toFixed(2)}` : ""}. Year to date: ${fmtT(p.ytd.actual)} produced, ${fmtT(s.ytd.actual)} shipped.`,
    check: `Year to date, production is at ${p.ytd.pct == null ? "no plan" : p.ytd.pct.toFixed(0) + "% of the annual plan"} and shipment at ${s.ytd.pct == null ? "no plan" : s.ytd.pct.toFixed(0) + "%"}, ${s.ytd.verdict.label === "BEHIND PACE" || p.ytd.verdict.label === "BEHIND PACE" ? "behind the time that has passed" : "in line with the time that has passed"}.`,
    act: acts.length ? `${acts.filter((a) => a.sev === "critical" || a.sev === "high").length} item${acts.filter((a) => a.sev === "critical" || a.sev === "high").length === 1 ? "" : "s"} need action first, ${acts.length} in total.` : "Nothing needs action in this range.",
  } : { headline: "No loaded day in this range.", plan: "", do: "", check: "", act: "" };

  return {
    from, to, days, sites, last, first, latest, totals, siteRows, outlook, trend, ore, strip, obTotal: obT, oreTotal: oreT, contractors,
    check: { ewh: arr(ewh, days), rain: arr(rain, days), rainTotal: rainT, delay, avail, equip, hse, safeDays, lastBad, hazard },
    stock, fuel, manpower, construction, explo, lab, geomap, barge, acts, story, colors: COLORS,
    coverage: { rows: siteRows.map((r) => ({ site: r.site, ...{ have: r.haveDays, span: r.spanDays, last: r.last } })) },
  };
}

// ---- the explorer: any table, any column, from the daily sums ----
export const TABLE_INFO = [
  ["tblRAWSHIP", "Shipment"], ["tblRAWMNG", "Mining"], ["tblRAWHAUL", "Hauling"], ["tblRAWSTOCK", "Ore stock"], ["tblRAWEQ", "Equipment"], ["tblRAWUP", "Availability"],
  ["tblRAWWEWH", "Working hours"], ["tblRAWHSE", "Safety"], ["tblRAWFUEL", "Fuel"], ["tblRAWMP", "Manpower"], ["tblRAWLAB", "Lab"], ["tblRAWEXPLO", "Exploration"],
  ["tblRAWGEOMAP", "Geological map"], ["tblCALENDAR", "Calendar and plan"],
];
export function explorerColumns(raw, tbl) {
  const set = new Set();
  Object.values(raw || {}).forEach((r) => rowsOf(r, tbl).forEach((x) => Object.keys(x.v || {}).forEach((c) => set.add(c))));
  return [...set];
}
/** Daily values of one column of one table, as a sum over the chosen sites (or the average when avg is true). */
export function explorerSeries(raw, tbl, col, days, avg = false) {
  const rows = Object.values(raw || {}).flatMap((r) => rowsOf(r, tbl));
  const m = avg ? avgBy(rows, col) : sumBy(rows, col);
  return { values: arr(m, days), total: total(m, days) };
}
/** One day, site by site (the detail behind a clicked day). */
export function dayDetail(raw, day) {
  return Object.keys(raw).filter((k) => raw[k]).map((k) => {
    const s = siteSeries(raw[k]), w = rowsOf(raw[k], "tblRAWWEWH");
    return { site: k, loaded: s.have.has(day), prod: s.prod.get(day) ?? null, planProd: s.planProd.get(day) ?? null, ship: s.shipD.get(day) ?? null, planShip: s.planShip.get(day) ?? null, ob: s.ob.get(day) ?? null,
      ewh: avgBy(w, "EWH").get(day) ?? null, rain: sumBy(w, "RAIN HOUR").get(day) ?? null, hazards: (raw[k].hazard || []).filter((h) => String(h.date).slice(0, 10) === day).length };
  });
}
export const HSE_META = HSE_COLS;
export { verdict, elapsed, pct };
export { sumBy, sumCols, avgBy, addMaps, total, arr, rowsOf, num, pctScale, DELAY_COLS, lastKey };
