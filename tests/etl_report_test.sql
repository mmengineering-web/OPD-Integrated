-- Phase 4.6: etl_report_data (supabase/sql/etl_07_report.sql). psql -v ON_ERROR_STOP=1 -f tests/etl_report_test.sql on an empty database.
\set ON_ERROR_STOP on
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true),'')::uuid $$;
do $$ begin
  if not exists (select from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated; end if;
end $$;
create table public.op_profile (user_id uuid primary key, email text, role text, is_active boolean default true);
create table public.etl_config (site text);
create table public.etl_history (id bigserial primary key, site text, tbl text, row_date date, data jsonb);
\i supabase/sql/etl_07_report.sql
-- etl_role() normally comes from etl_01_core; same definition here
create function public.etl_role() returns text language sql stable security definer set search_path = public as $$
  select role from public.op_profile where user_id = auth.uid() and is_active; $$;
insert into public.etl_config values ('WKM');
insert into public.op_profile values ('00000000-0000-0000-0000-000000000001','v@x','viewer'),('00000000-0000-0000-0000-000000000009','off@x','viewer');
update public.op_profile set is_active=false where email='off@x';
insert into public.etl_history(site,tbl,row_date,data) values
 ('WKM','tblRAWSHIP','2026-11-18','{"DAY":1}'),('WKM','tblRAWSHIP','2026-11-19','{"DAY":2}'),('WKM','tblRAWMNG','2026-11-19','{"L-DAY":3}'),
 ('WKM','tblCALENDAR','2026-11-19','{"ST-DAY":9}'),('WKM','tblRAWHSE','2026-11-19','{"NM":1}'),('BM','tblRAWSHIP','2026-11-25','{"DAY":99}');
grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated, anon;
set role authenticated; select set_config('test.uid','00000000-0000-0000-0000-000000000001',false);
do $$ declare r jsonb; begin
  r := public.etl_report_data();
  assert r->>'cut_off' = '2026-11-19', 'cut off = newest day';
  assert r->>'site' = 'WKM' and jsonb_array_length(r->'ship') = 1 and (r->'ship'->0->>'DAY') = '2', 'only the cut off day, only this site';
  assert jsonb_array_length(r->'mng') = 1 and jsonb_array_length(r->'cal') = 1 and jsonb_array_length(r->'hse') = 1;
  r := public.etl_report_data('2026-11-18');
  assert r->>'cut_off' = '2026-11-18' and jsonb_array_length(r->'mng') = 0, 'asking for an earlier day';
  r := public.etl_report_data('2026-01-01');
  assert r->'cut_off' = 'null'::jsonb, 'nothing loaded before';
  raise notice 'viewer read OK';
end $$;
-- direct table access stays closed
do $$ begin begin perform 1 from public.etl_history; raise exception 'FAIL direct read'; exception when insufficient_privilege then raise notice 'direct read refused OK'; end; end $$;
select set_config('test.uid','00000000-0000-0000-0000-000000000009',false);
do $$ begin begin perform public.etl_report_data(); raise exception 'FAIL inactive'; exception when others then assert sqlerrm like 'ETL: not allowed', sqlerrm; raise notice 'inactive refused OK'; end; end $$;
select set_config('test.uid','',false);
do $$ begin begin perform public.etl_report_data(); raise exception 'FAIL anon'; exception when others then assert sqlerrm like 'ETL: not allowed', sqlerrm; raise notice 'no user refused OK'; end; end $$;
reset role;
