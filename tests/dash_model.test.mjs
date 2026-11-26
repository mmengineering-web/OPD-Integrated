// Dashboard model tests. Run: node tests/dash_model.test.mjs
import assert from "node:assert/strict";
import { buildDash, rangeFor, dayList, addDays, daysBetween, explorerColumns, explorerSeries } from "../src/lib/opd/dash-model.js";
import { demoAll } from "../src/lib/opd/dash-demo.js";

let n = 0; const t = (name, f) => { f(); n++; console.log("PASS " + name); };

t("dates", () => {
  assert.equal(addDays("2026-11-30", 1), "2026-12-01"); assert.equal(daysBetween("2026-11-01", "2026-11-30"), 29);
  assert.equal(dayList("2026-11-01", "2026-11-03").length, 3); assert.deepEqual(dayList("2026-11-03", "2026-11-01"), []);
});
t("presets count back from the newest loaded day", () => {
  assert.deepEqual(rangeFor("7d", "2026-11-25"), { from: "2026-11-19", to: "2026-11-25" });
  assert.deepEqual(rangeFor("mtd", "2026-11-25"), { from: "2026-11-01", to: "2026-11-25" });
  assert.deepEqual(rangeFor("lm", "2026-11-25"), { from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(rangeFor("ytd", "2026-11-25"), { from: "2026-01-01", to: "2026-11-25" });
});

// A tiny hand made site: two days, two contractors, known sums.
const raw = { WKM: { site: "WKM", first: "2026-11-01", last: "2026-11-02", daily: {
  tblRAWMNG: [{ d: "2026-11-01", c: "A", n: 1, v: { "L-DAY": 10, "M-DAY": 5, "H-DAY": 85, "OB-DAY": 300, "L-YTD": 100, "M-YTD": 50, "H-YTD": 850, "L-MTD": 10, "M-MTD": 5, "H-MTD": 85 } },
              { d: "2026-11-01", c: "B", n: 1, v: { "L-DAY": 0, "M-DAY": 0, "H-DAY": 100, "OB-DAY": 200, "L-YTD": 0, "M-YTD": 0, "H-YTD": 100, "H-MTD": 100 } },
              { d: "2026-11-02", c: "A", n: 1, v: { "H-DAY": 200, "OB-DAY": 400, "H-YTD": 1150, "H-MTD": 385, "L-YTD": 100, "M-YTD": 50 } }],
  tblRAWSHIP: [{ d: "2026-11-01", c: "A", n: 1, v: { DAY: 120, YTD: 1000, MTD: 120 } }, { d: "2026-11-02", c: "A", n: 1, v: { DAY: 130, YTD: 1130, MTD: 250 } }],
  tblCALENDAR: [{ d: "2026-11-01", c: "A", n: 1, v: { "L-DAY": 20, "M-DAY": 10, "H-DAY": 170, "ST-DAY": 200, "ST-YTD": 3650, "ST-MTD": 6000, "H-YTD": 3000, "L-YTD": 500, "M-YTD": 100, "L-MTD": 600, "M-MTD": 300, "H-MTD": 5100 } },
                { d: "2026-11-02", c: "A", n: 1, v: { "L-DAY": 20, "M-DAY": 10, "H-DAY": 170, "ST-DAY": 200, "ST-YTD": 3650, "ST-MTD": 6000, "H-YTD": 3000, "L-YTD": 500, "M-YTD": 100, "L-MTD": 600, "M-MTD": 300, "H-MTD": 5100 } }],
  tblRAWHSE: [{ d: "2026-11-02", c: "A", n: 1, v: { NM: 2, LTI: 1 } }], tblRAWFUEL: [{ d: "2026-11-02", c: "A", n: 1, v: { DAY: 100, STOCK: -5 } }],
}, hazard: [{ date: "2026-11-02", "RISK LEVEL": "High", "REPAIR STATUS": "Continue", "IDENTIFIED HAZARD": "x", "CORRECTIVE ACTION": "y" }, { date: "2026-11-02", "RISK LEVEL": "Low", "REPAIR STATUS": "Closed" }, { date: "2026-10-02", "RISK LEVEL": "Low", "REPAIR STATUS": "Continue" }], cons: [], barge: [] } };
const m = buildDash(raw, { from: "2026-11-01", to: "2026-11-02" });

t("range sums: production = L+M+H over the days, shipment = DAY", () => {
  assert.equal(m.siteRows[0].prod.range.actual, 400); assert.equal(m.siteRows[0].ship.range.actual, 250);
  assert.equal(m.siteRows[0].prod.range.plan, 400); assert.equal(m.siteRows[0].ship.range.plan, 400);
  assert.equal(m.siteRows[0].ship.range.pct, 62.5);
});
t("year to date reads one day, never a sum over days", () => {
  assert.equal(m.totals.prod.ytd.actual, 100 + 50 + 1150); assert.equal(m.totals.ship.ytd.actual, 1130); assert.equal(m.totals.ship.ytd.plan, 3650);
  assert.equal(m.totals.ship.mtd.actual, 250);
});
t("cumulative lines and plan lines", () => { assert.deepEqual(m.trend.cumProd, [200, 400]); assert.deepEqual(m.trend.cumPlanShip, [200, 400]); });
t("stripping ratio and contractor split", () => { assert.equal(m.strip, 900 / 400); assert.equal(m.contractors.prod[0].name, "WKM · A"); assert.equal(m.contractors.prod[0].value, 300); });
t("outlook: needed rate for the days left", () => {
  const o = m.outlook.find((x) => x.key === "ship"); assert.equal(o.left, 59); assert.ok(Math.abs(o.needDay - (3650 - 1130) / 59) < 1e-9); assert.equal(o.avgDay, 125);
});
t("safety: counts, days since the last lost time injury, open high risk hazards in the range only", () => {
  assert.equal(m.check.hse.find((h) => h.key === "LTI").total, 1); assert.equal(m.check.safeDays, 0);
  assert.equal(m.check.hazard.total, 2); assert.equal(m.check.hazard.open, 1); assert.equal(m.check.hazard.openList[0].risk, "High");
});
t("actions are ranked, critical first", () => {
  assert.equal(m.acts[0].sev, "critical"); assert.ok(m.acts.some((a) => /Fuel stock went below zero/.test(a.title)));
  const order = { critical: 0, high: 1, medium: 2, info: 3 }; for (let i = 1; i < m.acts.length; i++) assert.ok(order[m.acts[i - 1].sev] <= order[m.acts[i].sev]);
});
t("explorer reads any table and column", () => {
  assert.ok(explorerColumns(raw, "tblRAWSHIP").includes("DAY")); assert.deepEqual(explorerSeries(raw, "tblRAWSHIP", "DAY", m.days).values, [120, 130]);
});

// The generated demo: every part of the page has something to draw, and a site behind the range is flagged.
const to = "2026-11-25", from = "2026-08-01";
const d = buildDash(demoAll(from, to, to), { from, to });
t("demo: all sites, all sections", () => {
  assert.deepEqual(d.sites, ["WKM", "BM", "TMS"]);
  for (const k of ["stock", "fuel", "manpower", "explo", "lab"]) assert.ok(d[k], k); assert.ok(d.check.equip && d.check.equip.length >= 3);
  assert.ok(d.check.avail.length >= 3 && d.check.delay.length && d.check.hazard.total > 0 && d.construction.items.length === 9);
  assert.ok(d.siteRows.find((r) => r.site === "TMS").stale); assert.ok(d.acts.some((a) => /TMS data stops/.test(a.title)));
  assert.ok(d.story.headline.includes("shipped") && d.story.act);
});
t("empty input does not break", () => { const e = buildDash({}, { from, to }); assert.equal(e.last, null); assert.equal(e.story.headline, "No loaded day in this range."); });
console.log(`\n${n} passed`);
