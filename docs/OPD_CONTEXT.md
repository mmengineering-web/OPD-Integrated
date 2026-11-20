# One Portal Data (OPD): concept, context and memory

Last updated: 20 Nov 2026. Owner: Gera. Portfolio project (non-commercial), but it must be fully functional.
Keys are NOT stored in this file. Publishable (anon) keys live in `src/lib/opd/config.js` and `src/lib/core/config.js`. Never commit a service-role key or a password.

## 1. What OPD is
One installable web app (PWA) for a mining company: one login for production, exploration and head-office data across sites. Hosted on Vercel as a static Next.js 16 export at https://explo-entry-next.vercel.app/ (single origin, so existing phones keep their session and local data).

## 2. Architecture
- Host: `explo-entry-next` repo (Next.js 16, React 19, Tailwind v4, Dexie, supabase-js 2). Static export, `trailingSlash: true`.
- Routes: `/` portal home, `/login/` OPD login, `/explo/` Exploration app (existing). Later: `/production/`.
- Service worker `public/sw.template.js` -> `out/sw.js` (cache `opd-<hash>`), caches each page under its own path, falls back to `/` offline.
- Test build: `EXP_STUB=1` aliases supabase-js to `tests/stub_supabase.mjs`. NEVER deploy `out-test`.

## 3. The 7 Supabase projects
| id | what | storage key |
|---|---|---|
| hub-prod | Head office production hub | sb-opd-hub-prod |
| hub-explo | Explo Hub (HO exploration, `dash.me()`) | sb-opd-hub-explo |
| wkm-prod / bm-prod / tms-prod | site production | sb-opd-<id> |
| wkm-explo / cdsm-explo | site exploration | sb-exp-WKM / sb-exp-CDSM (kept from the old app) |
Planned exploration sites (BM, TMS, IBN, TPB, AJB, CDS) have no project yet.

## 4. Auth design (credential fan-out, not federated SSO)
- Same email + password account exists in every project. The portal signs in to all in parallel (10 s timeout each).
- Per project state: ok / noprofile / inactive / invalid / unreachable / unconfigured. Login succeeds if at least one project accepts.
- A profile read error does not lock the person out; the database RLS decides.
- Roles: viewer, data_entry (DB value `geologist`), site_admin, super_admin; Explo Hub `admin` -> site_admin. `exp_profile.input_forms` limits forms (progress, collar, hours, sample).
- Redirects: only same-origin paths (`safeNext`).
- Known limit: a password that differs in one project looks like "no account" there.
- Sign out uses scope `local` (other devices stay signed in).
- Access object: `localStorage.opd_access`. Legacy Exploration keys: `exp_session`, `exp_guest_site`, `exp_last_sync_<SITE>`.

## 5. Exploration app facts
- Local DB: Dexie `exploration_<SITE>`, schema version 5. Do NOT add a version above 5 until the old app is retired.
- Offline-first outbox sync; guest mode (no login, data sent after login) stays.
- Edge Function `exp-admin-users` creates/deletes/resets users (Verify JWT off; checks caller is active super admin).

## 6. Phases
1. DONE: login foundation (`/login/`, portal home, `/explo/`, legacy bridge, SW, headers).
2. NEXT: Exploration uses the portal session (`attachSession`), site switcher, guest mode kept, portal sign-out clears Exploration server data.
3. Cutover (same address, data stays).
4. Production upload: browser-side parsing, `etl_*` tables/functions (`docs/DB_CONTRACT.md`), parsers for WKM/BM/TMS, 20-day shadow run.
5. Hub / All sites, documents, tools, help.

## 7. Decisions and constraints (memory)
- Language: all answers and UI docs in English for this project (Exploration UI text is still Indonesian).
- Output format: Summary / Detailed analysis / Next steps. Concise. Complete files for code revisions. One zip per phase.
- ML goal elsewhere in the project: >93% precision/recall/F1 with documented repo (not part of OPD).
- Vercel Hobby is non-commercial only; fine for this portfolio. Moving to company use needs Pro or another host.
- Verified: `dash.me()` returns rows (email, role, sites text[]).

## 8. Open items
- Production profile table shape (`op_profile`) unconfirmed; the portal reads `user_id, role, active/is_active, name/full_name`. Until the SQL exists production tiles may show "No profile".
- Parser sample files for WKM/BM/TMS daily reports (Phase 4).
- Explo Hub "All sites" tab is now enabled by the hub key; verify it with a real hub account.
- Real-account smoke test of the login against the live projects (only the fake backend has been run).

## 9. How to test
`npm run test:unit` · `npm run build` · `npm run build:test`, serve `out-test`, then `node tests/opd_e2e.mjs` and `python3 tests/e2e*.py` (BASE `/explo/`).
