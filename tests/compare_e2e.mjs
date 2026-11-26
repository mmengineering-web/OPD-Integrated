// Browser test of the Compare week panel on the Uploads page (step 4.5) against the stub build. Run: npm run build:test && node tests/compare_e2e.mjs
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { createRequire } from "node:module";
const require = createRequire("/opt/npm-tools/node_modules/");
const { chromium } = require("playwright");

const ROOT = "out-test";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".wasm": "application/wasm" };
const server = http.createServer((q, r) => {
  let f = join(ROOT, decodeURIComponent(new URL(q.url, "http://x").pathname));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, "index.html");
  if (!existsSync(f)) { r.writeHead(404); return r.end("nf"); }
  r.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" }); r.end(readFileSync(f));
});
await new Promise((res) => server.listen(4174, res));
const B = "http://localhost:4174";
let fail = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fail++; };
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });

// A small in-page copy of the database functions: three days (clean, only here, different) and the rules the SQL enforces.
const FAKE = () => {
  const C = (same, changed, only_portal, only_prod) => ({ same, changed, only_portal, only_prod });
  const days = [
    { report_date: "2026-11-26", verdict: "only_here", actual: C(40, 0, 3, 0), barge: C(0, 0, 0, 0), batches: [{ batch_id: "b3", source_file: "dr_26.pdf", kind: "pdf", verdict: "only_here", actual: C(40, 0, 3, 0), barge: null, checked_at: "2026-11-26T08:00:00Z", explained: false, note: null }] },
    { report_date: "2026-11-25", verdict: "clean", actual: C(50, 0, 0, 0), barge: C(0, 0, 0, 0), batches: [{ batch_id: "b2", source_file: "dr_25.pdf", kind: "pdf", verdict: "clean", actual: C(50, 0, 0, 0), barge: null, checked_at: "2026-11-25T08:00:00Z", explained: false, note: null }] },
    { report_date: "2026-11-24", verdict: "clean", actual: C(48, 0, 0, 0), barge: C(0, 0, 0, 0), batches: [{ batch_id: "b1", source_file: "dr_24.pdf", kind: "pdf", verdict: "clean", actual: C(48, 0, 0, 0), barge: null, checked_at: "2026-11-24T08:00:00Z", explained: false, note: null }] },
  ];
  const summary = () => {
    let streak = 0; for (const d of days) { if (d.verdict === "clean" || d.verdict === "explained") streak++; else break; }
    return { site: "BM", live: !!window.__live, need: 10, streak, ready: streak >= 10, newest_clean: days[0].report_date, missing_days: 0, days };
  };
  window.__rpc = {
    etl_compare_status: async () => (window.__missing ? { data: null, error: { message: "Could not find the function public.etl_compare_status(p_need) in the schema cache" } } : { data: summary(), error: null }),
    etl_compare_record: async ({ p_batch }) => ({ data: { batch_id: p_batch }, error: null }),
    etl_compare_explain: async ({ p_batch, p_explained, p_note }) => {
      if (p_explained && (p_note ?? "").trim().length < 10) return { data: null, error: { message: "ETL: write the reason in a few words (at least 10 characters)" } };
      const d = days.find((x) => x.batches.some((b) => b.batch_id === p_batch)); const b = d.batches[0];
      b.explained = p_explained; b.note = p_explained ? p_note : null; b.verdict = p_explained ? "explained" : "only_here"; d.verdict = b.verdict;
      return { data: { batch_id: p_batch, explained: p_explained }, error: null };
    },
  };
};

async function open(role, { live = false, missing = false } = {}) {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.addInitScript(`window.__live=${live};window.__missing=${missing};(${FAKE.toString()})();`);
  await page.addInitScript((r) => localStorage.setItem("opd_access", JSON.stringify({ v: 1, at: Date.now(), email: "x@can.test", name: "Test", projects: { "bm-prod": { state: "ok", role: r } }, ok: true, failures: [] })), role);
  await page.goto(B + "/production/data-inputs/");
  return { ctx, page };
}

// site admin: full panel
{
  const { ctx, page } = await open("site_admin");
  await page.waitForSelector("[data-compare-week]");
  const t = await page.textContent("[data-compare-week]");
  ok(/0 of 10 clean days in a row/.test(t), "shows 0 of 10: the newest day needs a reason, so the run has not started");
  ok((await page.locator("[data-compare-week] tbody > tr").count()) === 3, "three days listed");
  ok(/Needs a reason/.test(t) && /Clean/.test(t), "verdict badges are shown");
  ok((await page.getAttribute("[data-compare-week] [role=progressbar]", "aria-valuenow")) === "0", "progress bar value is 0");
  await page.click("text=26 Nov 2026");
  await page.waitForSelector("input[aria-label=Reason]");
  ok(await page.locator("button:has-text('Save reason')").isDisabled(), "Save reason is disabled until the reason has 10 characters");
  await page.fill("input[aria-label=Reason]", "late");
  ok(await page.locator("button:has-text('Save reason')").isDisabled(), "a short reason is not enough");
  await page.fill("input[aria-label=Reason]", "current process loads this day tomorrow");
  await page.click("button:has-text('Save reason')");
  await page.waitForSelector("text=Reason: current process loads this day tomorrow");
  const t2 = await page.textContent("[data-compare-week]");
  ok(/3 of 10 clean days in a row/.test(t2) && /7 more to go/.test(t2), "after the reason the day passes: 3 of 10, 7 more to go");
  const log = await page.evaluate(() => window.__rpcLog.map((x) => x[0]));
  ok(log.includes("etl_compare_explain") && log.filter((x) => x === "etl_compare_status").length >= 2, "the panel asked the database to save and then read the status again");
  await page.click("button:has-text('Remove reason')");
  await page.waitForSelector("text=Needs a reason");
  ok(/0 of 10/.test(await page.textContent("[data-compare-week]")), "removing the reason puts the day back");
  await page.click("button:has-text('Check again')");
  await page.waitForTimeout(300);
  ok((await page.evaluate(() => window.__rpcLog.some((x) => x[0] === "etl_compare_record" && x[1].p_batch === "b3"))), "Check again asks the database to compare that load");
  await ctx.close();
}
// data entry: can read, cannot write the reason
{
  const { ctx, page } = await open("data_entry");
  await page.waitForSelector("[data-compare-week]");
  await page.click("text=26 Nov 2026");
  await page.waitForSelector("text=Only a site admin can write the reason.");
  ok((await page.locator("input[aria-label=Reason]").count()) === 0, "data entry sees no reason field");
  ok((await page.locator("button:has-text('Check again')").count()) === 1, "data entry can still check a day again");
  await ctx.close();
}
// live site and a project without etl_06
{
  const { ctx, page } = await open("site_admin", { live: true });
  await page.waitForSelector("text=This site is live.");
  ok((await page.locator("[data-compare-week]").count()) === 0, "a live site shows no compare table");
  await ctx.close();
}
{
  const { ctx, page } = await open("site_admin", { missing: true });
  await page.waitForSelector("text=etl_06_compare.sql");
  ok(true, "a project without etl_06 says what to run");
  await ctx.close();
}
await browser.close(); server.close();
console.log(fail ? `${fail} FAILED` : "compare_e2e: all passed");
process.exit(fail ? 1 : 0);
