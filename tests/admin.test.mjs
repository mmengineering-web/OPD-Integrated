import test from "node:test";
import assert from "node:assert/strict";
import { PROJECTS } from "../src/lib/opd/config.js";
import { canOpen } from "../src/lib/opd/auth-core.js";
import { dbRole, functionName, buildMatrix, planUser, planDeleteEverywhere, runPlan, manageableProjects, generatePassword, personRole, superAdminCount } from "../src/lib/opd/admin-core.js";

const rec = (state, role) => ({ state, role, active: true });
const access = (o) => ({ ok: true, email: "boss@can.co", projects: o });
const ALL = Object.fromEntries(PROJECTS.map((p) => [p.id, rec("ok", "super_admin")]));

test("canOpen: ho-production needs the Hub production project; super_admin needs the role somewhere", () => {
  assert.equal(canOpen(PROJECTS, access({ "wkm-prod": rec("ok", "viewer") }), "production"), true);
  assert.equal(canOpen(PROJECTS, access({ "wkm-prod": rec("ok", "viewer") }), "ho-production"), false, "a site account is not enough for the all-sites dashboard");
  assert.equal(canOpen(PROJECTS, access({ "hub-prod": rec("ok", "viewer") }), "ho-production"), true);
  assert.equal(canOpen(PROJECTS, access({ "hub-prod": rec("noprofile", null) }), "ho-production"), false);
  assert.equal(canOpen(PROJECTS, access({ "hub-explo": rec("ok", "viewer") }), "ho-production"), false, "Explo Hub is not production");
  assert.equal(canOpen(PROJECTS, access({ "bm-prod": rec("ok", "site_admin") }), "super_admin"), false);
  assert.equal(canOpen(PROJECTS, access({ "bm-prod": rec("ok", "site_admin"), "wkm-explo": rec("ok", "super_admin") }), "super_admin"), true);
  assert.equal(canOpen(PROJECTS, { ok: false, projects: {} }, "super_admin"), false);
});

test("role mapping per project type, and which function handles it", () => {
  const P = (id) => PROJECTS.find((p) => p.id === id);
  assert.equal(dbRole(P("wkm-explo"), "data_entry"), "geologist");
  assert.equal(dbRole(P("wkm-explo"), "site_admin"), "site_admin");
  assert.equal(dbRole(P("wkm-prod"), "data_entry"), "data_entry");
  assert.equal(dbRole(P("hub-explo"), "site_admin"), "admin");
  assert.equal(dbRole(P("hub-explo"), "data_entry"), "viewer");
  assert.equal(functionName(P("cdsm-explo")), "exp-admin-users");
  assert.equal(functionName(P("hub-prod")), "op-admin-users");
  assert.equal(functionName(P("hub-explo")), "op-admin-users");
});

test("manageable projects: only those where the caller is an active super admin", () => {
  const a = access({ ...ALL, "bm-prod": rec("ok", "site_admin"), "tms-prod": rec("invalid", null), "hub-explo": rec("unreachable", null) });
  assert.deepEqual(manageableProjects(PROJECTS, a).map((p) => p.id).sort(), ["cdsm-explo", "hub-prod", "wkm-explo", "wkm-prod"]);
});

const listings = {
  "wkm-explo": { rows: [{ user_id: "e1", email: "Ana@can.co", name: "Ana", role: "geologist", active: true }, { user_id: "e9", email: "", name: "Old account", role: "viewer", active: true }, { user_id: "e0", email: "boss@can.co", name: "Boss", role: "super_admin", active: true }] },
  "wkm-prod": { rows: [{ user_id: "p1", email: "ana@can.co", name: "Ana", role: "viewer", active: true }, { user_id: "p0", email: "boss@can.co", name: "Boss", role: "super_admin", active: true }] },
  "bm-prod": { error: "Edge Function \"op-admin-users\" is not deployed" },
};

test("matrix: one row per person (case-insensitive email), errors skipped, no-email rows stay separate", () => {
  const m = buildMatrix(listings);
  assert.equal(m.length, 3);
  const ana = m.find((p) => p.email === "ana@can.co");
  assert.deepEqual(Object.keys(ana.cells).sort(), ["wkm-explo", "wkm-prod"]);
  assert.equal(ana.cells["wkm-explo"].role, "data_entry", "geologist shown as data entry");
  assert.ok(m.some((p) => p.loose && p.name === "Old account"));
  assert.equal(personRole(ana), "data_entry");
  assert.equal(superAdminCount(listings, "wkm-prod"), 1);
});

const mp = (ids) => PROJECTS.filter((p) => ids.includes(p.id));
const ctx = (ids, extra = {}) => ({ projects: mp(ids), listings, me: "boss@can.co", confirmRemove: false, ...extra });

test("plan: add user validates email, name, password length and ticked projects", () => {
  const bad = planUser({ person: null, want: { email: "nope", name: "", role: "viewer", password: "short", projects: [] }, ctx: ctx(["wkm-prod"]) });
  assert.equal(bad.errors.length, 4);
  const ok = planUser({ person: null, want: { email: "New@can.co", name: "New", role: "data_entry", password: "0123456789", projects: ["wkm-explo", "wkm-prod", "hub-explo"] }, ctx: ctx(["wkm-explo", "wkm-prod", "hub-explo"]) });
  assert.deepEqual(ok.errors, []);
  const byP = Object.fromEntries(ok.steps.map((s) => [s.projectId, s]));
  assert.equal(byP["wkm-explo"].role, "geologist");
  assert.equal(byP["wkm-prod"].role, "data_entry");
  assert.equal(byP["hub-explo"].role, "viewer");
  assert.equal(byP["wkm-prod"].email, "new@can.co");
  assert.ok(ok.steps.every((s) => s.op === "create" && s.password === "0123456789"));
});

test("plan: a tick on a project the caller does not manage is ignored", () => {
  const r = planUser({ person: null, want: { email: "n@can.co", name: "N", role: "viewer", password: "0123456789", projects: ["bm-prod"] }, ctx: ctx(["wkm-prod"]) });
  assert.ok(r.errors.some((e) => /Tick at least one/.test(e)));
});

test("plan: manage creates in new projects, updates changed roles, resets passwords, deletes unticked after confirmation", () => {
  const ana = buildMatrix(listings).find((p) => p.email === "ana@can.co");
  const ids = ["wkm-explo", "wkm-prod", "hub-prod"];
  const base = { person: ana, want: { email: ana.email, name: "Ana", role: "site_admin", password: "", projects: ["wkm-prod", "hub-prod"] } };
  let r = planUser({ ...base, ctx: ctx(ids) });
  assert.ok(r.errors.some((e) => /confirmation/.test(e)), "removal needs the confirmation tick");
  r = planUser({ ...base, want: { ...base.want, password: "newpassword1" }, ctx: ctx(ids, { confirmRemove: true }) });
  assert.deepEqual(r.errors, []);
  const ops = r.steps.map((s) => `${s.projectId}:${s.op}`).sort();
  assert.deepEqual(ops, ["hub-prod:create", "wkm-explo:delete", "wkm-prod:reset", "wkm-prod:update"]);
  assert.equal(r.steps.find((s) => s.projectId === "hub-prod").role, "site_admin");
});

test("plan: nothing changed is an error; same role is not an update", () => {
  const ana = buildMatrix(listings).find((p) => p.email === "ana@can.co");
  const r = planUser({ person: ana, want: { email: ana.email, name: "Ana", role: "viewer", password: "", projects: ["wkm-prod", "wkm-explo"] }, ctx: ctx(["wkm-explo", "wkm-prod"]) });
  assert.deepEqual(r.steps.map((s) => s.projectId + ":" + s.op), ["wkm-explo:update"], "explo cell is data_entry, so it moves to viewer; the prod cell already is viewer");
  const same = planUser({ person: ana, want: { email: ana.email, name: "Ana", role: "viewer", password: "", projects: ["wkm-prod"] }, ctx: ctx(["wkm-prod"]) });
  assert.deepEqual(same.errors, ["Nothing to change."]);
});

test("guards: cannot delete yourself; last super admin cannot be removed or demoted", () => {
  const boss = buildMatrix(listings).find((p) => p.email === "boss@can.co");
  const self = planDeleteEverywhere({ person: boss, ctx: ctx(["wkm-explo", "wkm-prod"], { confirmRemove: true }) });
  assert.ok(self.errors.includes("You cannot remove your own account."));
  const other = { ...boss, email: "other@can.co" };
  const last = planDeleteEverywhere({ person: other, ctx: ctx(["wkm-explo", "wkm-prod"], { confirmRemove: true }) });
  assert.equal(last.steps.length, 0);
  assert.ok(last.errors.some((e) => /last super admin/.test(e)));
  const demote = planUser({ person: boss, want: { email: boss.email, name: "Boss", role: "viewer", password: "", projects: ["wkm-prod", "wkm-explo"] }, ctx: ctx(["wkm-explo", "wkm-prod"], { me: "x@y.co" }) });
  assert.ok(demote.errors.some((e) => /last super admin/.test(e)));
});

test("delete everywhere lists only projects where the person has an account", () => {
  const ana = buildMatrix(listings).find((p) => p.email === "ana@can.co");
  const r = planDeleteEverywhere({ person: ana, ctx: ctx(["wkm-explo", "wkm-prod", "hub-prod"], { confirmRemove: true }) });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.steps.map((s) => s.projectId).sort(), ["wkm-explo", "wkm-prod"]);
});

test("runPlan: projects run in parallel, a failure skips the rest of that project only", async () => {
  const log = [];
  const steps = [
    { projectId: "wkm-prod", op: "create", label: "a", email: "x", name: "X", role: "viewer", password: "p" },
    { projectId: "wkm-prod", op: "reset", label: "b", user_id: "u", password: "p" },
    { projectId: "wkm-explo", op: "create", label: "c", email: "x", name: "X", role: "geologist", password: "p" },
    { projectId: "hub-prod", op: "delete", label: "d", user_id: "h" },
  ];
  const api = (p) => ({
    create: async () => { log.push(p.id + ":create"); if (p.id === "wkm-prod") throw new Error("boom"); },
    reset: async () => { log.push(p.id + ":reset"); },
    remove: async () => { log.push(p.id + ":delete"); },
    update: async () => {},
  });
  const res = await runPlan({ steps, projects: PROJECTS, api });
  assert.deepEqual(res.map((r) => r.status), ["failed", "skipped", "ok", "ok"]);
  assert.equal(res[0].message, "boom");
  assert.ok(!log.includes("wkm-prod:reset"), "skipped step never ran");
  assert.ok(log.includes("wkm-explo:create") && log.includes("hub-prod:delete"));
});

test("password generator: length, alphabet, no look-alike characters", () => {
  const pw = generatePassword(24);
  assert.equal(pw.length, 24);
  assert.match(pw, /^[a-hj-km-np-zA-HJ-NP-Z2-9]+$/);
  assert.notEqual(generatePassword(16), generatePassword(16));
});
