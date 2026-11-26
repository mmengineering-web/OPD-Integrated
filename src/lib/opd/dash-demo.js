// Synthetic etl_dash_data results for tests and visual checks. Never imported by the app pages.
import { addDays, dayList } from "./dash-model.js";

const rnd = (seed) => { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296); };

export function demoSite(site, { from, to, last, seed = 1, scale = 1, stale = 0 }) {
  const r = rnd(seed), days = dayList(from, to), end = addDays(last, -stale), rows = {}, push = (t, d, c, v) => ((rows[t] ??= []).push({ d, c, n: 1, v })), yr = last.slice(0, 4);
  let ytdP = 0, ytdS = 0, mtdP = 0, mtdS = 0, fuel = 90000 * scale, stock = 60000 * scale, mp = 520 * scale;
  const planP = 9000 * scale, planS = 9500 * scale;
  const dayN = (d) => Math.round((Date.parse(d) - Date.parse(yr + "-01-01")) / 86400000);
  ytdP = planP * dayN(from) * 0.93; ytdS = planS * dayN(from) * 0.84;
  const hz = [];
  for (const d of days) {
    if (d > end) continue;
    if (d.endsWith("-01")) { mtdP = 0; mtdS = 0; }
    const rain = r() < 0.18, wk = new Date(d).getUTCDay() === 5 ? 0.85 : 1;
    const base = rain ? 0.55 : 1;
    for (const c of ["PT A", "PT B"]) {
      const L = Math.round(planP * 0.3 * base * wk * (0.6 + r() * 0.7) * (c === "PT A" ? 0.6 : 0.4)), M = Math.round(planP * 0.12 * base * (0.5 + r()) * (c === "PT A" ? 0.6 : 0.4)), H = Math.round(planP * 0.58 * base * wk * (0.55 + r() * 0.7) * (c === "PT A" ? 0.6 : 0.4));
      const share = c === "PT A" ? 0.6 : 0.4;
      const OB = Math.round((L + M + H) * (2.4 + r()));
      ytdP += L + M + H; mtdP += L + M + H;
      push("tblRAWMNG", d, c, { "L-DAY": L, "M-DAY": M, "H-DAY": H, "OB-DAY": OB, "L-MTD": mtdP * 0.3 * share, "M-MTD": mtdP * 0.12 * share, "H-MTD": mtdP * 0.58 * share, "L-YTD": ytdP * 0.3 * share, "M-YTD": ytdP * 0.12 * share, "H-YTD": ytdP * 0.58 * share });
      push("tblRAWHAUL", d, c, { DAY: Math.round((L + M + H + OB) * 0.9) });
    }
    const sh = Math.round(planS * (rain ? 0.4 : 0.55 + r() * 0.8) * wk);
    ytdS += sh; mtdS += sh;
    push("tblRAWSHIP", d, "PT A", { DAY: sh, MTD: mtdS, YTD: ytdS });
    push("tblCALENDAR", d, "PT A", { "OB-DAY": planP * 2.9 * scale0(scale), "EFFECTIVE WORKING HOUR (EWH)": 10.5, "RAIN HOUR": 1.2, SLIPPERY: 0.6, "TOTAL DELAY": 6.5, "PHYSICAL AVAILABILITY (PA)": 0.88, "L-DAY": planP * 0.3, "M-DAY": planP * 0.12, "H-DAY": planP * 0.58, "ST-DAY": planS, "L-MTD": planP * 30 * 0.3, "M-MTD": planP * 30 * 0.12, "H-MTD": planP * 30 * 0.58, "ST-MTD": planS * 30, "L-YTD": planP * 340 * 0.3, "M-YTD": planP * 340 * 0.12, "H-YTD": planP * 340 * 0.58, "ST-YTD": planS * 340, "PHYSICAL AVAILABILITY (PA)": 0.9 - dayN(d) / 2500 });
    const ewh = rain ? 6 + r() * 3 : 11 + r() * 1.5;
    push("tblRAWWEWH", d, "PT A", { EWH: ewh, "RAIN HOUR": rain ? 3 + r() * 5 : 0, SLIPPERY: rain ? 2 : 0, "DAILY MEETING (P5M)": 0.25, "GENERAL SAFETY TALK": 0.25, "FRIDAY PRAY": 1, "REST & MEAL": 2, "REFUELLING & DAILY SERVICE (P2H)": 0.5, "SHIFT CHANGE": 0.5, OTHERS: r() });
    push("tblRAWUP", d, "PT A", { "EXC-PA": 0.9 - r() * 0.08 - dayN(d) / 3000, "EXC-MA": 0.88 - r() * 0.06, "EXC-UA": 0.75 - r() * 0.08, "EXC-EU": 0.66 - r() * 0.07, "DT-PA": 0.89 - r() * 0.06, "DT-MA": 0.86 - r() * 0.05, "DT-UA": 0.78 - r() * 0.08, "DT-EU": 0.67 - r() * 0.05 });
    push("tblRAWEQ", d, "PT A", { "OP-EXC1": 4, "OP-DT": 22 - Math.round(r() * 4), "OP-DOZER": 3, "S-DT": Math.round(r() * 4), "B-DT": Math.round(r() * 3), "B-EXC1": r() < 0.2 ? 1 : 0, "P-DT": 26 });
    push("tblRAWHSE", d, "PT A", { NM: r() < 0.3 ? 1 : 0, FAI: r() < 0.06 ? 1 : 0, PD: r() < 0.05 ? 1 : 0, LTI: 0, FATALITY: 0, MTI: 0, FC: 0, EC: 0 });
    fuel = fuel - 3500 * (0.8 + r() * 0.4) + (r() < 0.12 ? 40000 * scale : 0); stock = stock + (L0(r, planP) - sh) * 0.5;
    push("tblRAWFUEL", d, "PT A", { DAY: Math.round(3500 * (0.8 + r() * 0.4)), STOCK: Math.round(fuel) });
    push("tblRAWSTOCK", d, "PT A", { "ETO-H-TONAGE": Math.max(2000, stock * 0.42), "ETO-M-TONAGE": stock * 0.1, "ETO-L-TONAGE": stock * 0.28, "EFO-H-TONAGE": stock * 0.12, "EFO-L-TONAGE": stock * 0.08, "ETO-H-Ni": 1.78 + r() * 0.1 });
    mp += (r() - 0.45) * 2;
    push("tblRAWMP", d, "PT A", { TOTAL: Math.round(mp), ADD: r() < 0.1 ? 2 : 0, RESIGN: r() < 0.08 ? 1 : 0, MANAGER: 6, SPT: 12, SPV: 40, DRIVER: Math.round(mp * 0.5), OPERATOR: Math.round(mp * 0.25), ETC: Math.round(mp * 0.1) });
    push("tblRAWEXPLO", d, "PT A", { "P-DH": 2, "A-DH": r() < 0.8 ? 2 : 1, "P-SAMPLE": 20, "A-SAMPLE": Math.round(14 + r() * 8), "P-DEPTH": 60, "A-DEPTH": Math.round(40 + r() * 25) });
    push("tblRAWLAB", d, "PT A", { "FD-FP": Math.round(r() * 30), "FD-QC": Math.round(r() * 12), "FD-SS": Math.round(r() * 20), "FD-BARGE": r() < 0.2 ? 6 : 0, "ID-FP": Math.round(r() * 30) });
    if (r() < 0.2) hz.push({ date: d, "HAZARD LOCATION": "KM " + Math.round(r() * 20), "IDENTIFIED HAZARD": r() < 0.5 ? "Road surface slippery after rain" : "Unit lamp not working", "CORRECTIVE ACTION": "Stop hauling and grade the road", "REPAIR STATUS": r() < 0.6 ? "Closed" : "Continue", "RISK LEVEL": r() < 0.25 ? "High" : r() < 0.5 ? "Medium" : "Low", "HAZARD CATEGORY": r() < 0.6 ? "Kondisi Tidak Aman" : "Tindakan Tidak Aman" });
  }
  return {
    site, from, to, first: addDays(last, -200), last: end, daily: rows, hazard: hz,
    cons: [{ date: end, AREA: "Parkiran", "CONSTRUCTION ITEM": "Parkiran", PROGRESS: 97, REMARK: "On Going", CONSCATEGORY: "Building" }, { date: end, AREA: "Jembatan Timbang", "CONSTRUCTION ITEM": "Jembatan Timbang 2x100 Ton", PROGRESS: 39, REMARK: "On Going", CONSCATEGORY: "Infrastructure" }, { date: end, AREA: "Klinik", "CONSTRUCTION ITEM": "Klinik Pratama", PROGRESS: 27, REMARK: "On Going", CONSCATEGORY: "Building" }],
    barge: [{ "VESSEL/BARGE": "TB Sinar 1", CONTRACTOR: "PT A", STATUS: "Loading", "PLAN CAPACITY": 7500, "ACTUAL CAPACITY": 5200, MONTH: "Nov" }],
  };
}
const scale0 = () => 1;
const L0 = (r, p) => p * (0.8 + r() * 0.6);

export function demoAll(from, to, last) {
  return { WKM: demoSite("WKM", { from, to, last, seed: 3 }), BM: demoSite("BM", { from, to, last, seed: 11, scale: 0.6, stale: 1 }), TMS: demoSite("TMS", { from, to, last, seed: 29, scale: 0.35, stale: 9 }) };
}
