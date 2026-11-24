-- One Portal Data, Phase 4, step 4.2a-safety: the portal must not change prod_v2 until you say so.
-- Run AFTER etl_01_core.sql and etl_02_history.sql. Supersedes etl_plan_diff, etl_load and etl_undo of those files.
--
-- Why: prod_v2.fact_* are read by Looker. This file makes sure nothing in the portal's load path touches them
-- until the compare week is finished.
--   1. Nothing here alters, indexes, triggers or adds policies to any prod_v2 table. prod_v2 is only READ
--      (plan compare, shadow compare) until the site goes live.
--   2. Default mode is SHADOW: etl_load writes to public.etl_shadow_actual / etl_shadow_plan, which have the same 10
--      columns. Looker never sees them.
--   3. LIVE is a flag in etl_config. It can only be switched by the project owner in the SQL editor (no function,
--      no role of the portal can do it). When live, a load replaces only the (site, date, category, metric_group)
--      partitions of the uploaded report, exactly like the desktop ETL does for a changed date, and keeps a backup for undo.
--   4. Each batch remembers its target (shadow / live), so undo always restores the table the load wrote to.
--   5. The fact schema name is in etl_config.fact_schema (default prod_v2). Missing table = the load fails and writes nothing.

alter table public.etl_config add column if not exists live boolean not null default false;
alter table public.etl_config add column if not exists fact_schema text not null default 'prod_v2';
alter table public.etl_batch  add column if not exists target text check (target in ('shadow','live'));

create table if not exists public.etl_shadow_actual (
  date date, site text, pit text, contractor text, shift text, category text, metric_group text, metric text, value numeric, text_value text,
  source_file text, loaded_at timestamptz default now());
create table if not exists public.etl_shadow_plan (like public.etl_shadow_actual including defaults);
create index if not exists etl_shadow_actual_part on public.etl_shadow_actual (site, date, category, metric_group);
create index if not exists etl_shadow_plan_part   on public.etl_shadow_plan   (site, date, category, metric_group);
alter table public.etl_shadow_actual enable row level security;
alter table public.etl_shadow_plan   enable row level security;
revoke all on public.etl_shadow_actual, public.etl_shadow_plan from anon, authenticated, public;

-- the table a load writes to right now ('actual' | 'plan'), and the real prod table to compare with
create or replace function public.etl_target_table(p_tbl text, p_target text) returns text
language sql stable set search_path = public as $$
  select case when p_target = 'live'
              then format('%I.%I', (select fact_schema from public.etl_config), 'fact_production_' || p_tbl)
              else format('public.%I', 'etl_shadow_' || p_tbl) end $$;
create or replace function public.etl_real_table(p_tbl text) returns text
language sql stable set search_path = public as $$
  select format('%I.%I', (select fact_schema from public.etl_config), 'fact_production_' || p_tbl) $$;


-- prod_v2.fact_* also has source_file and loaded_at (and an id). The portal fills source_file with 'OPD: <file name>' and loaded_at with now(),
-- only when the target table has those columns. id is always left to the table's own default.
create or replace function public.etl_extra_lists(p_table text, p_src text, out ins text, out sel text)
language plpgsql stable set search_path = public as $$
declare t regclass := to_regclass(p_table);
begin
  ins := ''; sel := '';
  if t is null then return; end if;
  if exists (select 1 from pg_attribute where attrelid = t and attname = 'source_file' and not attisdropped) then
    ins := ins || ', source_file'; sel := sel || ', ' || quote_literal('OPD: ' || coalesce(p_src, 'upload'));
  end if;
  if exists (select 1 from pg_attribute where attrelid = t and attname = 'loaded_at' and not attisdropped) then
    ins := ins || ', loaded_at'; sel := sel || ', clock_timestamp()';
  end if;
end $$;

-- The 10 standard columns that exist in the real prod_v2 table (fact_production_plan has no shift column).
create or replace function public.etl_std_cols(p_real text) returns text
language sql stable set search_path = public as $$
  select string_agg(quote_ident(c), ', ' order by o)
  from unnest(array['date','site','pit','contractor','shift','category','metric_group','metric','value','text_value']) with ordinality u(c, o)
  where exists (select 1 from pg_attribute a where a.attrelid = to_regclass(p_real) and a.attname = u.c and not a.attisdropped) $$;

-- Plan comparison for a staged batch. Reads the real plan table, never writes.
create or replace function public.etl_plan_diff(p_batch uuid)
returns table (date date, category text, metric_group text, pit text, contractor text, shift text, metric text,
               existing numeric, incoming numeric, state text)
language plpgsql stable security definer set search_path = public as $$
declare has_shift boolean := exists (select 1 from pg_attribute where attrelid = to_regclass(public.etl_real_table('plan')) and attname = 'shift' and not attisdropped);
begin
  if not public.etl_can_load() then raise exception 'ETL: not allowed'; end if;
  return query execute format($q$
    with part as (select * from public.etl_batch_partition where batch_id = %L and tbl = 'plan'),
    ex as (select f.date, f.category, f.metric_group, f.pit, f.contractor, %s as shift, f.metric, f.value, f.text_value
             from %s f join part p on p.site = f.site and p.date = f.date and p.category = f.category and p.metric_group = f.metric_group),
    inc as (select * from public.etl_staging_plan where batch_id = %L)
    select coalesce(i.date, e.date), coalesce(i.category, e.category), coalesce(i.metric_group, e.metric_group),
           coalesce(i.pit, e.pit), coalesce(i.contractor, e.contractor), coalesce(i.shift, e.shift), coalesce(i.metric, e.metric),
           e.value, i.value,
           case when e.metric is null then 'new' when i.metric is null then 'missing'
                when e.value is not distinct from i.value and e.text_value is not distinct from i.text_value then 'same' else 'changed' end
    from inc i full join ex e
      on e.date = i.date and e.category = i.category and e.metric_group = i.metric_group and e.metric = i.metric
     and coalesce(e.pit,'') = coalesce(i.pit,'') and coalesce(e.contractor,'') = coalesce(i.contractor,'')
     %s$q$, p_batch, case when has_shift then 'f.shift' else 'null::text' end, public.etl_real_table('plan'), p_batch,
     case when has_shift then 'and coalesce(e.shift,'''') = coalesce(i.shift,'''')' else '' end);
end $$;

-- Compare week tool: what the portal wrote (shadow or live target of the batch) versus what the desktop ETL has in prod_v2,
-- for the partitions of the batch. state: same / changed / only_portal / only_prod.
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
    pr as (select f.date, f.category, f.metric_group, f.pit, f.contractor, f.shift, f.metric, f.value
             from %s f join part p on p.site = f.site and p.date = f.date and p.category = f.category and p.metric_group = f.metric_group),
    po as (select date, category, metric_group, pit, contractor, shift, metric, value from public.etl_staging_actual where batch_id = %L)
    select coalesce(o.date, r.date), coalesce(o.category, r.category), coalesce(o.metric_group, r.metric_group),
           coalesce(o.pit, r.pit), coalesce(o.contractor, r.contractor), coalesce(o.shift, r.shift), coalesce(o.metric, r.metric),
           r.value, o.value,
           case when r.metric is null then 'only_portal' when o.metric is null then 'only_prod'
                when r.value is not distinct from o.value then 'same' else 'changed' end
    from po o full join pr r
      on r.date = o.date and r.category = o.category and r.metric_group = o.metric_group and r.metric = o.metric
     and coalesce(r.pit,'') = coalesce(o.pit,'') and coalesce(r.contractor,'') = coalesce(o.contractor,'')
     and coalesce(r.shift,'') = coalesce(o.shift,'')$q$, p_batch, public.etl_real_table('actual'), p_batch);
end $$;

create or replace function public.etl_load(p_batch uuid, p_replace_plan boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b public.etl_batch%rowtype; cfg public.etl_config%rowtype; v_target text; ta text; tp text;
  v_del_a int := 0; v_ins_a int := 0; v_del_p int := 0; v_ins_p int := 0; v_del_h int := 0; v_ins_h int := 0; v_diff jsonb;
  ca text := public.etl_std_cols(public.etl_real_table('actual')); cp text := public.etl_std_cols(public.etl_real_table('plan'));
  pj constant text := 'p.site = f.site and p.date = f.date and p.category = f.category and p.metric_group = f.metric_group';
  xa record; xp record;
begin
  if not public.etl_can_load() then raise exception 'ETL: not allowed to load reports'; end if;
  select * into b from public.etl_batch where batch_id = p_batch for update;
  if not found then raise exception 'ETL: batch not found'; end if;
  if b.status <> 'staged' then raise exception 'ETL: batch is %, only a staged batch can be loaded', b.status; end if;
  if p_replace_plan and not public.etl_can_replace_plan() then raise exception 'ETL: only a site admin can replace plan values'; end if;
  select * into cfg from public.etl_config;
  v_target := case when cfg.live then 'live' else 'shadow' end;
  ta := public.etl_target_table('actual', v_target); tp := public.etl_target_table('plan', v_target);
  select * into xa from public.etl_extra_lists(ta, b.source_file); select * into xp from public.etl_extra_lists(tp, b.source_file);

  execute format('insert into public.etl_backup (batch_id, tbl, row_data) select %L, ''actual'', to_jsonb(f) from %s f join public.etl_batch_partition p on p.batch_id = %L and p.tbl = ''actual'' and %s', p_batch, ta, p_batch, pj);
  execute format('delete from %s f using public.etl_batch_partition p where p.batch_id = %L and p.tbl = ''actual'' and %s', ta, p_batch, pj);
  get diagnostics v_del_a = row_count;
  execute format('insert into %s (%s%s) select %s%s from public.etl_staging_actual where batch_id = %L', ta, ca, xa.ins, ca, xa.sel, p_batch);
  get diagnostics v_ins_a = row_count;

  select coalesce(jsonb_object_agg(state, n), '{}'::jsonb) into v_diff from (select state, count(*) n from public.etl_plan_diff(p_batch) group by state) s;
  if p_replace_plan then
    execute format('insert into public.etl_backup (batch_id, tbl, row_data) select %L, ''plan'', to_jsonb(f) from %s f join public.etl_batch_partition p on p.batch_id = %L and p.tbl = ''plan'' and %s', p_batch, tp, p_batch, pj);
    execute format('delete from %s f using public.etl_batch_partition p where p.batch_id = %L and p.tbl = ''plan'' and %s', tp, p_batch, pj);
    get diagnostics v_del_p = row_count;
    execute format('insert into %s (%s%s) select %s%s from public.etl_staging_plan where batch_id = %L', tp, cp, xp.ins, cp, xp.sel, p_batch);
    get diagnostics v_ins_p = row_count;
  end if;

  -- history is the portal's own table, written in both modes
  insert into public.etl_backup (batch_id, tbl, row_data)
    select p_batch, 'history', to_jsonb(h) from public.etl_history h
    where h.site = b.site and exists (select 1 from public.etl_staging_raw s where s.batch_id = p_batch and s.tbl = h.tbl and s.row_date = h.row_date);
  delete from public.etl_history h
    where h.site = b.site and exists (select 1 from public.etl_staging_raw s where s.batch_id = p_batch and s.tbl = h.tbl and s.row_date = h.row_date);
  get diagnostics v_del_h = row_count;
  insert into public.etl_history (tbl, site, row_date, data, batch_id)
    select s.tbl, b.site, s.row_date, s.data, p_batch from public.etl_staging_raw s where s.batch_id = p_batch;
  get diagnostics v_ins_h = row_count;

  update public.etl_batch set status = 'loaded', target = v_target, loaded_by = auth.uid(), loaded_at = clock_timestamp(), plan_replaced = p_replace_plan,
    row_counts = row_counts || jsonb_build_object('target', v_target, 'actual_deleted', v_del_a, 'actual_inserted', v_ins_a,
        'plan_deleted', v_del_p, 'plan_inserted', v_ins_p, 'history_deleted', v_del_h, 'history_inserted', v_ins_h, 'plan_diff', v_diff)
    where batch_id = p_batch;
  return (select row_counts from public.etl_batch where batch_id = p_batch);
end $$;

create or replace function public.etl_undo(p_batch uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b public.etl_batch%rowtype; v_clash uuid; ta text; tp text; xa record; xp record;
  ca text := public.etl_std_cols(public.etl_real_table('actual')); cp text := public.etl_std_cols(public.etl_real_table('plan'));
  pj constant text := 'p.site = f.site and p.date = f.date and p.category = f.category and p.metric_group = f.metric_group';
begin
  if not public.etl_can_load() then raise exception 'ETL: not allowed'; end if;
  select * into b from public.etl_batch where batch_id = p_batch for update;
  if not found then raise exception 'ETL: batch not found'; end if;
  if b.status <> 'loaded' then raise exception 'ETL: batch is %, only a loaded batch can be undone', b.status; end if;
  ta := public.etl_target_table('actual', b.target); tp := public.etl_target_table('plan', b.target);
  select * into xa from public.etl_extra_lists(ta, null); select * into xp from public.etl_extra_lists(tp, null);

  select o.batch_id into v_clash from public.etl_batch o
    join public.etl_batch_partition po on po.batch_id = o.batch_id
    join public.etl_batch_partition pb on pb.batch_id = p_batch and pb.tbl = po.tbl and pb.site = po.site and pb.date = po.date
         and pb.category = po.category and pb.metric_group = po.metric_group
    where o.status = 'loaded' and o.target = b.target and o.batch_id <> p_batch and o.loaded_at > b.loaded_at
      and (po.tbl = 'actual' or o.plan_replaced)
    limit 1;
  if v_clash is not null then raise exception 'ETL: a later load (%) changed the same data. Undo that one first.', v_clash; end if;
  select o.batch_id into v_clash from public.etl_batch o
    where o.status = 'loaded' and o.batch_id <> p_batch and o.loaded_at > b.loaded_at
      and exists (select 1 from public.etl_staging_raw so join public.etl_staging_raw sb
                    on sb.batch_id = p_batch and sb.tbl = so.tbl and sb.row_date = so.row_date where so.batch_id = o.batch_id)
    limit 1;
  if v_clash is not null then raise exception 'ETL: a later load (%) changed the same data. Undo that one first.', v_clash; end if;

  execute format('delete from %s f using public.etl_batch_partition p where p.batch_id = %L and p.tbl = ''actual'' and %s', ta, p_batch, pj);
  execute format('insert into %s (%s%s) select %s%s from public.etl_backup k, jsonb_populate_record(null::%s, k.row_data) f where k.batch_id = %L and k.tbl = ''actual''', ta, ca, xa.ins, ca, xa.ins, ta, p_batch);
  if b.plan_replaced then
    execute format('delete from %s f using public.etl_batch_partition p where p.batch_id = %L and p.tbl = ''plan'' and %s', tp, p_batch, pj);
    execute format('insert into %s (%s%s) select %s%s from public.etl_backup k, jsonb_populate_record(null::%s, k.row_data) f where k.batch_id = %L and k.tbl = ''plan''', tp, cp, xp.ins, cp, xp.ins, tp, p_batch);
  end if;

  delete from public.etl_history h where h.batch_id = p_batch;
  insert into public.etl_history (id, tbl, site, row_date, data, batch_id, created_at) overriding system value
    select r.id, r.tbl, r.site, r.row_date, r.data, r.batch_id, r.created_at
    from public.etl_backup k, jsonb_populate_record(null::public.etl_history, k.row_data) r where k.batch_id = p_batch and k.tbl = 'history';

  update public.etl_batch set status = 'undone', undone_by = auth.uid(), undone_at = clock_timestamp() where batch_id = p_batch;
  return jsonb_build_object('batch_id', p_batch, 'status', 'undone', 'target', b.target);
end $$;

revoke all on function public.etl_std_cols(text), public.etl_extra_lists(text,text), public.etl_target_table(text,text), public.etl_real_table(text), public.etl_plan_diff(uuid),
  public.etl_shadow_diff(uuid), public.etl_load(uuid,boolean), public.etl_undo(uuid) from public, anon;
grant execute on function public.etl_plan_diff(uuid), public.etl_shadow_diff(uuid), public.etl_load(uuid,boolean), public.etl_undo(uuid) to authenticated;
-- Going live (owner only, SQL editor, per site, after the compare week):  update public.etl_config set live = true;
