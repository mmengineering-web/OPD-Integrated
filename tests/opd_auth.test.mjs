import test from "node:test";
import assert from "node:assert/strict";
import { PROJECTS as REAL } from "../src/lib/opd/config.js";
import { signInAll, buildPortalModel, safeNext, normalizeRole, canUseForm, classifyAuthError, unreachableProjects, hubRole, sessionKey, topRole, exploSites, pickExploSite, infoFromPortal } from "../src/lib/opd/auth-core.js";
import { readProfile } from "../src/lib/opd/profile.js";
import { createFakeBackend, DEMO_USERS } from "./opd_fake.mjs";

// The real config has empty production keys; tests fill every project so the whole fan-out is exercised.
const PROJECTS = REAL.map((p) => ({ ...p, url: "https://x.supabase.co", anonKey: "k" }));
const run = (backend, email, password, timeoutMs = 500, projects = PROJECTS) => signInAll({
  projects, email, password, timeoutMs, deps: { createClient: backend.createClient, readProfile },
});

test("config: exploration projects keep the standalone storage keys, production uses sb-opd-*", () => {
  assert.equal(sessionKey(REAL.find((p) => p.id === "wkm-explo")), "sb-exp-WKM");
  assert.equal(sessionKey(REAL.find((p) => p.id === "cdsm-explo")), "sb-exp-CDSM");
  assert.equal(sessionKey(REAL.find((p) => p.id === "wkm-prod")), "sb-opd-wkm-prod");
  assert.equal(REAL.length, 7);
  assert.ok(REAL.every((p) => p.url.startsWith("https://") && p.anonKey.startsWith("sb_publishable_")), "all 7 projects configured, publishable keys only");
});

test("fan-out: roles per project (geologist -> data_entry, hub admin -> site_admin)", async () => {
  const a = await run(createFakeBackend(), "demo@can.local", "demo-demo-123");
  assert.equal(a.ok, true);
  assert.equal(a.projects["wkm-prod"].role, "super_admin");
  assert.equal(a.projects["bm-prod"].role, "data_entry");
  assert.equal(a.projects["wkm-explo"].role, "data_entry");
  assert.equal(a.projects["hub-explo"].role, "site_admin");
  assert.equal(a.projects["tms-prod"].state, "invalid");
  assert.equal(topRole(a), "super_admin");
  assert.deepEqual(a.failures, []);
});

test("unconfigured projects (no url/key) are skipped without a network call", async () => {
  const b = createFakeBackend();
  const blank = new Set(["wkm-prod", "hub-explo"]);
  const a = await run(b, "demo@can.local", "demo-demo-123", 500, REAL.map((p) => (blank.has(p.id) ? { ...p, url: "", anonKey: "" } : p)));
  assert.equal(a.projects["wkm-prod"].state, "unconfigured");
  assert.equal(a.projects["hub-explo"].state, "unconfigured");
  assert.equal(a.projects["wkm-explo"].state, "ok");
  assert.equal(a.ok, true);
  assert.ok(b.calls.every((c) => !blank.has(c[1])), "no call reached an unconfigured project");
});

test("nothing configured: login cannot succeed", async () => {
  const a = await run(createFakeBackend(), "demo@can.local", "demo-demo-123", 500, PROJECTS.map((p) => ({ ...p, url: "", anonKey: "" })));
  assert.equal(a.ok, false);
});

test("login succeeds if one project accepts; a down project is unreachable, not invalid", async () => {
  const a = await run(createFakeBackend({ down: ["wkm-prod", "hub-prod"] }), "demo@can.local", "demo-demo-123");
  assert.equal(a.ok, true);
  assert.deepEqual(unreachableProjects(a).sort(), ["hub-prod", "wkm-prod"]);
});

test("wrong password everywhere: login fails", async () => {
  const a = await run(createFakeBackend(), "demo@can.local", "nope");
  assert.equal(a.ok, false);
  assert.ok(Object.values(a.projects).every((p) => p.state === "invalid"));
});

test("timeout counts as unreachable", async () => {
  const a = await run(createFakeBackend({ latencyMs: 300 }), "demo@can.local", "demo-demo-123", 50);
  assert.equal(a.ok, false);
  assert.ok(Object.values(a.projects).every((p) => p.state === "unreachable"));
});

test("out-of-sync password looks like no account (known limit)", async () => {
  const a = await run(createFakeBackend({ wrongPassword: ["demo@can.local|wkm-explo"] }), "demo@can.local", "demo-demo-123");
  assert.equal(a.projects["wkm-explo"].state, "invalid");
  assert.equal(a.projects["cdsm-explo"].state, "ok");
});

test("profile read error does not lock the person out", async () => {
  const a = await signInAll({ projects: PROJECTS, email: "demo@can.local", password: "demo-demo-123",
    deps: { createClient: createFakeBackend().createClient, readProfile: async () => { throw new Error("boom"); } } });
  assert.equal(a.ok, true);
  assert.equal(a.projects["wkm-prod"].profileError, true);
  assert.equal(a.projects["wkm-prod"].role, "viewer");
});

test("portal model: viewer sees only WKM exploration, the rest is greyed", async () => {
  const a = await run(createFakeBackend(), "viewer@can.local", "viewer-view-123");
  const m = buildPortalModel(PROJECTS, a);
  assert.equal(m.ho.any, false);
  assert.deepEqual(m.sites.filter((s) => s.any).map((s) => s.code), ["WKM"]);
  assert.equal(m.sites.find((s) => s.code === "CDSM").production, null);
});

test("safeNext allows same-origin paths only", () => {
  for (const ok of ["/", "/explo/", "/explo/?site=WKM", "/production/?site=BM#x"]) assert.equal(safeNext(ok, "F"), ok, ok);
  for (const bad of ["https://evil.com", "//evil.com", "/\\evil.com", "javascript:alert(1)", "/../x", "explo/", "./x", "", null, undefined, "http:evil", "/a b", "/x\n"])
    assert.equal(safeNext(bad, "F"), "F", String(bad));
});

test("roles and form limits", () => {
  assert.equal(normalizeRole("geologist"), "data_entry");
  assert.equal(normalizeRole("weird"), "viewer");
  assert.equal(canUseForm("data_entry", ["collar"], "collar"), true);
  assert.equal(canUseForm("data_entry", ["collar"], "sample"), false);
  assert.equal(canUseForm("viewer", null, "sample"), false);
  assert.equal(hubRole("site_admin"), "admin");
  assert.equal(classifyAuthError({ status: 400, message: "Invalid login credentials" }), "invalid");
  assert.equal(classifyAuthError(new Error("Failed to fetch")), "unreachable");
});

test("demo users exist", () => assert.ok(DEMO_USERS.length >= 2));

// ---- Phase 2: Exploration on the portal session ----
test("exploSites: only usable site exploration projects, in config order", async () => {
  const a = await run(createFakeBackend(), "demo@can.local", "demo-demo-123");
  const sites = exploSites(PROJECTS, a);
  assert.deepEqual(sites.map((s) => s.site), ["WKM", "CDSM"].filter((c) => a.projects[`${c.toLowerCase()}-explo`].state === "ok"));
  assert.ok(sites.every((s) => s.usable && s.role));
  assert.ok(!sites.some((s) => s.site === undefined), "hub (HO) projects are not site tiles");
});

test("exploSites: unconfigured, invalid and unreachable projects are not offered", async () => {
  const a = await run(createFakeBackend({ down: ["wkm-explo"] }), "demo@can.local", "demo-demo-123");
  assert.ok(!exploSites(PROJECTS, a).some((s) => s.site === "WKM"));
  const blank = PROJECTS.map((p) => (p.id === "cdsm-explo" ? { ...p, url: "", anonKey: "" } : p));
  assert.ok(!exploSites(blank, a).some((s) => s.site === "CDSM"));
});

test("pickExploSite: ?site= wins, then last session, then guest site, then first allowed; never a site that is not allowed", () => {
  const sites = [{ site: "WKM" }, { site: "CDSM" }];
  assert.equal(pickExploSite(sites, { wanted: "cdsm", cached: "WKM" }), "CDSM");
  assert.equal(pickExploSite(sites, { wanted: null, cached: "CDSM" }), "CDSM");
  assert.equal(pickExploSite(sites, { guest: "CDSM" }), "CDSM");
  assert.equal(pickExploSite(sites, { wanted: "BM", cached: "TMS" }), "WKM", "not allowed -> first allowed");
  assert.equal(pickExploSite([], { wanted: "WKM" }), null);
});

test("infoFromPortal: permissions follow the portal role, forms limit carries over", () => {
  const v = infoFromPortal("WKM", "a@b.c", { role: "viewer", name: "Ann" });
  assert.equal(v.can_write, false); assert.equal(v.can_admin, false); assert.equal(v.name, "Ann"); assert.equal(v.forms, null);
  const d = infoFromPortal("WKM", "a@b.c", { role: "data_entry", forms: ["collar"] });
  assert.equal(d.can_write, true); assert.equal(d.can_admin, false); assert.deepEqual(d.forms, ["collar"]); assert.equal(d.name, "a@b.c");
  const s = infoFromPortal("CDSM", "a@b.c", { role: "super_admin", forms: [] });
  assert.equal(s.can_super, true); assert.equal(s.can_admin, true); assert.equal(s.forms, null, "empty list = all forms");
  assert.equal(s.role_label, "Super admin");
});
