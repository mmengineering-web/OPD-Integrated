# User administration: what to do in each Supabase project

The page `/portal/admin/` creates a person once and then creates the same account (same email and password) in every project you tick. It never holds a service-role key. Each project runs an Edge Function that holds the key as a secret and checks that the caller is an active super admin.

| Project | Id in OPD | Role table | Function | `PROFILE_MODE` |
|---|---|---|---|---|
| Hub (HO production) | `hub-prod` | `public.op_profile` | `op-admin-users` (new) | `op_profile` (default) |
| WKM production | `wkm-prod` | `public.op_profile` | `op-admin-users` (new) | `op_profile` |
| BM production | `bm-prod` | `public.op_profile` | `op-admin-users` (new) | `op_profile` |
| TMS production | `tms-prod` | `public.op_profile` | `op-admin-users` (new) | `op_profile` |
| Explo Hub (HO exploration) | `hub-explo` | `dash.member` | `op-admin-users` (new) | `dash_member` |
| WKM exploration | `wkm-explo` | `public.exp_profile` | `exp-admin-users` (already there) | none |
| CDSM exploration | `cdsm-explo` | `public.exp_profile` | `exp-admin-users` (already there) | none |

Files in this repo: `supabase/sql/op_profile.sql`, `supabase/functions/op-admin-users/index.ts`.

## A. The four production projects (Hub, WKM, BM, TMS)

Do these steps once in each project.

1. **Create the role table.** SQL Editor, paste `supabase/sql/op_profile.sql`, Run. It creates `op_profile`, the read policies, the "last super admin" trigger, and adds every existing login as `viewer`. If `op_profile` already exists with other columns, stop and send me its columns before running anything.
2. **Make yourself super admin** (edit the email, run once):
   `update public.op_profile set role = 'super_admin' where lower(email) = lower('your-email@example.com');`
   Check: `select email, role, is_active from public.op_profile;`
3. **Deploy the function.** Edge Functions, Deploy a new function, Via Editor. Name it exactly `op-admin-users`, paste `supabase/functions/op-admin-users/index.ts`, Deploy. With the CLI instead: `supabase functions deploy op-admin-users --project-ref <ref> --no-verify-jwt`.
4. **Turn Verify JWT off** for `op-admin-users` (function settings). The function verifies the caller itself; with it on, the browser call can be rejected before the code runs.
5. **Secrets.** Nothing to add. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase. `PROFILE_MODE` is not needed here because the default is `op_profile`.

Project refs (from the public URLs in `config.js`): Hub `yjytejxfkpvttomrpwvt`, WKM `wjwiyxlcbvwbfodxoczz`, BM `ucotnmgvkmpfvmqeksxy`, TMS `vsrnpmmwpvykaegwikap`.

## B. Explo Hub (`hub-explo`)

1. Deploy `op-admin-users` exactly as in A.3 and A.4.
2. **Secret:** Edge Functions, Secrets, add `PROFILE_MODE` = `dash_member`.
3. **Expose the `dash` schema:** Project Settings, API (Data API), Exposed schemas, add `dash`, Save.
4. **Check the member table:** `select * from dash.member limit 5;` The function assumes the columns `email`, `name` and `role` (roles `admin` or `viewer`). If yours differ, send me the output and I adjust one function.
5. **Add yourself as admin** if you are not there: `insert into dash.member (email, name, role) values ('your-email@example.com', 'Your name', 'admin');` (or update your row to `admin`).
6. The Explo Hub has only two roles. Site admin and Super admin become `admin`; Viewer and Data entry become `viewer`.

## C. WKM and CDSM exploration

Nothing new. Check three things:

1. `exp-admin-users` is deployed and Verify JWT is off (the Exploration Settings page already uses it).
2. Migration 0004 is applied, so `exp_admin_upsert_profile` exists.
3. Your account is `super_admin` there: `select email, role from public.exp_profile where lower(email) = lower('your-email@example.com');`

## D. Your own account, and first test

1. Sign in to OPD with the same email and password in every project you want to manage. A project only appears in the matrix when you are super admin in it. Sign out and in again after changing your role, so the access object is refreshed.
2. Open `/portal/admin/`. Every project you cannot read shows in a yellow box with the reason. "not deployed" means step A.3 or B.1 is missing in that project; any other message comes from the function.
3. Add a test user in one project first, check that they can sign in, then delete them.

## E. Rules the page and functions enforce

- Password at least 10 characters, shown once after creating, never stored.
- The same email and password go to every ticked project. Reset passwords from this page only; a password changed directly in one Supabase dashboard breaks that project's login.
- You cannot delete yourself. The last active super admin of a project cannot be deleted or demoted (page, function and, for `op_profile`, a database trigger).
- If the profile row cannot be saved after the login is created, the new login is removed again.
- Projects run in parallel. Inside one project the steps run in order, and after a failure the rest of that project is skipped. The result list shows every step.

## F. Troubleshooting

| Message or symptom | Cause and fix |
|---|---|
| `Edge Function "op-admin-users" is not deployed in <project>` | Deploy it (A.3). |
| `Only an active super admin can manage users.` | You are not `super_admin` in that project's table (A.2, B.5). |
| `Invalid session.` or a 401 | Sign out and in again. Check that Verify JWT is off. |
| `relation "public.op_profile" does not exist` | Run the SQL (A.1). |
| `The schema must be one of the following` or a `dash` error | Expose the `dash` schema (B.3). |
| `A user with this email address has already been registered` | That project already has the login. Open Manage on the person and tick the project instead of adding again. |
| Dashboard tile locked | The all-sites Dashboard needs a usable Hub production account (`op_profile` row in the Hub project). |
