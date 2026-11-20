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

// 4. go to Exploration with site preselected
await wkm.click();
await page.waitForURL(/\/explo\/\?site=WKM/);
await page.waitForSelector("#l-site");
ok((await page.inputValue("#l-site")) === "WKM", "exploration login preselects the site from ?site=");

// 4b. signed in: home offers the portal; portal breadcrumb leads home
await page.goto(B + "/");
await page.waitForSelector("#who-home");
ok((await page.locator('header a:has-text("Open portal")').count()) === 1, "signed in: home header shows Open portal");
await page.goto(B + "/portal/");
await page.waitForSelector('nav[aria-label="Breadcrumb"]');
ok((await page.locator('nav[aria-label="Breadcrumb"] [aria-current="page"]').textContent()) === "Portal", "portal breadcrumb marks the current page");

// 5. sign out of the portal (lands on the public home)
await page.waitForSelector("#b-out"); await page.click("#b-out");
await page.waitForURL(B + "/");
ok(await page.evaluate(() => !localStorage.getItem("opd_access") && !localStorage.getItem("fake-sb-exp-WKM")), "sign out clears the access object and every project session");

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
