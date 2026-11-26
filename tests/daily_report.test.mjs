import assert from "node:assert/strict";
import * as D from "../src/lib/opd/daily-report.js";

// WKM figures taken from the Daily Report of 19 Nov 2026: LGO 5,743.64 + HGO 10,945.46 = 16,689.10
const wkm = {
  site: "WKM", cut_off: "2026-11-19",
  ship: [{ CONTRACTOR: "A", DAY: 1000, WTD: 5000, MTD: 20000, YTD: 90000 }, { CONTRACTOR: "B", DAY: "500", WTD: 100, MTD: 300, YTD: 400 }],
  mng: [{ CONTRACTOR: "A", "L-DAY": 5743.64, "H-DAY": 10945.46, "M-DAY": 0, "L-MTD": 10, "H-MTD": 20, "OB-DAY": 7 }, { CONTRACTOR: "B", "L-DAY": 0 }],
  cal: [{ "ST-DAY": 2000, "ST-MTD": 40000, "L-DAY": 4000, "H-DAY": 8000 }], hse: [{ NM: 1, LTI: 0 }, { NM: 2 }],
};
const s = D.compileSite(wkm);
assert.equal(s.shipment.day.actual, 1500);
assert.equal(s.shipment.day.plan, 2000);
assert.equal(s.shipment.day.pct, 75);
assert.ok(Math.abs(s.production.day.actual - 16689.10) < 1e-9, "LGO + HGO = subtotal of the PDF");
assert.equal(s.production.day.plan, 12000);
assert.equal(s.production.week.pct, null, "no plan = no percent");
assert.equal(s.hse.NM, 3);
assert.equal(s.waste.ob.day, 7);
assert.equal(D.compileSite(null), null);
assert.equal(D.compileSite({ site: "BM", cut_off: null }), null);

const bm = { site: "BM", cut_off: "2026-11-18", ship: [{ DAY: 10 }], mng: [], cal: [{ "ST-DAY": 20 }], hse: [] };
const r = D.compileDaily({ WKM: wkm, BM: bm, TMS: null }, { TMS: "network" });
assert.equal(r.rows.length, 8);
assert.equal(r.rows.find((x) => x.company === "TMS").error, "network");
assert.equal(r.rows.find((x) => x.company === "CDSM").data, null);
assert.equal(r.report_date, "2026-11-19");
assert.deepEqual(r.stale, [{ company: "BM", cut_off: "2026-11-18" }], "a site behind the newest day is flagged");
assert.equal(r.total.shipment.day.actual, 1510);
assert.equal(r.total.shipment.day.plan, 2020);
assert.equal(D.longDate("2026-11-19"), "19 November 2026");
assert.equal(D.shortDate("2026-11-19"), "19-Nov-26");
assert.equal(D.fmt(16689.1), "16,689.10");
assert.equal(D.fmtPct(null), "-");
assert.equal(D.fileStem("2026-11-19"), "Daily_Report_Production_19_November_2026");
assert.equal(D.compileDaily({}).report_date, null);
assert.equal(D.status(100), "good"); assert.equal(D.status(85), "warn"); assert.equal(D.status(50), "bad"); assert.equal(D.status(null), "none");
const b = (actual, plan) => ({ actual, plan, pct: plan > 0 ? (actual / plan) * 100 : null });
assert.equal(D.elapsed("day", "2026-11-19"), 1);
assert.ok(Math.abs(D.elapsed("month", "2026-11-19") - 19 / 30) < 1e-9);
assert.ok(Math.abs(D.elapsed("week", "2026-11-19") - 4 / 7) < 1e-9, "19 Nov 2026 is a Thursday");
assert.ok(Math.abs(D.elapsed("year", "2026-12-31") - 1) < 1e-9);
assert.equal(D.verdict(b(120, 100), "day", "2026-11-19").label, "ACHIEVED");
assert.equal(D.verdict(b(90, 100), "day", "2026-11-19").label, "BELOW PLAN");
assert.equal(D.verdict(b(70, 100), "month", "2026-11-19").label, "ON PACE", "70% >= 63% of the month");
assert.equal(D.verdict(b(50, 100), "month", "2026-11-19").label, "BEHIND PACE");
assert.equal(D.verdict(b(5, 0), "year", "2026-11-19").label, "NO PLAN");
assert.equal(D.verdict(b(100, 100), "year", "2026-11-19").tone, "good");
const h = D.headline(r);
assert.match(h.title, /Production beat plan at 139%, shipment reached 75% of plan\./);
assert.match(h.title, /BM is the one to watch at 50%/, "the laggard is named");
assert.match(h.sub, /2 of 8 companies reporting/);
assert.equal(D.headline(D.compileDaily({})).title, "No data loaded yet");
assert.equal(r.total.shipment.year.plan, 0, "year plan is the sum of the calendar YTD plans (0 in this fixture)");
console.log("daily_report tests passed");
