// Daily Report compile (Phase 4.6). Pure: takes what etl_report_data returned per site and builds the report model. No DOM, no network.
// Mapping (checked against the Daily Report of 19 Nov 2026): shipment = SHIP DAY/WTD/MTD/YTD, shipment plan = calendar ST-*;
// production = ore L + M + H (LGO + MGO + HGO) from MNG, production plan = calendar L+M+H; one company per site; Cut Off = newest loaded day of the site.

export const SITE_COMPANY = { WKM: "WKM", BM: "BM", TMS: "TMS" };
export const COMPANIES = ["WKM", "BM", "TMS", "CDSM", "IBN", "TPB", "AJB", "CDS"];
export const COMPANY_NAME = { WKM: "PT WANA KENCANA MINERAL", BM: "PT BOSOWA MINING", TMS: "PT TAMBANG MATARAPE SEJAHTERA", CDSM: "PT CIPTA DJAYA SELARAS MINING", IBN: "PT INDO BUMI NIKEL", TPB: "PT TAMBANG PUSAKA BUMI", AJB: "PT ANUGERAH JAYA BUANA", CDS: "PT CIPTA DJAYA SURYA" };
// Companies without a site project: the mining product and remark as printed on the current Daily Report (manual text, no data behind it).
export const STATIC_ACTIVITY = { CDSM: ["PLAN LIMONIT AND SAPROLIT", "WAITING PPKH AND RKAB"], IBN: ["PLAN LIMONIT AND SAPROLIT", "WAITING PPKH AND RKAB"], TPB: ["PLAN EKSPLORATION", "-"], AJB: ["PLAN EKSPLORATION", "-"], CDS: ["PLAN EKSPLORATION", "-"] }
const PERIODS = [["day", "DAY"], ["week", "WTD"], ["month", "MTD"], ["year", "YTD"]];
const GRADES = [["lgo", "L"], ["mgo", "M"], ["hgo", "H"]];

const num = (v) => { const x = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/,/g, "")); return Number.isFinite(x) ? x : 0; };
const sum = (rows, col) => rows.reduce((a, r) => a + num(r?.[col]), 0);
export const pct = (actual, plan) => (plan > 0 ? (actual / plan) * 100 : null);

function block(actual, plan) {
  const o = {};
  PERIODS.forEach(([k]) => { o[k] = { actual: actual[k], plan: plan[k], pct: pct(actual[k], plan[k]) }; });
  return o;
}

const max = (rows, col) => rows.reduce((a, r) => Math.max(a, num(r?.[col])), 0);
const has = (rows) => Array.isArray(rows) && rows.length > 0;
const HSE_COLS = ["NM", "FATALITY", "MTI", "LTI", "FAI", "PD", "FC", "EC"];
export const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const iso7 = (start) => { const [y, m, d] = start.split("-").map(Number); return Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10)); };
const prodWord = (g) => [g.lgo && "LIMONIT", g.mgo && "MGO", g.hgo && "SAPROLIT"].filter(Boolean).join(" AND ");

/** One site: raw = the etl_report_data result. Returns null when the site has no loaded day. */
export function compileSite(raw) {
  if (!raw || !raw.cut_off) return null;
  const ship = raw.ship || [], mng = raw.mng || [], cal = raw.cal || [], hse = raw.hse || [];
  const sa = {}, sp = {};
  PERIODS.forEach(([k, c]) => { sa[k] = sum(ship, c); sp[k] = sum(cal, `ST-${c}`); });
  const pa = {}, pp = {}, grades = {}, materials = {};
  PERIODS.forEach(([k, c]) => {
    pa[k] = GRADES.reduce((a, [, g]) => a + sum(mng, `${g}-${c}`), 0);
    pp[k] = GRADES.reduce((a, [, g]) => a + sum(cal, `${g}-${c}`), 0);
  });
  GRADES.forEach(([name, g]) => {
    grades[name] = {}; materials[name] = {};
    PERIODS.forEach(([k, c]) => { const act = sum(mng, `${g}-${c}`), pl = sum(cal, `${g}-${c}`); grades[name][k] = act; materials[name][k] = { actual: act, plan: pl, pct: pct(act, pl) }; });
  });
  const hseTotal = {};
  HSE_COLS.forEach((c) => { hseTotal[c] = sum(hse, c); });
  const production = block(pa, pp), shipment = block(sa, sp);
  // A. activity: derived from what was produced; the remark is a plain reading of the cut-off day (the master has no free text for it)
  const made = { lgo: materials.lgo.year.actual > 0, mgo: materials.mgo.year.actual > 0, hgo: materials.hgo.year.actual > 0 };
  const planned = { lgo: materials.lgo.year.plan > 0, mgo: materials.mgo.year.plan > 0, hgo: materials.hgo.year.plan > 0 };
  const product = prodWord(made) ? `${prodWord(made)} PRODUCT` : prodWord(planned) ? `PLAN ${prodWord(planned)}` : "-";
  const remark = production.day.actual > 0 ? "MINING OPERATION" : shipment.day.actual > 0 ? "SHIPMENT ONLY" : "NO ACTIVITY ON CUT-OFF DAY";
  // D. yearly production: HGO (saprolite) by month
  const byMonth = Object.fromEntries((raw.monthly || []).map((m) => [m.month, m]));
  const monthly = MONTH_ABBR.map((l, i) => { const m = byMonth[i + 1]; const act = m ? num(m.actual) : 0, tg = m ? num(m.target) : 0; return { label: l, loaded: !!m, actual: act, target: tg, pct: pct(act, tg) }; });
  const yearActual = monthly.reduce((a, m) => a + m.actual, 0), yearTarget = materials.hgo.year.plan;
  // E. weather: Monday to Sunday of the cut-off week
  const wrows = raw.wewh || [];
  const weather = (raw.week_start ? iso7(raw.week_start) : []).map((d) => {
    const rs = wrows.filter((r) => String(r.date).slice(0, 10) === d);
    const ew = rs.map((r) => num(r.EWH)).filter((v) => v > 0);
    return { date: d, rain: rs.length ? max(rs, "RAIN HOUR") : null, ewh: ew.length ? ew.reduce((a, b) => a + b, 0) / ew.length : null };
  });
  // F. ore stock (ETO and EFO stockyards), latest state
  const st = raw.stock || [];
  const yard = (p) => ({ hgo: sum(st, `${p}-H-TONAGE`), mgo: sum(st, `${p}-M-TONAGE`), lgoa: sum(st, `${p}-L-TONAGE`), lgob: sum(st, `${p}-LB-TONAGE`), wa: sum(st, `${p}-WA-TONAGE`) });
  // G. fuel and manpower, latest state
  const fu = raw.fuel || [], mp = raw.mp || [];
  return {
    site: raw.site, cut_off: raw.cut_off,
    shipment, production, grades, materials,
    waste: { ob: Object.fromEntries(PERIODS.map(([k, c]) => [k, sum(mng, `OB-${c}`)])) },
    hse: hse.length ? hseTotal : null,
    hazards: (raw.hazard || []).map((r) => ({ hazard: r["IDENTIFIED HAZARD"] || "", action: r["CORRECTIVE ACTION"] || "", category: r["HAZARD CATEGORY"] || "", risk: r["RISK LEVEL"] || "", status: r["REPAIR STATUS"] || "", location: r["HAZARD LOCATION"] || "" })),
    activity: { product, remark },
    monthly, yearly: { actual: yearActual, target: yearTarget, pct: pct(yearActual, yearTarget) },
    weather,
    stock: has(st) ? { eto: yard("ETO"), efo: yard("EFO") } : null,
    fuel: has(fu) ? { day: sum(fu, "DAY"), week: sum(fu, "WTD"), month: sum(fu, "MTD"), stock: sum(fu, "STOCK") } : null,
    manpower: has(mp) ? { total: sum(mp, "TOTAL"), manager: sum(mp, "MANAGER"), spt: sum(mp, "SPT"), spv: sum(mp, "SPV"), driver: sum(mp, "DRIVER"), oprt: sum(mp, "OPERATOR"), etc: sum(mp, "ETC") } : null,
    construction: (raw.cons || []).map((r) => ({ area: String(r.AREA ?? ""), item: String(r["CONSTRUCTION ITEM"] ?? ""), progress: num(r.PROGRESS), remark: String(r.REMARK ?? ""), category: String(r.CONSCATEGORY || r.AREA || "Other") })),
    contractors: [...new Set([...ship, ...mng].map((r) => r.CONTRACTOR).filter(Boolean))],
  };
}

const ZERO = () => Object.fromEntries(PERIODS.map(([k]) => [k, { actual: 0, plan: 0, pct: null }]));
function addBlock(a, b) {
  const o = {};
  PERIODS.forEach(([k]) => { const act = a[k].actual + b[k].actual, pl = a[k].plan + b[k].plan; o[k] = { actual: act, plan: pl, pct: pct(act, pl) }; });
  return o;
}

/**
 * Whole report. sites = {WKM: raw|null, BM: raw|null, TMS: raw|null}; failed = {code: message}.
 * Companies without data stay in the table with null, so the layout matches the WhatsApp image. The totals use only the companies that have data.
 */
export function compileDaily(sites, failed = {}) {
  const rows = COMPANIES.map((c) => {
    const site = Object.keys(SITE_COMPANY).find((s) => SITE_COMPANY[s] === c);
    const d = site ? compileSite(sites?.[site]) : null;
    return { company: c, site: site || null, data: d, error: site ? failed[site] || null : null };
  });
  const have = rows.filter((r) => r.data);
  const total = { shipment: have.reduce((a, r) => addBlock(a, r.data.shipment), ZERO()), production: have.reduce((a, r) => addBlock(a, r.data.production), ZERO()) };
  const materials = {};
  GRADES.forEach(([name]) => {
    materials[name] = Object.fromEntries(PERIODS.map(([k]) => { const act = have.reduce((a, r) => a + r.data.materials[name][k].actual, 0), pl = have.reduce((a, r) => a + r.data.materials[name][k].plan, 0); return [k, { actual: act, plan: pl, pct: pct(act, pl) }]; }));
  });
  const monthly = MONTH_ABBR.map((l, i) => { const act = have.reduce((a, r) => a + r.data.monthly[i].actual, 0), tg = have.reduce((a, r) => a + r.data.monthly[i].target, 0); return { label: l, loaded: have.some((r) => r.data.monthly[i].loaded), actual: act, target: tg, pct: pct(act, tg) }; });
  const yearly = { actual: monthly.reduce((a, m) => a + m.actual, 0), target: materials.hgo.year.plan };
  yearly.pct = pct(yearly.actual, yearly.target);
  const cuts = have.map((r) => r.data.cut_off).sort();
  const out = {
    rows: rows.map((r) => ({ ...r, name: COMPANY_NAME[r.company] })), total, materials, monthly, yearly,
    report_date: cuts.length ? cuts[cuts.length - 1] : null,          // headline date = the newest cut off
    oldest_cut_off: cuts.length ? cuts[0] : null,
    stale: have.filter((r) => r.data.cut_off !== cuts[cuts.length - 1]).map((r) => ({ company: r.company, cut_off: r.data.cut_off })),
  };
  out.highlights = highlights(out);
  return out;
}

const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/** What matters today, worst first: stale sites, annual pace, companies far below or above plan, HSE cases, odd entries, rain. Max 8. */
export function highlights(rep) {
  const out = [], iso = rep.report_date;
  if (!iso) return out;
  rep.stale.forEach((s) => { const d = dayDiff(s.cut_off, iso); out.push({ tone: d >= 3 ? "bad" : "warn", tag: "DATA GAP", text: `${s.company} data stops at ${shortDate(s.cut_off)}, ${d} day${d === 1 ? "" : "s"} behind ${shortDate(iso)}. Load the missing days before reading its numbers.` }); });
  [["production", "Production", "WMT"], ["shipment", "Shipment", "MT"]].forEach(([k, name, u]) => {
    const y = rep.total[k].year, v = verdict(y, "year", iso);
    if (v.tone === "none") return;
    out.push({ tone: v.tone === "good" ? "good" : v.tone === "pace" ? "info" : "bad", tag: "YEAR TO DATE", text: `${name} year to date: ${fmt(y.actual, 0)} ${u} = ${y.pct.toFixed(1)}% of the annual plan of ${fmt(y.plan, 0)} ${u} (${v.label.toLowerCase()}, ${v.pace.toFixed(0)}% of the year has passed).` });
  });
  const have = rep.rows.filter((r) => r.data);
  [["production", "production"], ["shipment", "shipment"]].forEach(([k, n]) => {
    have.forEach((r) => {
      const d = r.data[k].day, when = r.data.cut_off === iso ? "today" : `on ${shortDate(r.data.cut_off)}`;
      if (d.plan > 0 && d.pct < 80) out.push({ tone: "bad", tag: "BELOW PLAN", text: `${r.company} ${n} ${when}: ${d.pct.toFixed(0)}% of plan (${fmt(d.actual, 0)} of ${fmt(d.plan, 0)}).` });
      else if (d.plan > 0 && d.pct >= 100) out.push({ tone: "good", tag: "ON TARGET", text: `${r.company} ${n} ${when}: ${d.pct.toFixed(0)}% of plan.` });
    });
  });
  have.forEach((r) => {
    const h = r.data.hse; if (!h) return;
    const hit = ["FATALITY", "LTI", "MTI", "FAI", "PD", "FC", "EC"].filter((c) => h[c] > 0);
    if (hit.length) out.push({ tone: h.FATALITY > 0 || h.LTI > 0 ? "bad" : "warn", tag: "HSE", text: `${r.company} HSE: ${hit.map((c) => `${c === "FATALITY" ? "fatality" : c} ${h[c]}`).join(", ")}.` });
    if (r.data.fuel && r.data.fuel.stock < 0) out.push({ tone: "warn", tag: "CHECK ENTRY", text: `${r.company} fuel stock is negative (${fmt(r.data.fuel.stock, 0)} L). Check the stock entry.` });
    const rain = r.data.weather.reduce((a, d) => a + (d.rain || 0), 0);
    if (rain > 0) out.push({ tone: "info", tag: "WEATHER", text: `${r.company} rain this week: ${rain.toFixed(1)} h.` });
  });
  const order = { bad: 0, warn: 1, info: 2, good: 3 };
  return out.map((x, i) => ({ ...x, i })).sort((a, b) => order[a.tone] - order[b.tone] || a.i - b.i).slice(0, 8).map((x) => ({ tone: x.tone, tag: x.tag, text: x.text }));
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function longDate(iso) { if (!iso) return "-"; const [y, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; }
export function shortDate(iso) { if (!iso) return "-"; const [y, m, d] = iso.split("-").map(Number); return `${String(d).padStart(2, "0")}-${MONTHS[m - 1].slice(0, 3)}-${String(y).slice(2)}`; }
export const fmt = (v, dp = 2) => (v == null ? "-" : v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }));
export const fmtPct = (v) => (v == null ? "-" : `${v.toFixed(1)}%`);
export const fileStem = (iso) => `Daily_Report_Production_${longDate(iso).replace(/ /g, "_")}`;

/** Share of the period that has passed on the cut-off day (0-1). Week = Monday to Sunday. */
export function elapsed(period, iso) {
  const [y, m, d] = iso.split("-").map(Number), t = Date.UTC(y, m - 1, d);
  if (period === "day") return 1;
  if (period === "week") return (((new Date(t).getUTCDay() + 6) % 7) + 1) / 7;
  if (period === "month") return d / new Date(Date.UTC(y, m, 0)).getUTCDate();
  const len = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
  return ((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / len;
}

/**
 * Achieved or not. b = {actual, plan, pct}. Plan of week, month and year is the full-period target (year = approved RKAB),
 * so below 100% is judged against the time that has passed: ON PACE or BEHIND PACE. Day has no pace: ACHIEVED or BELOW PLAN.
 * tone: good (achieved) | pace (not yet, but on pace) | bad | none.
 */
export function verdict(b, period, iso) {
  if (!b || !(b.plan > 0)) return { label: "NO PLAN", tone: "none", pace: null };
  const pace = elapsed(period, iso) * 100;
  if (b.pct >= 100) return { label: "ACHIEVED", tone: "good", pace };
  if (period === "day") return { label: "BELOW PLAN", tone: "bad", pace };
  return b.pct >= pace ? { label: "ON PACE", tone: "pace", pace } : { label: "BEHIND PACE", tone: "bad", pace };
}

/** Kept for the site pages: colour tone of a bare percent (>=100 good, 80-100 warn, <80 bad). */
export const status = (p) => (p == null ? "none" : p >= 100 ? "good" : p >= 80 ? "warn" : "bad");

/** The story in one sentence: what happened today, and who is lagging. Returns {title, sub}. */
export function headline(rep) {
  if (!rep?.report_date) return { title: "No data loaded yet", sub: "" };
  const sd = rep.total.shipment.day, pd = rep.total.production.day;
  const verb = (p) => (p == null ? "has no plan" : p >= 100 ? `beat plan at ${p.toFixed(0)}%` : `reached ${p.toFixed(0)}% of plan`);
  const have = rep.rows.filter((r) => r.data);
  const ranked = have.map((r) => ({ c: r.company, p: r.data.production.day.pct ?? r.data.shipment.day.pct })).filter((x) => x.p != null).sort((a, b) => a.p - b.p);
  let tail = "";
  if (ranked.length > 1 && ranked[0].p < 100) tail = ` ${ranked[0].c} is the one to watch at ${ranked[0].p.toFixed(0)}%.`;
  return {
    title: `Production ${verb(pd.pct)}, shipment ${verb(sd.pct)}.${tail}`,
    sub: `${longDate(rep.report_date)} \u00b7 ${have.length} of ${rep.rows.length} companies reporting`,
  };
}
