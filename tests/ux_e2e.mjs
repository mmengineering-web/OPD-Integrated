// Browser test of the UI/UX pass: short navigation labels, page search (type or scroll), input masks,
// clear button text, grouped form spacing and colour meaning. Run: node tests/ux_e2e.mjs (after npm run build:test)
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { createRequire } from "node:module";
const require = createRequire("/opt/npm-tools/node_modules/");
const { chromium } = require("playwright");

const ROOT = "out-test";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
const server = http.createServer((q, r) => {
  let f = join(ROOT, decodeURIComponent(new URL(q.url, "http://x").pathname));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, "index.html");
  if (!existsSync(f)) { r.writeHead(404); return r.end("nf"); }
  r.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" }); r.end(readFileSync(f));
});
await new Promise(res => server.listen(4175, res));
const B = "http://localhost:4175";
let fail = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fail++; };
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errs = []; page.on("pageerror", e => errs.push(e.message));
await page.route("https://datastudio.google.com/**", r => r.fulfill({ status: 200, contentType: "text/html", body: "<p>report</p>" }));

// ---- 1. short navigation labels and clear buttons on the public home ----
await page.goto(B + "/"); await page.waitForSelector("[data-sidebar]");
const side = await page.locator("[data-sidebar]").textContent();
ok(side.includes("Tools") && !side.includes("Mining Tools"), "sidebar says Tools, not Mining Tools");
ok((await page.textContent(".land-copy")).includes("Sign in") && !(await page.textContent(".land-copy")).includes("Start here"), "hero button says Sign in");
ok((await page.textContent("#b-login")).trim() === "Sign in", "top bar button says Sign in (one word for one action)");
await page.click('[data-side-section="explo"]'); await page.waitForSelector('[data-side-item="/exploration/maps/"]');
const labels = await page.locator('[data-side-section="explo"] ul a > span.flex-1').allTextContents();
ok(labels.every(l => l.trim().length <= 12), "every Exploration page label is 12 characters or fewer: " + labels.map(l => l.trim()).join(" | "));
ok(labels.some(l => l.includes("Maps")) && labels.some(l => l.includes("Requests")) && labels.some(l => l.includes("Data Entry")), "Exploration labels are Maps, Requests, Data Entry");
await page.click('[data-side-section="production"] button'); await page.waitForSelector('[data-side-item="/production/data-inputs/"]');
const plabels = (await page.locator('[data-side-section="production"] ul a > span.flex-1').allTextContents()).map(l => l.trim());
ok(plabels.some(l => l.startsWith("Uploads")) && plabels.some(l => l.startsWith("Guides")), "Production labels are Uploads and Guides");

// ---- 2. page search: type to narrow, or scroll ----
await page.keyboard.press("Control+k"); await page.waitForSelector("[cmdk-input]");
ok((await page.locator("[data-page-item]").count()) >= 20, "page search lists every page when nothing is typed");
ok(await page.evaluate(() => { const l = document.querySelector("[cmdk-list]"); return l.scrollHeight > l.clientHeight; }), "the list scrolls when nothing is typed");
const only = async q => { await page.fill("[cmdk-input]", q); await page.waitForTimeout(120); return page.locator("[data-page-item]").evaluateAll(a => a.map(x => x.getAttribute("data-page-item"))); };
ok(JSON.stringify(await only("maps")) === JSON.stringify(["/exploration/maps/"]), "typing 'maps' finds Maps");
ok((await only("interactive")).includes("/exploration/maps/"), "the old name 'interactive maps' still finds Maps");
ok((await only("user administration")).includes("/portal/admin/"), "the old name 'user administration' still finds Users");
ok((await only("data inputs")).includes("/production/data-inputs/"), "the old name 'data inputs' still finds Uploads");
ok((await only("mining tools")).includes("/tools/"), "the old name 'mining tools' still finds Tools");
ok((await only("zzzz")).length === 0 && (await page.textContent("[cmdk-empty]")).includes("No page matches"), "no match shows a plain message");
ok((await page.locator("[cmdk-list]").textContent()).length > 0, "message is inside the list");
await only("users");
ok((await page.locator('[data-page-item="/portal/admin/"]').textContent()).includes("Sign in"), "a page behind sign-in shows a lock hint");
await page.keyboard.press("Escape"); await page.waitForTimeout(200);
ok((await page.locator("[cmdk-input]").count()) === 0, "Escape closes the search");
await page.click("#b-search"); await page.waitForSelector("[cmdk-input]"); await page.fill("[cmdk-input]", "calc"); await page.waitForTimeout(150); await page.keyboard.press("Enter");
await page.waitForURL("**/tools/calculators/"); ok(true, "Enter opens the first match (Calculators)");

// ---- 3. input masks on the calculators ----
await page.waitForSelector("#utm-zone");
await page.fill("#utm-zone", "99"); ok((await page.inputValue("#utm-zone")) === "9", "zone: 99 becomes 9 (the zone is 1 to 60)");
await page.fill("#utm-zone", "abc5x1"); ok((await page.inputValue("#utm-zone")) === "51", "zone: letters are dropped");
await page.fill("#utm-a", "412500,555"); ok((await page.inputValue("#utm-a")) === "412500.55", "easting: comma becomes a dot, 2 decimals");
ok((await page.getAttribute("#utm-a", "placeholder")).includes("412500"), "easting shows an example");
await page.selectOption("#utm-dir", "l2u");
await page.fill("#utm-a", "-91"); ok((await page.inputValue("#utm-a")) === "-9", "latitude: -91 becomes -9");
await page.fill("#utm-b", "181"); ok((await page.inputValue("#utm-b")) === "18", "longitude: 181 becomes 18");
await page.click("#t-vol"); await page.fill("#t-vol", ""); await page.keyboard.type("1x2,5");
ok((await page.inputValue("#t-vol")) === "12.5", "typing 1x2,5 into volume gives 12.5");
await page.fill("#t-moist", "150"); ok((await page.inputValue("#t-moist")) === "15", "moisture: 150 becomes 15 (0 to 100)");
await page.fill("#t-vol", "1000"); await page.fill("#t-den", "1.6"); await page.fill("#t-moist", "30");
ok((await page.textContent("#t-wet")) === "1,600.0", "calculation still works with masked fields");
// caret: type in the middle of a number and keep typing there
await page.fill("#t-vol", "100"); await page.focus("#t-vol"); await page.evaluate(() => document.querySelector("#t-vol").setSelectionRange(1, 1));
await page.keyboard.type("x7"); ok((await page.inputValue("#t-vol")) === "1700", "the caret stays where the person is typing when a character is dropped");

// ---- 4. HPM masks ----
await page.goto(B + "/tools/hpm-nickel/"); await page.waitForSelector("#hpm-mc");
await page.fill("#hpm-mc", "150"); ok((await page.inputValue("#hpm-mc")) === "15", "HPM moisture: 150 becomes 15");
await page.fill("#hpm-ni", "1,8"); ok((await page.inputValue("#hpm-ni")) === "1.8", "HPM nickel: comma becomes a dot");
await page.fill("#hpm-mc", "30");
ok((await page.textContent("#hpm-pdf")).trim() === "Download PDF", "PDF button says Download PDF");

// ---- 5. login: mask, buttons, grouped spacing ----
await page.goto(B + "/login/"); await page.waitForSelector("#l-email");
await page.fill("#l-email", "  Ana@CAN.co "); ok((await page.inputValue("#l-email")) === "ana@can.co", "login email: spaces removed, lower case");
ok((await page.getAttribute("#l-email", "placeholder")) === "name@company.com", "login email shows an example");
ok((await page.textContent("#l-go")).includes("Sign in"), "sign-in button says Sign in");
ok((await page.textContent("#l-guest")).includes("without signing in"), "guest button says what it does");
const gap = await page.evaluate(() => {
  const f = document.querySelector("#lf"); const first = f.firstElementChild;
  const gIn = parseFloat(getComputedStyle(first).rowGap), gOut = parseFloat(getComputedStyle(f).rowGap);
  const col = f.parentElement.parentElement; const gGroups = parseFloat(getComputedStyle(col).rowGap);
  return { gIn, gOut, gGroups };
});
ok(gap.gIn < gap.gOut && gap.gOut < gap.gGroups, `spacing grows with distance: fields ${gap.gIn}px, form parts ${gap.gOut}px, page groups ${gap.gGroups}px`);
await page.click("#l-guest"); await page.waitForSelector("#guest-panel");
ok((await page.textContent("#l-guest-go")).includes("Pick a site to continue") && await page.locator("#l-guest-go").isDisabled(), "guest action asks for a site first");

// ---- 6. Exploration forms: hole ID mask ----
await page.locator('#guest-panel label:has([data-site="CDSM"])').click(); await page.click("#l-guest-go");
await page.waitForURL(/\/explo\/\?site=CDSM/); await page.waitForSelector("[name=hole_id]");
await page.fill("[name=hole_id]", "wkm dd_0004!"); ok((await page.inputValue("[name=hole_id]")) === "WKM-DD-0004", "hole ID: capitals, hyphens, no symbols");
ok((await page.getAttribute("[name=hole_id]", "placeholder")) === "WKM-DD-0004", "hole ID shows an example");

// ---- 7. admin page: colours, grouping, search, button text ----
const KEY = { "wkm-explo": "fake-sb-exp-WKM", "wkm-prod": "fake-sb-opd-wkm-prod", "hub-prod": "fake-sb-opd-hub-prod" };
const U = (id, email, name, role) => ({ user_id: id, email, full_name: name, role, is_active: true });
await page.evaluate(() => localStorage.clear());
await page.addInitScript(d => { window.__fnDb = d; }, {
  [KEY["wkm-explo"]]: [U("e0", "boss@can.co", "Boss", "super_admin"), U("e1", "ana@can.co", "Ana", "geologist"), U("e2", "vic@can.co", "Vic", "viewer")],
  [KEY["wkm-prod"]]: [U("p0", "boss@can.co", "Boss", "super_admin"), U("p1", "ana@can.co", "Ana", "site_admin")],
  [KEY["hub-prod"]]: [U("h0", "boss@can.co", "Boss", "super_admin")],
});
await page.evaluate(() => localStorage.setItem("opd_access", JSON.stringify({ v: 1, at: Date.now(), email: "boss@can.co", name: "Boss", ok: true, failures: [], projects: { "wkm-explo": { state: "ok", role: "super_admin" }, "wkm-prod": { state: "ok", role: "super_admin" }, "hub-prod": { state: "ok", role: "super_admin" } } })));
await page.goto(B + "/portal/admin/"); await page.waitForSelector("[data-user]");
ok((await page.textContent("[data-side-item='/portal/admin/']")).includes("Users"), "sidebar says Users");
ok((await page.textContent("h1")).trim() === "Users", "page title matches the menu label");
const tone = r => page.locator(`[data-role="${r}"]`).first().evaluate(e => getComputedStyle(e).backgroundColor);
const [tv, td, ts, tsa] = [await tone("viewer"), await tone("data_entry"), await tone("site_admin"), await tone("super_admin")];
ok(new Set([tv, td, tsa]).size === 3, "viewer, data entry and super admin pills each have their own colour");
ok(ts !== undefined && (await page.locator('[data-role="super_admin"]').count()) >= 1, "super admin pill is present");
ok((await page.textContent("#u-count")).includes("3 people"), "the list says how many people there are");
await page.fill("#u-search", "viewer"); await page.waitForTimeout(100);
ok((await page.locator("[data-user]").count()) === 1 && (await page.textContent("#u-count")).includes("1 of 3"), "search matches a role word and shows 1 of 3");
await page.click("#u-clear"); ok((await page.locator("[data-user]").count()) === 3 && (await page.inputValue("#u-search")) === "", "the clear button resets the search");
ok((await page.textContent("#u-refresh")).includes("Refresh list"), "button says Refresh list");
ok((await page.locator('[data-user="ana@can.co"] [data-manage]').textContent()).trim() === "Edit access", "row button says Edit access");
await page.click("#u-add"); await page.waitForSelector("#m-user");
ok((await page.textContent("#m-apply")).trim() === "Create user", "adding: the action says Create user");
const groups = await page.locator("#m-user form > fieldset legend").allTextContents();
ok(JSON.stringify(groups) === JSON.stringify(["Person", "Sign-in and role", "Access to projects"]), "dialog is grouped: Person, Sign-in and role, Access to projects");
const sp = await page.evaluate(() => {
  const form = document.querySelector("#m-user form"); const fs = document.querySelector("#m-user form > fieldset");
  return { between: parseFloat(getComputedStyle(form).rowGap), within: parseFloat(getComputedStyle(fs).rowGap) };
});
ok(sp.within < sp.between, `fields in a group sit closer (${sp.within}px) than groups (${sp.between}px)`);
await page.fill("#m-email", " NEW@Can.co "); ok((await page.inputValue("#m-email")) === "new@can.co", "dialog email mask");
await page.fill("#m-name", "Rina 99 O'Neil"); ok((await page.inputValue("#m-name")) === "Rina O'Neil", "name mask drops digits");
ok((await page.textContent("#m-pw-hint")).includes("10+"), "password hint states the minimum before typing");
await page.fill("#m-pw", "abcd"); ok((await page.textContent("#m-pw-hint")).includes("4 of 10, 6 more"), "password hint counts down");
await page.fill("#m-pw", "abcdefghij"); ok((await page.textContent("#m-pw-hint")).includes("long enough"), "password hint confirms when long enough");
ok((await page.textContent("#m-gen")).trim() === "Generate password", "button says Generate password");
await page.keyboard.press("Escape");
await page.locator('[data-user="ana@can.co"] [data-manage]').click(); await page.waitForSelector("#m-user");
ok((await page.textContent("#m-apply")).trim() === "Save changes", "editing: the action says Save changes");
await page.keyboard.press("Escape");

// ---- 9. motion: scroll reveal, page wipe, reduced motion ----
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 700 } });
  const m = await ctx.newPage(); const merr = []; m.on("pageerror", e => merr.push(e.message));
  await m.addInitScript(() => { window.__forceWipe = true; });
  await m.goto(B + "/tools/"); await m.waitForSelector("[data-sidebar]"); await m.waitForTimeout(300);
  const tagged = await m.locator("#main [data-reveal]").count();
  ok(tagged >= 2, `page blocks are tagged for reveal (${tagged})`);
  ok(await m.evaluate(() => document.querySelector("#main [data-reveal].is-in") !== null), "blocks in view have revealed");
  await m.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await m.waitForTimeout(900);
  ok(await m.evaluate(() => [...document.querySelectorAll("#main [data-reveal]")].every(e => e.classList.contains("is-in") || e.getBoundingClientRect().top > innerHeight)), "blocks reveal as you scroll to them");
  await m.evaluate(() => window.scrollTo(0, 0));
  // wipe: a sidebar link covers the screen, then navigates, then the panel lifts
  await m.click("[data-sidebar] a[href='/tools/calculators/']");
  await m.waitForTimeout(80);
  ok(await m.evaluate(() => document.getElementById("wipe").classList.contains("cover")), "following a link starts the page wipe");
  await m.waitForURL("**/tools/calculators/", { timeout: 4000 });
  await m.waitForSelector("#utm-zone", { timeout: 4000 });
  await m.waitForTimeout(900);
  ok(await m.evaluate(() => !document.documentElement.dataset.wipe && !document.getElementById("wipe").classList.contains("cover")), "the panel lifts off the next page");
  ok(await m.evaluate(() => getComputedStyle(document.getElementById("wipe")).pointerEvents === "none"), "the panel never blocks clicks after it lifts");
  // in-page anchor and skip link keep working
  ok(await m.evaluate(() => document.querySelector("a[href='#main']") !== null), "skip link still present");
  // the Exploration entry page: whatever is in view is visible (the app itself opts out with data-no-motion)
  await m.goto(B + "/explo/"); await m.waitForTimeout(1800);
  ok(await m.evaluate(() => [...document.querySelectorAll("[data-reveal]:not(.is-in)")].every(e => e.getBoundingClientRect().top > innerHeight)), "Exploration entry page: nothing in view is left hidden");
  ok(merr.length === 0, "motion: no page errors" + (merr.length ? ": " + merr[0] : ""));
  await ctx.close();
  // reduced motion: everything visible at once, no wipe
  const rctx = await browser.newContext({ viewport: { width: 1280, height: 700 }, reducedMotion: "reduce" });
  const r = await rctx.newPage(); await r.addInitScript(() => { window.__forceWipe = true; });
  await r.goto(B + "/tools/"); await r.waitForSelector("[data-sidebar]"); await r.waitForTimeout(300);
  ok(await r.evaluate(() => document.querySelectorAll("[data-reveal]").length === 0 && !document.documentElement.classList.contains("js-motion")), "reduced motion: nothing is hidden for reveal");
  await r.click("[data-sidebar] a[href='/tools/calculators/']");
  await r.waitForURL("**/tools/calculators/", { timeout: 2000 });
  ok(true, "reduced motion: link navigates at once");
  await rctx.close();
}

// ---- 8. phone: nothing breaks ----
await page.setViewportSize({ width: 390, height: 800 }); await page.goto(B + "/tools/calculators/"); await page.waitForSelector("#utm-zone");
ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "calculators fit a phone");
ok(await page.locator("#b-search").isVisible(), "page search is reachable on a phone");
await page.click("#b-search"); await page.waitForSelector("[cmdk-input]"); ok(true, "page search opens on a phone"); await page.keyboard.press("Escape");

ok(errs.length === 0, "no page errors" + (errs.length ? ": " + errs[0] : ""));
await browser.close(); server.close();
console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
