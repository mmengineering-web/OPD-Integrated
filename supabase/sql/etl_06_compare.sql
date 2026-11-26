-- One Portal Data, Phase 4, step 4.5: compare week and going live.
-- Run AFTER etl_01 to etl_05 in the same project (site project: WKM, BM, TMS). Safe to run twice.
--
-- What it adds (new objects only; nothing here alters, indexes or adds a trigger or policy to any prod_v2 table):
--   1. etl_compare_log     one row per test-mode load: how the rows the portal wrote compare with what the desktop ETL has in prod_v2.
--   2. etl_compare_record  (portal, data entry and up) computes that comparison on the server and stores it. Can be repeated: the desktop
--                          often loads the same day later than the portal, so a day is checked again after the desktop has written it.
--   3. etl_compare_explain (portal, site admin and up) writes the reason why rows exist only in the portal. Nothing else can be explained.
--   4. etl_compare_status  (portal) the daily table and the number of clean days in a row. Target: 10.
--   5. Owner tools, SQL editor only (no portal role can run them): etl_golive_check, etl_golive_backup, etl_go_live, etl_go_back, etl_golive_restore.
--
-- A day is CLEAN when the portal and the desktop ETL agree on every row that was compared:
--   0 different, 0 only in prod_v2 ("only there"), and every row only in the portal ("only here") explained by a site admin.
-- Different or only-there rows cannot be explained away: fix the cause (parser, file or desktop ETL) and load the day again.

-- 1. Log ----------------------------------------------------------------------------------------------------------------------------
create table if not exists public.etl_compare_log (
  batch_id    uuid primary key references public.etl_batch(batch_id) on delete cascade,
  site        text not null,
  report_date date not null,
  actual      jsonb not null default '{}'::jsonb,   -- {same, changed, only_portal, only_prod} for the fact rows
  barge       jsonb,                                 -- same shape for the barge list; {"error": "..."} when fact_barge could not be read; null when the batch had no barge rows
  checked_at  timestamptz not null default now(),
  checked_by  uuid,
  explained   boolean not null default false,
  note        text,
  explained_by uuid,
  explained_at timestamptz
);
create index if not exists etl_compare_log_day on public.etl_compare_log (site, report_date desc);
alter table public.etl_compare_log enable row level security;
revoke all on public.etl_compare_log from anon, authenticated, public;
grant select on public.etl_compare_log to authenticated;
drop policy if exists etl_compare_log_read on public.etl_compare_log;
create policy etl_compare_log_read on public.etl_compare_log for select to authenticated using (public.etl_can_load());
-- no insert/update/delete policy on purpose: only the functions below write here.

-- 2. Verdict of one comparison ---------------------------------------------------------------------------------------------------
--    clean       nothing differs
--    explained   rows only in the portal, and a site admin wrote why
--    only_here   rows only in the portal, not explained yet
--    different   a value differs, or rows exist only in prod_v2: must be fixed, cannot be explained
--    unknown     nothing was compared, or the barge list could not be read
create or replace function public.etl_compare_verdict(a jsonb, g jsonb, p_explained boolean) returns text
language sql immutable set search_path = public as $$
  select case
    when g ? 'error' then 'unknown'
    when coalesce((a->>'changed')::int,0) + coalesce((a->>'only_prod')::int,0)
       + coalesce((g->>'changed')::int,0) + coalesce((g->>'only_prod')::int,0) > 0 then 'different'
    when coalesce((a->>'same')::int,0) + coalesce((a->>'only_portal')::int,0)
       + coalesce((g->>'same')::int,0) + coalesce((g->>'only_portal')::int,0) = 0 then 'unknown'
    when coalesce((a->>'only_portal')::int,0) + coalesce((g->>'only_portal')::int,0) > 0
      then case when p_explained then 'explained' else 'only_here' end
    else 'clean' end $$;

-- 3. Record the comparison of a loaded test-mode batch ------------------------------------------------------------------------
create or replace function public.etl_compare_record(p_batch uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b public.etl_batch%rowtype; prev public.etl_compare_log%rowtype; a jsonb; g jsonb := null; keep boolean := false;
begin
  if not public.etl_can_load() then raise exception 'ETL: not allowed'; end if;
  select * into b from public.etl_batch where batch_id = p_batch;
  if not found then raise exception 'ETL: batch not found'; end if;
  if b.status <> 'loaded' then raise exception 'ETL: only a loaded batch can be compared (this one is %)', b.status; end if;
  if b.target is distinct from 'shadow' then raise exception 'ETL: a live load has nothing to compare with, it is the data'; end if;

  select jsonb_build_object('same', count(*) filter (where state = 'same'), 'changed', count(*) filter (where state = 'changed'),
                            'only_portal', count(*) filter (where state = 'only_portal'), 'only_prod', count(*) filter (where state = 'only_prod'))
    into a from public.etl_shadow_diff(p_batch);

  if exists (select 1 from public.etl_staging_barge where batch_id = p_batch) then
    begin
      select jsonb_build_object('same', count(*) filter (where state = 'same'), 'changed', count(*) filter (where state = 'changed'),
                                'only_portal', count(*) filter (where state = 'only_portal'), 'only_prod', count(*) filter (where state = 'only_prod'))
        into g from public.etl_barge_diff(p_batch);
    exception when others then
      g := jsonb_build_object('error', sqlerrm);
    end;
  end if;

  -- a note stays valid only while the rows it explained are the same ones: if the number of rows only here changed, it must be read again
  select * into prev from public.etl_compare_log where batch_id = p_batch;
  if found and prev.explained
     and (prev.actual->>'only_portal') is not distinct from (a->>'only_portal')
     and (prev.barge->>'only_portal') is not distinct from (g->>'only_portal') then keep := true; end if;

  insert into public.etl_compare_log (batch_id, site, report_date, actual, barge, checked_at, checked_by, explained, note, explained_by, explained_at)
    values (p_batch, b.site, b.report_date, a, g, clock_timestamp(), auth.uid(),
            keep, prev.note, case when keep then prev.explained_by end, case when keep then prev.explained_at end)
  on conflict (batch_id) do update set actual = excluded.actual, barge = excluded.barge, checked_at = excluded.checked_at, checked_by = excluded.checked_by,
    explained = excluded.explained, explained_by = excluded.explained_by, explained_at = excluded.explained_at;
  return jsonb_build_object('batch_id', p_batch, 'report_date', b.report_date, 'actual', a, 'barge', g,
                            'verdict', public.etl_compare_verdict(a, g, keep));
end $$;

-- 4. A site admin explains rows that exist only in the portal --------------------------------------------------------------------
create or replace function public.etl_compare_explain(p_batch uuid, p_explained boolean, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c public.etl_compare_log%rowtype; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not public.etl_can_replace_plan() then raise exception 'ETL: only a site admin can explain differences'; end if;
  select * into c from public.etl_compare_log where batch_id = p_batch for update;
  if not found then raise exception 'ETL: this load has not been compared yet'; end if;
  if p_explained then
    if v_note is null or length(v_note) < 10 then raise exception 'ETL: write the reason in a few words (at least 10 characters)'; end if;
    if public.etl_compare_verdict(c.actual, c.barge, true) <> 'explained' then
      raise exception 'ETL: only rows that exist only in the portal can be explained. Different values and rows only in prod_v2 must be fixed and loaded again';
    end if;
    update public.etl_compare_log set explained = true, note = v_note, explained_by = auth.uid(), explained_at = clock_timestamp() where batch_id = p_batch;
  else
    update public.etl_compare_log set explained = false, explained_by = null, explained_at = null where batch_id = p_batch;
  end if;
  return jsonb_build_object('batch_id', p_batch, 'explained', p_explained);
end $$;

-- 5. Status: the daily table and the clean days in a row -------------------------------------------------------------------------
--    One entry per report day, built from the loads still standing in test mode. A load is left out when it was undone, or when a later load
--    of the same day replaced it (same file name, or it covers every partition of the earlier one). A load that was never compared shows as
--    "unchecked" and counts as not clean.
create or replace function public.etl_compare_summary(p_need int default 10) returns jsonb
language plpgsql stable set search_path = public as $$
declare cfg public.etl_config%rowtype; v_days jsonb; v_streak int := 0; v_newest date; v_oldest date; r record;
begin
  select * into cfg from public.etl_config;
  with cur as (
    select b.batch_id, b.report_date, b.source_file, b.kind, b.loaded_at, c.actual, c.barge, c.checked_at, c.explained, c.note,
           case when c.batch_id is null then 'unchecked' else public.etl_compare_verdict(c.actual, c.barge, c.explained) end as verdict
    from public.etl_batch b left join public.etl_compare_log c on c.batch_id = b.batch_id
    where b.status = 'loaded' and b.target = 'shadow'
      and not exists (
        select 1 from public.etl_batch o
        where o.status = 'loaded' and o.target = 'shadow' and o.batch_id <> b.batch_id and o.report_date = b.report_date and o.loaded_at > b.loaded_at
          and (o.source_file is not distinct from b.source_file
               or (exists (select 1 from public.etl_batch_partition x where x.batch_id = b.batch_id)
                   and not exists (select 1 from public.etl_batch_partition x where x.batch_id = b.batch_id
                                     and not exists (select 1 from public.etl_batch_partition y
                                                      where y.batch_id = o.batch_id and y.tbl = x.tbl and y.site = x.site and y.date = x.date
                                                        and y.category = x.category and y.metric_group = x.metric_group))))))
  , per_day as (
    select report_date,
      case when bool_or(verdict = 'different') then 'different' when bool_or(verdict = 'unchecked') then 'unchecked'
           when bool_or(verdict = 'unknown') then 'unknown' when bool_or(verdict = 'only_here') then 'only_here'
           when bool_or(verdict = 'explained') then 'explained' else 'clean' end as verdict,
      jsonb_build_object('same', coalesce(sum((actual->>'same')::int),0), 'changed', coalesce(sum((actual->>'changed')::int),0),
                         'only_portal', coalesce(sum((actual->>'only_portal')::int),0), 'only_prod', coalesce(sum((actual->>'only_prod')::int),0)) as actual,
      jsonb_build_object('same', coalesce(sum((barge->>'same')::int),0), 'changed', coalesce(sum((barge->>'changed')::int),0),
                         'only_portal', coalesce(sum((barge->>'only_portal')::int),0), 'only_prod', coalesce(sum((barge->>'only_prod')::int),0)) as barge,
      jsonb_agg(jsonb_build_object('batch_id', batch_id, 'source_file', source_file, 'kind', kind, 'verdict', verdict, 'actual', actual, 'barge', barge,
                                   'checked_at', checked_at, 'explained', coalesce(explained, false), 'note', note) order by loaded_at) as batches
    from cur group by report_date)
  select jsonb_agg(to_jsonb(d) order by d.report_date desc) into v_days from (select * from per_day order by report_date desc limit 30) d;

  for r in select (e->>'report_date')::date as d, e->>'verdict' as v from jsonb_array_elements(coalesce(v_days, '[]'::jsonb)) e loop
    exit when r.v not in ('clean', 'explained');
    v_streak := v_streak + 1; v_oldest := r.d; v_newest := coalesce(v_newest, r.d);
  end loop;

  return jsonb_build_object('site', cfg.site, 'live', coalesce(cfg.live, false), 'need', p_need, 'streak', v_streak, 'ready', v_streak >= p_need,
    'newest_clean', v_newest, 'oldest_clean', v_oldest,
    'missing_days', case when v_streak > 0 then (v_newest - v_oldest + 1) - v_streak else 0 end,
    'days', coalesce(v_days, '[]'::jsonb));
end $$;

create or replace function public.etl_compare_status(p_need int default 10) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.etl_can_load() then raise exception 'ETL: not allowed'; end if;
  return public.etl_compare_summary(greatest(1, least(coalesce(p_need, 10), 30)));
end $$;

-- 6. Owner tools (SQL editor only) -------------------------------------------------------------------------------------------------
create table if not exists public.etl_golive_log (
  id bigint generated always as identity primary key, at timestamptz not null default now(), action text not null, detail jsonb not null default '{}'::jsonb);
create table if not exists public.etl_prelive_snapshot (
  id bigint generated always as identity primary key, taken_at timestamptz not null, site text not null, tbl text not null check (tbl in ('actual','plan','barge')),
  snapshot_table text not null, row_count bigint not null, restored_at timestamptz);
alter table public.etl_golive_log enable row level security;
alter table public.etl_prelive_snapshot enable row level security;
revoke all on public.etl_golive_log, public.etl_prelive_snapshot from anon, authenticated, public;
create schema if not exists etl_prelive;
revoke all on schema etl_prelive from public, anon, authenticated;

-- Backup of this site's rows in the three prod tables, kept in the new schema etl_prelive (nothing in prod_v2 is touched).
create or replace function public.etl_golive_backup() returns jsonb
language plpgsql set search_path = public as $$
declare cfg public.etl_config%rowtype; ts timestamptz := clock_timestamp(); tag text := to_char(clock_timestamp(), 'YYYYMMDD_HH24MISS');
        src text; snap text; n bigint; t text; out jsonb := '[]'::jsonb;
begin
  select * into cfg from public.etl_config;
  if cfg.site is null then raise exception 'ETL: this project has no site configured'; end if;
  foreach t in array array['actual','plan','barge'] loop
    src := case t when 'barge' then public.etl_barge_table('live') else public.etl_real_table(t) end;
    if to_regclass(src) is null then raise exception 'ETL: % does not exist, nothing was backed up', src; end if;
  end loop;
  foreach t in array array['actual','plan','barge'] loop
    src := case t when 'barge' then public.etl_barge_table('live') else public.etl_real_table(t) end;
    snap := format('etl_prelive.%I', t || '_' || tag);
    execute format('create table %s as select * from %s where site = %L', snap, src, cfg.site);
    execute format('select count(*) from %s', snap) into n;
    insert into public.etl_prelive_snapshot (taken_at, site, tbl, snapshot_table, row_count) values (ts, cfg.site, t, snap, n);
    out := out || jsonb_build_object('table', t, 'snapshot', snap, 'rows', n);
  end loop;
  insert into public.etl_golive_log (action, detail) values ('backup', jsonb_build_object('taken_at', ts, 'tables', out));
  return jsonb_build_object('taken_at', ts, 'tables', out);
end $$;

-- One line per condition. ok = true / false, or null when only a person can say (the desktop step).
create or replace function public.etl_golive_check(p_need int default 10) returns table (item text, ok boolean, detail text)
language plpgsql set search_path = public as $$
declare cfg public.etl_config%rowtype; s jsonb; t text; src text; v_snap timestamptz; v_last timestamptz; v_has_src boolean; v_has_ts boolean;
begin
  select * into cfg from public.etl_config;
  item := '1 site configured'; ok := cfg.site is not null; detail := coalesce(cfg.site, 'etl_config is empty'); return next;
  item := '2 prod tables readable'; ok := true; detail := '';
  foreach t in array array['actual','plan','barge'] loop
    src := case t when 'barge' then public.etl_barge_table('live') else public.etl_real_table(t) end;
    if to_regclass(src) is null then ok := false; detail := detail || src || ' missing; '; end if;
  end loop;
  if ok then detail := cfg.fact_schema || ' fact_production_actual, fact_production_plan, fact_barge'; end if; return next;
  item := '3 still in test mode'; ok := not coalesce(cfg.live, false); detail := case when cfg.live then 'already live' else 'live = false' end; return next;
  s := public.etl_compare_summary(p_need);
  item := '4 clean days in a row'; ok := (s->>'ready')::boolean;
  detail := format('%s of %s needed; newest clean day %s; %s calendar day(s) without a load inside the run', s->>'streak', p_need, coalesce(s->>'newest_clean', 'none'), s->>'missing_days'); return next;
  select max(taken_at) into v_snap from (select taken_at from public.etl_prelive_snapshot where site = cfg.site and restored_at is null
                                          group by taken_at having count(distinct tbl) = 3) x;
  item := '5 backup taken in the last 24 hours'; ok := v_snap is not null and v_snap > now() - interval '24 hours';
  detail := coalesce('taken ' || v_snap::text, 'none: run select public.etl_golive_backup();'); return next;
  -- the desktop's last write, when the prod tables tell (source_file not written by the portal, loaded_at present)
  v_has_src := exists (select 1 from pg_attribute where attrelid = to_regclass(public.etl_real_table('actual')) and attname = 'source_file' and not attisdropped);
  v_has_ts := exists (select 1 from pg_attribute where attrelid = to_regclass(public.etl_real_table('actual')) and attname = 'loaded_at' and not attisdropped);
  if v_has_src and v_has_ts then
    execute format('select max(loaded_at) from %s where site = %L and coalesce(source_file, '''') not like %L', public.etl_real_table('actual'), cfg.site, 'OPD:%') into v_last;
  end if;
  item := '6 desktop Supabase step switched off'; ok := null;
  detail := 'only you can confirm this. Last desktop write in prod_v2: ' || coalesce(v_last::text, 'unknown') || '. It must not move after the switch-off.'; return next;
end $$;

-- Go live. Refuses unless checks 1 to 5 pass and you confirm the desktop step is off. Logged.
create or replace function public.etl_go_live(p_confirm text default null, p_need int default 10) returns jsonb
language plpgsql set search_path = public as $$
declare bad text;
begin
  if p_confirm is distinct from 'DESKTOP STEP IS OFF' then
    raise exception 'ETL: confirm that the desktop Supabase step is switched off: select public.etl_go_live(''DESKTOP STEP IS OFF'');';
  end if;
  select string_agg(item || ' (' || detail || ')', '; ') into bad from public.etl_golive_check(p_need) where ok is false;
  if bad is not null then raise exception 'ETL: not ready: %', bad; end if;
  update public.etl_config set live = true;
  insert into public.etl_golive_log (action, detail) values ('go_live', jsonb_build_object('site', (select site from public.etl_config), 'need', p_need));
  return jsonb_build_object('live', true, 'site', (select site from public.etl_config));
end $$;

-- Back to test mode. Loads already written to prod_v2 stay until you undo them in the portal (Recent uploads) or restore the backup.
create or replace function public.etl_go_back() returns jsonb
language plpgsql set search_path = public as $$
begin
  update public.etl_config set live = false;
  insert into public.etl_golive_log (action, detail) values ('go_back', jsonb_build_object('site', (select site from public.etl_config)));
  return jsonb_build_object('live', false, 'site', (select site from public.etl_config));
end $$;

-- Last resort: put this site's three prod tables back exactly as the backup of p_taken_at had them. Only in test mode (run etl_go_back first),
-- and only with the confirmation text. Everything the desktop or the portal wrote to this site after the backup is removed.
create or replace function public.etl_golive_restore(p_taken_at timestamptz, p_confirm text) returns jsonb
language plpgsql set search_path = public as $$
declare cfg public.etl_config%rowtype; s record; dst text; n bigint; out jsonb := '[]'::jsonb;
begin
  select * into cfg from public.etl_config;
  if p_confirm is distinct from 'RESTORE ' || cfg.site then raise exception 'ETL: to restore, confirm with the text RESTORE %', cfg.site; end if;
  if cfg.live then raise exception 'ETL: switch back to test mode first: select public.etl_go_back();'; end if;
  if (select count(*) from public.etl_prelive_snapshot where site = cfg.site and taken_at = p_taken_at and restored_at is null) <> 3 then
    raise exception 'ETL: no complete, unrestored backup taken at % (see etl_prelive_snapshot)', p_taken_at;
  end if;
  for s in select * from public.etl_prelive_snapshot where site = cfg.site and taken_at = p_taken_at order by tbl loop
    dst := case s.tbl when 'barge' then public.etl_barge_table('live') else public.etl_real_table(s.tbl) end;
    execute format('delete from %s where site = %L', dst, cfg.site);
    execute format('insert into %s overriding system value select * from %s', dst, s.snapshot_table);
    execute format('select count(*) from %s where site = %L', dst, cfg.site) into n;
    if n <> s.row_count then raise exception 'ETL: % has % rows after the restore, the backup had %. Nothing was kept.', dst, n, s.row_count; end if;
    update public.etl_prelive_snapshot set restored_at = clock_timestamp() where id = s.id;
    out := out || jsonb_build_object('table', s.tbl, 'rows', n);
  end loop;
  insert into public.etl_golive_log (action, detail) values ('restore', jsonb_build_object('taken_at', p_taken_at, 'tables', out));
  return jsonb_build_object('restored', out);
end $$;

-- Access: the portal may record, explain and read the status. The owner tools have no grant: they run in the SQL editor only.
revoke all on function public.etl_compare_verdict(jsonb,jsonb,boolean), public.etl_compare_record(uuid), public.etl_compare_explain(uuid,boolean,text),
  public.etl_compare_summary(int), public.etl_compare_status(int), public.etl_golive_backup(), public.etl_golive_check(int), public.etl_go_live(text,int),
  public.etl_go_back(), public.etl_golive_restore(timestamptz,text) from public, anon, authenticated;
grant execute on function public.etl_compare_record(uuid), public.etl_compare_explain(uuid,boolean,text), public.etl_compare_status(int) to authenticated;
-- Going live, after 10 clean days:  select * from public.etl_golive_check();  select public.etl_golive_backup();  select public.etl_go_live('DESKTOP STEP IS OFF');
