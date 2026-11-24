-- One Portal Data, Phase 4, step 4.3: the barge list, the plan replace and the ship updates in the portal.
-- Run AFTER etl_01, etl_02 and etl_03, in the same project. Safe to run twice. Supersedes etl_load and etl_undo of etl_03.
--
-- What it does: an uploaded Daily Report adds new barges (SI) to the list and updates existing ones (status never goes back; the rules are the
-- desktop ETL's, run in the browser). The browser also rebuilds the calculated columns (MONTH, YEAR, WEEK, WTD, MTD, YTD) and sends only the rows
-- that changed. Load writes them to
--   1. etl_history (tbl tblRAWBARGE): the same row keeps its id, so the list order does not change; a new SI is added at the end;
--   2. the barge table of the target: public.etl_shadow_barge in shadow mode, <fact_schema>.fact_barge when etl_config.live = true.
-- Plan replace (4.3b): a batch staged with the calendar rows (tblCALENDAR) and plan rows loads only with p_replace_plan = true (site_admin and up).
-- Undo puts both back. prod_v2.fact_barge is never touched in shadow mode. Looker is not affected until you go live.

alter table public.etl_backup drop constraint if exists etl_backup_tbl_check;
alter table public.etl_backup add constraint etl_backup_tbl_check check (tbl in ('actual','plan','history','barge'));

-- barge rows staged with a batch: si (upper case, trimmed), hist = the tblRAWBARGE row, fact = the fact_barge row, old = the row before
create table if not exists public.etl_staging_barge (
  batch_id uuid not null references public.etl_batch(batch_id) on delete cascade,
  si text not null, hist jsonb not null, fact jsonb not null, old jsonb);
create index if not exists etl_staging_barge_batch on public.etl_staging_barge (batch_id);
create index if not exists etl_staging_barge_si on public.etl_staging_barge (si);

create table if not exists public.etl_shadow_barge (
  si text, month_name text, vessel_barge text, capacity numeric, contractor text, start_date date, finish_date date,
  plan_capacity numeric, actual_capacity numeric, wtd numeric, mtd numeric, ytd numeric, grade_plan numeric, grade_actual numeric,
  status text, input_date date, year_month text, month_week text, week text, site text, source_file text, loaded_at timestamptz default now());
create index if not exists etl_shadow_barge_si on public.etl_shadow_barge (site, si);
alter table public.etl_staging_barge enable row level security;
alter table public.etl_shadow_barge  enable row level security;
revoke all on public.etl_staging_barge, public.etl_shadow_barge from anon, authenticated, public;

create or replace function public.etl_barge_table(p_target text) returns text
language sql stable set search_path = public as $$
  select case when p_target = 'live' then format('%I.%I', (select fact_schema from public.etl_config), 'fact_barge')
              else 'public.etl_shadow_barge' end $$;

-- the barge columns that exist in the real fact_barge (id, source_file and loaded_at are handled apart)
create or replace function public.etl_barge_cols(p_real text) returns text
language sql stable set search_path = public as $$
  select string_agg(quote_ident(c), ', ' order by o)
  from unnest(array['si','month_name','vessel_barge','capacity','contractor','start_date','finish_date','plan_capacity','actual_capacity',
                    'wtd','mtd','ytd','grade_plan','grade_actual','status','input_date','year_month','month_week','week','site']) with ordinality u(c, o)
  where exists (select 1 from pg_attribute a where a.attrelid = to_regclass(p_real) and a.attname = u.c and not a.attisdropped) $$;

-- stage the changed barge rows of a batch: p_rows = [{"si":..., "hist":{...}, "fact":{...}, "old":{...}|null}, ...]
create or replace function public.etl_stage_barge(p_batch uuid, p_rows jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare b public.etl_batch%rowtype; n int;
begin
  if not public.etl_can_load() then raise exception 'ETL: not allowed'; end if;
  select * into b from public.etl_batch where batch_id = p_batch for update;
  if not found then raise exception 'ETL: batch not found'; end if;
  if b.status <> 'staged' then raise exception 'ETL: batch is %, barge rows can only be added while staged', b.status; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'ETL: barge rows must be a list'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'ETL: too many barge rows'; end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r where r ->> 'si' is null or r -> 'hist' is null or r -> 'fact' is null
             or (r -> 'fact' ->> 'site') is distinct from b.site) then
    raise exception 'ETL: a barge row is incomplete or belongs to another site';
  end if;
  delete from public.etl_staging_barge where batch_id = p_batch;
  insert into public.etl_staging_barge (batch_id, si, hist, fact, old)
    select p_batch, upper(btrim(r ->> 'si')), r -> 'hist', r -> 'fact', nullif(r -> 'old', 'null'::jsonb) from jsonb_array_elements(p_rows) r;
  get diagnostics n = row_count;
  update public.etl_batch set row_counts = row_counts || jsonb_build_object('barge', n) where batch_id = p_batch;
  return n;
end $$;

-- compare week: what the portal wrote for the barges of a batch versus the real fact_barge (desktop ETL). state: same / changed / only_portal / only_prod
create or replace function public.etl_barge_diff(p_batch uuid)
returns table (si text, state text, changed_columns text)
language plpgsql stable security definer set search_path = public as $$
declare b public.etl_batch%rowtype; tb text; tr text := public.etl_barge_table('live'); cb text;
begin
  if not public.etl_can_load() then raise exception 'ETL: not allowed'; end if;
  select * into b from public.etl_batch where batch_id = p_batch;
  if not found then raise exception 'ETL: batch not found'; end if;
  tb := public.etl_barge_table(coalesce(b.target, 'shadow'));
  if to_regclass(tr) is null then raise exception 'ETL: % does not exist', tr; end if;
  return query execute format($q$
    with st as (select s.si from public.etl_staging_barge s where s.batch_id = %L),
    po as (select upper(btrim(f.si)) as si, to_jsonb(f) - 'id' - 'source_file' - 'loaded_at' as j from %s f join st on st.si = upper(btrim(f.si)) where f.site = %L),
    pr as (select upper(btrim(f.si)) as si, to_jsonb(f) - 'id' - 'source_file' - 'loaded_at' as j from %s f join st on st.si = upper(btrim(f.si)) where f.site = %L)
    select coalesce(po.si, pr.si)::text,
           case when pr.si is null then 'only_portal' when po.si is null then 'only_prod' when po.j = pr.j then 'same' else 'changed' end::text,
           (select string_agg(k, ', ' order by k) from jsonb_object_keys(coalesce(po.j, '{}'::jsonb) || coalesce(pr.j, '{}'::jsonb)) k
             where (po.j -> k) is distinct from (pr.j -> k))::text
    from po full join pr on pr.si = po.si$q$, p_batch, tb, b.site, tr, b.site);
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
                when r.value is not distinct from o.value or abs(r.value - o.value) <= 0.000001 then 'same' else 'changed' end
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
  v_del_a int := 0; v_ins_a int := 0; v_del_p int := 0; v_ins_p int := 0; v_del_h int := 0; v_ins_h int := 0; v_diff jsonb; tb text; xb record; cb text; v_del_b int := 0; v_ins_b int := 0; v_nb int := 0;
  ca text := public.etl_std_cols(public.etl_real_table('actual')); cp text := public.etl_std_cols(public.etl_real_table('plan'));
  pj constant text := 'p.site = f.site and p.date = f.date and p.category = f.category and p.metric_group = f.metric_group';
  xa record; xp record;
begin
  if not public.etl_can_load() then raise exception 'ETL: not allowed to load reports'; end if;
  select * into b from public.etl_batch where batch_id = p_batch for update;
  if not found then raise exception 'ETL: batch not found'; end if;
  if b.status <> 'staged' then raise exception 'ETL: batch is %, only a staged batch can be loaded', b.status; end if;
  if p_replace_plan and not public.etl_can_replace_plan() then raise exception 'ETL: only a site admin can replace plan values'; end if;
  if not p_replace_plan and exists (select 1 from public.etl_staging_raw r where r.batch_id = p_batch and r.tbl = 'tblCALENDAR') then
    raise exception 'ETL: this batch carries calendar (plan) rows, it can only be loaded with the plan replaced';
  end if;
  select * into cfg from public.etl_config;
  v_target := case when cfg.live then 'live' else 'shadow' end;
  ta := public.etl_target_table('actual', v_target); tp := public.etl_target_table('plan', v_target);
  select * into xa from public.etl_extra_lists(ta, b.source_file); select * into xp from public.etl_extra_lists(tp, b.source_file);
  tb := public.etl_barge_table(v_target); cb := public.etl_barge_cols(public.etl_barge_table('live'));
  select * into xb from public.etl_extra_lists(tb, b.source_file);

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


  -- barge list: history rows are updated in place (same id, so the list keeps its order), new SIs are appended; fact_barge of the target follows
  select count(*) into v_nb from public.etl_staging_barge where batch_id = p_batch;
  if v_nb > 0 then
    insert into public.etl_backup (batch_id, tbl, row_data)
      select p_batch, 'history', to_jsonb(h) from public.etl_history h
      where h.site = b.site and h.tbl = 'tblRAWBARGE'
        and exists (select 1 from public.etl_staging_barge s where s.batch_id = p_batch and s.si = upper(btrim(h.data ->> 'SI')));
    delete from public.etl_history h
      where h.site = b.site and h.tbl = 'tblRAWBARGE'
        and exists (select 1 from public.etl_staging_barge s where s.batch_id = p_batch and s.si = upper(btrim(h.data ->> 'SI')));
    insert into public.etl_history (id, tbl, site, row_date, data, batch_id) overriding system value
      select (k.row_data ->> 'id')::bigint, 'tblRAWBARGE', b.site, nullif(s.hist ->> 'FINISHDATE', '')::date, s.hist, p_batch
      from public.etl_staging_barge s join public.etl_backup k on k.batch_id = p_batch and k.tbl = 'history'
        and k.row_data ->> 'tbl' = 'tblRAWBARGE' and upper(btrim(k.row_data #>> '{data,SI}')) = s.si
      where s.batch_id = p_batch;
    insert into public.etl_history (tbl, site, row_date, data, batch_id)
      select 'tblRAWBARGE', b.site, nullif(s.hist ->> 'FINISHDATE', '')::date, s.hist, p_batch
      from public.etl_staging_barge s where s.batch_id = p_batch
        and not exists (select 1 from public.etl_backup k where k.batch_id = p_batch and k.tbl = 'history'
                        and k.row_data ->> 'tbl' = 'tblRAWBARGE' and upper(btrim(k.row_data #>> '{data,SI}')) = s.si);
    get diagnostics v_ins_b = row_count;

    execute format('insert into public.etl_backup (batch_id, tbl, row_data) select %L, ''barge'', to_jsonb(f) from %s f where exists (select 1 from public.etl_staging_barge s where s.batch_id = %L and s.si = upper(btrim(f.si)) and s.fact ->> ''site'' = f.site)', p_batch, tb, p_batch);
    execute format('delete from %s f where exists (select 1 from public.etl_staging_barge s where s.batch_id = %L and s.si = upper(btrim(f.si)) and s.fact ->> ''site'' = f.site)', tb, p_batch);
    get diagnostics v_del_b = row_count;
    execute format('insert into %s (%s%s) select %s%s from (select (jsonb_populate_record(null::%s, s.fact)).* from public.etl_staging_barge s where s.batch_id = %L) f', tb, cb, xb.ins, cb, xb.sel, tb, p_batch);
  end if;

  update public.etl_batch set status = 'loaded', target = v_target, loaded_by = auth.uid(), loaded_at = clock_timestamp(), plan_replaced = p_replace_plan,
    row_counts = row_counts || jsonb_build_object('target', v_target, 'actual_deleted', v_del_a, 'actual_inserted', v_ins_a,
        'plan_deleted', v_del_p, 'plan_inserted', v_ins_p, 'history_deleted', v_del_h, 'history_inserted', v_ins_h, 'barge_rows', v_nb, 'barge_fact_deleted', v_del_b, 'plan_diff', v_diff)
    where batch_id = p_batch;
  return (select row_counts from public.etl_batch where batch_id = p_batch);
end $$;

create or replace function public.etl_undo(p_batch uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b public.etl_batch%rowtype; v_clash uuid; ta text; tp text; xa record; xp record; tb text; xb record; cb text := public.etl_barge_cols(public.etl_barge_table('live'));
  ca text := public.etl_std_cols(public.etl_real_table('actual')); cp text := public.etl_std_cols(public.etl_real_table('plan'));
  pj constant text := 'p.site = f.site and p.date = f.date and p.category = f.category and p.metric_group = f.metric_group';
begin
  if not public.etl_can_load() then raise exception 'ETL: not allowed'; end if;
  select * into b from public.etl_batch where batch_id = p_batch for update;
  if not found then raise exception 'ETL: batch not found'; end if;
  if b.status <> 'loaded' then raise exception 'ETL: batch is %, only a loaded batch can be undone', b.status; end if;
  ta := public.etl_target_table('actual', b.target); tp := public.etl_target_table('plan', b.target);
  select * into xa from public.etl_extra_lists(ta, null); select * into xp from public.etl_extra_lists(tp, null);
  tb := public.etl_barge_table(b.target); select * into xb from public.etl_extra_lists(tb, null);

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

  select o.batch_id into v_clash from public.etl_batch o
    where o.status = 'loaded' and o.batch_id <> p_batch and o.loaded_at > b.loaded_at
      and exists (select 1 from public.etl_staging_barge so join public.etl_staging_barge sb on sb.batch_id = p_batch and sb.si = so.si where so.batch_id = o.batch_id)
    limit 1;
  if v_clash is not null then raise exception 'ETL: a later load (%) changed the same barges. Undo that one first.', v_clash; end if;

  execute format('delete from %s f where exists (select 1 from public.etl_staging_barge s where s.batch_id = %L and s.si = upper(btrim(f.si)) and s.fact ->> ''site'' = f.site)', tb, p_batch);
  execute format('insert into %s (%s%s) select %s%s from (select (jsonb_populate_record(null::%s, k.row_data)).* from public.etl_backup k where k.batch_id = %L and k.tbl = ''barge'') f', tb, cb, xb.ins, cb, xb.ins, tb, p_batch);

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


-- Ship updates (4.3c): a second batch, kind 'ship-sync', that rewrites SHIP of earlier days after a barge change. Admin only.
-- Rows may be dated before the report date (never after it). Only the SHIP category is accepted. Load and undo are the normal etl_load / etl_undo.
create or replace function public.etl_stage_ship(p_site text, p_report_date date, p_source_file text, p_actual jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_batch uuid; v_cfg text; v_bad int; v_dups int;
begin
  if not public.etl_can_replace_plan() then raise exception 'ETL: only a site admin can apply ship updates'; end if;
  select site into v_cfg from public.etl_config;
  if v_cfg is null then raise exception 'ETL: this project has no site configured (etl_config)'; end if;
  if p_site is distinct from v_cfg then raise exception 'ETL: this project serves site %, not %', v_cfg, p_site; end if;
  if p_report_date is null then raise exception 'ETL: report date is missing'; end if;
  create temp table _s on commit drop as
    select * from jsonb_populate_recordset(null::public.etl_staging_actual, coalesce(p_actual, '[]'::jsonb));
  select count(*) into v_bad from _s;
  if v_bad = 0 then raise exception 'ETL: no ship rows to load'; end if;
  select count(*) into v_bad from _s
    where site is distinct from p_site or date is null or date > p_report_date or date < p_report_date - 400
       or category is distinct from 'SHIP' or coalesce(metric_group, '') = '' or coalesce(metric, '') = '';
  if v_bad > 0 then raise exception 'ETL: % row(s) are not SHIP rows of this site up to the report date', v_bad; end if;
  select count(*) into v_dups from (select 1 from _s group by date, site, coalesce(pit,''), coalesce(contractor,''), coalesce(shift,''), category, metric_group, metric having count(*) > 1) d;
  if v_dups > 0 then raise exception 'ETL: % duplicate key(s) in the ship rows', v_dups; end if;
  insert into public.etl_batch (site, report_date, kind, source_file, created_by)
    values (p_site, p_report_date, 'ship-sync', p_source_file, auth.uid()) returning batch_id into v_batch;
  insert into public.etl_staging_actual select v_batch, date, site, pit, contractor, shift, category, metric_group, metric, value, text_value from _s;
  insert into public.etl_batch_partition select distinct v_batch, 'actual', site, date, category, metric_group from _s;
  update public.etl_batch set row_counts = jsonb_build_object('actual', (select count(*) from _s), 'plan', 0) where batch_id = v_batch;
  drop table _s;
  return v_batch;
end $$;

revoke all on function public.etl_barge_table(text), public.etl_barge_cols(text), public.etl_stage_barge(uuid,jsonb), public.etl_barge_diff(uuid), public.etl_stage_ship(text,date,text,jsonb),
  public.etl_load(uuid,boolean), public.etl_undo(uuid) from public, anon;
grant execute on function public.etl_stage_barge(uuid,jsonb), public.etl_barge_diff(uuid), public.etl_stage_ship(text,date,text,jsonb), public.etl_load(uuid,boolean), public.etl_undo(uuid) to authenticated;
