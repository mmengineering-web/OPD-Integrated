// op-admin-users: creates, lists, updates, resets and deletes users for One Portal Data.
// Deploy in: WKM, BM, TMS production, Hub production (PROFILE_MODE=op_profile, the default) and Explo Hub (PROFILE_MODE=dash_member).
// Verify JWT must be OFF in the dashboard: this function verifies the caller itself (below).
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase; never put the service-role key in the repo.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MODE = (Deno.env.get("PROFILE_MODE") || "op_profile").toLowerCase();   // "op_profile" | "dash_member"
const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const fail = (msg: string, status = 400) => json({ error: msg }, status);

const OP_ROLES = ["viewer", "data_entry", "site_admin", "super_admin"];
const DASH_ROLES = ["viewer", "admin"];
const roles = MODE === "dash_member" ? DASH_ROLES : OP_ROLES;
const isSuper = (r: string) => (MODE === "dash_member" ? r === "admin" : r === "super_admin");
const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

// Service-role client. For the Explo Hub the member table lives in the "dash" schema (it must be exposed in API settings).
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false }, ...(MODE === "dash_member" ? { db: { schema: "dash" } } : {}) });
const table = () => admin.from(MODE === "dash_member" ? "member" : "op_profile");

// Normalised row: { user_id, email, name, role, active }
const fromDb = (r: any) => ({ user_id: r.user_id ?? null, email: norm(r.email), full_name: r.full_name ?? r.name ?? null, role: r.role, is_active: (r.is_active ?? r.active) !== false });

async function listRows() {
  const { data, error } = await table().select("*");
  if (error) throw new Error(error.message);
  const rows = (data || []).map(fromDb);
  if (MODE === "dash_member" && rows.some((r) => !r.user_id)) {
    // dash.member is keyed by email: look the auth user up by email so the page can act on user_id.
    const byEmail = new Map<string, string>();
    for (let page = 1; page <= 20; page++) {
      const { data: l, error: e } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (e) throw new Error(e.message);
      for (const u of l.users) if (u.email) byEmail.set(norm(u.email), u.id);
      if (l.users.length < 1000) break;
    }
    for (const r of rows) if (!r.user_id) r.user_id = byEmail.get(r.email) ?? null;
  }
  return rows;
}

async function caller(req: Request) {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) throw Object.assign(new Error("Sign in first."), { status: 401 });
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data.user) throw Object.assign(new Error("Invalid session."), { status: 401 });
  const rows = await listRows();
  const me = rows.find((r) => (r.user_id && r.user_id === data.user!.id) || (!r.user_id && r.email === norm(data.user!.email)));
  if (!me || !me.is_active || !isSuper(me.role)) throw Object.assign(new Error("Only an active super admin can manage users."), { status: 403 });
  return { id: data.user.id, email: norm(data.user.email), rows };
}

async function writeProfile(user_id: string, email: string, name: string, role: string) {
  if (MODE === "dash_member") {
    // No assumption about unique constraints: update the member row by email, or insert it.
    const { data: ex, error: e1 } = await table().select("email").eq("email", email).limit(1);
    if (e1) throw new Error(e1.message);
    const { error } = ex && ex.length ? await table().update({ name, role }).eq("email", email) : await table().insert({ email, name, role });
    if (error) throw new Error(error.message);
    return;
  }
  const { error } = await table().upsert({ user_id, email, full_name: name, role, is_active: true }, { onConflict: "user_id" });
  if (error) throw new Error(error.message);
}

function lastSuperGuard(rows: any[], user_id: string, why: string) {
  const target = rows.find((r) => r.user_id === user_id);
  if (!target || !isSuper(target.role)) return;
  const others = rows.filter((r) => r.user_id !== user_id && r.is_active && isSuper(r.role));
  if (others.length === 0) throw new Error(`The last super admin cannot be ${why}.`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail("POST only.", 405);
  try {
    const me = await caller(req);
    const b = await req.json().catch(() => ({}));
    const action = String(b.action || "");

    if (action === "list") return json({ users: me.rows });

    if (action === "create") {
      const email = norm(b.email), name = String(b.full_name || "").trim(), role = String(b.role || "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail("Invalid email.");
      if (!name) return fail("Full name is required.");
      if (!roles.includes(role)) return fail(`Role must be one of: ${roles.join(", ")}.`);
      if (String(b.password || "").length < 10) return fail("The password must have at least 10 characters.");
      const { data, error } = await admin.auth.admin.createUser({ email, password: b.password, email_confirm: true, user_metadata: { full_name: name } });
      if (error || !data.user) return fail(error?.message || "Could not create the account.");
      try { await writeProfile(data.user.id, email, name, role); }
      catch (e) { await admin.auth.admin.deleteUser(data.user.id); return fail(`Profile not saved, account rolled back: ${(e as Error).message}`, 500); }
      return json({ ok: true, user_id: data.user.id });
    }

    if (action === "update") {
      const id = String(b.user_id || ""), role = String(b.role || "");
      if (!id) return fail("user_id is required.");
      if (!roles.includes(role)) return fail(`Role must be one of: ${roles.join(", ")}.`);
      const target = me.rows.find((r) => r.user_id === id);
      if (!target) return fail("User not found in this project.", 404);
      if (!isSuper(role)) lastSuperGuard(me.rows, id, "demoted");
      await writeProfile(id, target.email, String(b.full_name || target.full_name || "").trim(), role);
      return json({ ok: true });
    }

    if (action === "reset_password") {
      const id = String(b.user_id || "");
      if (!id) return fail("user_id is required.");
      if (String(b.password || "").length < 10) return fail("The password must have at least 10 characters.");
      const { error } = await admin.auth.admin.updateUserById(id, { password: b.password });
      if (error) return fail(error.message);
      return json({ ok: true });
    }

    if (action === "delete") {
      const id = String(b.user_id || "");
      if (!id) return fail("user_id is required.");
      if (id === me.id) return fail("You cannot delete your own account.");
      lastSuperGuard(me.rows, id, "deleted");
      const target = me.rows.find((r) => r.user_id === id);
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) return fail(error.message);
      if (MODE === "dash_member") { if (target) await table().delete().eq("email", target.email); }
      else await table().delete().eq("user_id", id);   // no-op when the foreign key already cascaded
      return json({ ok: true });
    }

    return fail("Unknown action.");
  } catch (e) {
    const err = e as Error & { status?: number };
    return fail(err.message || "Server error.", err.status || 400);
  }
});
