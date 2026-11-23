// Browser glue for the Super Admin page: one supabase-js client per project, signed in with the caller's own portal session.
// No service-role key is ever used here. The Edge Functions hold it as a secret and check that the caller is an active super admin.
import { makeClient } from './session.js';
import { functionName } from './admin-core.js';

const clients = new Map();
const clientFor = (p) => clients.get(p.id) || clients.set(p.id, makeClient(p)).get(p.id);

async function callFn(p, body) {
  const name = functionName(p);
  const { data, error } = await clientFor(p).functions.invoke(name, { body });
  if (error) {
    let msg = error.message || 'The server did not answer.';
    const st = error.context?.status;
    if (st === 404) msg = `Edge Function "${name}" is not deployed in ${p.name}.`;
    else if (error.context && typeof error.context.json === 'function') {
      try { const j = await error.context.json(); if (j?.error) msg = j.error; } catch { /* keep msg */ }
    } else if (/Failed to send/i.test(msg)) msg = `Cannot reach "${name}" in ${p.name} (not deployed, paused project, or offline).`;
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

const row = (r) => ({ user_id: r.user_id, email: r.email || '', name: r.full_name ?? r.name ?? null, role: r.role, active: (r.is_active ?? r.active) !== false });

/** The five operations on one project. Exploration sites use their existing function and RPC; the other projects use op-admin-users. */
export function apiFor(p) {
  if (p.profile?.type === 'exp') {
    const c = clientFor(p);
    return {
      async list() {
        const { data, error } = await c.from('exp_profile').select('user_id,full_name,role,is_active,email').order('full_name');
        if (error) throw new Error(error.message);
        return (data || []).map(row);
      },
      async create({ email, name, role, password }) {
        const d = await callFn(p, { action: 'create', email, full_name: name, role, password });
        return { user_id: d?.user_id ?? d?.user?.id ?? null };
      },
      async update({ email, name, role }) {
        const { error } = await c.rpc('exp_admin_upsert_profile', { p_email: email, p_name: name, p_role: role, p_active: true });
        if (error) throw new Error(error.message);
      },
      reset: ({ user_id, password }) => callFn(p, { action: 'reset_password', user_id, password }),
      remove: ({ user_id }) => callFn(p, { action: 'delete', user_id }),
    };
  }
  return {
    async list() { const d = await callFn(p, { action: 'list' }); return (d?.users || []).map(row); },
    async create({ email, name, role, password }) { const d = await callFn(p, { action: 'create', email, full_name: name, role, password }); return { user_id: d?.user_id ?? null }; },
    update: ({ user_id, email, name, role }) => callFn(p, { action: 'update', user_id, email, full_name: name, role }),
    reset: ({ user_id, password }) => callFn(p, { action: 'reset_password', user_id, password }),
    remove: ({ user_id }) => callFn(p, { action: 'delete', user_id }),
  };
}

/** Read every manageable project in parallel. One paused project does not block the others. */
export async function listAll(projects) {
  const out = {};
  await Promise.all(projects.map(async (p) => {
    try { out[p.id] = { rows: await apiFor(p).list() }; }
    catch (e) { out[p.id] = { error: e?.message || String(e) }; }
  }));
  return out;
}
