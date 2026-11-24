-- One Portal Data, Phase 4, step 4.1: Daily Report ETL core (batch log, staging, load, undo).
-- Run in the SQL editor of EACH production site project (WKM, BM, TMS, ...). Safe to run twice.
-- Review before running in production.
--
-- ASSUMPTIONS to confirm on one real project before running (nothing here touches the Excel-fed flow until etl_load is called):
--   1. NOTE: etl_load/etl_undo/etl_plan_diff here are SUPERSEDED by etl_03_safe_target.sql (prod_v2 target, shadow mode). Run 01, 02, 03 together, never 01+02 alone.
--      date, site, pit, contractor, shift, category, metric_group, metric, value, text_value.
--   2. public.op_profile exists (supabase/sql/op_profile.sql).
--   3. The desktop ETL writes the same fact tables. While both run, the desktop ETL "delete dates no longer in master"
--      rule can erase OPD loads. Pause that rule per site, or run the shadow period (docs/ROADMAP.md, Phase 4) first.
--
-- Rules built in:
--   - Only active profiles with role data_entry, site_admin or super_admin can stage and load (viewers cannot).
--   - A project serves ONE site (etl_config). Staging another site's report is refused.
--   - Writes happen only through the functions below. No direct insert/update/delete from the browser.
--   - A load replaces only the partitions it contains: (site, date, category, metric_group). Sections the adapter marked ERROR
--     are never staged, so their old rows stay.
--   - Load twice = same rows. Undo restores the exact previous rows from etl_backup.
--   - Plan values are compared, not written. Only an explicit "replace plan" by site_admin or super_admin writes them.
--   - The existing desktop table etl_load_log is not touched. This flow logs in etl_batch.

-- 1. Config: which site this project serves. Set once per project, for example:
--    insert into public.etl_config (site) values ('PT TAMBANG MATARAPE SEJAHTERA');   -- exactly the text of the `site` column in prod_v2
create table if not exists public.etl_config (
  site text primary key,
  created_at timestamptz not null default now()
);
create unique index if not exists etl_config_one_row on public.etl_config ((true));

-- 2. Batch = one log row per dropped report.
create table if not exists public.etl_batch (
  batch_id     uuid primary key default gen_random_uuid(),
  site         text not null,
  report_date  date not null,
  kind         text not null,
  source_file  text,
  status       text not null default 'staged' check (status in ('staged','loaded','undone','failed')),
  sections     jsonb not null default '{}'::jsonb,
  issues       jsonb not null default '[]'::jsonb,
  row_counts   jsonb not null default '{}'::jsonb,
  plan_replaced boolean not null default false,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  loaded_by    uuid,
  loaded_at    timestamptz,
  undone_by    uuid,
  undone_at    timestamptz
);
create index if not exists etl_batch_site_date on public.etl_batch (site, report_date desc, created_at desc);

-- 3. Staging rows (same 10 columns as the fact tables) and the partitions a batch touches.
create table if not exists public.etl_staging_actual (
  batch_id uuid not null references public.etl_batch(batch_id) on delete cascade,
  date date not null, site text not null, pit text, contractor text, shift text,
  category text not null, metric_group text not null, metric text not null, value numeric, text_value text
);
create index if not exists etl_staging_actual_batch on public.etl_staging_actual (batch_id);
create table if not exists public.etl_staging_plan (like public.etl_staging_actual including defaults);
alter table public.etl_staging_plan add constraint etl_staging_plan_batch_fk foreign key (batch_id) references public.etl_batch(batch_id) on delete cascade;
create index if not exists etl_staging_plan_batch on public.etl_staging_plan (batch_id);

create table if not exists public.etl_batch_partition (
  batch_id uuid not null references public.etl_batch(batch_id) on delete cascade,
  tbl text not null check (tbl in ('actual','plan')),
  site text not null, date date not null, category text not null, metric_group text not null,
  primary key (batch_id, tbl, site, date, category, metric_group)
);

-- 4. Backup of the rows a load replaced, so undo restores them exactly.
create table if not exists public.etl_backup (
  batch_id uuid not null references public.etl_batch(batch_id) on delete cascade,
  tbl text not null check (tbl in ('actual','plan')),
  row_data jsonb not null
);
create index if not exists etl_backup_batch on public.etl_backup (batch_id, tbl);

-- 5. Access. Everything is locked; people read the log through RLS, and write only through the functions.
alter table public.etl_config enable row level security;
alter table public.etl_batch enable row level security;
alter table public.etl_staging_actual enable row level security;
alter table public.etl_staging_plan enable row level security;
alter table public.etl_batch_partition enable row level security;
alter table public.etl_backup enable row level security;
revoke all on public.etl_config, public.etl_batch, public.etl_staging_actual, public.etl_staging_plan,
              public.etl_batch_partition, public.etl_backup from anon, authenticated, public;

create or replace function public.etl_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.op_profile where user_id = auth.uid() and is_active;
$$;
create or replace function public.etl_can_load() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.etl_role() in ('data_entry','site_admin','super_admin'), false);
$$;
create or replace function public.etl_can_replace_plan() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.etl_role() in ('site_admin','super_admin'), false);
$$;

grant select on public.etl_batch to authenticated;
drop policy if exists etl_batch_read on public.etl_batch;
create policy etl_batch_read on public.etl_batch for select to authenticated using (public.etl_can_load());
-- No insert/update/delete policy on purpose.

-- 6. Stage: validate and store the parsed rows of one report. Returns the batch id.
--    p_actual / p_plan: json arrays of {date,site,pit,contractor,shift,category,metric_group,metric,value,text_value}
--    p_sections: {"<metric_group>": "ok" | "error" | "skipped"} from the adapter. Rows of a non-ok group are refused.
--    p_issues: the adapter's issues list, kept for the log.
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
    select 1 from _a group by date, site, coalesce(pit,''), coalesce(contractor,''), coalesce(shift,''), category, metric_group, metric having count(*) > 1) d;
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

-- 7. Plan comparison for a staged batch (never writes).
create or replace function public.etl_plan_diff(p_batch uuid)
returns table (date date, category text, metric_group text, pit text, contractor text, shift text, metric text,
               existing numeric, incoming numeric, state text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.etl_can_load() then raise exception 'ETL: not allowed'; end if;
  return query
  with part as (select * from public.etl_batch_partition where batch_id = p_batch and tbl = 'plan'),
  ex as (select f.* from public.fact_production_plan f join part p
           on p.site = f.site and p.date = f.date and p.category = f.category and p.metric_group = f.metric_group),
  inc as (select * from public.etl_staging_plan where batch_id = p_batch)
  select coalesce(i.date, e.date), coalesce(i.category, e.category), coalesce(i.metric_group, e.metric_group),
         coalesce(i.pit, e.pit), coalesce(i.contractor, e.contractor), coalesce(i.shift, e.shift), coalesce(i.metric, e.metric),
         e.value, i.value,
         case when e.metric is null then 'new' when i.metric is null then 'missing'
              when e.value is not distinct from i.value and e.text_value is not distinct from i.text_value then 'same' else 'changed' end
  from inc i full join ex e
    on e.date = i.date and e.category = i.category and e.metric_group = i.metric_group and e.metric = i.metric
   and coalesce(e.pit,'') = coalesce(i.pit,'') and coalesce(e.contractor,'') = coalesce(i.contractor,'')
   and coalesce(e.shift,'') = coalesce(i.shift,'');
end $$;

-- 8. Load: replace the actual partitions of the batch. Plan is replaced only when asked and allowed.
create or replace function public.etl_load(p_batch uuid, p_replace_plan boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b public.etl_batch%rowtype; v_del_a int := 0; v_ins_a int := 0; v_del_p int := 0; v_ins_p int := 0; v_diff jsonb;
begin
  if not public.etl_can_load() then raise exception 'ETL: not allowed to load reports'; end if;
  select * into b from public.etl_batch where batch_id = p_batch for update;
  if not found then raise exception 'ETL: batch not found'; end if;
  if b.status <> 'staged' then raise exception 'ETL: batch is %, only a staged batch can be loaded', b.status; end if;
  if p_replace_plan and not public.etl_can_replace_plan() then raise exception 'ETL: only a site admin can replace plan values'; end if;

  -- actual: back up, delete, insert
  insert into public.etl_backup (batch_id, tbl, row_data)
    select p_batch, 'actual', to_jsonb(f) from public.fact_production_actual f join public.etl_batch_partition p
      on p.batch_id = p_batch and p.tbl = 'actual' and p.site = f.site and p.date = f.date and p.category = f.category and p.metric_group = f.metric_group;
  delete from public.fact_production_actual f using public.etl_batch_partition p
    where p.batch_id = p_batch and p.tbl = 'actual' and p.site = f.site and p.date = f.date and p.category = f.category and p.metric_group = f.metric_group;
  get diagnostics v_del_a = row_count;
  insert into public.fact_production_actual (date, site, pit, contractor, shift, category, metric_group, metric, value, text_value)
    select date, site, pit, contractor, shift, category, metric_group, metric, value, text_value from public.etl_staging_actual where batch_id = p_batch;
  get diagnostics v_ins_a = row_count;

  -- plan: compare always, write only when asked
  select coalesce(jsonb_object_agg(state, n), '{}'::jsonb) into v_diff
    from (select state, count(*) n from public.etl_plan_diff(p_batch) group by state) s;
  if p_replace_plan then
    insert into public.etl_backup (batch_id, tbl, row_data)
      select p_batch, 'plan', to_jsonb(f) from public.fact_production_plan f join public.etl_batch_partition p
        on p.batch_id = p_batch and p.tbl = 'plan' and p.site = f.site and p.date = f.date and p.category = f.category and p.metric_group = f.metric_group;
    delete from public.fact_production_plan f using public.etl_batch_partition p
      where p.batch_id = p_batch and p.tbl = 'plan' and p.site = f.site and p.date = f.date and p.category = f.category and p.metric_group = f.metric_group;
    get diagnostics v_del_p = row_count;
    insert into public.fact_production_plan (date, site, pit, contractor, shift, category, metric_group, metric, value, text_value)
      select date, site, pit, contractor, shift, category, metric_group, metric, value, text_value from public.etl_staging_plan where batch_id = p_batch;
    get diagnostics v_ins_p = row_count;
  end if;

  update public.etl_batch set status = 'loaded', loaded_by = auth.uid(), loaded_at = clock_timestamp(), plan_replaced = p_replace_plan,
    row_counts = row_counts || jsonb_build_object('actual_deleted', v_del_a, 'actual_inserted', v_ins_a,
                                                  'plan_deleted', v_del_p, 'plan_inserted', v_ins_p, 'plan_diff', v_diff)
    where batch_id = p_batch;
  return (select row_counts from public.etl_batch where batch_id = p_batch);
end $$;

-- 9. Undo: put the replaced rows back. Refused if a later loaded batch touched the same partitions.
create or replace function public.etl_undo(p_batch uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b public.etl_batch%rowtype; v_clash uuid;
begin
  if not public.etl_can_load() then raise exception 'ETL: not allowed'; end if;
  select * into b from public.etl_batch where batch_id = p_batch for update;
  if not found then raise exception 'ETL: batch not found'; end if;
  if b.status <> 'loaded' then raise exception 'ETL: batch is %, only a loaded batch can be undone', b.status; end if;

  select o.batch_id into v_clash from public.etl_batch o
    join public.etl_batch_partition po on po.batch_id = o.batch_id
    join public.etl_batch_partition pb on pb.batch_id = p_batch and pb.tbl = po.tbl and pb.site = po.site and pb.date = po.date
         and pb.category = po.category and pb.metric_group = po.metric_group
    where o.status = 'loaded' and o.batch_id <> p_batch and o.loaded_at > b.loaded_at
      and (po.tbl = 'actual' or o.plan_replaced)
    limit 1;
  if v_clash is not null then raise exception 'ETL: a later load (%) changed the same data. Undo that one first.', v_clash; end if;

  delete from public.fact_production_actual f using public.etl_batch_partition p
    where p.batch_id = p_batch and p.tbl = 'actual' and p.site = f.site and p.date = f.date and p.category = f.category and p.metric_group = f.metric_group;
  insert into public.fact_production_actual
    select r.* from public.etl_backup k, jsonb_populate_record(null::public.fact_production_actual, k.row_data) r
    where k.batch_id = p_batch and k.tbl = 'actual';

  if b.plan_replaced then
    delete from public.fact_production_plan f using public.etl_batch_partition p
      where p.batch_id = p_batch and p.tbl = 'plan' and p.site = f.site and p.date = f.date and p.category = f.category and p.metric_group = f.metric_group;
    insert into public.fact_production_plan
      select r.* from public.etl_backup k, jsonb_populate_record(null::public.fact_production_plan, k.row_data) r
      where k.batch_id = p_batch and k.tbl = 'plan';
  end if;

  update public.etl_batch set status = 'undone', undone_by = auth.uid(), undone_at = clock_timestamp() where batch_id = p_batch;
  return jsonb_build_object('batch_id', p_batch, 'status', 'undone');
end $$;

revoke all on function public.etl_stage(text,date,text,text,jsonb,jsonb,jsonb,jsonb), public.etl_plan_diff(uuid),
  public.etl_load(uuid,boolean), public.etl_undo(uuid), public.etl_role(), public.etl_can_load(), public.etl_can_replace_plan()
  from public, anon;
grant execute on function public.etl_stage(text,date,text,text,jsonb,jsonb,jsonb,jsonb), public.etl_plan_diff(uuid),
  public.etl_load(uuid,boolean), public.etl_undo(uuid), public.etl_can_load(), public.etl_can_replace_plan() to authenticated;
