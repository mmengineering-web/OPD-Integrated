-- One Portal Data, Phase 4, step 4.2a: history store (replaces the Excel master as the parsers' memory).
-- Run AFTER etl_01_core.sql, in the same project. Safe to run twice. Review before running in production.
--
-- What it is: the parsers need the past rows of the master tables (pit owners, previous fuel stock, barge list,
-- period sums) and the vocabulary lists. etl_history holds those rows as JSON, one row per master row:
--   tbl       tblRAWMNG, tblRAWHSE, ..., tblRAWBARGE, tblCALENDAR (plan, compare only), tblIDPIT, tblIDCONTRACTOR, ...
--   site      the site code of this project (etl_config)
--   row_date  the row's DATE (FINISHDATE for the barge list); null for vocabulary lists
--   data      the master row as JSON (column name -> value), input columns plus the stored values
-- It is seeded once from the existing master (tools/seed_history.py), then every confirmed load adds its rows.
--
-- This file REPLACES etl_load and etl_undo of step 4.1 with versions that also write and restore history.
-- Barge list: seeded and read only for now. Its merge rules (latest state, status never goes back) come in step 4.3.

create table if not exists public.etl_history (
  id          bigint generated always as identity primary key,
  tbl         text not null,
  site        text not null,
  row_date    date,
  data        jsonb not null,
  batch_id    uuid references public.etl_batch(batch_id) on delete set null,   -- null = seeded from the master
  created_at  timestamptz not null default now()
);
create index if not exists etl_history_lookup on public.etl_history (site, tbl, row_date);

-- raw (tblRAW*) rows of a staged batch, written to etl_history when the batch is loaded
create table if not exists public.etl_staging_raw (
  batch_id uuid not null references public.etl_batch(batch_id) on delete cascade,
  tbl      text not null,
  row_date date not null,
  data     jsonb not null
);
create index if not exists etl_staging_raw_batch on public.etl_staging_raw (batch_id);

alter table public.etl_backup drop constraint if exists etl_backup_tbl_check;
alter table public.etl_backup add constraint etl_backup_tbl_check check (tbl in ('actual','plan','history'));

alter table public.etl_history enable row level security;
alter table public.etl_staging_raw enable row level security;
revoke all on public.etl_history, public.etl_staging_raw from anon, authenticated, public;

-- Read: the parser asks for a table and a date window. Returns JSON rows (oldest first).
-- p_from / p_to null = no limit. Vocabulary lists have no date and are always returned when asked by name.
create or replace function public.etl_history_read(p_tbl text, p_from date default null, p_to date default null)
returns setof jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_site text;
begin
  if not public.etl_can_load() then raise exception 'ETL: not allowed'; end if;
  select site into v_site from public.etl_config;
  return query
    select h.data from public.etl_history h
    where h.site = v_site and h.tbl = p_tbl
      and (p_from is null or h.row_date is null or h.row_date >= p_from)
      and (p_to   is null or h.row_date is null or h.row_date <= p_to)
    order by h.row_date nulls first, h.id;
end $$;

-- Which dates are in the history (for the seed check and the Upload page "last day loaded").
create or replace function public.etl_history_summary()
returns table (tbl text, rows bigint, first_date date, last_date date)
language plpgsql stable security definer set search_path = public as $$
declare v_site text;
begin
  if not public.etl_can_load() then raise exception 'ETL: not allowed'; end if;
  select site into v_site from public.etl_config;
  return query select h.tbl, count(*), min(h.row_date), max(h.row_date)
    from public.etl_history h where h.site = v_site group by h.tbl order by h.tbl;
end $$;

-- Stage the raw rows of a batch: p_raw = {"tblRAWMNG":[{...DATE...}, ...], ...}. Only date-keyed tables (not the barge list).
create or replace function public.etl_stage_raw(p_batch uuid, p_raw jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare b public.etl_batch%rowtype; n int;
begin
  if not public.etl_can_load() then raise exception 'ETL: not allowed'; end if;
  select * into b from public.etl_batch where batch_id = p_batch for update;
  if not found then raise exception 'ETL: batch not found'; end if;
  if b.status <> 'staged' then raise exception 'ETL: batch is %, raw rows can only be added while staged', b.status; end if;
  if p_raw ? 'tblRAWBARGE' then raise exception 'ETL: the barge list is merged by SI, not staged by date (step 4.3)'; end if;
  delete from public.etl_staging_raw where batch_id = p_batch;
  insert into public.etl_staging_raw (batch_id, tbl, row_date, data)
    select p_batch, t.key, (r.value ->> 'DATE')::date, r.value
    from jsonb_each(p_raw) t, jsonb_array_elements(t.value) r
    where (r.value ->> 'DATE') is not null;
  get diagnostics n = row_count;
  if exists (select 1 from jsonb_each(p_raw) t, jsonb_array_elements(t.value) r where (r.value ->> 'DATE') is null) then
    raise exception 'ETL: a raw row has no DATE';
  end if;
  update public.etl_batch set row_counts = row_counts || jsonb_build_object('raw', n) where batch_id = p_batch;
  return n;
end $$;

-- Load (replaces 4.1): actual and plan as before, plus the history rows of the batch (replace per table and date).
create or replace function public.etl_load(p_batch uuid, p_replace_plan boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b public.etl_batch%rowtype; v_del_a int := 0; v_ins_a int := 0; v_del_p int := 0; v_ins_p int := 0;
  v_del_h int := 0; v_ins_h int := 0; v_diff jsonb;
begin
  if not public.etl_can_load() then raise exception 'ETL: not allowed to load reports'; end if;
  select * into b from public.etl_batch where batch_id = p_batch for update;
  if not found then raise exception 'ETL: batch not found'; end if;
  if b.status <> 'staged' then raise exception 'ETL: batch is %, only a staged batch can be loaded', b.status; end if;
  if p_replace_plan and not public.etl_can_replace_plan() then raise exception 'ETL: only a site admin can replace plan values'; end if;

  insert into public.etl_backup (batch_id, tbl, row_data)
    select p_batch, 'actual', to_jsonb(f) from public.fact_production_actual f join public.etl_batch_partition p
      on p.batch_id = p_batch and p.tbl = 'actual' and p.site = f.site and p.date = f.date and p.category = f.category and p.metric_group = f.metric_group;
  delete from public.fact_production_actual f using public.etl_batch_partition p
    where p.batch_id = p_batch and p.tbl = 'actual' and p.site = f.site and p.date = f.date and p.category = f.category and p.metric_group = f.metric_group;
  get diagnostics v_del_a = row_count;
  insert into public.fact_production_actual (date, site, pit, contractor, shift, category, metric_group, metric, value, text_value)
    select date, site, pit, contractor, shift, category, metric_group, metric, value, text_value from public.etl_staging_actual where batch_id = p_batch;
  get diagnostics v_ins_a = row_count;

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

  -- history: replace the rows of the same table and date, keep a copy of what was replaced
  insert into public.etl_backup (batch_id, tbl, row_data)
    select p_batch, 'history', to_jsonb(h) from public.etl_history h
    where h.site = b.site and exists (select 1 from public.etl_staging_raw s where s.batch_id = p_batch and s.tbl = h.tbl and s.row_date = h.row_date);
  delete from public.etl_history h
    where h.site = b.site and exists (select 1 from public.etl_staging_raw s where s.batch_id = p_batch and s.tbl = h.tbl and s.row_date = h.row_date);
  get diagnostics v_del_h = row_count;
  insert into public.etl_history (tbl, site, row_date, data, batch_id)
    select s.tbl, b.site, s.row_date, s.data, p_batch from public.etl_staging_raw s where s.batch_id = p_batch;
  get diagnostics v_ins_h = row_count;

  update public.etl_batch set status = 'loaded', loaded_by = auth.uid(), loaded_at = clock_timestamp(), plan_replaced = p_replace_plan,
    row_counts = row_counts || jsonb_build_object('actual_deleted', v_del_a, 'actual_inserted', v_ins_a,
                                                  'plan_deleted', v_del_p, 'plan_inserted', v_ins_p,
                                                  'history_deleted', v_del_h, 'history_inserted', v_ins_h, 'plan_diff', v_diff)
    where batch_id = p_batch;
  return (select row_counts from public.etl_batch where batch_id = p_batch);
end $$;

-- Undo (replaces 4.1): also puts the replaced history rows back.
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
  -- history: a later loaded batch that replaced the same table and date must be undone first
  select o.batch_id into v_clash from public.etl_batch o
    where o.status = 'loaded' and o.batch_id <> p_batch and o.loaded_at > b.loaded_at
      and exists (select 1 from public.etl_staging_raw so join public.etl_staging_raw sb
                    on sb.batch_id = p_batch and sb.tbl = so.tbl and sb.row_date = so.row_date where so.batch_id = o.batch_id)
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

  delete from public.etl_history h where h.batch_id = p_batch;
  insert into public.etl_history (id, tbl, site, row_date, data, batch_id, created_at) overriding system value
    select r.id, r.tbl, r.site, r.row_date, r.data, r.batch_id, r.created_at
    from public.etl_backup k, jsonb_populate_record(null::public.etl_history, k.row_data) r
    where k.batch_id = p_batch and k.tbl = 'history';

  update public.etl_batch set status = 'undone', undone_by = auth.uid(), undone_at = clock_timestamp() where batch_id = p_batch;
  return jsonb_build_object('batch_id', p_batch, 'status', 'undone');
end $$;

revoke all on function public.etl_history_read(text,date,date), public.etl_history_summary(), public.etl_stage_raw(uuid,jsonb),
  public.etl_load(uuid,boolean), public.etl_undo(uuid) from public, anon;
grant execute on function public.etl_history_read(text,date,date), public.etl_history_summary(), public.etl_stage_raw(uuid,jsonb),
  public.etl_load(uuid,boolean), public.etl_undo(uuid) to authenticated;
