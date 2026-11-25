# Phase 4 design: Daily Report upload without Excel

Owner: Gera. Written: 24 Nov 2026. Status: **steps 4.1 to 4.4 built (test mode). 4.5 compare week and go-live: not started.** Sections 2 to 7 are the original proposal; the step-status sections at the end are current.
Builds on `supabase/sql/etl_01_core.sql` (step 4.1) and the CAN Daily Report ETL v1.13.1. Current operating guide: `docs/OPD_UPLOAD_MODULE.md`.

## 1. Goal

A site user drops the day's report (WKM PDF, BM PDF, TMS workbooks) into OPD. OPD reads it, shows what it found and what looks wrong, the user confirms, and the rows land in that site's Supabase project. No master workbook, no Excel, no desktop app. Every load can be undone (done in 4.1).

## 2. What the proof showed (24 Nov 2026)

Tool: `scripts/etl/parity_check.py`. It runs the existing parsers on a report, turns the staged `tblRAW*` rows into fact rows with the app's own export rules, and compares them with what the saved master exports for the same day. No Excel was used. It ran on Linux.

| Site | Report | Rows from the report alone | Same key, same value | Different value | Missing from report alone |
|---|---|---|---|---|---|
| WKM | 19 Nov 2026 | 282 | 282 | 0 | 795 (all formula columns) |
| BM | 18 Nov 2026 | 342 | 342 | 0 | 413 (all formula columns) |

So the parsers and the mapping do not need Excel. What Excel adds is only formula columns, and every one of them can be computed:

| Excel formula column | What it is | Replace with |
|---|---|---|
| `DTOT/WTOT/MTOT/YTOT`, `DALL/WALL/MALL/YALL`, `WTD/MTD/YTD` (MNG, HSE, SHIP, HAUL, FUEL) | Running totals that reset each week, month, year | Value stated in the DR is stored; OPD computes the DAY-sum, compares, flags a mismatch, user can edit (decision 2) |
| `EQ P-*` | Population = OP + S + B | SQL view |
| `MP TOTAL` | Sum of the role columns | SQL view |
| `FUEL STOCK`, `FUEL FR` | Stock chain (previous stock + add - used), fuel ratio | SQL view, or computed at load from the previous day |
| `LAB IM/IY/FM/FY/AM/AY` | Monthly and yearly cumulative lab counts | SQL view |
| `STOCK Si/MgO` | Ratio of two grades | SQL view |
| `SHIP ROWID`, `YEAR/MONTH/WEEK` | Row id and calendar lookups | Not needed |

## 3. What the parsers still read from the master (history)

The mapping asks the master for: past rows of a table (pit owners, previous fuel stock, barge list), sums over a period, contractor lists, vocabulary lists (pits, contractors, statuses), and the plan calendar (compare only). That is eight small calls (`rows`, `rows_on`, `sum_between`, `contractors`, `vocab`, `tables`, `data`).

Replacement: a **history store in the site's Supabase project**, with the same calls. One table keeps the `tblRAW*` rows as JSON (`etl_raw`: table, site, date, row), plus a small table for the vocabulary lists and the plan calendar. It is **seeded once from your current masters** (I write the seed script, you run it), then every confirmed load adds its rows. After that the Excel master is no longer read or written.

## 4. Where the parser runs

| Option | How | For | Against |
|---|---|---|---|
| **A. Python function on Vercel** (**Proposal**) | Browser sends the file to `/api/etl-parse` with the user's login. The function runs the existing Python parsers, reads history from the site project with the user's token, returns rows and issues. Nothing is stored. | Reuses ~3,000 lines of tested parsing, same results as today, fast to build | The report file leaves the phone for a few seconds (not stored). Needs Vercel Pro limits for time and size |
| B. Rewrite the parsers in TypeScript (pdf.js) | Everything in the browser | Matches the "files are read in the browser" principle | A rewrite of PDF logic that took weeks to get right; high risk of new differences; the WKM and BM pit charts are vector shapes |
| C. Python in the browser (Pyodide) | Same Python, run client side | Same principle as B, less rewriting | The earlier attempt failed at package install; PDF libraries may not load |

**Proposal: A first**, because it keeps today's proven results. If the browser-only rule matters more to you, we try C on one site first.

## 5. Build order (each step has its own exit test)

| Step | What | Exit test |
|---|---|---|
| 4.2a | History store tables and seed script (from your masters) | History read back equals the master for the last 60 days, per site |
| 4.2b | Derived-metrics SQL views (totals, population, stock chain, lab, ratios) | For 30 days, view output equals the master's stored values; differences listed and explained |
| 4.2c | `/api/etl-parse` function and Upload page (drop, issues, preview, Load, Undo) | Browser test: WKM and BM report in, same rows as `parity_check.py`, load, undo |
| 4.3 | Barge list, ship sync and plan compare/replace in the page | Same barge and ship results as the desktop app on the Nov reports |
| 4.4 | TMS (needs the Daily Production Report workbook and hazard .docx, see section 7) | 0 unexplained differences on 30 days |
| 4.5 | Compare week: desktop and OPD both load, daily diff, then switch the feed | 10 clean days per site |

## 6. Decisions needed

1. Where the parser runs: A, B or C (section 4).
2. Cumulative numbers (**Decided by Gera**): the DR's own stated value wins and is stored. OPD also computes the value from the DAY rows, compares it with the DR, and flags a mismatch on the preview. The user can edit the stored value on the preview before loading, because some totals are typed by hand in the DR. The DAY-sum is a check, never the stored value. The roadmap rule "recompute YTD from daily values" is therefore not applied at load; it stays available as a report in the compare step.
3. Who runs the seed from the masters (Gera on the site PC, or I send the script and you run it).
4. Replace desktop writes: once OPD loads a site, the desktop step 5 must stop for that site, or it will delete OPD days that are not in the master.

## 7. Files still needed from you

- **TMS:** one Daily Production Report `.xlsx` (the cumulative one, `Production`, `Unit`, `SPO` sheets, `Daily Report Huayou` blocks) and one Laporan Inspeksi Harian `.docx`. The files sent so far (`MoCo`, `Realisasi Barging`, `STOCK 15 NOV`) are the barging and stock inputs and the parked TMS Site ETL input, not the daily report itself.
- **WKM and BM:** 4 or 5 more daily PDFs each, including a stopped-pit day, a month change, a rain day and a barge event day, so the parity check covers them.
- **CDSM, IBN, TPB, AJB, CDS:** one sample report each when they are ready. None has an adapter today.
- **Vercel plan:** confirm the project is (or will be) on Pro, because a Python function needs more than the Hobby time limit for large PDFs.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Report file goes to a server function (option A) | Not stored, only the user's login can call it, nothing logged except size and result. Decision 1 |
| History seed is wrong or incomplete | 4.2a exit test compares 60 days per site against the master before anything is loaded |
| Two writers (desktop step 5 and OPD) | Decision 4. Per-site switch date, then desktop step 5 off for that site |
| Looker reads stored totals today | No change: stored totals stay, now equal to the DR |
| Parser breaks on a changed layout | Unchanged by design: ERROR on that section, nothing loaded from it |
| Single maintainer | `scripts/etl/parity_check.py` and per-adapter tests stay in the repo |


## Step 4.2a status (history store)
- `supabase/sql/etl_02_history.sql`: `etl_history`, `etl_staging_raw`, `etl_history_read`, `etl_history_summary`, `etl_stage_raw`, and `etl_load` / `etl_undo` replaced to write and restore history. Tests H1-H9 and T1-T15 pass on Postgres 16.
- `scripts/etl/seed_history.py`: dumps all `tblRAW*`, vocab and `tblCALENDAR` rows of a master to NDJSON, optionally loads them (connection string from `OPD_DB_URL` only, never printed). Refuses a second seed and a wrong site.
- Seed source is the three site masters. The HO file `Master Database HO - New` holds only EAV query outputs, no `tblRAW*` tables.
- Barge list: rows with no FINISHDATE (open barges) are stored with `row_date` null and always returned by `etl_history_read`. Merge rules come in 4.3.

## Protecting prod_v2 (Looker) - rule for every step
- Portal objects are new tables/functions only (`etl_*` in `public`). No ALTER, index, trigger or policy on any `prod_v2` table.
- Default is SHADOW mode: loads write `public.etl_shadow_actual/plan`. `etl_shadow_diff(batch)` compares them with prod_v2 (same / changed / only_portal / only_prod) for the compare week.
- LIVE is `etl_config.live`, switched by the owner in the SQL editor per site. When live, only the uploaded (site, date, category, metric_group) partitions are replaced, backup kept, undo restores the same target.
- Desktop ETL step 5 (`DELETE_MISSING_GROUPS`) must be switched off for a site on the day it goes live, otherwise two writers.
- Tests S1-S7 (`tests/etl_safety_test.sql`) prove: shadow load leaves prod_v2 byte-identical; live load touches only the uploaded partition; undo restores values.
- Parity on 4 more reports (WKM 16 and 31 Oct, BM 16 and 29 Oct): PARITY OK.

## Step 4.2c status (24 Nov 2026): the Upload page

Built: `/production/data-inputs/` (replaces the placeholder). A data_entry+ user of WKM or BM drops the Daily Report PDF; the browser reads it
(Pyodide in a web worker, `public/etl/`), shows issues and a preview, and on **Load** stages and loads through `etl_stage`, `etl_stage_raw`, `etl_load`.
Undo uses `etl_undo`. In shadow mode the page shows the compare against the rows the desktop ETL put in prod_v2 (`etl_shadow_diff`).
TMS is not offered yet (step 4.4). The original PDF is not kept. Plan values are not touched (step 4.3).

History window the reader asks for: from 20 days before 1 January of the report year (never less than 45 days) up to the day before the report;
the calendar up to and including the report day; vocabulary lists whole. A shorter window gave wrong YTD/MTD for contractors idle for weeks.

Proven without Excel and without a browser UI (same Pyodide 0.27.2 build, run in Node, PDF read by pdfplumber in WebAssembly):
WKM 19 Nov 1077/1077 and BM 18 Nov 755/755 rows identical to the Excel master export; against a scratch Postgres with etl_01-03 and the WKM seed:
stage, load (shadow), compare with the desktop rows (1077 same, 0 different), undo (shadow and history restored), viewer refused.
NOT yet seen: the page in a real browser (Edge/Chrome), the first-time download size and time on site internet, a phone.

Not in this step: editing a value on the preview (the preview is read-only), the cumulative DR-versus-DAY-sum flag as its own panel
(the report's own reconciliation checks are listed under "Checks"), barge list merge (4.3), plan compare/replace (4.3).

## Step 4.3a status (24 Nov 2026): barge list

`opd_barge.py` merges the barges of the report into the history list (`tblRAWBARGE`, one row per SI, ordered by id) with the desktop rules
(`t_barge`), then rebuilds the calculated columns (MONTH = month name of FINISHDATE, blank gives "January"; YEAR; WEEK from the site's week start
`barge_week` in the config; WTD/MTD/YTD = running ACTUAL CAPACITY per contractor and period in FINISHDATE order, same day in list order).
Verified against the stored values of all three masters (WKM 297, BM 52, TMS 25 rows): 0 differences.
The browser sends only rows that changed (`etl_stage_barge`: si, hist, fact, old). `etl_load` updates the history row in place (same id, so the order
is kept) or appends a new SI, and replaces the rows of those SIs in the target barge table (`etl_shadow_barge` in shadow mode, `<fact_schema>.fact_barge`
when live). `etl_undo` restores both and refuses when a later load touched the same SIs. `etl_barge_diff` compares portal and prod_v2.fact_barge.
INPUT DATE of an added or updated SI is the report date (the desktop loader stamps the load time).
Open: plan Replace (4.3b) and Ship Apply (4.3c).

## Step 4.3b and 4.3c status (24 Nov 2026): plan Replace and ship updates

**Plan.** `t_plan` already lists the report's plan values that differ from `tblCALENDAR` (`run.plan_cal`). `opd_plan.propose` turns them into calendar changes: per contractor
and plan column, the run of equal calendar values containing the report day is rewritten from the report day to its end (MTD columns stop at the month end; ST-DAY = ST-WTD/7).
The calendar rows of every touched day (all contractors) go to `etl_history` through `etl_stage_raw`, the matching plan rows (categories PLAN, touched groups) through `p_plan`;
`etl_load(p_replace_plan := true)` needs `etl_can_replace_plan()`. A batch that carries calendar rows loads only with the replace flag. Undo restores history and plan.
**Ship.** `t_ship_sync` output is returned as `ship_updates`. After the report is loaded a site admin applies the ticked rows: `opd_ship.apply` overwrites DAY and INPUT DATE of the stored
SHIP row and moves WTD/MTD/YTD of that row and of the later rows of the same contractor in the same week/month/year by the same delta, then sums DALL..YALL again. The result is a
separate batch (`etl_stage_ship`, kind `ship-sync`, SHIP category only, admin only) that replaces the SHIP partitions and history rows of the touched days. Undo order is enforced by the
existing clash checks (a main batch cannot be undone while a later batch touched the same partitions).
Open: the first real new-day report (WKM 20 Nov); preview editing; TMS (4.4); compare week and cutover (4.5).

## Step 4.4a status (24 Nov 2026): TMS Daily Production Report
The desktop TMS reader (tms_adapter / tms_to_master / tms_dpr_parser) runs unchanged in Pyodide through the same history-backed master as WKM/BM; formulas by opd_formulas
(validated on all 195 TMS MNG rows and the other tables). Page: kind "tms" reads .xlsx. Hazard (.docx, closures update older rows), Realisasi Barging and the stock register are staged by the same
modules but are refused for now until their load path (history update of old rows, barge merge by SI, stock per contractor) is tested: steps 4.4b / 4.4c.

## Step 4.4b to 4.4f status (24 Nov 2026): TMS complete in test mode
TMS now reads four file types: DPR, Realisasi Barging, stock dome register and hazard `.docx` (`etl_05_hazard.sql` needed on TMS). `fact_skip_metrics` drops TOT/ALL helper metrics that prod_v2 does not hold. Reader version 4.4-5. Details: `docs/OPD_UPLOAD_MODULE.md`. Open: hazard closures of earlier findings, TMS plan Replace, editable preview.

## Step 4.4g status (25 Nov 2026): stock register like the barge list
The TMS stock upload now compares the register with the database before loading. Per contractor and date: insert (new), update (differs, columns listed old -> new) or same (skipped). The last stock date in the database is shown per contractor; the page reads TMS stock history through the newest day (`readHistory(..., { stockAll: true })`) so a re-upload of the same day is recognised. Whole-day replacement is kept, so rows of other contractors of that day are copied unchanged. No rows are deleted for being absent from the file (a register is one day, not a list). Reader version 4.4-6. No SQL change.
