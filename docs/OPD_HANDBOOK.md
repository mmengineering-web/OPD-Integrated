# OPD Handbook: everything built so far, and what to do when a new site arrives

Owner: Gera. Last updated: 24 Nov 2026. UI rules: `docs/UX_RULES.md`.
Live app: https://technicalproductionportal.vercel.app (final address, decided 24 Nov 2026; `opd-integrated.vercel.app` is the former test address, do not give it to crews). Repo: `mmengineering-web/OPD-Integrated`.

> **No secrets in this file or in the repo.** Only Supabase publishable (anon) keys are in the code. A service-role key exists only as an auto-injected secret inside each Edge Function. Passwords are never stored.

This file is the one-page memory of the project. Detail lives in the other docs; the links are in section 13.

---

## 1. What OPD is, in five lines

1. One installable web app (PWA) for the mining company: one login for production, exploration and head-office data.
2. Next.js 16 static export, React 19, TypeScript, Tailwind v4, Dexie (offline), supabase-js 2, hosted on Vercel.
3. Login is **credential fan-out**: the same email and password exist in every Supabase project and the portal signs in to all of them in parallel.
4. Access is decided by the roles stored in each Supabase project (and by RLS there). The browser only hides or shows pages.
5. A super admin manages people from `/portal/admin/`. The page calls one Edge Function per project; nothing holds a service-role key in the browser.

---

## 2. The seven Supabase projects

| OPD id | What it is | Project ref | Role table | Admin function | Function secret | Browser storage key |
|---|---|---|---|---|---|---|
| `hub-prod` | Head office production hub | `yjytejxfkpvttomrpwvt` | `public.op_profile` | `op-admin-users` | none (default `op_profile`) | `sb-opd-hub-prod` |
| `hub-explo` | Explo Hub (head office exploration) | `nuymrirtigecyrosidga` | `dash.member` | `op-admin-users` | `PROFILE_MODE=dash_member` | `sb-opd-hub-explo` |
| `wkm-prod` | WKM production | `wjwiyxlcbvwbfodxoczz` | `public.op_profile` | `op-admin-users` | none | `sb-opd-wkm-prod` |
| `bm-prod` | BM production | `ucotnmgvkmpfvmqeksxy` | `public.op_profile` | `op-admin-users` | none | `sb-opd-bm-prod` |
| `tms-prod` | TMS production | `vsrnpmmwpvykaegwikap` | `public.op_profile` | `op-admin-users` | none | `sb-opd-tms-prod` |
| `wkm-explo` | WKM exploration | `yjhjlyeckoljhzjkxmmh` | `public.exp_profile` | `exp-admin-users` | none | `sb-exp-WKM` |
| `cdsm-explo` | CDSM exploration | `tebzrlygodzdtkytrzrp` | `public.exp_profile` | `exp-admin-users` | none | `sb-exp-CDSM` |

Planned sites with no project yet: IBN, TPB, AJB, CDS (all four), plus BM and TMS exploration. Their empty slots already exist in `src/lib/core/config.js` (`SITES`).

Where the keys live (publishable only): production and hubs in `src/lib/opd/config.js`; exploration sites and the Explo Hub in `src/lib/core/config.js`.

**Billing note:** prod.bm showed "Grace period is over". Fix the plan there before relying on it.

---

## 3. Roles

| Role in OPD | Can input | Edit master data | Manage users | Stored as in `op_profile` | in `exp_profile` | in `dash.member` (Explo Hub) |
|---|---|---|---|---|---|---|
| Viewer | no | no | no | `viewer` | `viewer` | `viewer` |
| Data entry | yes | no | no | `data_entry` | `geologist` | `data_entry` |
| Site admin | yes | yes | no | `site_admin` | `site_admin` | `admin` |
| Super admin | yes | yes | yes | `super_admin` | `super_admin` | `super_admin` |

- Mapping code: `dbRole(project, role)` in `src/lib/opd/admin-core.js`. `normalizeRole` maps `geologist` to data entry and `admin` to site admin on the way in.
- Only `super_admin` can manage users. The Explo Hub `admin` is a site admin, not a user manager.
- `exp_profile.input_forms` can limit a person to some forms (progress, collar, hours, sample). Empty means all.

---

## 4. Who sees which page

`AppFrame gate=...` and `canOpen()` in `src/lib/opd/auth-core.js`. Pages are listed once in `src/lib/opd/sitemap.tsx`.

| `need` value | Opens when |
|---|---|
| `any` | signed in with at least one usable account |
| `production` | a usable production project (head office or a site) |
| `exploration` | a usable exploration project |
| `ho-production` | a usable `hub-prod` account (the all-sites Dashboard) |
| `super_admin` | super admin in at least one project (User administration) |

"Usable" means the login worked and the profile is active.

Public pages (no login): Home, the hub landing pages, Tools (HPM Nickel, Calculators), Help.

The all-sites Dashboard embeds two Looker Studio reports: Production (`0063a62c-4550-4b4d-aaeb-b2e59c6c3914`) and Management (`0fc8101a-d0f7-40ed-86fa-7ad0115343d9`). Code: `src/components/opd/dashboard-view.tsx`.

---

## 5. The User administration page (`/portal/admin/`)

Code: `src/components/opd/users-admin.tsx` (UI), `admin-core.js` (pure logic, unit tested), `admin-api.js` (Supabase calls).

What it does: shows a matrix (people by project), and lets a super admin add, manage or delete a person across the projects they tick.

Rules enforced in the page, in the function, and (for `op_profile`) by a database trigger:

- Password at least 10 characters. Generated or typed. Shown once, with a Copy button, never stored.
- Same email and password go to every ticked project. Reset passwords only from this page. A password changed directly in one Supabase dashboard breaks that project's login for that person.
- You cannot delete yourself.
- The last active super admin of a project cannot be removed or demoted.
- If the profile row fails after the login is created, the new login is rolled back.
- Projects run in parallel. Steps inside one project run in order; after a failure the rest of that project is skipped. The result list shows every step.
- The page reads the cached access object. **After any role or user change, sign out and sign in again.**
- A project shows in the matrix only when you are super admin in it. Projects that cannot be read appear in a yellow box with the reason.

Edge Function `supabase/functions/op-admin-users/index.ts` actions: `list`, `create`, `update`, `reset_password`, `delete`. Verify JWT is **off** (the function checks the caller itself with `admin.auth.getUser(jwt)`, then the role table). Exploration sites use the older `exp-admin-users` (create, reset_password, delete) plus the RPC `exp_admin_upsert_profile`.

Hub members created from the page get `sites = null`, which `dash.my_sites()` treats as all sites. A per-site picker is not built yet.

---

## 6. One-time setup per project (condensed)

Full steps and checks: `docs/SUPERADMIN_SETUP.md`.

### A. Production project (Hub, WKM, BM, TMS, or a new one)

1. SQL Editor: run `supabase/sql/op_profile.sql` (rerunnable). It creates `op_profile`, RLS, the last-super-admin trigger, and backfills existing logins as `viewer`.
2. The Auth user for you must exist (Authentication, Users). Then promote yourself:
   `update public.op_profile set role = 'super_admin' where lower(email) = lower('you@example.com');`
3. Edge Functions: deploy `op-admin-users` (name exactly this) from `supabase/functions/op-admin-users/index.ts`.
4. Function settings: **Verify JWT off**.
5. Secrets: nothing to add. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected.

### B. Explo Hub (`dash.member`)

1. Deploy `op-admin-users`, Verify JWT off.
2. Secret `PROFILE_MODE` = `dash_member`.
3. Project Settings, Data API, Exposed schemas: add `dash`.
4. Grants for the function (all three are needed):
   ```sql
   grant usage on schema dash to service_role;
   grant select, insert, update, delete on all tables in schema dash to service_role;
   alter default privileges in schema dash grant all on tables to service_role;
   ```
5. Allow the four roles:
   ```sql
   alter table dash.member drop constraint member_role_check;
   alter table dash.member add constraint member_role_check
     check (role in ('viewer','data_entry','admin','super_admin'));
   ```
6. Your own row:
   ```sql
   insert into dash.member (user_id, email, role)
   select id, email, 'super_admin' from auth.users
   where lower(email) = lower('you@example.com')
     and not exists (select 1 from dash.member m where m.user_id = auth.users.id);
   ```
   Do **not** run `op_profile.sql` here. The Explo Hub uses `dash.member`, and `public.op_profile` does not exist there (expected).

### C. Exploration site (`exp_profile`)

1. `exp-admin-users` deployed, Verify JWT off.
2. Migration with `exp_admin_upsert_profile` applied.
3. Your row in `exp_profile` has `super_admin`.
4. Storage bucket `exp-photos` exists.

---

## 7. ADD A NEW SITE: checklist

Pick the type, then do every line. The grep at the end finds anything missed.

### 7.1 New production site (example id `xyz-prod`)

Supabase
- [ ] Create the project. Check billing is active.
- [ ] Create your Auth user (same email and password as everywhere).
- [ ] Run `op_profile.sql`, promote yourself (section 6A).
- [ ] Deploy `op-admin-users`, Verify JWT off.

Code
- [ ] `src/lib/opd/config.js`: add `"xyz-prod": { url, anonKey }` to `PROD`, and a project entry `{ id: "xyz-prod", name: "XYZ production", scope: "site", site: "XYZ", module: "production", profile: OP_PROFILE, ...PROD["xyz-prod"] }` to `PROJECTS`.
- [ ] `src/components/opd/users-admin.tsx`: add the id to `SHORT` and to the Production group in `GROUPS`. The column separators come from `GROUP_START`, which is computed from `GROUPS`, so nothing else needs editing.
- [ ] Text that lists sites: `src/components/opd/hubs.tsx` ("Sites with production", Uploads list) and `landing.tsx` (Production card text). `SITE_CODES` in `landing.tsx` already holds all eight codes; the Sites grid turns Live / Connected / Planned by itself.
- [ ] Tests: counts that assume 7 projects ("7 of 7" and the project lists in `tests/admin_e2e.mjs`, `tests/admin.test.mjs`, `tests/opd_e2e.mjs`, `tests/stub_supabase.mjs`). Update, then run all suites (section 11).

People
- [ ] `/portal/admin/`, Manage each person, tick the new project, Apply. Existing people do not get access automatically.
- [ ] Sign out and in again, check the matrix shows the new column.

Docs
- [ ] Add the row to section 2 here, to `docs/SUPERADMIN_SETUP.md`, and to README section 7.

### 7.2 New exploration site (example `BM`, `TMS`, `IBN`, `TPB`, `AJB`, `CDS`)

Supabase
- [ ] Create the project from the exploration migrations (same schema as WKM or CDSM), including `exp_profile`, `exp_admin_upsert_profile`, bucket `exp-photos`.
- [ ] Deploy `exp-admin-users`, Verify JWT off. Put your `super_admin` row in `exp_profile`.

Code
- [ ] `src/lib/core/config.js`: fill `SITES.<CODE>.url` and `anonKey`. The slot already exists.
- [ ] `src/lib/opd/config.js`: add `explo("<CODE>")` to `PROJECTS`. The id becomes `<code>-explo` and the storage key `sb-exp-<CODE>`.
- [ ] `users-admin.tsx`: `SHORT`, the Exploration group in `GROUPS`.
- [ ] `hubs.tsx` ("Sites live"). The local Dexie database `exploration_<CODE>` is created per site automatically. **Do not raise the Dexie version above 5.**
- [ ] Tests and docs as in 7.1.

Explo Hub
- [ ] Members with `sites = null` see all sites. Members with a `sites` array need the new code added. How the hub aggregates site data is defined in the hub SQL (`supabase/hub/` in the old explo-entry-next repo); check it before promising the site appears in "All sites".

### 7.3 Find anything missed

```bash
grep -rnE "tms-prod|TMS" src tests docs README.md
```
Replace TMS with a site you already added to see every file that lists sites, then mirror each hit for the new one.

### 7.4 After the change

1. `npm run test:unit`, then the browser suites (section 11).
2. Commit and push (section 9). Vercel redeploys on push.
3. Real check: sign in as yourself, open `/portal/admin/`, confirm "N of N" with no yellow box.

---

## 8. Day-to-day runbooks

| Task | Steps |
|---|---|
| Add a person | `/portal/admin/`, Add user, email, name, role, Generate password, tick projects, Plan, confirm, Apply, Copy the password once. Send it through a private channel. |
| Change a role or add a site to a person | Manage on the person, change role or tick/untick projects, Apply. They sign out and in. |
| Reset a password | Manage, Reset password (applies to every project they have). Never reset in one Supabase dashboard only. |
| Remove a person | Delete everywhere. You cannot delete yourself or the last super admin. |
| Someone says "no access" | Check the matrix row. Check `is_active`. Ask them to sign out and in. Check the password is the same in every project. |
| Update the Edge Function | See 8.1. |

### 8.1 Updating an Edge Function in the Supabase editor

1. Open the function, Code tab. Select all, delete, then paste the **whole** `index.ts` from the repo. Never merge by hand.
2. Deploy updates. Confirm.
3. The deploy error "Expected ',' ... DASH_ROLES" means line 19 lost a comma in the editor. The correct line is:
   `const DASH_ROLES = ["viewer", "data_entry", "admin", "super_admin"];`
4. After deploying, reload `/portal/admin/`. An old function gives "Only an active super admin can manage users." in the yellow box.

---

## 9. Shipping the web app

Windows working folder: `C:\Users\HUAYOU GROUP\Downloads\About Data\OPD` (must contain `.git`).

```bat
cd /d "C:\Users\HUAYOU GROUP\Downloads\About Data\OPD"
git add -A
git status
git commit -m "Describe the change"
git push
```

If Vercel says "Module not found: @/lib/...": `git add -f src/lib`. Vercel Hobby is non-commercial only; company use needs Pro or another host. Never deploy `out-test`.

---

## 10. Troubleshooting: every error seen so far

| Message or symptom | Cause | Fix |
|---|---|---|
| Matrix shows 2 of 7 | Your Auth user or role row is missing in the other projects | Create the Auth user with the same password, insert or update the role row, sign out and in |
| `select ... from auth.users` returns 0 rows | The Auth user does not exist in that project | Authentication, Users, add the user |
| `relation "public.op_profile" does not exist` in Explo Hub | Expected: the hub uses `dash.member` | Do not run `op_profile.sql` there |
| `syntax error at or near "<"` | `<name>` in a guide is a placeholder | Replace it with the real name (for example `member_role_check`) |
| `permission denied for schema dash` | `service_role` lacks usage on `dash` | Run all three grants in 6B |
| `Only an active super admin can manage users.` (Explo Hub) | Old function code or your row is not `super_admin` | Redeploy the current `index.ts`; check `dash.member` |
| `new row violates check constraint "member_role_check"` | Role list too short | Run the constraint change in 6B |
| Deploy fails: "Expected ','" at line 19 | A comma was lost while editing in the browser | Paste the whole file again (8.1) |
| `Edge Function "op-admin-users" is not deployed in <project>` | 404 | Deploy it (6A step 3) |
| `Invalid session.` or 401 | Stale session or Verify JWT on | Sign out and in; turn Verify JWT off |
| `The schema must be one of the following` | `dash` not exposed | Expose it (6B step 3) |
| `A user with this email address has already been registered` | Login already exists there | Manage the person and tick the project instead of adding |
| Dashboard tile locked | No usable `hub-prod` account | Add an `op_profile` row in the Hub project |
| Billing banner "Grace period is over" (prod.bm) | Supabase plan lapsed | Fix the plan or the project may pause |

---

## 11. Testing

All run against a fake Supabase stub. Nothing here has touched the real projects.

```bash
npm run test:unit            # admin.test.mjs (13 tests), masks.test.mjs (13 tests) plus auth, rules, QC, calc, 3D, HPM
npm run build:test           # builds out-test with the stub (never deploy)
python3 -m http.server 8801 -d out-test &
node tests/opd_e2e.mjs       # 108 checks
node tests/admin_e2e.mjs     # 40 checks
node tests/ux_e2e.mjs        # labels, page search, input masks, phone (port 4175)
CHROME=/usr/bin/google-chrome python3 tests/e2e.py   # plus e2e_data, e2e_dash, e2e_forms, e2e_3d, e2e_sw
```

The stub (`tests/stub_supabase.mjs`) supports `functions.invoke`, `window.__fnDb`, `__fnFail`, `__fnDown`, `__fnLog` and the `exp_admin_upsert_profile` RPC.

**Not yet verified for real:** creating, updating and deleting a user through the page against the live projects. Do the throwaway-user test (section 12, item 1).

---

## 12. Open items

1. **Write test with a throwaway user:** Add user (Data entry), tick Explo hub plus one site, Apply, sign in as that user in a private window, then Delete everywhere. Report any red message word for word.
2. Does the Explo Hub dashboard treat `data_entry` differently from `viewer`? Unknown. Check the hub policies and functions.
3. Per-site picker for Explo Hub members (`sites` array): offered, not built.
4. (Done) Column separators in `users-admin.tsx` are now computed from the groups.
5. Production Data Inputs (daily report upload, Phase 4): needs sample files for WKM, BM, TMS.
6. Next tools: Drillhole Analysis, Hauling Cost, Revenue Projection.
7. Dashboard Guideline PDF (12 MB) not yet added to Production Guidelines.
8. Kepmen 363/2026 versus 144/2026: confirm which applies to the HPM calculator. Live HMA sheet check still open.
9. Real-account cutover smoke test and real-phone tests (`docs/PHONE_TESTS.md`).
10. Vercel Pro (or other host) before company use.

---

## 13. Decisions to remember

- Credential fan-out, not SSO. One email and one password in every project.
- Super admin only through the Edge Function. No service-role key in the browser, ever.
- Explo Hub keeps `dash.member`. Moving it to `op_profile` was considered and not recommended.
- Four roles everywhere: viewer, data entry, site admin (Explo Hub: `admin`), super admin.
- Verify JWT is off on the admin functions; they verify the caller themselves.
- Dexie schema stays at 5 until the old app is retired. Legacy storage keys must keep working.
- Language: English for documentation and answers; the Exploration UI text is still Indonesian.
- One zip per phase, complete files for code revisions.

### Other documents

| File | Content |
|---|---|
| `README.md` | Full technical README (routes, architecture, tests, deploy) |
| `docs/SUPERADMIN_SETUP.md` | Per-project setup and troubleshooting for user administration |
| `docs/UX_RULES.md` | Colour meaning, masks, button wording, spacing, short labels, motion (scroll reveal, page wipe) |
| `docs/OPD_CONTEXT.md` | Concept and memory (older) |
| `docs/OPD_PHASE1.md` | Phase 1 notes |
| `docs/CUTOVER.md` | Domain swap, rollback, retirement runbook |
| `docs/PHONE_TESTS.md` | Phone test checklist |
| `supabase/sql/op_profile.sql` | Role table for production projects |
| `supabase/functions/op-admin-users/index.ts` | Admin Edge Function |

- **UX (23 Nov 2026):** colour meaning, masks, button wording, spacing and short labels are fixed in `docs/UX_RULES.md`. Menu names: Users, Uploads, Guides, Data Entry, Maps, Requests, Tools. The page search (Ctrl/Cmd+K) is hidden in the Exploration app, which has its own palette.
- **Motion (23 Nov 2026):** scroll reveal plus a page wipe, both off for reduced motion and for the Exploration app. The reference sites (rorvexo, skyline.web.id) could not be read, so this is a general version; tune it in `docs/UX_RULES.md` section 7.
