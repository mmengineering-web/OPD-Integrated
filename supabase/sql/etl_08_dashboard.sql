-- Phase 4.7: dashboard reader. READ-ONLY, any active portal role (viewer and up), site project only.
-- Returns, for a date range of at most 400 days, one row per table, day and contractor with the SUM of each dashboard column
-- (n = number of source rows, so an average can be worked out), plus the hazard findings of the range, the latest construction state,
-- and the barge list. Cumulative columns (MTD/YTD/WTD) are summed over the rows of one day only; the client reads them for a single day.
-- Nothing is written. SECURITY DEFINER, no table grant, execute for authenticated only. Needs etl_07_report.sql (etl_num) first.
create or replace function public.etl_dash_data(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_site text; cols jsonb := '{"tblRAWSHIP":["DAY","MTD","YTD"],"tblRAWMNG":["S-DAY","S-MTD","S-YTD","OB-DAY","OB-MTD","OB-YTD","L-DAY","L-MTD","L-YTD","M-DAY","M-MTD","M-YTD","H-DAY","H-MTD","H-YTD","Q-DAY","Q-MTD","Q-YTD"],"tblCALENDAR":["S-DAY","S-MTD","S-YTD","OB-DAY","OB-MTD","OB-YTD","L-DAY","L-MTD","L-YTD","M-DAY","M-MTD","M-YTD","H-DAY","H-MTD","H-YTD","Q-DAY","Q-MTD","Q-YTD","ST-DAY","ST-MTD","ST-YTD","MOHH","BREAKDOWN","AVAILABLE HOUR","EFFECTIVE WORKING HOUR (EWH)","RAIN HOUR","SLIPPERY","TOTAL DELAY","PHYSICAL AVAILABILITY (PA)","MECHANICAL AVAILABILITY (MA)","UTILIZATION OF AVAILABILITY (UA)","EFFECTIVE UTILIZATION (EU)"],"tblRAWHSE":["NM","MTI","LTI","FAI","PD","FC","EC","FATALITY"],"tblRAWWEWH":["EWH","RAIN HOUR","SLIPPERY","DAILY MEETING (P5M)","GENERAL SAFETY TALK","FRIDAY PRAY","REST & MEAL","REFUELLING & DAILY SERVICE (P2H)","RELOCATIONS","PREPARE LOADING/DUMPING POINT","SHIFT CHANGE","SURVEY & GC","PREPARE TOWER LAMP","BREAK FASTING","OTHERS"],"tblRAWSTOCK":["ETO-H-Ni","ETO-H-Fe","ETO-H-MC","ETO-H-TONAGE","ETO-M-Ni","ETO-M-Fe","ETO-M-MC","ETO-M-TONAGE","ETO-L-Ni","ETO-L-Fe","ETO-L-MC","ETO-L-TONAGE","ETO-LB-Ni","ETO-LB-Fe","ETO-LB-MC","ETO-LB-TONAGE","ETO-WS-TONAGE","ETO-WA-TONAGE","EFO-H-Ni","EFO-H-Fe","EFO-H-MC","EFO-H-TONAGE","EFO-M-Ni","EFO-M-Fe","EFO-M-MC","EFO-M-TONAGE","EFO-L-Ni","EFO-L-Fe","EFO-L-MC","EFO-L-TONAGE","EFO-LB-Ni","EFO-LB-Fe","EFO-LB-MC","EFO-LB-TONAGE","EFO-WS-TONAGE","EFO-WA-TONAGE"],"tblRAWHAUL":["DAY","MTD","YTD"],"tblRAWEQ":["OP-EXC1","OP-EXC2","OP-EXC3","OP-DT","OP-DOZER","OP-BREAKER","OP-GRADER","OP-COMPAC","OP-FT","OP-WT","OP-LV","OP-LT","OP-ADT","S-EXC1","S-EXC2","S-EXC3","S-DT","S-DOZER","S-BREAKER","S-GRADER","S-COMPAC","S-FT","S-WT","S-LV","S-LT","S-ADT","B-EXC1","B-EXC2","B-EXC3","B-DT","B-DOZER","B-BREAKER","B-GRADER","B-COMPAC","B-FT","B-WT","B-LV","B-LT","B-ADT","P-EXC1","P-EXC2","P-EXC3","P-DT","P-DOZER","P-BREAKER","P-GRADER","P-COMPAC","P-FT","P-WT","P-LV","P-LT","P-ADT"],"tblRAWUP":["EXC-PA","EXC-MA","EXC-UA","EXC-EU","DT-PA","DT-MA","DT-UA","DT-EU","DZ-PA","DZ-MA","DZ-UA","DZ-EU","GD-PA","GD-MA","GD-UA","GD-EU","CP-PA","CP-MA","CP-UA","CP-EU"],"tblRAWFUEL":["DAY","MTD","STOCK ADD","STOCK","FR"],"tblRAWMP":["ADD","RESIGN","TOTAL","MANAGER","SPT","SPV","DRIVER","OPERATOR","ETC"],"tblRAWLAB":["ID-FP","ID-QC","ID-SS","ID-SC","ID-FO","ID-DOME","ID-BARGE","ID-EXPLO","FD-FP","FD-QC","FD-SS","FD-SC","FD-FO","FD-DOME","FD-BARGE","FD-EXPLO","AD-FP","AD-QC","AD-SS","AD-SC","AD-FO","AD-DOME","AD-BARGE","AD-EXPLO"],"tblRAWEXPLO":["SO-PLAN","SO-ACTUAL","PUH-PLAN","PUH-ACTUAL","P-DH","P-SAMPLE","P-DEPTH","A-DH","A-SAMPLE","A-DEPTH"],"tblRAWGEOMAP":["TOTAL COVERED AREA"]}'::jsonb; r jsonb;
begin
  if public.etl_role() is null then raise exception 'ETL: not allowed'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'ETL: the date range is not valid'; end if;
  if p_to - p_from > 400 then raise exception 'ETL: the date range is longer than 400 days'; end if;
  select site into v_site from public.etl_config;
  if v_site is null then raise exception 'ETL: this project has no site configured (etl_config)'; end if;
  with sel as (
    select h.tbl, h.row_date d, coalesce(h.data->>'CONTRACTOR', '') c, h.data
    from public.etl_history h
    where h.site = v_site and h.row_date between p_from and p_to and cols ? h.tbl),
  ex as (
    select s.tbl, s.d, s.c, k.col, (s.data->>k.col)::numeric x
    from sel s cross join lateral jsonb_array_elements_text(cols->s.tbl) as k(col)
    where (s.data->>k.col) ~ '^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$'),
  sums as (select tbl, d, c, col, sum(x) s from ex group by 1, 2, 3, 4),
  vv as (select tbl, d, c, jsonb_object_agg(col, round(s, 4)) v from sums group by 1, 2, 3),
  cnt as (select tbl, d, c, count(*) n from sel group by 1, 2, 3),
  rows_ as (select cnt.tbl, jsonb_agg(jsonb_build_object('d', cnt.d, 'c', cnt.c, 'n', cnt.n, 'v', coalesce(vv.v, '{}'::jsonb)) order by cnt.d, cnt.c) rr
            from cnt left join vv on vv.tbl = cnt.tbl and vv.d = cnt.d and vv.c = cnt.c group by cnt.tbl)
  select jsonb_build_object(
    'site', v_site, 'from', p_from, 'to', p_to,
    'first', (select min(x.row_date) from public.etl_history x where x.site = v_site and x.tbl in ('tblRAWSHIP', 'tblRAWMNG')),
    'last',  (select max(x.row_date) from public.etl_history x where x.site = v_site and x.tbl in ('tblRAWSHIP', 'tblRAWMNG')),
    'daily', coalesce((select jsonb_object_agg(tbl, rr) from rows_), '{}'::jsonb),
    'hazard', coalesce((select jsonb_agg(jsonb_build_object('date', h.row_date) || h.data order by h.row_date, h.id)
                        from (select * from public.etl_history x where x.site = v_site and x.tbl = 'tblRAWHAZARD' and x.row_date between p_from and p_to order by x.row_date desc, x.id desc limit 1000) h), '[]'::jsonb),
    'cons', coalesce((select jsonb_agg(jsonb_build_object('date', t.row_date) || t.data) from (
                        select distinct on (h.data->>'AREA', h.data->>'CONSTRUCTION ITEM') h.row_date, h.data
                        from public.etl_history h where h.site = v_site and h.tbl = 'tblRAWCONS' and h.row_date <= p_to
                        order by h.data->>'AREA', h.data->>'CONSTRUCTION ITEM', h.row_date desc, h.id desc) t), '[]'::jsonb),
    'barge', coalesce((select jsonb_agg(h.data) from (select x.data from public.etl_history x where x.site = v_site and x.tbl = 'tblRAWBARGE' order by x.id desc limit 300) h), '[]'::jsonb)
  ) into r;
  return r;
end $$;
revoke all on function public.etl_dash_data(date, date) from public, anon;
grant execute on function public.etl_dash_data(date, date) to authenticated;
