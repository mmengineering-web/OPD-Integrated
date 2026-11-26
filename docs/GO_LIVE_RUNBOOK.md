# Compare week and go-live runbook (Phase 4, step 4.5)

Owner: Gera. Written: 25 Nov 2026. Applies to version 4.5.0. SQL: `supabase/sql/etl_06_compare.sql`. Page: Production > Uploads > **Compare week**.

Goal: prove, on real days, that the portal produces the same rows as the desktop ETL, then let the portal be the only writer of `prod_v2` for that site, with a way back at every step.

Order of sites: **TMS, then BM, then WKM** (TMS has the simplest files; WKM has the most plan and ship corrections). One site at a time. Do not start the next site before the previous one has run live for a few days.

---

## 1. Rules

1. Two writers never write one site. While the compare runs the portal writes a safe copy (`etl_shadow_*`) and the desktop ETL writes `prod_v2`. At go-live the desktop's Supabase step is switched off first.
2. **Clean day** = the portal and the current process agree on every row compared: 0 different, 0 only there, and every "only here" row explained by a site admin. Different and only-there rows can never be explained away; fix the cause and load the day again.
3. **Ready** = 10 clean days in a row. A day with no load, or a load that was never compared, is not clean and breaks the run (a calendar gap inside the run is shown as a warning, because a day that was not reported is fine but a day that was forgotten is not).
4. Only the owner switches a site live. No portal role can do it.

---

## 2. Before the compare week (once per site)

| # | Who | What |
|---|---|---|
| 1 | Owner | Run `etl_06_compare.sql` in the SQL editor of the site project (after `etl_01` to `etl_05`; safe to repeat). On TMS, check `etl_05_hazard.sql` has been run. |
| 2 | Owner | Check `select site, live from public.etl_config;` shows the right site text and `live = false`. |
| 3 | Owner | Choose the **start day** (the first day both flows run on the same file) and tell the site. Proposal: a Monday, so a week boundary is inside the first run. |
| 4 | Owner | Run `etl_06_compare.sql` on the other two sites only when it is their turn. A project without it shows "Not installed on this site yet" in the Compare week card and still works as before. |
| 5 | Site admin | Open Uploads once and confirm "Compare week" shows 0 of 10 clean days. |

Open items that block a clean TMS run, from the guide of 24 Nov 2026: the FMI barging sheet Ke-24 duplicate and the two MnO typos in the TMS stock file are site fixes. A duplicate is an ERROR and blocks Load on purpose.

---

## 3. Every day of the compare week

1. The site user uploads the day's file(s) in Uploads, as usual (TMS: each file type separately), and presses **Load**. The page loads in test mode and stores the comparison by itself.
2. The desktop ETL runs on the same file as before. It often finishes **after** the portal.
3. After the desktop has loaded the day, open Uploads, open the day in **Compare week** and press **Check again**. Do this whenever the desktop loads later than the portal; until then, rows show as "only here".
4. Read the result.

| Result | Meaning | What to do |
|---|---|---|
| Clean | Every row matches | Nothing |
| Explained | Rows only in the portal, with a reason | Nothing. The reason is kept with the day. |
| Needs a reason | Rows exist only in the portal | Usually the desktop has not loaded the day yet: press Check again later. If the desktop will never write these rows (a category it does not load), a **site admin** writes the reason in the day's card. A reason is dropped automatically when a re-check finds a different number of such rows. |
| Different | A value differs, or rows exist only in `prod_v2` | Press **Show rows**. Decide which side is right. If the portal is wrong, fix the parser or the file and load the day again (the old load is replaced in the table, so the run is judged on the corrected load). If the desktop is wrong, fix it there, then Check again. |
| Not checked | Loaded but never compared (for example the page was closed during the load) | Open the day, press Check again. |
| Nothing to compare | No rows were compared, or the barge list could not be read | Open the day; the card says which. A barge error usually means `fact_barge` has other column names than the portal expects. Report it word for word. |

5. Corrections: loading the same file (same name) again, or a corrected file that covers the same day, replaces the earlier load in the table. A load that was undone does not count.
6. A day with **no report** (site did not work) needs no action, but the run is shown with a "calendar days without a load" warning. Check it was a real non-reporting day.

---

## 4. Go-live day for one site

Do the steps in this order, in one sitting, at a time when no upload is in progress. Steps 4.3 to 4.5 are run by the owner in the SQL editor of that site's project.

**4.1 Check the day.** The last compare day (call it D) has been loaded by both flows and shows Clean or Explained. Do not switch off the desktop step before it has loaded D, otherwise D is missing from Looker.

**4.2 Switch off the desktop's Supabase step for this site** (the upload step; the desktop ETL's step 5, `DELETE_MISSING_GROUPS`, must be off too, otherwise two writers). Keep the Excel master only as a record; it no longer receives new days.

**4.3 Back up the site's rows** (the backup goes to the new schema `etl_prelive`; nothing in `prod_v2` changes):

```sql
select public.etl_golive_backup();
```

Note the `taken_at` value it returns. You need it for a restore.

**4.4 Read the checklist:**

```sql
select * from public.etl_golive_check();
```

Items 1 to 5 must show `ok = true`. Item 6 (the desktop step) is blank because only you can confirm it; the line shows the last time the desktop wrote to `prod_v2`. It must not move after the switch-off.

**4.5 Go live:**

```sql
select public.etl_go_live('DESKTOP STEP IS OFF');
```

It refuses unless items 1 to 5 pass, and writes a line in `etl_golive_log`. (The old way, `update public.etl_config set live = true;`, still works but skips these checks. Use the function.)

**4.6 First live day.** The site uploads the next day's file in Uploads. The page now says "These rows are now in the live production data." Check Looker for that day: production, shipment, stock and barge. Check **Recent uploads** shows the load as `loaded` (not "test mode"). The Compare week card is replaced by a "Live" card.

---

## 5. Rolling back (use the smallest step that fixes it)

| Step | When | How |
|---|---|---|
| 1. Undo the bad load | One day is wrong | Recent uploads > Undo. Needs the same file corrected and loaded again. Undo is refused if a later load touched the same days: undo the later one first. |
| 2. Back to test mode | The site should stop writing to `prod_v2` | `select public.etl_go_back();` Loads already written to `prod_v2` stay until undone (step 1). Switch the desktop's Supabase step back on only after this and after step 1 for every live day, so there are never two writers. |
| 3. Restore the backup | The prod tables are damaged beyond undo | `select public.etl_go_back();` first. Then `select public.etl_golive_restore('<taken_at>', 'RESTORE <SITE TEXT>');` where the confirmation text is exactly `RESTORE ` plus the `site` text of `etl_config`. It puts the site's rows of `fact_production_actual`, `fact_production_plan` and `fact_barge` back exactly as the backup had them and checks the row counts; it removes everything written to this site after the backup. A backup can be restored once. |

After step 3, the portal's own history (`etl_history`) still holds the days loaded after the backup. Undo those live batches in the portal first (step 1) so history and prod tables agree again.

---

## 6. Per-site record (fill in)

| | TMS | BM | WKM |
|---|---|---|---|
| `etl_06` run on | | | |
| Compare start day | | | |
| Clean days reached on | | | |
| Backup `taken_at` | | | |
| Desktop step off on | | | |
| Live on | | | |
| First live day checked in Looker | | | |

---

## 7. What the compare does and does not prove

- It compares the rows the portal wrote for the days of a load with what `prod_v2` holds for the same (site, date, category, metric group) partitions, and the barge list by SI. Numbers equal within 0.000001 count as the same.
- It does not compare days the portal never loaded, plan values the portal does not write (TMS plan differences are only logged), or the Excel master itself.
- It does not make a wrong desktop value right: if the desktop is wrong and the portal is right, the day shows Different until one side is corrected.
- The comparison is recomputed on the server each time. A browser cannot send its own numbers.

Known limits: the barge compare needs `fact_barge` to exist with the same column names as the portal's barge table; the daily table shows the last 30 report days; "10 clean days" is a constant in the page and a default in `etl_compare_status` (asking for another number is possible in SQL: `select public.etl_golive_check(14);`).
