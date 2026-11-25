# One Portal Data (OPD)

One installable web app (PWA) for a mining company: **one login** for production, exploration and head-office data across sites, with an offline-first Exploration data-entry app built in.

- Live: https://technicalproductionportal.vercel.app
- Repo: https://github.com/mmengineering-web/OPD-Integrated
- Owner: Gera. Portfolio project (non-commercial), but built to be fully functional.
- Version: **4.4.0** (Phase 4, step 4.4; Python reader `public/etl/manifest.json` 4.4-6). Last updated: 24 Nov 2026

> **Security.** This repository contains only Supabase **publishable (anon) keys**, which are safe in a browser because access is enforced by Row Level Security. Never commit a service-role key, a database connection string, a password, a `.env`, or any site data (master workbooks, `*.ndjson` dumps, daily reports). `.gitignore` blocks the common ones. Site data and user names must stay out of this public repo.

---

## Contents

1. [What OPD is](#1-what-opd-is)
2. [Status and roadmap](#2-status-and-roadmap)
3. [Tech stack](#3-tech-stack)
4. [Routes and user flow](#4-routes-and-user-flow)
5. [Architecture](#5-architecture)
6. [Authentication design](#6-authentication-design)
7. [The Supabase projects](#7-the-supabase-projects)
8. [Exploration app](#8-exploration-app)
9. [Offline and sync](#9-offline-and-sync)
10. [Design system](#10-design-system)
11. [Repository layout](#11-repository-layout)
12. [Getting started](#12-getting-started)
13. [Testing](#13-testing)
14. [Deployment (Vercel)](#14-deployment-vercel)
15. [Pushing changes with Git (Windows)](#15-pushing-changes-with-git-windows)
16. [Constraints and rules](#16-constraints-and-rules)
17. [Known limits and open items](#17-known-limits-and-open-items)
18. [Further documents](#18-further-documents)

---

## 1. What OPD is

Mining operations produce data in separate places: daily production reports, drilling and sampling in the field, head-office summaries. OPD puts them behind one address and one login.

| Area | What it gives |
|---|---|
| **Portal** | One sign-in. Tiles per site and module (Production, Exploration), greyed out where the person has no usable account. |
| **Exploration** | Offline-first field data entry (collars, drilling progress, distribution hours, samples), import, reports, dashboard, data QC, map, 3D drill holes. |
| **Production** | Dashboard (Looker), guides, and **Uploads** (Phase 4): the site's daily file is read in the browser and loaded into `etl_*` tables. WKM and BM: Daily Report PDF. TMS: Daily Production Report `.xlsx`, Realisasi Barging `.xlsx`, stock register `.xlsx`, hazard inspection `.docx`. Test mode (shadow) until the owner switches a site live. See `docs/OPD_UPLOAD_MODULE.md`. |
| **Head office / Hub** | Planned (Phase 5): all-sites view, documents, tools, help. |

Sites in scope: WKM, CDSM, BM, TMS, IBN, TPB, AJB, CDS. Only WKM and CDSM have an exploration project today; BM, TMS and WKM have production projects. The rest show as "Planned" on the home page.

---

## 2. Status and roadmap

| Phase | Scope | State |
|---|---|---|
| 1 | Login foundation: `/login/`, portal, `/explo/`, legacy bridge, service worker, security headers. Redesign: Laterite/Strata palette, public landing page, interactive hero deck, mobile fixes, breadcrumbs. | **Done** |
| 2 | Exploration uses the portal session (`attachSession`), site switcher, guest mode kept, portal sign-out clears Exploration server data, Portal › Exploration breadcrumb. | **Built and tested on the fake backend** (real-account and phone tests still open) |
| 3 | Cutover: same address, data stays on phones. See `docs/CUTOVER.md`. | Prepared |
| 4 | Production upload without Excel: browser-side parsers (Pyodide) for WKM/BM/TMS, `etl_01` to `etl_05` SQL, shadow (test) mode, compare, undo. Steps 4.1 to 4.4 built; 4.5 (compare week and go-live per site) not started. | **Built, test mode** (compare week next) |
| 5 | Hub / All sites, documents, tools, help. | Planned |

Phase 4 detail and the per-step status are in `docs/PHASE4_EXCEL_FREE_DESIGN.md`; the operator and admin guide is `docs/OPD_UPLOAD_MODULE.md`.

Optional follow-ups: mobile menu for the landing nav links (hidden under 768 px today).

---

## 3. Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (static export, `trailingSlash: true`), React 19, TypeScript |
| Styling | Tailwind CSS v4, shadcn-style hand-written components, CSS custom-property tokens |
| Fonts | Newsreader (headings, OFL, `next/font/local`), Geist and Geist Mono (body) |
| Motion | `motion` library plus CSS transforms driven by custom properties |
| Local data | Dexie 4 (IndexedDB), one database per site |
| Backend | Supabase (`@supabase/supabase-js` 2): Auth, Postgres with RLS, Storage, one Edge Function |
| Maps and charts | Leaflet 1.9.4, Chart.js, shpjs (all vendored in `public/vendor/`) |
| Documents | jsPDF, pdf.js, SheetJS mini (vendored) |
| Upload reader | Pyodide 0.27.2 (Python in a web worker; pdfplumber, openpyxl, python-docx) loaded from `public/etl/` on first use |
| 3D | three.js + react-three-fiber (lazy chunk, only when the 3D tab opens) |
| Hosting | Vercel (static `out/` folder) |
| PWA | Custom service worker generated after build, web app manifest |

---

## 4. Routes and user flow

| Route | Purpose | Notes |
|---|---|---|
| `/` | Public landing page | Hero with interactive card deck, Modules, Sites, How it works. Never forces a login. |
| `/login/` | OPD login | One email and password. Returns to `/portal/` by default. `?next=` accepts same-origin paths only. |
| `/portal/` | Signed-in home | Module and site tiles. Signed out, it redirects to `/login/?next=/portal/`. |
| `/explo/` | Exploration app | `?site=WKM` preselects the site. Guest mode available. |
| `/production/` | Production hub (public landing) | Cards: Dashboard, Uploads, Guides. |
| `/production/dashboard/`, `/production/data-inputs/`, `/production/guidelines/` | Production data pages | Login + a usable production account. `data-inputs` is the Upload page (data entry and above, own site only). |
| `/exploration/` | Exploration hub (public landing) | Cards: Field Data Entry (`/explo/`), Request Data, Interactive Maps. |
| `/exploration/request-data/`, `/exploration/maps/` | Exploration data pages | Login + a usable exploration account. |
| `/documents/` | Documents hub (public landing) | Cards: Reports, SOPs, Templates. |
| `/documents/reports/`, `/documents/sops/`, `/documents/templates/` | Document pages | Login (any account). Placeholders until Phase 5. |
| `/tools/` | Tools hub (public landing) | Calculators and HPM Nickel open now; Drillhole Analysis, Hauling Cost, Revenue Projection planned. |
| `/portal/admin/` | User administration | Super admins only. Matrix of people by project, add, manage and delete. Logic in `src/lib/opd/admin-core.js` (unit tested), calls in `admin-api.js`. Needs the Edge Function and SQL in `supabase/`; setup per project is in `docs/SUPERADMIN_SETUP.md`. |
| `/production/dashboard/` | All-sites dashboard | Looker Studio reports (Production, Management). Opens only for accounts with a usable Hub production project (`hub-prod`). |
| `/tools/hpm-nickel/` | HPM Nickel Calculator | Public. Kepmen ESDM 363.K/2026. Logic in `src/lib/core/hpm.js` (unit tested). Reads HMA prices from the public Google Sheet, falls back to a built-in table offline. PDF via the vendored jsPDF. |
| `/tools/calculators/` | Calculators | Public: UTM and lat/lon, volume to wet and dry tonnes. |
| `/help/` | Help (public) | Contacts and FAQ. |

**Menu.** Every page shares one menu: Home, Production, Exploration, Documents, Tools, Help (`AppFrame` and `AppNav` in `src/components/opd/app-frame.tsx`). Each item opens a public landing page; nobody is asked to log in just to look.

**Layout.** Every page, including Home and the Exploration data-entry app, renders inside one shell (`src/components/opd/shell.tsx`): a floating, rounded sidebar with a profile block, tile icons, nested pages and an offline notice (full tree on desktop, icon rail when collapsed; the toggle is in the top bar and is remembered in `opd_side`; a drawer on phones, Escape closes it) and breadcrumbs. There is no top menu: the sidebar is the navigation, and the top bar holds the toggle, theme and account. Pages are listed once, in `src/lib/opd/sitemap.tsx`; the menu and sidebar both read it. A lock marks pages your accounts cannot open. The login page has breadcrumbs only. Opening Field Data Entry while signed out skips any login: it shows the site picker and "Start offline data entry", with an optional link to the OPD login. Home links to Exploration, Production, Documents, Tools and Portal. A search button in the top bar (Ctrl/Cmd+K) jumps to any page by typing or scrolling; Pages reveal block by block as you scroll and a page wipe plays between pages (both off for reduced motion). UI rules are in `docs/UX_RULES.md`. Hover and press effects live in `globals.css` (`lift`, `tap`, `nudge`, `skeleton`) and respect reduced motion. To add a page, add it to the sitemap and create its route.

**Guest entry.** "Exploration entry without signing in" on the OPD login asks for the site first (cards, nothing preselected), stores `exp_guest_site`, and opens `/explo/?site=<SITE>` straight in data entry, with the site shown in the header and an offline strip ("Salah site? Ganti site"). The Exploration login uses the same site cards and remembers the last site (`exp_last_site`).

**Analysis pages.** Dashboard, Data QC, Interactive Maps and 3D Hole are OPD pages under Exploration (`/exploration/dashboard/`, `/data-qc/`, `/maps/`, `/3d-hole/`), not tabs of Field Data Entry. Each needs an exploration account, shows a site picker with only the sites that account can open, attaches that site's portal session (`attachSession`) and renders the same view components. Field Data Entry keeps Input, Data and Settings tabs.

**Page access.** A page that shows data is wrapped in `AppFrame gate="production" | "exploration" | "any"`. Signed out, it goes to the OPD login (`/login/?next=<page>`, never the Exploration login) and returns after sign-in. Signed in, `canOpen()` in `auth-core.js` checks the person's accounts; if none qualifies the page shows "You don't have access to this page". `any` = signed in with at least one usable account; `production` / `exploration` = a usable project of that module (head office or a site).

Flow: **Home → Log in → Portal → Exploration (or Production)**. Breadcrumbs show the path (Home › Log in, Home › Portal). Sign-out lands on `/`.

Phones that already have the old standalone Exploration login (or guest mode) are sent from `/` straight to `/explo/`, so nobody is forced to log in again.

**Landing page details**

- Hero: headline "One login for every site and module", buttons *Start here* and *Explore*.
- Deck: three cards (Exploration → `/explo/`, Head office → `/portal/`, Production = coming soon). Pointer drag with a 6 px move threshold before capture, 48 px swipe threshold, dots, arrow keys, tap a side card to bring it forward. Built with CSS variables `--k`, `--ak`, `--d` and `calc()`, `touch-action: pan-y`. No hover tilt.
- Sites grid derives Live / Connected / Planned from `exploProject` and `PROJECTS`.
- Header shows *Log in* and *Get started* (scrolls to How it works, because accounts are created by a super admin). When signed in it shows the person's name and *Open portal*.

---

## 5. Architecture

```
Browser (PWA)
 ├─ Landing / Login / Portal      src/components/opd/*       React, client-side
 ├─ Exploration app               src/components/*, src/lib/core/*
 │    ├─ Dexie  exploration_<SITE>   (offline store + outbox)
 │    └─ sync.js  ── supabase-js ──► site Supabase project
 ├─ OPD session                   src/lib/opd/*   fan-out sign-in, localStorage.opd_access
 └─ Service worker  sw.js         caches every page, falls back to "/"

Vercel: serves out/ (static). No server code.
Supabase: 7 projects (see section 7). RLS decides what each person can read or write.
```

Key points:

- **Static export.** There is no Node server. Everything runs in the browser against Supabase.
- **Core is plain JS.** `src/lib/core/*.js` is the offline core carried over from the v2.0.0 vanilla app (db, sync, validate, rules, defs, config, geometry, QC and dashboard calculations). It is loaded lazily through `core()` in `src/lib/boot.ts`.
- **Pure auth logic.** `src/lib/opd/auth-core.js` has no DOM and no network of its own. Supabase calls are injected, so it is unit-tested with fakes.
- **Same origin.** One origin keeps existing sessions and local databases valid across the move.

---

## 6. Authentication design

OPD uses **credential fan-out**, not federated SSO. The same email and password exist in every Supabase project. The portal signs in to all of them in parallel.

- 10 second timeout per project.
- Per-project state: `ok`, `noprofile`, `inactive`, `invalid`, `unreachable`, `unconfigured`.
- Login succeeds if **at least one** project accepts the credentials.
- A profile read error does not lock anyone out. The database RLS decides.
- Result is stored as `localStorage.opd_access` (`{ v, at, email, name, projects, ok, failures }`).
- Sign-out uses scope `local`: other devices stay signed in.
- Redirects go through `safeNext`: same-origin paths only, no scheme, no `//`, no backslash, no `..`, no control characters.

### Roles

| Role | DB value | Can input | Can edit master data | Manages users |
|---|---|---|---|---|
| Viewer | `viewer` | no | no | no |
| Data entry | `data_entry` (legacy `geologist`) | yes | no | no |
| Site admin | `site_admin` (Explo Hub `admin`) | yes | yes | no |
| Super admin | `super_admin` | yes | yes | yes |

`exp_profile.input_forms` can limit a person to some forms (progress, collar, hours, sample). An empty or missing list means all forms. This is a UI check; the database still enforces access.

### Storage keys

| Key | Meaning |
|---|---|
| `opd_access` | Portal access object |
| `sb-opd-<project id>` | Supabase session for a portal project |
| `sb-exp-<SITE>` | Exploration session, kept from the old app so signed-in phones stay signed in |
| `exp_session`, `exp_guest_site`, `exp_last_sync_<SITE>` | Legacy Exploration keys; must keep working |

### Phase 2 (Exploration on the portal session)

Built: `attachSession` (portal session, no second login, offline-safe), site switcher, portal sign-out purges Exploration server data, Portal › Exploration breadcrumb, Dexie stays at 5. See `src/lib/core/sync.js`, `src/components/app-shell.tsx`, `src/lib/opd/session.js`.

---

## 7. The Supabase projects

Seven projects sit behind the single login. Only **publishable keys** appear in the code (`src/lib/opd/config.js`, `src/lib/core/config.js`).

| id | What | Profile source | Storage key |
|---|---|---|---|
| `hub-prod` | Head office production hub | `op_profile` | `sb-opd-hub-prod` |
| `hub-explo` | Explo Hub (HO exploration) | `dash.me()` returns email, role, sites[] | `sb-opd-hub-explo` |
| `wkm-prod`, `bm-prod`, `tms-prod` | Site production | `op_profile` | `sb-opd-<id>` |
| `wkm-explo`, `cdsm-explo` | Site exploration | `exp_profile` (full_name, role, is_active, input_forms) | `sb-exp-WKM`, `sb-exp-CDSM` |

Planned exploration sites (BM, TMS, IBN, TPB, AJB, CDS) have no project yet. A project with an empty URL or key is "unconfigured": the portal skips it and greys the module out.

**Edge Function** `exp-admin-users`: creates, deletes and resets users. Verify JWT is off; the function itself checks that the caller is an active super admin.

**Storage bucket:** `exp-photos`.

---

## 8. Exploration app

Offline-first field data entry and analysis for drilling programmes. UI text is currently Indonesian.

| Tab | What it does |
|---|---|
| Progress | Drilling progress with dynamic rules (for example core result for coring holes, downtime reason when downtime > 0) |
| Collar | Planned and as-built collars, GPS position and accuracy, photos |
| Distribution Hour | Rig hours and downtime |
| Sample | Sample registration |
| Data Records | Lists, filters, sort, Excel and photo backup, soft delete |
| Laporan | Copyable and shareable daily report |
| Import Data | Excel template import with preview (ready / warning / rejected); lab RoA PDF import |
| Pengaturan | Rigs, prospects, code lists (drag order), parameters, users and roles |
| Dashboard | KPIs, charts with Chart/Table toggle, collar map, Excel and PDF export |
| Data QC | Issues, QAQC geochemistry, Lab Analysis sheets, editable thresholds, Excel downloads |
| Peta | Leaflet map, layer panel, shapefile and GeoJSON upload (device-only), PDF map export |
| 3D Hole | Minimum-curvature drill paths, colour by Class / Ni / Fe / MgO, vertical exaggeration, low-power SVG fallback |

Behaviour notes:

- Lab Analysis parameters (28 yellow cells plus a small form for sample flow days, dip deviation and GPS accuracy) are saved in `exp_setting` key `qaqc_thresholds`. Admins and super admins can edit; Reset restores defaults.
- 3D starts in "Plan + section" on low-power devices (no WebGL, 2 cores or fewer, 2 GB or less, or reduced motion). The scene renders on demand only.
- A code list the site database does not define falls back to built-in codes. A deactivated list stays empty.
- Dashboard, Data QC, Peta (basemap tiles) and 3D need internet. Input and sync work offline.
- The v2.0.0 "All sites" hub dashboard is not ported.

---

## 9. Offline and sync

- **Local database:** Dexie `exploration_<SITE>`, **schema version 5**. Do not add `db.version(6)` or higher until the old app is retired. An older app cannot open a newer local database, so a rollback would fail on upgraded phones.
- **Outbox:** every save writes the record and an outbox entry in one transaction. `sync.js` sends the outbox when online. The header chip shows `online - N pending`.
- **Guest mode:** input without login; records are sent after the next normal login.
- **Purge on logout:** `purgeServerData()` deletes cached collars, progress, hours, surveys, samples, assays and photos that are not waiting in the outbox. Reference data (rigs, prospects, codes, settings) and uploaded map layers stay.
- **Service worker:** `public/sw.template.js` becomes `out/sw.js` with a content-hash cache name (`opd-<hash>`). It caches each page under its own path, falls back to `/` offline, removes old `exp-pwa-*` caches and shows "A new version is ready" after a release.
- **iOS limits:** no background sync, and Safari may clear site data after about 7 days without use. Ask iPhone users to sync before a long break.

---

## 10. Design system

Direction: **Laterite / Strata**, a mining-appropriate palette with orange meaning "act".

| Token | Light | Dark |
|---|---|---|
| `--success` | `#166534` | n/a (see `globals.css`) |
| `--warning` | `#8a5a00` | `#facc15` |
| `--danger` / `--destructive` | `#a61b2b` | `#ff6b7a` |
| `--info` | `#1e4fa8` | n/a |
| `--link` | `#1e4fa8` | `#7aa8ff` |

Rules:

- Status colours do not collide: orange = action, ochre = warning, crimson = danger, blue = link/info.
- Contrast measured against WCAG: all pairs about 5:1 or better, most 6.8:1 or better.
- `--chart-2` stays amber because dashboards use it as the "warn" series. `--accent-brand` stays orange (active nav marks).
- No violet. No hover tilt. Hero entrance uses the `.enter` class once on load. `prefers-reduced-motion` is respected.
- Headings in Newsreader, body in Geist. Tokens live in `src/app/globals.css` (light and dark) and map through `@theme inline`.
- Components in `src/components/ui/` are hand-written in the shadcn style (button, card, command, input, label). `npx shadcn add` still works.

---

## 11. Repository layout

```
OPD/
├─ README.md                    this file
├─ docs/                        handbook, context, upload module, Phase 4 design, cutover, phone tests, UX rules
├─ supabase/
│   ├─ sql/                     op_profile.sql, etl_01 to etl_05 (run per site project, in order)
│   └─ functions/op-admin-users Edge Function (user administration)
├─ public/
│   ├─ etl/                     upload reader: worker, manifest (version), Python parsers, site configs, wheels
│   ├─ manifest.webmanifest
│   ├─ sw.template.js           service worker source
│   └─ vendor/                  Chart.js, jsPDF, pdf.js, SheetJS, shpjs, Leaflet
├─ scripts/make-sw.mjs          builds out/sw.js after next build
├─ scripts/etl/                 desktop-side tools: seed_history.py, parity and formula checks (need local site masters, never committed)
├─ src/
│   ├─ app/                     routes: page.tsx (/), login, portal, explo, layout, globals.css
│   ├─ components/
│   │   ├─ opd/                 landing, opd-login, portal-home, breadcrumb
│   │   ├─ ui/                  button, card, command, input, label
│   │   └─ *.tsx                Exploration app: app-shell, forms, dashboard, qc, map, 3D, admin...
│   ├─ fonts/                   Geist, Geist Mono, Newsreader (+ OFL license)
│   └─ lib/
│       ├─ boot.ts              lazy core() loader and openSite
│       ├─ opd/                 auth-core, config, profile, session, admin-core, etl-client
│       └─ core/                db, sync, validate, rules, defs, geo3d, dash/, qc/, lab/, roa/, map...
├─ tests/                       unit (.mjs), browser e2e (.mjs, .py), fake Supabase stub
├─ next.config.ts   vercel.json   package.json
```

---

## 12. Getting started

Requirements: Node 20+ and npm.

```bash
npm install
npm run dev            # local dev server
npm run build          # production static export -> out/ + out/sw.js
npm run build:test     # TEST build -> out-test/ with a fake Supabase (never deploy)
npm run test:unit      # all unit tests
```

Configuration: Supabase URL and publishable key per project in `src/lib/opd/config.js` and `src/lib/core/config.js`. Leave a project's URL or key empty to mark it "not connected".

---

## 13. Testing

| Test | Command | Covers |
|---|---|---|
| Unit | `npm run test:unit` | OPD auth (fan-out, roles, `safeNext`, portal model), rules evaluator, RoA/QC, dashboard calc, 3D geometry, admin, masks, upload client (`etl_client`) |
| Portal e2e | `node tests/opd_e2e.mjs` | Public home, deck interactions, login, portal redirect, breadcrumbs, sign-out, offline paths |
| Exploration e2e | `python3 tests/e2e.py`, `e2e_data.py`, `e2e_dash.py`, `e2e_forms.py`, `e2e_3d.py`, `e2e_sw.py` | Shell, forms, records, import, settings, dashboard, QC, map, 3D, service worker takeover |
| ETL SQL | `tests/etl_*_test.sql` | Run on a scratch Postgres 16 (core, history, safety S1-S7) |
| Live smoke | `python3 tests/live_smoke.py` | Read-only check of the real site; credentials from environment variables on your own computer |
| Phones | `docs/PHONE_TESTS.md` | Android and iPhone checklist |

To run the browser tests: `npm run build:test`, serve `out-test/` on port 8801, then run the scripts (Exploration scripts use base path `/explo/`).

**Never deploy `out-test`.** It uses a fake Supabase client.

---

## 14. Deployment (Vercel)

- `vercel.json`: framework none, build `npm run build`, output `out`.
- Headers: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `frame-ancestors 'none'`. `sw.js` and the manifest are never cached; `/_next/static/*` is immutable for a year.
- Vercel Hobby is for non-commercial use only. Moving to company use needs Pro or another host.
- Common failure: *Module not found: `@/lib/...`* means `src/lib` was not pushed (it can be hidden by a global ignore rule). Fix with `git add -f src/lib`.

Cutover from the old vanilla app (same address vs new address, rollback, retirement) is in `docs/CUTOVER.md`.

---

## 15. Pushing changes with Git (Windows)

Working folder: `C:\Users\HUAYOU GROUP\Downloads\About Data\OPD`. It must be the repo itself (it contains `.git`).

One-time setup:

```bat
cd /d "C:\Users\HUAYOU GROUP\Downloads\About Data\OPD"
git init
git branch -M main
git remote add origin https://github.com/mmengineering-web/OPD-Integrated.git
git fetch origin
git reset origin/main
git add -A
git add -f src/lib
git commit -m "Sync local OPD"
git push -u origin main
```

Every later change (after you extract a new zip into the folder):

```bat
cd /d "C:\Users\HUAYOU GROUP\Downloads\About Data\OPD"
git add -A
git status
git commit -m "Describe the change"
git push
```

Vercel redeploys on each push.

---

## 16. Constraints and rules

- **Dexie stays at version 5** until the old app is retired.
- **Keep legacy keys working** (`exp_session`, `exp_guest_site`, `exp_last_sync_<SITE>`, `sb-exp-<SITE>`).
- **No secrets in the repo.** Publishable keys only.
- **Open redirects blocked** by `safeNext`.
- **English** for project documentation (the Exploration UI is still Indonesian).
- **Every phase is documented**, tested and shipped as one zip.
- Quality target for any ML work in the wider project: above 93% precision, recall and F1 (not part of OPD).

---

## 17. Known limits and open items

- A password that differs in one project looks like "no account" there; that module is greyed out.
- Roles on the portal come from profile tables; RLS still decides what is allowed.
- The production profile table is `op_profile` (`supabase/sql/op_profile.sql`). A project without it shows "No profile".
- Phase 4: compare week and go-live (step 4.5) not started. The preview is read-only; TMS hazard closures of earlier findings and TMS plan Replace are not built. First download of the reader is about 35 MB; not yet measured on site internet or a phone.
- Explo Hub "All sites" tab: verify with a real hub account.
- Only a fake backend has been exercised in automated tests. A real-account smoke test against the live projects, and real-phone tests, are still open.
- Landing nav links are hidden under 768 px; a mobile menu is not built yet.

---

## 18. Further documents

| File | Content |
|---|---|
| `docs/OPD_HANDBOOK.md` | One-page memory: projects, roles, setup per project, new-site checklist, troubleshooting |
| `docs/OPD_CONTEXT.md` | Concept, decisions and memory |
| `docs/OPD_UPLOAD_MODULE.md` | Upload module: operator guide, architecture, test mode, go-live |
| `docs/PHASE4_EXCEL_FREE_DESIGN.md` | Phase 4 design and per-step status |
| `docs/SUPERADMIN_SETUP.md` | User administration setup per project |
| `docs/UX_RULES.md` | UI rules |
| `docs/CUTOVER.md` | Domain swap, rollback, retirement runbook |
| `docs/PHONE_TESTS.md` | Phone test checklist and result table |
