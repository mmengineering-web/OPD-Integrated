// Pure auth logic (no DOM, no network of its own). Concept section 4.
// Everything that touches Supabase is injected, so this file is tested with fakes.

export const ROLES = ['viewer', 'data_entry', 'site_admin', 'super_admin'];
export const ROLE_LABEL = {
  viewer: 'Viewer',
  data_entry: 'Data entry',
  site_admin: 'Site admin',
  super_admin: 'Super admin',
};

/** 'geologist' is the legacy database value of data_entry (concept 4.3, to confirm). */
export function normalizeRole(r) {
  const v = String(r ?? '').trim().toLowerCase();
  if (v === 'geologist') return 'data_entry';
  if (v === 'admin') return 'site_admin'; // Explo Hub 'admin'
  return ROLES.includes(v) ? v : (v ? 'viewer' : null);
}

export const canInput = (role) => ['data_entry', 'site_admin', 'super_admin'].includes(role);
export const canEditMaster = (role) => ['site_admin', 'super_admin'].includes(role);
export const canManageUsers = (role) => role === 'super_admin';
export const hubRole = (role) => (canEditMaster(role) ? 'admin' : 'viewer');

/** Limit a person to some forms. Empty or missing list = all forms (UI check; the database still enforces). */
export function canUseForm(role, inputForms, formId) {
  if (!canInput(role)) return false;
  if (!Array.isArray(inputForms) || inputForms.length === 0) return true;
  return inputForms.includes(formId);
}

/** A project is configured when it has a URL and a public anon key. */
export const isConfigured = (p) => !!(p?.url && p?.anonKey);

export function withTimeout(promise, ms, label = 'timeout') {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(label), { code: 'timeout' })), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

/** invalid = no account there (or other password); unreachable = paused, offline, timeout, server error. */
export function classifyAuthError(err) {
  if (!err) return 'unreachable';
  if (err.code === 'timeout') return 'unreachable';
  const status = err.status ?? err.statusCode;
  const msg = String(err.message || '').toLowerCase();
  if (status === 400 || status === 401 || status === 422) return 'invalid';
  if (/invalid login|invalid credentials|email not confirmed|invalid_grant/.test(msg)) return 'invalid';
  return 'unreachable';
}

/**
 * Sign in to every project in parallel.
 * deps.createClient(project) -> client with auth.signInWithPassword
 * deps.readProfile(client, project, user) -> {found, role, active, name, forms} (may throw)
 */
export async function signInAll({ projects, email, password, deps, timeoutMs = 10000 }) {
  const out = {};
  await Promise.all(projects.map(async (p) => {
    const rec = { id: p.id, state: 'unreachable', role: null, active: null, name: null, forms: null, profileError: false, error: null };
    out[p.id] = rec;
    let client;
    if (!isConfigured(p)) { rec.state = 'unconfigured'; return; }   // no URL/key yet: nothing to call, not a failure
    try {
      client = deps.createClient(p);
      const { data, error } = await withTimeout(client.auth.signInWithPassword({ email, password }), timeoutMs);
      if (error) { rec.state = classifyAuthError(error); rec.error = error.message || String(error); return; }
      if (!data?.session) { rec.state = 'invalid'; return; }
      rec.state = 'ok';
      try {
        const prof = await withTimeout(deps.readProfile(client, p, data.user), timeoutMs);
        if (!prof || prof.found === false) rec.state = 'noprofile';
        else {
          rec.role = normalizeRole(prof.role);
          rec.active = prof.active !== false;
          rec.name = prof.name ?? null;
          rec.forms = prof.forms ?? null;
          if (!rec.active) rec.state = 'inactive';
        }
      } catch (e) {
        // A profile read error does not lock the person out (4.2). The database RLS still decides.
        rec.profileError = true;
        rec.role = 'viewer';
        rec.active = true;
        rec.error = e.message || String(e);
      }
    } catch (e) {
      rec.state = classifyAuthError(e);
      rec.error = e.message || String(e);
    }
  }));
  return buildAccess(email, projects, out);
}

export function buildAccess(email, projects, results) {
  const list = projects.map((p) => results[p.id]);
  const names = list.map((r) => r.name).filter(Boolean);
  return {
    v: 1,
    at: Date.now(),
    email,
    name: names[0] || email,
    projects: results,
    // login succeeds if at least one project accepted the credentials (4.2)
    ok: list.some((r) => ['ok', 'noprofile', 'inactive'].includes(r.state)),
    failures: list.filter((r) => r.state === 'unreachable').map((r) => r.id),
  };
}

/** Can the person use this project's module? */
export function projectAccess(access, projectId) {
  const r = access?.projects?.[projectId];
  if (!r) return { usable: false, state: 'none', role: null };
  const usable = r.state === 'ok';
  return { usable, state: r.state, role: usable ? r.role : null, forms: r.forms ?? null, profileError: !!r.profileError };
}

/**
 * Portal home model: a Head Office tile, one tile per site with Production and Exploration links.
 * Modules the person cannot use stay in the list with usable=false (greyed out).
 */
export function buildPortalModel(projects, access) {
  const ho = projects.filter((p) => p.scope === 'ho');
  const sites = [...new Set(projects.filter((p) => p.scope === 'site').map((p) => p.site))];
  const mod = (p) => p ? { projectId: p.id, ...projectAccess(access, p.id) } : null;
  const siteTiles = sites.map((code) => {
    const prod = projects.find((p) => p.site === code && p.module === 'production');
    const explo = projects.find((p) => p.site === code && p.module === 'exploration');
    const production = mod(prod), exploration = mod(explo);
    return { code, production, exploration, any: !!(production?.usable || exploration?.usable) };
  });
  const hoTile = {
    production: mod(ho.find((p) => p.module === 'production')),
    exploration: mod(ho.find((p) => p.module === 'exploration')),
  };
  hoTile.any = !!(hoTile.production?.usable || hoTile.exploration?.usable);
  return { ho: hoTile, sites: siteTiles };
}

/** Projects that failed for a reason other than "not registered" (banner in 4.2). */
export function unreachableProjects(access) {
  return Object.values(access?.projects || {}).filter((r) => r.state === 'unreachable').map((r) => r.id);
}

/** Highest role across projects, for showing who is signed in. */
export function topRole(access) {
  let best = -1, role = null;
  for (const r of Object.values(access?.projects || {})) {
    const i = ROLES.indexOf(r.role);
    if (r.state === 'ok' && i > best) { best = i; role = r.role; }
  }
  return role;
}

/**
 * Open-redirect guard (4.2). Only same-origin paths are allowed ("/explo/?site=WKM"):
 * no scheme, no "//", no backslash, no "..", no control characters. Anything else returns the fallback.
 */
export function safeNext(next, fallback = '/') {
  if (typeof next !== 'string' || !next || next.length > 300) return fallback;
  if (/[\\\u0000-\u001f\s]/.test(next)) return fallback;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(next)) return fallback; // scheme
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('..')) return fallback;
  if (!/^\/[A-Za-z0-9_\-./]*(\?[A-Za-z0-9_\-=&%.]*)?(#[A-Za-z0-9_\-/.=&%]*)?$/.test(next)) return fallback;
  return next;
}

/** Exploration projects keep the storage key of the standalone app (sb-exp-<SITE>) so phones that are signed in stay signed in. */
export const sessionKey = (p) => p.storageKey || `sb-opd-${p.id}`;
export const ACCESS_KEY = 'opd_access';

// ---- Phase 2: Exploration on the portal session ----

/** Exploration sites the person may open: site-scope exploration projects that are configured and whose state is "ok". */
export function exploSites(projects, access) {
  return projects
    .filter((p) => p.scope === 'site' && p.module === 'exploration' && isConfigured(p))
    .map((p) => ({ site: p.site, projectId: p.id, ...projectAccess(access, p.id) }))
    .filter((s) => s.usable);
}

/** Which site to open: ?site= first, then the site of the last Exploration session, then a guest site, then the first allowed one. */
export function pickExploSite(sites, { wanted, cached, guest } = {}) {
  const codes = sites.map((s) => s.site);
  for (const c of [wanted, cached, guest]) {
    const u = typeof c === 'string' ? c.toUpperCase() : null;
    if (u && codes.includes(u)) return u;
  }
  return codes[0] ?? null;
}

/** Exploration info object built from the portal role. Used when the server profile cannot be read (offline); the next sync replaces it. */
export function infoFromPortal(site, email, rec) {
  const role = rec?.role ?? 'viewer';
  return {
    site, email, name: rec?.name || email, role, role_label: ROLE_LABEL[role] || role,
    can_write: canInput(role), can_admin: canEditMaster(role), can_super: canManageUsers(role),
    forms: Array.isArray(rec?.forms) && rec.forms.length ? rec.forms : null,
  };
}

// ---- Page access: which pages need which kind of account ----

/**
 * Can this person open a page that needs `need`?
 *   "any"          at least one usable account (the person is signed in)
 *   "production"   a usable production project (head office or a site)
 *   "exploration"  a usable exploration project (head office or a site)
 *   "ho-production" a usable Hub production project (prod.hub): the all-sites views
 *   "super_admin"  super admin in at least one project (user administration)
 */
export function canOpen(projects, access, need) {
  if (!access?.ok) return false;
  if (!need || need === 'any') return true;
  if (need === 'ho-production') return projectAccess(access, 'hub-prod').usable;        // the all-sites dashboard: only the Hub production project
  if (need === 'super_admin') return projects.some((p) => projectAccess(access, p.id).role === 'super_admin');
  return projects.some((p) => p.module === need && projectAccess(access, p.id).usable);
}

/** Usable projects of a module (or all modules for "any"), for showing the person what their access is. */
export function usableProjects(projects, access, need) {
  return projects.filter((p) => (!need || need === 'any' || p.module === need) && projectAccess(access, p.id).usable)
    .map((p) => ({ id: p.id, name: p.name, site: p.site ?? null, module: p.module, role: projectAccess(access, p.id).role }));
}
