# Interactive PDCA Dashboard

Location: Production > Dashboard > **Interactive** tab (default). The Looker Studio tabs stay beside it.

## Install (once per site project: WKM, BM, TMS)
1. Run `supabase/sql/etl_07_report.sql` (if not yet).
2. Run `supabase/sql/etl_08_dashboard.sql`. It adds `etl_dash_data(from, to)`, read-only, SECURITY DEFINER, checks `etl_role()`, max 400 days, authenticated only.

## Use
- Sites: "All sites" or one or more chips. Only sites the account can read appear (hub accounts see all).
- Range: one button that shows the dates. It opens a two-month calendar (one month on a phone). Press a day and slide to another day to pick the range, or click a start day and an end day. Quick ranges (7 days, 30 days, This month, Last month, Year to date) sit above the calendar and end on the newest loaded day. Max 400 days.
- Overview: four KPI cards (range and year to date, verdict chip, pace tick), the cycle in four sentences, cumulative actual vs plan (click a day for site detail), site table, first actions.
- Plan: annual plan (RKAB), required vs current t/day, year-end projection, plan by site.
- Do: grades, shipment, overburden/stripping, contractors, stock, fuel, manpower, hauling, construction, exploration, lab, barges.
- Check: achievement table (day, MTD, YTD, range), availability, working hours and rain, delay causes, equipment, HSE, hazards, data completeness.
- Act: ranked actions and open hazard corrective actions.
- All tables: every column of the 14 tblRAW* tables and the calendar.

## Rules
- Production = ore L+M+H. Shipment = tblRAWSHIP DAY. Plans from tblCALENDAR.
- MTD/YTD columns are cumulative: read on one day, never summed across days.
- Verdicts: ACHIEVED / ON PACE / BEHIND PACE / BELOW PLAN / NO PLAN.

## Assumptions to confirm
- Calendar YTD plan is the approved annual plan.
- Equipment groups: OP operating, S standby, B breakdown, P plan.
- Lab ID / FD / AD families are shown as loaded, meaning not interpreted.

## Files
`etl_08_dashboard.sql`, `etl-client.js` (dashData, dashAll), `dash-model.js`, `dash-demo.js` (tests only), `dash/charts.tsx`, `dash/pdca-dashboard.tsx`, `dashboard-view.tsx`, tests `dash_model.test.mjs`, `etl_dash_test.sql`.

## Reports by table (4.9)
A second row of tabs, **By table**, one report per RAW table (13): Mining, Shipment, Working hours, Equipment, Availability, Hauling, Ore stock, Safety, Fuel, Manpower, Lab, Exploration, Geological map.
Each report has a one-sentence headline, KPI cards, linked charts on the same days (volume, hours, units), a "why was this day low" panel (click any bar), a rain-day against dry-day table, and links to the related reports.

### Waterfall (Production plan to Actual)
- Volume is overburden in BCM: tblRAWMNG OB-DAY against tblCALENDAR OB-DAY, over the days that have production.
- Rate = actual BCM per actual effective working hour of the period.
- Cause bar = (planned hours - actual hours) x rate. Green means less lost time than plan.
- Rain and Slippery use the calendar plan hours. The other causes share (calendar TOTAL DELAY - RAIN - SLIPPERY) in proportion to their actual hours, because the calendar has no plan per cause.
- Availability = volume after the causes x (actual PA / plan PA - 1). PA is the mean of PA over excavators, dump trucks, dozers, graders, compactors.
- Productivity is what is left, so the bridge always closes on Actual. The chart axis does not start at zero, and the note under the chart says where it starts.
- If the calendar has no OB-DAY plan or the site has no EWH, the chart is replaced by the reason.

### Rain effect
Rainy day = rain + slippery hours of 1 h or more. The table compares the daily averages with dry days for volume, hours, units operating, standby and breakdown, availability and fuel per BCM. The slope line is a simple correlation across days. It shows a pattern, not proof.

### Bridges (stock, fuel, headcount)
Opening + inflows - outflows +/- unexplained = closing. Ore stock: mined and shipped. Fuel: deliveries and use. Headcount: joined and left. The unexplained bar is what the daily rows do not account for, so a large one means a data problem to check. Only days where every selected site has loaded that table are counted, so a late site does not look like a drop.

### Links between reports
- Ore stock: stock by grade, mined vs shipped, rain hours, Ni by grade.
- Safety: events by type against hours and weather, hazards by risk and category, open hazard list.
- Fuel: used, litres per BCM, hauled, rain hours, stock and deliveries.
- Manpower: headcount, joined/left, by role, units operating.
- Lab: samples per family and type, barge samples vs shipment, exploration samples vs drilled.
- Exploration: plan vs actual holes, depth and samples, cumulative depth, rain.
- Geological map: covered area, added per day, drill holes.

Files: `dash-reports.js` (model), `dash/reports.tsx`, `dash/reports-more.tsx`, `dash/report-ui.tsx`, `dash/charts.tsx` (Waterfall), `dash/pdca-dashboard.tsx` (tabs), test `tests/dash_reports.test.mjs`. No new SQL: `etl_08_dashboard.sql` already returns the columns.
