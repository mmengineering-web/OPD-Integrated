// In-memory fake of the small part of supabase-js that the app uses.
// Used by the Node tests and by DEMO mode (no real project needed). Never used when real keys are configured.

export const DEMO_USERS = [
  { email: 'demo@can.local', password: 'demo-demo-123', name: 'Demo Admin',
    roles: { 'hub-prod': 'super_admin', 'hub-explo': 'admin', 'wkm-prod': 'super_admin', 'bm-prod': 'data_entry', 'wkm-explo': 'geologist', 'cdsm-explo': 'viewer' } },
  { email: 'viewer@can.local', password: 'viewer-view-123', name: 'Demo Viewer',
    roles: { 'wkm-prod': 'viewer', 'wkm-explo': 'viewer' } },
];

export function createFakeBackend({ users = DEMO_USERS, down = [], latencyMs = 0, wrongPassword = [], persist = false } = {}) {
  const db = {}; // projectId -> table -> rows
  const storage = {};
  const calls = [];
  // storage key -> session. With persist (demo mode) sessions live in localStorage, like a real supabase-js client,
  // so a page reload keeps the person signed in.
  const mem = {};
  const sessions = new Proxy(mem, {
    get: (t, k) => (persist ? JSON.parse(localStorage.getItem(String(k)) || 'null') ?? undefined : t[k]),
    set: (t, k, v) => { if (persist) localStorage.setItem(String(k), JSON.stringify(v)); else t[k] = v; return true; },
    deleteProperty: (t, k) => { if (persist) localStorage.removeItem(String(k)); else delete t[k]; return true; },
  });
  const table = (pid, t) => ((db[pid] ??= {})[t] ??= []);
  const sleep = () => (latencyMs ? new Promise((r) => setTimeout(r, latencyMs)) : Promise.resolve());

  function createClient(project) {
    const pid = project.id;
    const key = project.storageKey || `sb-opd-${pid}`;
    let user = null;
    const err = (status, message) => ({ status, message });
    const client = {
      auth: {
        async signInWithPassword({ email, password }) {
          await sleep(); calls.push(['signIn', pid]);
          if (down.includes(pid)) return { data: null, error: Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0 }) };
          const u = users.find((x) => x.email.toLowerCase() === String(email).toLowerCase());
          const hasAccount = u && (pid in u.roles);
          if (!hasAccount || u.password !== password || wrongPassword.includes(`${email}|${pid}`)) return { data: null, error: err(400, 'Invalid login credentials') };
          user = { id: `${u.email}:${pid}`, email: u.email };
          const session = { access_token: 'fake', refresh_token: 'fake', user, expires_at: Math.floor(Date.now() / 1000) + 3600 };
          sessions[key] = session;
          return { data: { session, user }, error: null };
        },
        async getSession() { const s = sessions[key]; if (s && !user) user = s.user; return { data: { session: s || null }, error: null }; },
        async signOut() { delete sessions[key]; user = null; return { error: null }; },
      },
      from(t) {
        const rows = () => table(pid, t);
        const q = {
          _f: [], _order: null, _limit: null,
          select() { return q; },
          eq(c, v) { q._f.push((r) => r[c] === v); return q; },
          gt(c, v) { q._f.push((r) => r[c] > v); return q; },
          order(c, o = {}) { q._order = [c, o.ascending !== false]; return q; },
          limit(n) { q._limit = n; return q; },
          async maybeSingle() { const r = (await q.then()).data; return { data: r[0] ?? null, error: null }; },
          async upsert(input, opts = {}) {
            await sleep(); calls.push(['upsert', pid, t]);
            if (down.includes(pid)) return { error: Object.assign(new Error('Failed to fetch'), { status: 0 }) };
            if (!sessions[key]) return { error: { status: 401, message: 'JWT expired' } };
            const key2 = opts.onConflict || 'id';
            for (const r of [].concat(input)) {
              const i = r[key2] === undefined ? -1 : rows().findIndex((x) => x[key2] === r[key2]); // insert without a key always adds
              if (i >= 0) rows()[i] = { ...rows()[i], ...r }; else rows().push({ ...r });
            }
            return { error: null };
          },
          async insert(input) { return q.upsert(input); },
          then(res) {
            let r = rows().filter((x) => q._f.every((f) => f(x)));
            // profile lookups: the fake profile tables are derived from the user list
            if (['op_profile', 'exp_profile'].includes(t)) {
              const u = users.find((x) => x.email === user?.email);
              r = u && pid in u.roles ? [{ user_id: user.id, email: u.email, name: u.name, role: u.roles[pid], active: true, input_forms: null }] : [];
            }
            if (q._order) r = [...r].sort((a, b) => (a[q._order[0]] > b[q._order[0]] ? 1 : -1) * (q._order[1] ? 1 : -1));
            if (q._limit) r = r.slice(0, q._limit);
            const out = { data: r, error: null };
            return res ? Promise.resolve(out).then(res) : Promise.resolve(out);
          },
        };
        return q;
      },
      schema(name) {
        return { async rpc(fn) {
          if (name === 'dash' && fn === 'me') {
            const u = users.find((x) => x.email === user?.email);
            return { data: u && pid in u.roles ? [{ email: u.email, role: u.roles[pid] }] : [], error: null };
          }
          return { data: null, error: { message: `rpc ${name}.${fn} not found` } };
        } };
      },
      async rpc(fn, args) {
        calls.push(['rpc', pid, fn]);
        const handler = client._rpc?.[fn];
        if (!handler) return { data: null, error: { code: 'PGRST202', message: `Could not find the function ${fn}` } };
        return handler(args);
      },
      storage: {
        from(bucket) {
          return { async upload(path, blob) { (storage[bucket] ??= {})[path] = blob; return { data: { path }, error: null }; } };
        },
      },
    };
    client._rpc = demoRpc(pid);
    return client;
  }

  // Demo versions of etl_load / etl_undo (real ones are database functions, see docs/DB_CONTRACT.md)
  function demoRpc(pid) {
    return {
      etl_load({ p_batch_id, p_mode, p_dry_run }) {
        const staged = table(pid, 'etl_stage').filter((r) => r.batch_id === p_batch_id);
        const by = {};
        staged.forEach((r) => (by[r.target_table] ??= []).push(r));
        const tables = {}; let existingTotal = 0;
        for (const [t, rs] of Object.entries(by)) {
          const dates = new Set(rs.map((r) => r.report_date));
          const live = table(pid, `live_${t}`);
          const hit = live.filter((x) => dates.has(x.report_date));
          existingTotal += live.length;
          tables[t] = p_mode === 'overwrite'
            ? { added: rs.length - hit.length > 0 ? rs.length : rs.length, replaced: hit.length, unchanged: 0 }
            : { added: hit.length ? 0 : rs.length, replaced: 0, unchanged: hit.length ? rs.length : 0 };
          if (!p_dry_run) {
            if (p_mode === 'overwrite') db[pid][`live_${t}`] = live.filter((x) => !dates.has(x.report_date));
            if (p_mode === 'overwrite' || !hit.length) rs.forEach((r) => table(pid, `live_${t}`).push({ ...r.row, report_date: r.report_date, batch_id: p_batch_id }));
          }
        }
        if (!p_dry_run) {
          const b = table(pid, 'etl_load_batch').find((x) => x.id === p_batch_id);
          if (b) Object.assign(b, { status: 'loaded', counts: tables, loaded_at: new Date().toISOString() });
        }
        return { data: { batch_id: p_batch_id, tables, existing: existingTotal, issues: [] }, error: null };
      },
      etl_undo({ p_batch_id }) {
        for (const k of Object.keys(db[pid] || {})) if (k.startsWith('live_')) db[pid][k] = db[pid][k].filter((x) => x.batch_id !== p_batch_id);
        const b = table(pid, 'etl_load_batch').find((x) => x.id === p_batch_id);
        if (b) b.status = 'undone';
        return { data: { undone: true }, error: null };
      },
    };
  }
  return { createClient, db, storage, calls, sessions, table };
}
