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
await page.waitForSelector("[data-sidebar]");
ok((await page.locator("header nav").count()) === 0, "no top menu: the sidebar is the navigation");
ok(JSON.stringify(await page.locator("[data-sidebar] [data-side-section]").evaluateAll(a => a.map(x => x.getAttribute("data-side-section")))) === JSON.stringify(["home", "portal", "production", "explo", "documents", "tools", "help"]), "sidebar lists Home, Portal, Production, Exploration, Documents, Mining Tools, Help");
ok((await page.locator('[data-sidebar] [data-side-section="home"]').getAttribute("aria-current")) === "page", "sidebar: Home is the current page");
await page.waitForSelector("h1");
ok(/one login/i.test(await page.textContent("h1")), "home shows the hero without signing in");
ok((await page.locator('#b-login').getAttribute("href")).startsWith("/login/"), "Log in goes to /login/");
ok((await page.locator('[data-sidebar]').count()) === 1, "public home has the sidebar too");
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
ok((await page.locator('nav[aria-label="Breadcrumb"] a[href="/exploration/"]').count()) === 1 && (await page.locator('nav[aria-label="Breadcrumb"] [aria-current="page"]').textContent()) === "Drilling Progress", "Home > Exploration > Field Data Entry > tab breadcrumb");
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
await page.waitForSelector("#who");
ok((await page.locator('header #b-portal').count()) === 1 && (await page.locator('header #b-out').count()) === 1, "signed in: home header shows Portal and Sign out");
await page.goto(B + "/portal/");
await page.waitForSelector('nav[aria-label="Breadcrumb"]');
ok((await page.locator('nav[aria-label="Breadcrumb"] [aria-current="page"]').textContent()) === "Portal", "portal breadcrumb marks the current page");

// 4c. main menu on every page; each menu item is a public landing page
const NAVS = [["home", "Home", "/"], ["production", "Production", "/production/"], ["explo", "Exploration", "/exploration/"], ["documents", "Documents", "/documents/"], ["tools", "Tools", "/tools/"], ["help", "Help", "/help/"]];
await page.setViewportSize({ width: 1200, height: 800 });
await page.goto(B + "/portal/"); await page.waitForSelector("[data-sidebar]");
for (const [key, label, path] of NAVS.filter(n => n[0] !== "home")) {
  await page.goto(B + path); await page.waitForSelector("[data-sidebar] [aria-current=page], [data-sidebar] [aria-expanded=true]");
  ok((await page.locator(`[data-sidebar] [data-side-section="${key}"]`).count()) === 1 && (await page.locator("[data-sidebar] [aria-current=page]").count()) >= 1, `${path}: ${label} is open in the sidebar`);
}
await page.goto(B + "/production/"); await page.waitForSelector("[data-card]");
ok((await page.locator("[data-card]").allTextContents()).length === 3, "production landing has Dashboard, Uploads, Guides");
await page.goto(B + "/exploration/"); await page.waitForSelector("[data-card]");
ok((await page.locator('[data-card="Data Entry"]').getAttribute("href")) === "/explo/", "exploration landing links to the field entry app");
await page.goto(B + "/documents/"); await page.waitForSelector("[data-card]");
ok((await page.locator("[data-card]").count()) === 3, "documents landing has Reports, SOPs, Templates");
await page.goto(B + "/tools/"); await page.waitForSelector("[data-card]");
ok((await page.locator("[data-card]").count()) === 5 && (await page.locator('a[data-card]').count()) === 2, "tools landing: 5 tools, the calculators and the HPM calculator are open");
await page.goto(B + "/tools/calculators/"); await page.waitForSelector("#utm-a");
await page.fill("#utm-a", "500000"); await page.fill("#utm-b", "9500000"); await page.fill("#utm-zone", "51");
ok((await page.textContent("#utm-o2")) === "123.000000", "calculators: UTM on the central meridian gives longitude 123");
await page.fill("#t-vol", "1000");
ok((await page.textContent("#t-wet")) === "1,600.0" && (await page.textContent("#t-dry")) === "1,120.0", "calculators: 1000 bcm x 1.6 = 1,600 wet t, 1,120 dry t at 30% moisture");
// HPM nickel calculator: the live sheet is blocked so the built-in table is used
await page.route("https://docs.google.com/**", r => r.abort());
await page.goto(B + "/tools/hpm-nickel/"); await page.waitForSelector("#hpm-out");
ok((await page.textContent("#hpm-out")) === "77.63", "HPM: saprolite default (Ni 1.8, Sep 2026 period 2, 30% MC) gives 77.63 USD/WMT");
ok((await page.textContent("#hpm-label")).includes("September 2026") && (await page.textContent("#hpm-source")) === "Built-in table", "HPM: opens on the latest period from the built-in table when the sheet is unreachable");
ok((await page.textContent("#hpm-cf")) === "32.0%", "HPM: nickel CF at 1.8% Ni is 32%");
await page.click('[data-seg="limonite"]');
ok((await page.textContent("#hpm-out")) === "25.64" && (await page.textContent("#hpm-t-co")) === "17%", "HPM: limonite (Ni 0.9, low segment) gives 25.64 with cobalt CF 17%");
await page.click('[data-seg="expert"]'); await page.fill("#hpm-fe", "40");
ok((await page.textContent("#hpm-r-fe")) === "0.00 USD", "HPM: Fe above 35% is left out");
await page.fill("#hpm-mc", "");
ok((await page.locator("#hpm-err").count()) === 1 && (await page.textContent("#hpm-out")) === "–", "HPM: an empty field shows an error and no result");
await page.fill("#hpm-mc", "35"); await page.selectOption("#hpm-month", "Juli 2026");
ok((await page.inputValue("#hpm-h-nikel")) === "17593.33", "HPM: choosing a period fills the HMA prices");
const dl = page.waitForEvent("download"); await page.click("#hpm-pdf");
ok((await dl).suggestedFilename().startsWith("HPM_Nickel_Juli_2026"), "HPM: the PDF downloads");
await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(400);
ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), "HPM: no sideways scroll on a phone");
await page.setViewportSize({ width: 1200, height: 800 });
await page.goto(B + "/help/"); await page.waitForSelector("[data-faq] details");
await page.locator("[data-faq] summary").first().click();
ok(await page.locator("[data-faq] details").first().evaluate(e => e.open), "help: a question opens");
await page.setViewportSize({ width: 390, height: 800 });
await page.goto(B + "/production/"); await page.waitForSelector("#b-menu");
ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), "phone width: menu does not widen the page");
await page.setViewportSize({ width: 1200, height: 800 });

// 4c2. analysis pages live in the OPD Exploration section, with a site picker based on the person's access
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(B + "/exploration/dashboard/"); await page.waitForSelector("#site-pick");
ok((await page.locator('#site-pick [data-site]').count()) === 2, "analysis page: the picker lists only the two sites this account can open");
await page.waitForSelector("#dash, #site-failed", { timeout: 25000 });
ok((await page.locator("#dash").count()) === 1, "Dashboard renders in the Exploration section");
await page.locator('#site-pick label:has([data-site="CDSM"])').click();
await page.waitForFunction(() => document.querySelector("#site-now")?.textContent?.includes("CDSM"));
await page.waitForSelector("#dash, #site-failed", { timeout: 25000 });
ok((await page.locator("#dash").count()) === 1 && (await page.locator("#site-failed").count()) === 0, "switching the site reloads the Dashboard for that site");
await page.goto(B + "/exploration/data-qc/"); await page.waitForSelector("#qc", { timeout: 25000 });
ok(true, "Data QC renders in the Exploration section");
await page.goto(B + "/exploration/3d-hole/"); await page.waitForSelector("#d3-view", { timeout: 25000 });
ok(true, "3D Hole renders in the Exploration section");
await page.goto(B + "/exploration/maps/"); await page.waitForSelector("#map", { timeout: 25000 });
ok(true, "Map renders in the Exploration section");
await page.goto(B + "/explo/?site=WKM"); await page.waitForSelector("#sync-chip");
ok((await page.locator("aside button[data-t=dash], aside button[data-t=qc], aside button[data-t=map], aside button[data-t=d3]").count()) === 0, "Field Data Entry no longer has the Analisis tabs");
ok((await page.locator("aside button[data-t=progress]").count()) === 1, "Field Data Entry still has the input tabs");

// 4d. access check on pages that show data (the stub login gives this person exploration accounts only)
const setAccess = projects => page.evaluate(p => localStorage.setItem("opd_access", JSON.stringify({ v: 1, at: Date.now(), email: "geo@can.test", name: "Test User", projects: p, ok: true, failures: [] })), projects);
await setAccess({ "wkm-explo": { state: "ok", role: "data_entry" }, "wkm-prod": { state: "invalid" } });
await page.goto(B + "/production/dashboard/"); await page.waitForSelector("#denied");
ok((await page.textContent("#denied")).includes("You don't have access to this page"), "signed in without a production account: \"You don't have access to this page\"");
ok((await page.locator("#denied a", { hasText: "Back to Production" }).count()) === 1, "access-denied page offers a way back");
await page.goto(B + "/exploration/maps/"); await page.waitForSelector("#site-pick");
ok((await page.locator('#site-pick [data-site]').count()) === 1 && (await page.locator('#site-pick [data-site="WKM"]').count()) === 1 && (await page.locator("#denied").count()) === 0, "exploration analysis page opens with an exploration account and offers only that site");
await page.goto(B + "/documents/reports/"); await page.waitForSelector("[data-access]");
ok((await page.locator("#denied").count()) === 0, "documents open for any signed-in account");
await setAccess({ "bm-prod": { state: "ok", role: "viewer" } });
await page.goto(B + "/production/data-inputs/"); await page.waitForSelector("[data-access]");
ok((await page.locator('[data-project="bm-prod"]').count()) === 1, "production page opens with a production account");
await page.goto(B + "/exploration/request-data/"); await page.waitForSelector("#denied");
ok(true, "production-only account is denied on an exploration page");
// signed out: the data page goes to the OPD login (not the Exploration login), and comes back after sign-in
await page.evaluate(() => localStorage.removeItem("opd_access"));
await page.goto(B + "/production/dashboard/"); await page.waitForURL(/\/login\/\?next=%2Fproduction%2Fdashboard%2F/);
ok((await page.locator("#l-email").count()) === 1 && (await page.locator("#l-site").count()) === 0, "signed out: data page goes to the OPD login");
await page.goto(B + "/production/"); await page.waitForSelector("[data-card]");
ok(page.url().endsWith("/production/"), "signed out: the landing page itself stays open");
await page.goto(B + "/login/?next=%2Fproduction%2Fdashboard%2F");
await page.fill("#l-email", "geo@can.test"); await page.fill("#l-pw", "good"); await page.click("#l-go");
await page.waitForURL(/\/production\/dashboard\//);
await page.waitForSelector("#denied, [data-access]");
ok(true, "after sign-in it returns to the page that was asked for");
// 4e. sidebar: all sections, current one open, locks follow the account, phone drawer
await setAccess({ "wkm-explo": { state: "ok", role: "data_entry" }, "wkm-prod": { state: "invalid" } });
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(B + "/exploration/maps/"); await page.waitForSelector("[data-sidebar]");
const side = page.locator("[data-sidebar]");
ok((await side.locator("[data-side-section]").count()) === 7, "sidebar lists Home, Portal and the five sections");
ok((await side.locator('[data-side-item="/exploration/maps/"]').getAttribute("aria-current")) === "page", "sidebar marks the current page");
ok((await side.locator('[data-side-section="production"] [data-side-item]').count()) === 0, "sidebar keeps other sections closed");
await side.locator('[data-side-section="production"] button').click();
ok((await side.locator('[data-side-item="/production/dashboard/"] .sr-only').textContent()).includes("can't open"), "production pages show a lock for an exploration-only account");
ok((await side.locator('[data-side-item="/exploration/request-data/"] .sr-only').count()) === 0, "exploration pages show no lock for an exploration account");
await side.locator('[data-side-item="/production/dashboard/"]').click(); await page.waitForSelector("#denied");
ok(true, "a locked sidebar link still opens the access message");
await page.setViewportSize({ width: 390, height: 800 });
await page.goto(B + "/documents/"); await page.waitForSelector("#b-menu");
ok(!(await page.locator("[data-sidebar]").isVisible()), "phone: the sidebar is hidden");
await page.click("#b-menu"); await page.waitForSelector("[data-drawer] [data-side-item]");
ok((await page.locator("[data-drawer] [aria-modal=true]").count()) === 1, "phone: the menu opens as a dialog");
await page.keyboard.press("Escape");
ok((await page.locator("[data-drawer]").count()) === 0, "phone: Escape closes the menu");
await page.click("#b-menu"); await page.click('[data-drawer] [data-side-item="/documents/reports/"]'); await page.waitForURL(/\/documents\/reports\//);
ok(true, "phone: a drawer link goes to its page");
ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), "phone: no sideways scroll with the menu");
await page.setViewportSize({ width: 1200, height: 800 });

await page.goto(B + "/portal/");
await page.setViewportSize({ width: 1200, height: 800 });
await page.goto(B + "/explo/?site=WKM"); await page.waitForSelector("#sync-chip");
ok((await page.locator("[data-sidebar] [data-side-extra]").count()) === 1 && (await page.locator("header nav").count()) === 0, "Exploration app: sidebar navigation, no top menu");

// 4f. one layout everywhere: sentence-case menu, collapsible sidebar, same shell on Home and in the Exploration app
await page.setViewportSize({ width: 1400, height: 800 });
await page.goto(B + "/"); await page.waitForSelector("[data-sidebar]");
ok((await page.locator("[data-sidebar] a").first().evaluate(e => getComputedStyle(e).textTransform)) === "none", "sidebar labels are not in capitals");
ok((await page.locator("[data-sidebar] #b-collapse").count()) === 1 && (await page.locator("header #b-collapse").count()) === 0, "collapse button sits at the bottom of the sidebar");
const w1 = await page.locator("[data-sidebar]").evaluate(e => e.getBoundingClientRect().width);
await page.click("#b-collapse"); await page.waitForTimeout(450);
const w2 = await page.locator("[data-sidebar]").evaluate(e => e.getBoundingClientRect().width);
ok(w1 > 200 && w2 < 100, "sidebar collapses to an icon rail");
ok((await page.locator('[data-sidebar] [data-side-section="production"]').getAttribute("title")) === "Production", "collapsed rail keeps labels as tooltips");
await page.reload(); await page.waitForSelector("[data-sidebar]"); await page.waitForTimeout(450);
ok((await page.locator("[data-sidebar]").evaluate(e => e.getBoundingClientRect().width)) < 100, "collapsed state is remembered");
await page.goto(B + "/explo/?site=WKM"); await page.waitForSelector("#sync-chip"); await page.waitForTimeout(450);
ok((await page.locator("[data-sidebar] button[data-t=progress]").count()) === 1, "Exploration app: its tabs sit in the OPD sidebar (rail)");
await page.click("#b-collapse"); await page.waitForTimeout(450);
ok((await page.locator("[data-sidebar] [data-side-extra] button[data-t=collars]").count()) === 1 && (await page.locator('[data-sidebar] [data-side-item="/explo/"]').count()) === 1, "Exploration app: expanded sidebar nests the tabs under Field Data Entry");
ok((await page.locator("aside").count()) === 1, "Exploration app has one sidebar, the OPD one");
await page.goto(B + "/"); await page.waitForSelector('[data-module-card]');
ok(JSON.stringify(await page.locator("[data-module-card]").evaluateAll(a => a.map(x => x.getAttribute("data-module-card")))) === JSON.stringify(["Exploration", "Production", "Documents", "Tools", "Portal"]), "home lists Exploration, Production, Documents, Tools and Portal");
ok(!(await page.textContent("body")).includes("Three modules"), "home no longer says three modules");
await page.evaluate(() => localStorage.setItem("opd_side", "0"));

// 5. sign out of the portal (lands on the public home)
await page.goto(B + "/portal/"); await page.waitForSelector("#b-out"); await page.click("#b-out");
await page.waitForURL(B + "/");
ok(await page.evaluate(() => !localStorage.getItem("opd_access") && !localStorage.getItem("fake-sb-exp-WKM") && !localStorage.getItem("exp_session")), "sign out clears the access object, every project session and the Exploration session");

// 5b. after sign-out the public landing pages stay open and data pages ask for login again
await page.goto(B + "/tools/"); await page.waitForSelector("[data-card]");
ok(page.url().endsWith("/tools/"), "signed out: /tools/ landing opens without login");
await page.goto(B + "/documents/reports/"); await page.waitForURL(/\/login\/\?next=%2Fdocuments%2Freports%2F/);
ok(true, "signed out: /documents/reports/ redirects to the OPD login with next");

await page.goto(B + "/login/"); await page.waitForSelector("#lf");
ok((await page.locator('nav[aria-label="Main"]').count()) === 0 && (await page.locator('nav[aria-label="Breadcrumb"]').count()) === 1, "OPD login has no menu, only the breadcrumb");
// 5c. guest entry from the OPD login: pick the site, then straight into data entry (no Exploration login page)
await page.goto(B + "/login/"); await page.waitForSelector("#l-guest"); await page.click("#l-guest");
await page.waitForSelector("#guest-panel");
ok(await page.locator("#l-guest-go").isDisabled(), "guest entry: no site is preselected, the button stays off");
ok((await page.locator("#guest-panel [data-site]").count()) === 8, "guest entry: every site is a card");
await page.locator('#guest-panel label:has([data-site="CDSM"])').click();
ok((await page.locator("#l-guest-go").textContent()).includes("CDSM"), "guest entry: the button names the chosen site");
await page.click("#l-guest-go"); await page.waitForURL(/\/explo\/\?site=CDSM/);
await page.waitForSelector("#guest-strip");
ok((await page.locator("#lf").count()) === 0, "guest entry: opens data entry directly, not the Exploration login");
ok((await page.textContent("#site-chip")).includes("CDSM") && (await page.textContent("#guest-strip")).includes("CDSM"), "data entry shows the site in the header and in the offline strip");
await page.click("#b-change-site"); await page.waitForSelector("#lf");
ok((await page.locator("#l-email").count()) === 0 && (await page.locator("[data-sidebar]").count()) === 1, "start screen: no login form, site selection inside the OPD layout");
ok((await page.locator("#l-guest").textContent()).includes("offline"), "start screen: offers offline data entry");
ok((await page.locator("#l-portal").getAttribute("href")).includes("/login/?next="), "start screen: optional link to the OPD login");
ok((await page.locator("[data-site-picker] input:checked").getAttribute("data-site")) === "CDSM", "start screen: the site is a card picker and remembers the last site");
ok((await page.textContent("#site-banner")).includes("CDSM"), "start screen: a banner names the site the data will go to");
await page.evaluate(() => { localStorage.removeItem("exp_guest_site"); });

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
