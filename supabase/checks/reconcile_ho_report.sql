-- Reconcile etl_history against the HO Excel master report (Daily Report 19 Nov 2026).
-- Run in each site's Supabase SQL editor. It filters on the cut-off date of that site:
--   WKM 2026-11-19 | BM 2026-11-18 | TMS 2026-11-09
-- Change :cut and :site below. Output: one row per metric with expected, db (tolerant), db (strict, what etl_dash_data sees), status.
with p as (select '2026-11-18'::date as cut, 'BM'::text as site),   -- <== edit
exp(site, tbl, col, kind, expected) as (values
 ('WKM','tblRAWMNG','L-DAY','day',4140.75),('WKM','tblRAWMNG','L-MTD','day',107674.98),('WKM','tblRAWMNG','L-YTD','day',1471643.05),
 ('WKM','tblRAWMNG','H-DAY','day',10383.54),('WKM','tblRAWMNG','H-MTD','day',183568.54),('WKM','tblRAWMNG','H-YTD','day',2857682.03),
 ('WKM','tblRAWMNG','M-DAY','day',0),
 ('WKM','tblRAWSHIP','DAY','day',9573.32),('WKM','tblRAWSHIP','MTD','day',214358.52),('WKM','tblRAWSHIP','YTD','day',3001332.89),
 ('BM','tblRAWMNG','L-DAY','day',0),('BM','tblRAWMNG','L-MTD','day',0),('BM','tblRAWMNG','L-YTD','day',92533.00),
 ('BM','tblRAWMNG','H-DAY','day',0),('BM','tblRAWMNG','H-MTD','day',16644.55),('BM','tblRAWMNG','H-YTD','day',403955.16),
 ('BM','tblRAWSHIP','DAY','day',0),('BM','tblRAWSHIP','MTD','day',0),('BM','tblRAWSHIP','YTD','day',438175.35),
 ('TMS','tblRAWMNG','L-DAY','day',8279.04),('TMS','tblRAWMNG','L-MTD','day',71813.84),('TMS','tblRAWMNG','L-YTD','day',581044.13),
 ('TMS','tblRAWMNG','H-DAY','day',0),
 ('TMS','tblRAWSHIP','DAY','day',11270.08),('TMS','tblRAWSHIP','MTD','day',47444.80),('TMS','tblRAWSHIP','YTD','day',293757.02),
 ('WKM','tblRAWFUEL','DAY','day',50006),('WKM','tblRAWFUEL','MTD','day',912097),('WKM','tblRAWFUEL','STOCK','day',269749),
 ('BM','tblRAWFUEL','DAY','day',395),('BM','tblRAWFUEL','MTD','day',37374),('BM','tblRAWFUEL','STOCK','day',34642),
 ('TMS','tblRAWFUEL','DAY','day',5651),('TMS','tblRAWFUEL','MTD','day',97727),('TMS','tblRAWFUEL','STOCK','day',-1073263),
 ('WKM','tblRAWMP','TOTAL','day',1347),('BM','tblRAWMP','TOTAL','day',249),('TMS','tblRAWMP','TOTAL','day',336),
 ('WKM','tblRAWWEWH','EWH','day',13.46),('BM','tblRAWWEWH','EWH','day',9)
),
-- week = sum of DAY columns Monday..cut-off (WKM 49693.54 shipment, 54572.42 HGO, 27462.05 LGO; BM 0; TMS = day)
wk as (select date_trunc('week',(select cut from p))::date as mon),
rows_ as (
  select h.tbl, k.key as col, h.row_date, h.data->>k.key as raw
  from etl_history h, p, jsonb_each_text(h.data) k
  where h.site = p.site and h.row_date = p.cut
)
select e.tbl, e.col, e.expected,
  (select count(*) from rows_ r where r.tbl=e.tbl and r.col=e.col)                                            as n_rows,
  (select sum(nullif(regexp_replace(r.raw,'[^0-9eE.+-]','','g'),'')::numeric) from rows_ r where r.tbl=e.tbl and r.col=e.col) as db_tolerant,
  (select sum(r.raw::numeric) from rows_ r where r.tbl=e.tbl and r.col=e.col and r.raw ~ '^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$') as db_strict,
  (select string_agg(distinct r.raw, ' | ') from rows_ r where r.tbl=e.tbl and r.col=e.col and r.raw !~ '^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$') as dropped_by_rpc,
  case when abs(coalesce((select sum(nullif(regexp_replace(r.raw,'[^0-9eE.+-]','','g'),'')::numeric) from rows_ r where r.tbl=e.tbl and r.col=e.col),0) - e.expected) < 0.05 then 'OK' else 'DIFF' end as status
from exp e, p where e.site = p.site
order by e.tbl, e.col;

-- Week check (Monday..cut-off) for production and shipment
select 'week' as k, h.tbl, kv.key as col, sum(nullif(regexp_replace(kv.value,'[^0-9eE.+-]','','g'),'')::numeric) as week_sum
from etl_history h, p, wk, jsonb_each_text(h.data) kv
where h.site=p.site and h.row_date between wk.mon and p.cut
  and ((h.tbl='tblRAWMNG' and kv.key in ('L-DAY','M-DAY','H-DAY')) or (h.tbl='tblRAWSHIP' and kv.key='DAY'))
group by 1,2,3 order by 2,3;

-- Duplicate / multi-row days (cumulative columns get double counted if >1 row per day per contractor)
select tbl, row_date, count(*) rows_per_day, count(distinct batch_id) batches
from etl_history h, p where h.site=p.site and h.row_date between p.cut-6 and p.cut and h.tbl in ('tblRAWMNG','tblRAWSHIP')
group by 1,2 having count(*)>1 order by 2 desc;

-- Last loaded day per table (is the cut-off actually in the database?)
select tbl, max(row_date) as newest, count(*) filter (where row_date = (select cut from p)) as rows_on_cut
from etl_history h, p where h.site=p.site and h.tbl in ('tblRAWMNG','tblRAWSHIP','tblRAWWEWH','tblRAWFUEL','tblRAWMP') group by 1;
