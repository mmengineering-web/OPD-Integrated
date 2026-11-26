import test from "node:test"; import assert from "node:assert/strict";
import { demoAll } from "../src/lib/opd/dash-demo.js";
import { buildReports, linreg } from "../src/lib/opd/dash-reports.js";
const range = { from: "2026-10-26", to: "2026-11-24" };
const raw = demoAll(range.from, range.to, "2026-11-24");

test("waterfall closes exactly on actual production", () => {
  const m = buildReports(raw, range), s = m.wf.steps;
  assert.equal(m.wf.ok, true);
  assert.equal(s[0].key, "plan"); assert.equal(s.at(-1).key, "actual");
  const bridge = s[0].value + s.slice(1, -1).reduce((a, x) => a + x.value, 0);
  assert.ok(Math.abs(bridge - s.at(-1).value) < 1e-6);
});
test("a cause is a gain when less time was lost than planned", () => {
  const m = buildReports(raw, range), rain = m.wf.steps.find((x) => x.key === "RAIN HOUR");
  assert.equal(Math.sign(rain.value), Math.sign(rain.planHours - rain.hours));
  assert.ok(Math.abs(rain.value - (rain.planHours - rain.hours) * m.wf.rate) < 1e-6);
});
test("other causes share the remaining plan delay in proportion to their hours", () => {
  const m = buildReports(raw, range), others = m.wf.steps.filter((x) => x.type === "delta" && x.planHours != null && !["RAIN HOUR", "SLIPPERY"].includes(x.key));
  const tot = others.reduce((a, x) => a + x.hours, 0), plan = others.reduce((a, x) => a + x.planHours, 0);
  others.filter((x) => x.hours > 0).forEach((x) => assert.ok(Math.abs(x.planHours / plan - x.hours / tot) < 1e-9));
});
test("no plan or no hours gives a reason, not a chart", () => {
  const bare = { WKM: { ...raw.WKM, daily: { tblRAWMNG: raw.WKM.daily.tblRAWMNG } } };
  const m = buildReports(bare, range);
  assert.equal(m.wf.ok, false); assert.match(m.wf.why, /plan/i);
});
test("rain days are compared with dry days", () => {
  const m = buildReports(raw, range);
  assert.equal(m.rainEffect.ok, true);
  assert.ok(m.rainEffect.nRain > 0 && m.rainEffect.nDry > 0);
  const ob = m.rainEffect.rows.find((r) => r.label === "Overburden moved");
  assert.ok(ob.rain < ob.dry, "demo rain days move less");
});
test("a weak day is explained by the causes that stand out", () => {
  const m = buildReports(raw, range), e = m.worst[0];
  assert.ok(e.reasons.length > 0); assert.ok(e.pctPlan < 100);
});
test("linreg finds a clean slope", () => {
  const r = linreg([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]); assert.ok(Math.abs(r.slope - 2) < 1e-9 && Math.abs(r.r - 1) < 1e-9);
  assert.equal(linreg([1, 1, 1, 1], [1, 2, 3, 4]), null);
});
test("report series line up with the day list", () => {
  const m = buildReports(raw, range);
  ["ob", "ewh", "wet", "OP", "B", "pa", "haul"].forEach((k) => assert.equal(m.s[k].length, m.days.length));
});

test("stock, fuel and headcount bridges close on the closing value", () => {
  const m = buildReports(raw, range);
  for (const k of ["stock", "fuel", "people"]) {
    const b = m.bridges[k]; assert.equal(b.ok, true, k);
    const s = b.steps, sum = s[0].value + s.slice(1, -1).reduce((a, x) => a + x.value, 0);
    assert.ok(Math.abs(sum - s.at(-1).value) < 1e-6, k);
  }
});
test("a late site does not look like a stock drop: bridge ends on the last day every site has loaded", () => {
  const m = buildReports(raw, range), b = m.bridges.stock;
  assert.ok(b.last < "2026-11-24", "TMS is 9 days late in the demo, so the bridge stops before the newest day");
});
test("a bridge needs two stock days", () => {
  const one = { WKM: { ...raw.WKM, daily: { ...raw.WKM.daily, tblRAWFUEL: raw.WKM.daily.tblRAWFUEL.slice(0, 1) } } };
  assert.equal(buildReports(one, range).bridges.fuel.ok, false);
});
test("the extra series are aligned and rain rows cover drilling, fuel and incidents", () => {
  const m = buildReports(raw, range);
  ["stock", "inc", "fuelStock", "mp", "labTotal", "geo"].forEach((k) => assert.equal(m.x[k].length, m.days.length, k));
  const labels = m.rainEffect.rows.map((r) => r.label);
  ["Fuel used", "Incidents and near misses", "Drill holes drilled"].forEach((l) => assert.ok(labels.includes(l), l));
});
