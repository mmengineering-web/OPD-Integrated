// Pure logic of the Super Admin "User administration" page (no DOM, no network of its own).
// Everything that touches Supabase arrives through `api(project)` (see admin-api.js), so this file is tested with fakes.
//
// One person = one email. The same email and password are created in every project the person is ticked for,
// because the portal login signs in to all projects with one credential pair (credential fan-out).
import { normalizeRole, hubRole } from './auth-core.js';

export const MIN_PASSWORD = 10;
/** Role choices in the UI. 'data_entry' is the portal name of the database value 'geologist'. */
export const ADMIN_ROLES = [
  { v: 'viewer', t: 'Viewer' },
  { v: 'data_entry', t: 'Data entry (geologist)' },
  { v: 'site_admin', t: 'Site admin' },
  { v: 'super_admin', t: 'Super admin' },
];
export const roleText = (r) => ADMIN_ROLES.find((x) => x.v === r)?.t ?? (r || 'no role');

/** The role value each kind of project stores. exp_profile keeps 'geologist'; the Explo Hub only knows admin and viewer. */
export function dbRole(project, role) {
  const r = normalizeRole(role);
  if (project.profile?.type === 'dash') return hubRole(r);
  if (project.profile?.type === 'exp') return r === 'data_entry' ? 'geologist' : r;
  return r;
}

/** Which edge function manages this project's users. */
export const functionName = (project) => (project.profile?.type === 'exp' ? 'exp-admin-users' : 'op-admin-users');

export const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim());
const lc = (v) => String(v || '').trim().toLowerCase();

/** Projects the caller may manage: usable and super admin there. */
export function manageableProjects(projects, access) {
  return projects.filter((p) => {
    const r = access?.projects?.[p.id];
    return r && r.state === 'ok' && r.role === 'super_admin';
  });
}

/**
 * Turn the per-project listings into one row per person.
 * listings[projectId] = { rows: [{user_id, email, name, role, active}] } or { error }.
 * Rows without an email (old Exploration accounts) cannot be matched across projects, so each is its own row.
 */
export function buildMatrix(listings) {
  const byEmail = new Map(), loose = [];
  for (const [pid, l] of Object.entries(listings || {})) {
    if (!l || l.error) continue;
    for (const r of l.rows || []) {
      const cell = { user_id: r.user_id, role: normalizeRole(r.role), active: r.active !== false, name: r.name || null };
      const key = lc(r.email);
      if (!key) { loose.push({ email: '', name: r.name || '(no email)', loose: true, cells: { [pid]: cell } }); continue; }
      const p = byEmail.get(key) || { email: key, name: null, loose: false, cells: {} };
      p.cells[pid] = cell;
      p.name = p.name || r.name || null;
      byEmail.set(key, p);
    }
  }
  const people = [...byEmail.values()].sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
  return [...people, ...loose];
}

/** A person's highest role across the projects, for the table's role column. */
export function personRole(person) {
  const order = ['viewer', 'data_entry', 'site_admin', 'super_admin'];
  let best = -1;
  for (const c of Object.values(person.cells)) best = Math.max(best, order.indexOf(c.role));
  return best < 0 ? null : order[best];
}

/** Number of active super admins in a project (for the "last super admin" guard). */
export function superAdminCount(listings, projectId) {
  return (listings?.[projectId]?.rows || []).filter((r) => normalizeRole(r.role) === 'super_admin' && r.active !== false).length;
}

/**
 * Plan the work for one person.
 *   person    existing row, or null when creating
 *   want      { email, name, role, password, projects: Set|array of project ids }
 *   ctx       { projects (manageable), listings, me (caller email), confirmRemove (bool) }
 * Returns { errors: [], steps: [{projectId, op, label, ...}] }. Steps with op 'delete' need ctx.confirmRemove.
 */
export function planUser({ person, want, ctx }) {
  const errors = [], steps = [];
  const byId = new Map(ctx.projects.map((p) => [p.id, p]));
  const ticked = new Set([...want.projects].filter((id) => byId.has(id)));
  const email = lc(person?.email || want.email);
  const role = normalizeRole(want.role) || 'viewer';
  const pw = want.password || '';

  if (!looksLikeEmail(email)) errors.push('Enter a valid email address.');
  if (!person && !String(want.name || '').trim()) errors.push('Enter the full name.');
  const needsPw = !person || pw !== '';
  if (needsPw && pw.length < MIN_PASSWORD) errors.push(`The password must have at least ${MIN_PASSWORD} characters.`);
  if (!person && ticked.size === 0) errors.push('Tick at least one project.');
  if (person && !person.loose && ticked.size === 0 && !Object.keys(person.cells).some((id) => byId.has(id))) errors.push('You cannot manage this person in any project.');

  for (const p of ctx.projects) {
    const cell = person?.cells?.[p.id];
    const on = ticked.has(p.id);
    if (on && !cell) {
      if (person?.loose) continue;                       // a row without email cannot be copied elsewhere
      steps.push({ projectId: p.id, op: 'create', label: `Create account in ${p.name}`, email, name: String(want.name || person?.name || '').trim(), role: dbRole(p, role), password: pw });
    } else if (on && cell && !person?.loose) {
      if (normalizeRole(cell.role) !== role && !(p.profile?.type === 'dash' && hubRole(normalizeRole(cell.role)) === hubRole(role))) {
        if (cell.role === 'super_admin' && superAdminCount(ctx.listings, p.id) <= 1) errors.push(`${p.name}: ${email} is the last super admin, so the role cannot be lowered.`);
        else steps.push({ projectId: p.id, op: 'update', label: `Change role in ${p.name} to ${roleText(role)}`, user_id: cell.user_id, email, name: String(want.name || person?.name || '').trim(), role: dbRole(p, role) });
      }
      if (pw) steps.push({ projectId: p.id, op: 'reset', label: `Reset password in ${p.name}`, user_id: cell.user_id, email, password: pw });
    } else if (!on && cell) {
      if (lc(ctx.me) === email) { errors.push('You cannot remove your own account.'); continue; }
      if (cell.role === 'super_admin' && superAdminCount(ctx.listings, p.id) <= 1) { errors.push(`${p.name}: ${email} is the last super admin and cannot be removed.`); continue; }
      steps.push({ projectId: p.id, op: 'delete', label: `Delete account in ${p.name}`, user_id: cell.user_id, email });
    }
  }
  if (steps.some((s) => s.op === 'delete') && !ctx.confirmRemove) errors.push('Tick the confirmation box: removing an account cannot be undone.');
  if (!errors.length && steps.length === 0) errors.push('Nothing to change.');
  return { errors, steps };
}

/** Plan "delete everywhere": every project the caller manages where the person has an account. */
export function planDeleteEverywhere({ person, ctx }) {
  const want = { email: person.email, name: person.name, role: personRole(person) || 'viewer', password: '', projects: [] };
  return planUser({ person, want, ctx: { ...ctx, projects: ctx.projects.filter((p) => person.cells[p.id]) } });
}

/**
 * Run a plan. Projects run in parallel; the steps of one project run in order, and after a failure the rest of that project is skipped.
 * api(project) -> { create, update, reset, remove }. Each call returns a promise; a throw means failure.
 * Returns [{ step, status: 'ok'|'failed'|'skipped', message }] in plan order.
 */
export async function runPlan({ steps, projects, api, onProgress }) {
  const results = steps.map((step) => ({ step, status: 'skipped', message: 'Skipped because an earlier step in this project failed.' }));
  const byProject = new Map();
  steps.forEach((s, i) => { (byProject.get(s.projectId) || byProject.set(s.projectId, []).get(s.projectId)).push(i); });
  await Promise.all([...byProject.entries()].map(async ([pid, idxs]) => {
    const project = projects.find((p) => p.id === pid);
    const a = api(project);
    let failed = false;
    for (const i of idxs) {
      if (failed) continue;
      const s = steps[i];
      try {
        if (s.op === 'create') await a.create({ email: s.email, name: s.name, role: s.role, password: s.password });
        else if (s.op === 'update') await a.update({ user_id: s.user_id, email: s.email, name: s.name, role: s.role });
        else if (s.op === 'reset') await a.reset({ user_id: s.user_id, password: s.password });
        else if (s.op === 'delete') await a.remove({ user_id: s.user_id });
        else throw new Error(`Unknown step ${s.op}`);
        results[i] = { step: s, status: 'ok', message: 'Done' };
      } catch (e) {
        failed = true;
        results[i] = { step: s, status: 'failed', message: e?.message || String(e) };
      }
      onProgress?.(results.slice());
    }
  }));
  return results;
}

/** 16-character password from an unambiguous alphabet. `rand` is injectable for tests. */
export function generatePassword(n = 16, rand = (len) => crypto.getRandomValues(new Uint8Array(len))) {
  const A = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(rand(n), (b) => A[b % A.length]).join('');
}
