# Upload module (Data inputs) - One Portal Data

Status: 24 Nov 2026. WKM and BM read the Daily Report PDF; TMS reads four file types. All sites run in TEST MODE (shadow): nothing written by the module reaches `prod_v2` / Looker until the owner sets `etl_config.live = true`.

## 1. What it does
A Data entry, Site admin or Super admin user opens **Production > Uploads** (`/production/data-inputs/`), drops the site's daily file, reads the preview and issues, presses **Load**, and can **Undo**. The file is read in the browser; the original is not kept. Only the rows go to the site's own Supabase project. Own site only.

| Site | Files taken | Loads into |
|---|---|---|
| WKM, BM | Daily Report PDF (also barge list, plan check/Replace, ship updates of earlier days) | MNG, HSE, HAUL, SHIP, FUEL, EQ, MP, STOCK ... (per site config), barge list |
| TMS | Daily Production Report `.xlsx` | MNG, HAUL, SHIP, WEWH, EQ, FUEL, CONS |
| TMS | Realisasi Barging `.xlsx` (sheet VMM + sheet FMI) | barge list only |
| TMS | Stock dome register `.xlsx` | STOCK (per contractor), only new or changed days (see section 6, Stock register) |
| TMS | Laporan Inspeksi Harian `.docx` | HAZARD |

## 2. The daily routine (operator)
1. Log in (own site). Uploads. Drop the file. First use of the day downloads the reader (about 35 MB, then cached by the browser).
2. Wait for "Reading the site history", then the preview. Check the Errors / Warnings counts and the cards (see 5).
3. **Load into <site>** is disabled while an ERROR exists (a part of the file could not be read). Fix the cause at site, or load only after it is understood.
4. After Load: "rows written", and the compare against the current process. In test mode the rows go to a safe copy.
5. **Undo this load** restores history and the target table. Undo is refused if a later load touched the same days.
6. TMS: upload each file type separately (DPR, barging, stock, hazard). Order does not matter.

## 3. Architecture
```
file (pdf/xlsx/docx) -> web worker (public/etl/etl-worker.js)
   -> Pyodide 0.27.2 (Python in the browser): public/etl/py/*.py
   -> {report_date, actual[] (fact rows), raw{table: rows}, barge[], plan, ship_updates[], log[]}
page (src/components/opd/upload-view.tsx) + src/lib/opd/etl-client.js
   -> RPC etl_stage / etl_stage_raw / etl_stage_barge  -> staging tables (nothing live)
   -> etl_load -> history + target (shadow table or prod_v2.*)    -> etl_undo
```
- **History** (`public.etl_history`) holds every master row (`tblRAW*`, vocab, `tblCALENDAR`) as JSON. It replaces the Excel master. The reader gets the window it needs (from the start of the year, calendar to +400 days, the whole barge list). Seeded once per site from the master with `scripts/etl/seed_history.py` (`OPD_DB_URL` env only, never printed; refuses a second seed or a wrong site).
- **Reader** = the desktop ETL parsers, unchanged, run on a history-backed master (`opd_parse.HistoryMaster`). Formula columns (WTD/MTD/YTD, week, running totals, ROWID, stock...) are rebuilt by `opd_formulas.py`, validated against every row of the WKM, BM and TMS masters (`scripts/etl/validate_formulas.py`).
- **Fact rows** (long/EAV shape of `prod_v2.fact_production_actual`) come from `master_export.build_actual`, the same function as the Excel master export. 15 significant digits like the desktop.
- **Roles**: `etl_can_load` = data_entry, site_admin, super_admin. `etl_can_replace_plan` and the ship Apply = site_admin, super_admin. A project serves one site (`etl_config.site`).

## 4. Database (run on each site project, in order, safe to repeat)
| File | Adds |
|---|---|
| `etl_01_core.sql` | `etl_config`, batches, staging, `etl_stage`, `etl_plan_diff`, `etl_load`, `etl_undo`, roles |
| `etl_02_history.sql` | `etl_history`, `etl_stage_raw`, `etl_history_read`, `etl_history_summary`, history in load/undo |
| `etl_03_safe_target.sql` | shadow tables, `live` flag, `etl_shadow_diff`, backup for live undo |
| `etl_04_barge.sql` | barge list (shadow `etl_shadow_barge`, live `<fact_schema>.fact_barge`), plan guard, `etl_stage_ship`, tolerant compare |
| `etl_05_hazard.sql` | duplicate key includes the text (several findings per day); compare matches on the text. Needed on TMS |

Rules built in: nothing alters or adds triggers/policies to `prod_v2`; a load replaces only the (site, date, category, metric_group) partitions it contains; sections the reader marked ERROR are not loaded; `etl_*` functions are SECURITY DEFINER, tables have RLS and no direct access.

## 5. What the page shows
- **Preview**: fact rows by category (filter by contractor/pit/metric). Read-only (editing is not built).
- **Issues**: ERROR (blocks Load), WARN, RECON (totals differ from history), INFO.
- **Barge list**: new / changed SIs; week, month, year, running totals are recalculated for the whole list on load. TMS week = Monday start, rule -1; WKM (6,+1); BM (7,-1) (`barge_week` in the config).
- **Plan card** (WKM, BM): the plan printed in the report differs from `tblCALENDAR`. A site admin can tick "Replace the plan when I load": the value holds from the report day to the end of the run of equal calendar values (a month plan stops at month end; ST-DAY = ST-WTD / 7). Earlier days never change.
- **Ship of earlier days** (WKM, BM): SHIP of earlier days that differs from the barge list. After the report is loaded a site admin presses "Apply ticked rows": DAY is overwritten and WTD/MTD/YTD of that day and later days of the contractor move by the same difference. Own batch, own Undo.
- **Compare** after Load: same / different / only here / only there against `prod_v2` for the same days (and the barge list).
- **Recent uploads**: loaded (test mode) / loaded / undone.

## 6. TMS specifics
- Config `public/etl/config/config_tms.json` (desktop config plus `barge_week` and `fact_skip_metrics`). `prod_v2` holds only DAY/WTD/MTD/YTD (+ROWID) of MNG and SHIP: the TOT/ALL helper columns are left out of the fact rows (history keeps them).
- DPR: production from the `Production` sheet (BCM x factor), WEWH from the SPO sheet, EQ from `Unit`, FUEL, CONS from the `Daily Report Huayou ` sheet. The stock block of the DPR is not loaded; the stock register is the source (from 10 Nov 2026). TMS plan differences are logged only (no Replace).
- Barging: one block per trip ("Ke-n"); SI `{n:03d}-TMS` (VMM) / `{n:03d}-FMI`; vessel + start date adopts an existing SI. Excel's day/month swap is corrected with a WARN. A second block with the same Ke-n or a block with no vessel is skipped; a duplicate is an ERROR (Load blocked until site fixes the sheet).
- Hazard: one row per new finding, `-` row on a day with none; REMARKS carries the finding ID (`[SF-67]`); RISK LEVEL and HAZARD CATEGORY are not in the report (loaded blank, fact group `-`). Closing a finding loaded earlier changes an old row: not applied yet (WARN).
- Word and Excel libraries for TMS (python-docx + lxml) load only when a TMS file is used.

## 7. Test mode, compare week, going live
- Default is SHADOW: `public.etl_shadow_actual / plan / barge`. Looker is not affected.
- Compare week: upload each day's files in the portal as well as running the desktop ETL; read the compare (target: 0 different, 0 only there, every "only here" explained).
- Go live (owner only, SQL editor, per site): switch off the desktop's Supabase step for that site first (one writer), back up the three prod tables, then `update public.etl_config set live = true;`. Rollback: `live = false`, undo recent batches, restore the backup.

## 8. Tests
`npm run test:unit` (client logic), `tests/etl_*_test.sql` (Postgres 16: core, history, safety S1-S7), `scripts/etl/test_barge.py`, `test_plan_ship.py`, `parity_check.py`, `validate_formulas.py`, and the reference harnesses `tests/integration_*.mjs.txt` (real worker + scratch Postgres). Checked against the real masters: WKM 1077/1077, BM 755/755 rows identical; TMS DPR 11 Oct and 9 Nov: 0 differences in input values, formulas 0 differences on all rows.

## 9. Known limits
Preview is not editable. TMS hazard closures of earlier findings and TMS plan Replace are not built. The browser is not yet seen on a phone; first download is large. Two writers must not run on one site (see 7). Supabase billing status and Vercel Hobby terms are outside this module but affect it.

## 10. Troubleshooting
| Message | Meaning / action |
|---|---|
| "This site has no history yet" | seed the site first (`seed_history.py`) |
| "ETL: this project serves site X, not Y" | wrong project or `etl_config.site` text; must equal the `site` column text |
| "ETL: not allowed" in the SQL editor | functions need a signed-in portal user; use plain SQL there |
| "Cannot load: ... appears twice" | ERROR in the file; fix at site |
| "duplicate key(s) in the actual rows" | run `etl_05_hazard.sql`; otherwise the file has two identical rows |
| "N different" after a load of an old day | the master/desktop value differs; open the compare rows |
| Old reader after an update | the browser caches by `manifest.json` version; reload twice or clear site data |
