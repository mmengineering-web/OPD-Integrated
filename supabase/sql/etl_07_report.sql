-- Phase 4.6: Daily Report reader. READ-ONLY, any active portal role (viewer and up), site project only.
-- Returns what the Daily Report (sections A-H) needs from the portal copy of the master tables (etl_history), for the newest loaded
-- day of the site (the "cut off"): production, shipment, plan, HSE and hazards of that day, the Monday-Sunday week of weather and
-- effective working hours, the latest ore stock, fuel, manpower and construction state on or before the cut off, and the monthly
-- HGO production of the year. Nothing is written. SECURITY DEFINER, no table grant, execute for authenticated only.
create or replace function public.etl_num(t text) returns numeric
language sql immutable as $$ select case when t ~ '^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$' then t::numeric else 0 end $$;

create or replace function public.etl_report_data(p_date date default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_site text; v_cut date; v_wk date; r jsonb;
begin
  if public.etl_role() is null then raise exception 'ETL: not allowed'; end if;
  select site into v_site from public.etl_config;
  if v_site is null then raise exception 'ETL: this project has no site configured (etl_config)'; end if;
  select max(h.row_date) into v_cut from public.etl_history h
    where h.site = v_site and h.tbl in ('tblRAWSHIP','tblRAWMNG') and h.row_date is not null and (p_date is null or h.row_date <= p_date);
  if v_cut is null then
    return jsonb_build_object('site', v_site, 'cut_off', null);
  end if;
  v_wk := date_trunc('week', v_cut)::date;      -- Monday
  select jsonb_build_object(
    'site', v_site, 'cut_off', v_cut, 'week_start', v_wk,
    'ship',   coalesce((select jsonb_agg(h.data order by h.id) from public.etl_history h where h.site = v_site and h.tbl = 'tblRAWSHIP'    and h.row_date = v_cut), '[]'::jsonb),
    'mng',    coalesce((select jsonb_agg(h.data order by h.id) from public.etl_history h where h.site = v_site and h.tbl = 'tblRAWMNG'     and h.row_date = v_cut), '[]'::jsonb),
    'hse',    coalesce((select jsonb_agg(h.data order by h.id) from public.etl_history h where h.site = v_site and h.tbl = 'tblRAWHSE'     and h.row_date = v_cut), '[]'::jsonb),
    'cal',    coalesce((select jsonb_agg(h.data order by h.id) from public.etl_history h where h.site = v_site and h.tbl = 'tblCALENDAR'   and h.row_date = v_cut), '[]'::jsonb),
    'hazard', coalesce((select jsonb_agg(h.data order by h.id) from public.etl_history h where h.site = v_site and h.tbl = 'tblRAWHAZARD'  and h.row_date = v_cut), '[]'::jsonb),
    'wewh',   coalesce((select jsonb_agg(jsonb_build_object('date', h.row_date) || h.data order by h.row_date, h.id) from public.etl_history h
                         where h.site = v_site and h.tbl = 'tblRAWWEWH' and h.row_date between v_wk and v_wk + 6), '[]'::jsonb),
    -- state tables: the newest day on or before the cut off
    'stock',  coalesce((select jsonb_agg(h.data order by h.id) from public.etl_history h where h.site = v_site and h.tbl = 'tblRAWSTOCK'
                         and h.row_date = (select max(x.row_date) from public.etl_history x where x.site = v_site and x.tbl = 'tblRAWSTOCK' and x.row_date <= v_cut)), '[]'::jsonb),
    'fuel',   coalesce((select jsonb_agg(h.data order by h.id) from public.etl_history h where h.site = v_site and h.tbl = 'tblRAWFUEL'
                         and h.row_date = (select max(x.row_date) from public.etl_history x where x.site = v_site and x.tbl = 'tblRAWFUEL' and x.row_date <= v_cut)), '[]'::jsonb),
    'mp',     coalesce((select jsonb_agg(h.data order by h.id) from public.etl_history h where h.site = v_site and h.tbl = 'tblRAWMP'
                         and h.row_date = (select max(x.row_date) from public.etl_history x where x.site = v_site and x.tbl = 'tblRAWMP' and x.row_date <= v_cut)), '[]'::jsonb),
    'cons',   coalesce((select jsonb_agg(t.data) from (
                         select distinct on (h.data->>'AREA', h.data->>'CONSTRUCTION ITEM') h.data
                         from public.etl_history h where h.site = v_site and h.tbl = 'tblRAWCONS' and h.row_date <= v_cut
                         order by h.data->>'AREA', h.data->>'CONSTRUCTION ITEM', h.row_date desc, h.id desc) t), '[]'::jsonb),
    -- HGO (saprolite) by month of the cut-off year: MTD of the last loaded day of each month, and the calendar target of that day
    'monthly', coalesce((select jsonb_agg(jsonb_build_object('month', l.m, 'date', l.d,
        'actual', (select coalesce(sum(public.etl_num(h.data->>'H-MTD')), 0) from public.etl_history h where h.site = v_site and h.tbl = 'tblRAWMNG' and h.row_date = l.d),
        'target', (select coalesce(sum(public.etl_num(h.data->>'H-MTD')), 0) from public.etl_history h where h.site = v_site and h.tbl = 'tblCALENDAR' and h.row_date = l.d)) order by l.m)
      from (select extract(month from x.row_date)::int m, max(x.row_date) d from public.etl_history x
            where x.site = v_site and x.tbl = 'tblRAWMNG' and x.row_date <= v_cut and extract(year from x.row_date) = extract(year from v_cut) group by 1) l), '[]'::jsonb)
  ) into r;
  return r;
end $$;
revoke all on function public.etl_report_data(date), public.etl_num(text) from public, anon;
grant execute on function public.etl_report_data(date) to authenticated;
