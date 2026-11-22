// Browser test of the portal flow against the stub build (npm run build:test). Run: node tests/opd_e2e.mjs
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { createRequire } from "node:module";
const require = createRequire("/opt/npm-tools/node_modules/");
const { chromium } = require("playwright");

const ROOT = "out-test";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".txt": "text/plain", ".ico": "image/x-icon" };
const server = http.createServer((q, r) => {
  let p = decodeURIComponent(new URL(q.url, "http://x").pathname);
  let f = join(ROOT, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, "index.html");
  if (!existsSync(f)) { r.writeHead(404); return r.end("nf"); }
  r.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" }); r.end(readFileSync(f));
});
await new Promise(res => server.listen(4173, res));
const B = "http://localhost:4173";

let fail = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fail++; };
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", e => errs.push(e.message));

// 0. public home: hero, Log in and Get started, no forced redirect
await page.goto(B + "/");
await page.waitForSelector("h1");
ok(/one login/i.test(await page.textContent("h1")), "home shows the hero without signing in");
ok((await page.locator('#n-login').getAttribute("href")) === "/login/", "Log in goes to /login/");
ok((await page.locator('header a:has-text("Get started")').count()) === 1, "Get started button is in the header");
ok(page.url() === B + "/", "home does not redirect when signed out");
await page.locator(".land-dots button").nth(0).click(); await page.waitForTimeout(400);
ok((await page.locator(".land-card[data-on]").getAttribute("data-id")) === "explo", "card deck: dot selects the Exploration card");
await page.locator('.land-card[data-id="prod"]').click({ force: true }); await page.waitForTimeout(400);
ok((await page.locator(".land-card[data-on]").getAttribute("data-id")) === "prod", "card deck: tapping a side card brings it forward");

// 1. portal without access -> login with next
await page.goto(B + "/portal/");
await page.waitForURL(/\/login\//);
ok(/next=%2Fportal%2F|next=\/portal\//.test(page.url()), "portal without access redirects to /login/?next=/portal/");
ok((await page.locator('nav[aria-label="Breadcrumb"]').textContent()).includes("Home"), "login shows a Home breadcrumb");

// 2. wrong password
await page.fill("#l-email", "geo@can.test"); await page.fill("#l-pw", "bad"); await page.click("#l-go");
await page.waitForSelector("#l-msg");
ok(/wrong|no account/i.test(await page.textContent("#l-msg")), "wrong password shows an error and stays on login");

// 3. good login (the stub accepts the password "good"), hostile next is ignored
await page.goto(B + "/login/?next=//evil.com");
await page.fill("#l-email", "geo@can.test"); await page.fill("#l-pw", "good"); await page.click("#l-go");
await page.waitForURL(B + "/portal/");
ok(true, "open-redirect next is ignored, lands on the portal");
await page.waitForSelector("#who");
ok((await page.textContent("#who")).includes("geo@can.test") || (await page.textContent("#who")).length > 3, "home shows who is signed in");
const wkm = await page.locator('[data-module="wkm-explo"]').first();
ok((await wkm.evaluate(e => e.tagName)) === "A", "WKM exploration is a link (usable)");
const cdsm = await page.locator('[data-module="cdsm-explo"]').first();
ok((await cdsm.evaluate(e => e.tagName)) === "A", "CDSM exploration is a link (usable)");
ok((await page.locator('[data-tile="BM"] [aria-disabled]').count()) === 2, "BM tiles are greyed (no profile in the stub)");
const acc = await page.evaluate(() => JSON.parse(localStorage.getItem("opd_access")));
ok(acc.ok && acc.projects["wkm-explo"].state !== "unconfigured" && acc.projects["wkm-prod"].state === "noprofile", "access object saved; production project signed in but has no profile (stub)");
ok(await page.evaluate(() => !!localStorage.getItem("fake-sb-exp-WKM")), "WKM session stored under the standalone key sb-exp-WKM");

// 4. Phase 2: Exploration opens on the portal session (no second login), site preselected from ?site=
await wkm.click();
await page.waitForURL(/\/explo\/\?site=WKM/);
await page.waitForSelector("#sync-chip");
ok((await page.locator("#l-site").count()) === 0, "exploration opens without a second login");
ok((await page.textContent("body")).includes("WKM"), "exploration opened on the WKM site");
ok((await page.locator('nav[aria-label="Breadcrumb"] a[href="/portal/"]').count()) === 1 && (await page.locator('nav[aria-label="Breadcrumb"] [aria-current="page"]').textContent()) === "WKM", "Portal > Exploration > site breadcrumb in the header");
ok((await page.locator("#site-switch option").count()) === 2, "site switcher lists the sites the portal allows");
await page.selectOption("#site-switch", "CDSM");
await page.waitForURL(/\/explo\/\?site=CDSM/);
await page.waitForFunction(() => document.querySelector("#site-switch")?.value === "CDSM");
ok(await page.evaluate(() => JSON.parse(localStorage.getItem("exp_session") || "{}").site === "CDSM"), "switching sites re-attaches the CDSM session");
await page.selectOption("#site-switch", "WKM");
await page.waitForFunction(() => document.querySelector("#site-switch")?.value === "WKM");
// reload keeps the site and still needs no login
await page.reload(); await page.waitForSelector("#sync-chip");
ok((await page.locator("#l-site").count()) === 0, "reload stays signed in via the portal session");

// 4b. signed in: home offers the portal; portal breadcrumb leads home
await page.goto(B + "/");
await page.waitForSelector("#who-home");
ok((await page.locator('header a:has-text("Open portal")').count()) === 1, "signed in: home header shows Open portal");
await page.goto(B + "/portal/");
await page.waitForSelector('nav[aria-label="Breadcrumb"]');
ok((await page.locator('nav[aria-label="Breadcrumb"] [aria-current="page"]').textContent()) === "Portal", "portal breadcrumb marks the current page");

// 4c. main menu: six pages, each reachable, active item marked, content renders
const NAVS = [["home", "Home", "/portal/"], ["production", "Production", "/production/"], ["explo", "Exploration", "/explo/"], ["documents", "Documents", "/documents/"], ["tools", "Mining Tools", "/tools/"], ["help", "Help", "/help/"]];
await page.setViewportSize({ width: 1200, height: 800 });
await page.goto(B + "/portal/"); await page.waitForSelector('header nav[aria-label="Main"]');
ok(JSON.stringify(await page.locator('header nav[aria-label="Main"] a').allTextContents()) === JSON.stringify(NAVS.map(n => n[1])), "menu lists Home, Production, Exploration, Documents, Mining Tools, Help");
for (const [key, label, path] of NAVS.filter(n => n[0] !== "explo")) {
  await page.goto(B + path); await page.waitForSelector('header nav[aria-label="Main"]');
  ok((await page.locator('header nav[aria-label="Main"] [aria-current="page"]').textContent()) === label, `${path}: ${label} is the active menu item`);
}
await page.goto(B + "/production/"); await page.waitForSelector('[data-tile="WKM"]');
ok((await page.locator('[data-tile="WKM"]').count()) === 1, "production lists the sites");
await page.goto(B + "/documents/"); await page.waitForSelector("[data-shelf]");
ok((await page.locator("[data-shelf]").count()) === 6, "documents shows the six shelves");
await page.goto(B + "/help/"); await page.waitForSelector("[data-faq] details");
await page.locator("[data-faq] summary").first().click();
ok(await page.locator("[data-faq] details").first().evaluate(e => e.open), "help: a question opens");
await page.goto(B + "/tools/"); await page.waitForSelector("#utm-a");
await page.fill("#utm-a", "500000"); await page.fill("#utm-b", "9500000"); await page.fill("#utm-zone", "51");
ok((await page.textContent("#utm-o2")) === "123.000000", "tools: UTM on the central meridian gives longitude 123");
await page.fill("#t-vol", "1000");
ok((await page.textContent("#t-wet")) === "1,600.0" && (await page.textContent("#t-dry")) === "1,120.0", "tools: 1000 bcm x 1.6 t/m3 = 1,600 wet t, 1,120 dry t at 30% moisture");
await page.setViewportSize({ width: 390, height: 800 });
await page.goto(B + "/help/"); await page.waitForSelector('header nav[aria-label="Main"]:visible');
ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), "phone width: menu does not widen the page");
await page.setViewportSize({ width: 1200, height: 800 });
await page.click('header a[data-nav="explo"]'); await page.waitForURL(/\/explo\//); await page.waitForSelector("#sync-chip");
ok((await page.locator('main nav[aria-label="Main"] [aria-current="page"]').textContent()) === "Exploration", "Exploration shows the same menu with Exploration active");

// 5. sign out of the portal (lands on the public home)
await page.goto(B + "/portal/"); await page.waitForSelector("#b-out"); await page.click("#b-out");
await page.waitForURL(B + "/");
ok(await page.evaluate(() => !localStorage.getItem("opd_access") && !localStorage.getItem("fake-sb-exp-WKM") && !localStorage.getItem("exp_session")), "sign out clears the access object, every project session and the Exploration session");

// 5b. signed out: a deep link goes to login and comes back to that page
await page.goto(B + "/tools/"); await page.waitForURL(/\/login\/\?next=%2Ftools%2F/);
ok(true, "signed out: /tools/ redirects to login with next");

// 6. legacy standalone session goes straight to Exploration
await page.evaluate(() => localStorage.setItem("exp_session", JSON.stringify({ site: "WKM", email: "a@b.c", name: "A", role: "geologist", role_label: "G", can_write: true, can_admin: false, can_super: false })));
await page.goto(B + "/");
await page.waitForURL(/\/explo\//);
ok(true, "phone with the old Exploration login is sent to /explo/ (no forced re-login)");
await page.evaluate(() => localStorage.clear());

// 7. offline: service worker serves every page
await page.goto(B + "/login/"); await page.goto(B + "/explo/");
await page.evaluate(() => navigator.serviceWorker.ready.then(() => 1));
await page.reload(); await page.waitForTimeout(500);
await ctx.setOffline(true);
for (const path of ["/login/", "/explo/", "/portal/", "/"]) {
  await page.goto(B + path).catch(() => {});
  await page.waitForTimeout(400);
  const body = await page.textContent("body");
  ok(body.length > 20 && !/ERR_|offline.*chrome/i.test(body), `offline: ${path} still loads`);
}
await ctx.setOffline(false);

ok(errs.length === 0, "no page errors" + (errs.length ? ": " + errs.join(" | ") : ""));
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
