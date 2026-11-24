-- etl_05_hazard.sql  (OPD step 4.4b)  Run in the SQL editor of each site project AFTER etl_01 - etl_04. Safe to run twice.
-- Why: a day can hold several hazard findings with the same category and status (the TMS master has 6 such days). Their rows differ only in text_value
-- (location | hazard | action). So
--   1. etl_stage: two rows are a duplicate only when the text is also the same.
--   2. etl_shadow_diff: rows are matched on the text too, so several findings of one day are not multiplied against each other.
-- Nothing else changes. The fact tables have no unique key, a load replaces whole (site, date, category, group) partitions.

create or replace function public.etl_stage(
  p_site text, p_report_date date, p_kind text, p_source_file text,
  p_actual jsonb, p_plan jsonb default '[]'::jsonb, p_sections jsonb default '{}'::jsonb, p_issues jsonb default '[]'::jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_batch uuid; v_cfg text; v_bad int; v_dups int;
begin
  if not public.etl_can_load() then raise exception 'ETL: not allowed to load reports'; end if;
  select site into v_cfg from public.etl_config;
  if v_cfg is null then raise exception 'ETL: this project has no site configured (etl_config)'; end if;
  if p_site is distinct from v_cfg then raise exception 'ETL: this project serves site %, not %', v_cfg, p_site; end if;
  if p_report_date is null then raise exception 'ETL: report date is missing'; end if;

  create temp table _a on commit drop as
    select * from jsonb_populate_recordset(null::public.etl_staging_actual, coalesce(p_actual,'[]'::jsonb));
  create temp table _p on commit drop as
    select * from jsonb_populate_recordset(null::public.etl_staging_actual, coalesce(p_plan,'[]'::jsonb));

  -- rows must carry site, date, category, metric_group and metric; numbers must have been numbers.
  select count(*) into v_bad from (
    select * from _a union all select * from _p) x
    where x.site is distinct from p_site or x.date is null or coalesce(x.category,'') = ''
       or coalesce(x.metric_group,'') = '' or coalesce(x.metric,'') = '';
  if v_bad > 0 then raise exception 'ETL: % row(s) without the right site, date, category, metric group or metric', v_bad; end if;

  select count(*) into v_bad from _a where date <> p_report_date;
  if v_bad > 0 then raise exception 'ETL: % actual row(s) are not dated %', v_bad, p_report_date; end if;

  select count(*) into v_bad from (select * from _a union all select * from _p) x
    where (p_sections ->> x.metric_group) is not null and (p_sections ->> x.metric_group) <> 'ok';
  if v_bad > 0 then raise exception 'ETL: % row(s) belong to a section that is not ok', v_bad; end if;

  select count(*) into v_dups from (
    select 1 from _a group by date, site, coalesce(pit,''), coalesce(contractor,''), coalesce(shift,''), category, metric_group, metric, coalesce(text_value,'') having count(*) > 1) d;
  if v_dups > 0 then raise exception 'ETL: % duplicate key(s) in the actual rows', v_dups; end if;
  select count(*) into v_dups from (
    select 1 from _p group by date, site, coalesce(pit,''), coalesce(contractor,''), coalesce(shift,''), category, metric_group, metric having count(*) > 1) d;
  if v_dups > 0 then raise exception 'ETL: % duplicate key(s) in the plan rows', v_dups; end if;

  insert into public.etl_batch (site, report_date, kind, source_file, sections, issues, created_by)
    values (p_site, p_report_date, p_kind, p_source_file, coalesce(p_sections,'{}'), coalesce(p_issues,'[]'), auth.uid())
    returning batch_id into v_batch;

  insert into public.etl_staging_actual select v_batch, date, site, pit, contractor, shift, category, metric_group, metric, value, text_value from _a;
  insert into public.etl_staging_plan   select v_batch, date, site, pit, contractor, shift, category, metric_group, metric, value, text_value from _p;
  insert into public.etl_batch_partition select distinct v_batch, 'actual', site, date, category, metric_group from _a;
  insert into public.etl_batch_partition select distinct v_batch, 'plan',   site, date, category, metric_group from _p;

  update public.etl_batch set row_counts = jsonb_build_object('actual', (select count(*) from _a), 'plan', (select count(*) from _p))
    where batch_id = v_batch;
  drop table _a; drop table _p;
  return v_batch;
end $$;

create or replace function public.etl_shadow_diff(p_batch uuid)
returns table (date date, category text, metric_group text, pit text, contractor text, shift text, metric text,
               prod_value numeric, portal_value numeric, state text)
language plpgsql stable security definer set search_path = public as $$
declare b public.etl_batch%rowtype;
begin
  if not public.etl_can_load() then raise exception 'ETL: not allowed'; end if;
  select * into b from public.etl_batch where batch_id = p_batch;
  if not found then raise exception 'ETL: batch not found'; end if;
  return query execute format($q$
    with part as (select * from public.etl_batch_partition where batch_id = %L and tbl = 'actual'),
    pr as (select f.date, f.category, f.metric_group, f.pit, f.contractor, f.shift, f.metric, f.value, f.text_value
             from %s f join part p on p.site = f.site and p.date = f.date and p.category = f.category and p.metric_group = f.metric_group),
    po as (select date, category, metric_group, pit, contractor, shift, metric, value, text_value from public.etl_staging_actual where batch_id = %L)
    select coalesce(o.date, r.date), coalesce(o.category, r.category), coalesce(o.metric_group, r.metric_group),
           coalesce(o.pit, r.pit), coalesce(o.contractor, r.contractor), coalesce(o.shift, r.shift), coalesce(o.metric, r.metric),
           r.value, o.value,
           case when r.metric is null then 'only_portal' when o.metric is null then 'only_prod'
                when r.value is not distinct from o.value or abs(r.value - o.value) <= 0.000001 then 'same' else 'changed' end
    from po o full join pr r
      on r.date = o.date and r.category = o.category and r.metric_group = o.metric_group and r.metric = o.metric
     and coalesce(r.pit,'') = coalesce(o.pit,'') and coalesce(r.contractor,'') = coalesce(o.contractor,'')
     and coalesce(r.shift,'') = coalesce(o.shift,'')
     and coalesce(r.text_value,'') = coalesce(o.text_value,'')$q$, p_batch, public.etl_real_table('actual'), p_batch);
end $$;
