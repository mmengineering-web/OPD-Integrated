# One Portal Data, Phase 1: login foundation

What is new
- `/login/`: one email + password. The browser signs in to every configured project in parallel (10 s timeout each). Login works if at least one project accepts.
- `/`: portal home. One tile per site, Production and Exploration modules, greyed when you have no usable account there. Banner when a project is unreachable.
- `/explo/`: the existing Exploration app, moved here. Still has its own login in this phase (Phase 2 removes it). `?site=WKM` preselects the site.
- Phones already signed in to the old Exploration app (or in guest mode) are sent from `/` straight to `/explo/`, no forced re-login.
- Sign out clears the portal access object and every project session (scope local: other devices stay signed in).

Files
- `src/lib/opd/config.js`: the 7 projects. Production URLs/anon keys are EMPTY until you send them; they show as "Not connected yet". Fill the `PROD` object, anon key only.
- `src/lib/opd/auth-core.js`: pure logic (fan-out, roles, portal model, safe redirect). `profile.js`, `session.js`: browser glue.
- Exploration projects keep the storage key `sb-exp-<SITE>`, so existing sessions survive.
- Do NOT add a Dexie version above 5 until the old app is retired.

Tests
- `npm run test:unit` (13 new auth tests + existing)
- `npm run build:test`, serve `out-test`, then `node tests/opd_e2e.mjs` (portal flow, offline) and the python `tests/e2e*.py` (Exploration, now under `/explo/`)
- Never deploy the `out-test` build (it uses a fake Supabase).

Known limits
- A password that differs in one project looks like "no account" there (module greyed).
- Roles shown on the portal come from the profile tables; the database RLS still decides what is allowed.
