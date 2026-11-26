# Daily Report download (Phase 4.6)

Dashboard page (`/production/dashboard/`) has a **Daily Report** card: Summary image (PNG), Summary (PDF), Full report (PDF).

## Where the numbers come from
- Read only, from each site project (WKM, BM, TMS) you can sign in to, via `etl_report_data()` (`supabase/sql/etl_07_report.sql`). Any active role, viewer and up. Reads the portal copy of the master tables (`etl_history`), newest loaded day = the site's **Cut Off**.
- Shipment = SHIP DAY/WTD/MTD/YTD summed over rows of the cut-off day; plan = calendar `ST-*`.
- Production = ore L + M + H (LGO + MGO + HGO) from MNG; plan = calendar L+M+H. Checked against the PDF of 19 Nov 2026 (WKM 5,743.64 + 10,945.46 = 16,689.10).
- One company per site. CDSM, IBN, TPB, AJB, CDS have no site project and show dashes. Totals use only companies with data.
- Headline date = newest cut off. A site behind it is listed in a warning on the card and on the image/PDF.

## Not in the full report yet
Activity and average grade (Ni) are not in the portal history; the full PDF says so. Add them when those tables are loaded.

## Install
Run `etl_07_report.sql` once in each site project (WKM, BM, TMS). A site without it shows "report reader not installed" and the other sites still compile.

## Tests
`node tests/daily_report.test.mjs`; `psql -v ON_ERROR_STOP=1 -f tests/etl_report_test.sql` on an empty database.

## Reading the image
- Headline (the day's story, names the weakest company), four cards (Shipment and Production, today and month), Day and Month target bars per company with a dashed plan line, and a table of the numbers.
- The annual plan (RKAB = calendar YTD plan, summed over companies) is printed beside each chart title and as a "Year plan (RKAB)" column in the table. YTD % of it is shown next to it.
- Bar colours: green at or above plan, amber 80-100%, red below 80%.
- The full PDF site pages show Day / WTD / MTD / YTD with plan, actual, % and a result (ACHIEVED, ON PACE, BEHIND PACE, BELOW PLAN). Week = Monday to Sunday for the time-passed share used by ON PACE.
