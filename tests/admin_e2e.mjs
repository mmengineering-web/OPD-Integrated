// Browser test of the all-sites Dashboard and the Super Admin user page against the stub build. Run: node tests/admin_e2e.mjs (after npm run build:test)
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
await new Promise(res => server.listen(4174, res));
const B = "http://localhost:4174";
let fail = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fail++; };
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await (await browser.newContext()).newPage();
const errs = []; page.on("pageerror", e => errs.push(e.message));
// Google Looker frames are not reachable from the sandbox; the test only checks the frame address.
await page.route("https://datastudio.google.com/**", r => r.fulfill({ status: 200, contentType: "text/html", body: "<p>report</p>" }));

const KEY = { "wkm-explo": "fake-sb-exp-WKM", "cdsm-explo": "fake-sb-exp-CDSM", "wkm-prod": "fake-sb-opd-wkm-prod", "hub-prod": "fake-sb-opd-hub-prod", "bm-prod": "fake-sb-opd-bm-prod" };
const setAccess = p => page.evaluate(p => localStorage.setItem("opd_access", JSON.stringify({ v: 1, at: Date.now(), email: "boss@can.co", name: "Boss", projects: p, ok: true, failures: [] })), p);
const seed = db => page.addInitScript(d => { window.__fnDb = d; }, db);
const U = (id, email, name, role) => ({ user_id: id, email, full_name: name, role, is_active: true });
await page.goto(B + "/login/"); await page.waitForSelector("#l-email");

// ---- Dashboard: Hub production accounts only ----
await setAccess({ "bm-prod": { state: "ok", role: "viewer" } });
await page.goto(B + "/production/dashboard/"); await page.waitForSelector("#denied");
ok((await page.textContent("#denied")).includes("Head Office production"), "site-only production account is denied on the all-sites dashboard");
await setAccess({ "hub-prod": { state: "ok", role: "viewer" } });
await page.goto(B + "/production/dashboard/"); await page.waitForSelector("#dash-frame");
ok((await page.getAttribute("#dash-frame", "src")).includes("0063a62c-4550-4b4d-aaeb-b2e59c6c3914"), "Hub production account sees the Production report");
await page.click('[data-report="management"]');
ok((await page.getAttribute("#dash-frame", "src")).includes("0fc8101a-d0f7-40ed-86fa-7ad0115343d9"), "switching to the Management report changes the frame");
ok((await page.getAttribute("#open-live", "href")).startsWith("https://lookerstudio.google.com/reporting/0fc8101a"), "open-in-new-tab follows the report");
ok((await page.getAttribute("#open-live", "rel")).includes("noopener"), "external link uses noopener");
await setAccess({ "hub-explo": { state: "ok", role: "viewer" } });
await page.goto(B + "/production/dashboard/"); await page.waitForSelector("#denied");
ok(true, "Explo Hub account is not enough for the production dashboard");

// ---- Admin page access ----
await setAccess({ "wkm-prod": { state: "ok", role: "site_admin" } });
await page.goto(B + "/portal/admin/"); await page.waitForSelector("#denied");
ok((await page.textContent("#denied")).includes("super admin"), "site admin cannot open user administration");
await page.goto(B + "/portal/"); await page.waitForSelector("[data-sidebar]");
ok(await page.locator('[data-side-item="/portal/admin/"] .sr-only').count() === 1, "sidebar shows a lock on User administration for a non-super account");

// ---- Admin page ----
const SUPER = { "wkm-explo": { state: "ok", role: "super_admin" }, "wkm-prod": { state: "ok", role: "super_admin" }, "hub-prod": { state: "ok", role: "super_admin" }, "bm-prod": { state: "ok", role: "site_admin" } };
await setAccess(SUPER);
await seed({
  [KEY["wkm-explo"]]: [U("e0", "boss@can.co", "Boss", "super_admin"), U("e1", "ana@can.co", "Ana", "geologist")],
  [KEY["wkm-prod"]]: [U("p0", "boss@can.co", "Boss", "super_admin"), U("p1", "ana@can.co", "Ana", "viewer")],
  [KEY["hub-prod"]]: [U("h0", "boss@can.co", "Boss", "super_admin")],
});
await page.goto(B + "/portal/admin/"); await page.waitForSelector("[data-user]");
ok((await page.locator("[data-user]").count()) === 2, "matrix lists two people");
ok((await page.textContent('[data-user="ana@can.co"] [data-cell="wkm-explo"]')).includes("Data entry"), "geologist shows as Data entry");
ok((await page.textContent('[data-user="ana@can.co"] [data-cell="hub-prod"]')).includes("–"), "no account shows a dash");
ok((await page.locator("#u-table thead th").count()) >= 9, "table has the project columns");
await page.fill("#u-search", "ana"); ok((await page.locator("[data-user]").count()) === 1, "search filters by name or email"); await page.fill("#u-search", "");
// sidebar: no lock for a super admin
ok(await page.locator('[data-side-item="/portal/admin/"][aria-current="page"]').count() === 1, "sidebar marks User administration as the current page");

// add user: validation, plan, apply
await page.click("#u-add"); await page.waitForSelector("#m-user");
ok(await page.locator("#m-apply").isDisabled(), "Apply is disabled until the form is valid");
ok(await page.locator('[data-proj="bm-prod"]').isDisabled(), "a project where you are only site admin cannot be ticked");
await page.fill("#m-email", "Rina@can.co"); await page.fill("#m-name", "Rina"); await page.selectOption("#m-role", "data_entry");
await page.click("#m-gen"); const pw = await page.inputValue("#m-pw");
ok(pw.length === 16, "Generate fills a 16-character password");
await page.check('[data-proj="wkm-explo"]'); await page.check('[data-proj="wkm-prod"]');
ok((await page.locator("#m-plan [data-plan]").count()) === 2, "plan lists one create step per ticked project");
ok(await page.locator("#m-apply").isEnabled(), "Apply is enabled");
await page.fill("#m-pw", "short"); ok(await page.locator("#m-apply").isDisabled(), "a short password blocks Apply"); await page.fill("#m-pw", pw);
await page.evaluate(() => { window.__fnFail = { "fake-sb-opd-wkm-prod": "Email address already registered" }; });
await page.click("#m-apply"); await page.waitForSelector("#m-summary");
ok((await page.locator('#m-result [data-step="wkm-explo:create"]').getAttribute("data-status")) === "ok", "exploration create succeeded");
ok((await page.locator('#m-result [data-step="wkm-prod:create"]').getAttribute("data-status")) === "failed" && (await page.textContent("#m-result")).includes("already registered"), "a failure in one project is shown with the server message");
ok((await page.locator("#m-pwbox").count()) === 1 && (await page.textContent("#m-pwtext")) === pw, "password is shown once after creating");
let log = await page.evaluate(() => window.__fnLog);
const c = log.find(l => l[1] === "exp-admin-users" && l[2].action === "create");
ok(c && c[2].email === "rina@can.co" && c[2].role === "geologist" && c[2].full_name === "Rina" && c[2].password === pw, "exploration project got email (lowercase), name, role geologist and the password");
await page.click("#m-close"); await page.waitForSelector("[data-user]");
ok((await page.locator('[data-user="rina@can.co"]').count()) === 1, "list refreshes after applying");
ok((await page.textContent('[data-user="rina@can.co"] [data-cell="wkm-explo"]')).includes("Data entry"), "new account appears in the Exploration column");

// op function: success path and role payload
await page.evaluate(() => { window.__fnFail = {}; window.__fnLog = []; });
await page.locator('[data-user="rina@can.co"] [data-manage]').click(); await page.waitForSelector("#m-user");
await page.check('[data-proj="wkm-prod"]'); await page.check('[data-proj="hub-prod"]'); await page.selectOption("#m-role", "site_admin");
await page.fill("#m-pw", "another-pass-123");
await page.click("#m-apply"); await page.waitForSelector("#m-summary");
log = await page.evaluate(() => window.__fnLog);
ok(log.some(l => l[1] === "op-admin-users" && l[2].action === "create" && l[2].role === "site_admin"), "production and hub projects go through op-admin-users");
ok(log.some(l => l[1] === "rpc" && l[2].p_role === "site_admin"), "exploration role change uses exp_admin_upsert_profile");
ok(log.some(l => l[1] === "exp-admin-users" && l[2].action === "reset_password"), "a typed password resets it in existing projects");
await page.click("#m-close");

// manage: unticking needs the confirmation, then deletes
await page.locator('[data-user="rina@can.co"] [data-manage]').click(); await page.waitForSelector("#m-user");
await page.uncheck('[data-proj="hub-prod"]');
ok(await page.locator("#m-apply").isDisabled(), "removing a project is blocked until confirmed");
await page.check("#m-confirm"); ok(await page.locator("#m-apply").isEnabled(), "confirmation enables Apply");
await page.click("#m-apply"); await page.waitForSelector("#m-summary");
ok((await page.locator('[data-step="hub-prod:delete"]').getAttribute("data-status")) === "ok", "unticked project deletes the account there");
await page.click("#m-close");

// delete everywhere + guards
await page.locator('[data-user="rina@can.co"] [data-delete]').click(); await page.waitForSelector("#m-delete");
ok(await page.locator("#d-apply").isDisabled(), "delete everywhere needs the confirmation");
await page.check("#d-confirm"); await page.click("#d-apply"); await page.waitForSelector("#d-close"); await page.click("#d-close");
await page.waitForSelector("[data-user]");
ok((await page.locator('[data-user="rina@can.co"]').count()) === 0, "person disappears after delete everywhere");
await page.locator('[data-user="boss@can.co"] [data-delete]').click(); await page.waitForSelector("#m-delete");
ok((await page.locator("#m-delete [data-plan-error]").first().textContent()).includes("own account"), "you cannot delete yourself");
await page.keyboard.press("Escape"); await page.waitForSelector("#m-delete", { state: "detached" });
ok(true, "Escape closes the dialog");

// a project whose function is not deployed shows a banner, the others still load
await page.addInitScript(() => { window.__fnDown = { "fake-sb-opd-hub-prod": true }; });
await page.reload(); await page.waitForSelector("[data-user]");
ok((await page.locator('[data-err="hub-prod"]').count()) === 1, "an unreachable project is listed in the warning banner");
ok((await page.locator("[data-user]").count()) >= 1, "other projects still load");

// phone: the table scrolls inside its card, not the page
await page.setViewportSize({ width: 390, height: 800 }); await page.waitForTimeout(300);
ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no horizontal page overflow on a phone");

ok(errs.length === 0, "no page errors" + (errs.length ? ": " + errs[0] : ""));
await browser.close(); server.close();
console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
