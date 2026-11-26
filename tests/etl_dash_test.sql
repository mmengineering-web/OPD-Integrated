-- Phase 4.7: etl_dash_data (supabase/sql/etl_08_dashboard.sql). psql -v ON_ERROR_STOP=1 -f tests/etl_dash_test.sql on an empty database.
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
create function public.etl_role() returns text language sql stable security definer set search_path = public as $$
  select role from public.op_profile where user_id = auth.uid() and is_active; $$;
\i supabase/sql/etl_08_dashboard.sql
insert into public.etl_config values ('WKM');
insert into public.op_profile values ('00000000-0000-0000-0000-000000000001','v@x','viewer'),('00000000-0000-0000-0000-000000000009','off@x','viewer');
update public.op_profile set is_active=false where email='off@x';
insert into public.etl_history(site,tbl,row_date,data) values
 ('WKM','tblRAWMNG','2026-11-01','{"CONTRACTOR":"A","L-DAY":10,"H-DAY":"5","PIT":"P1"}'),
 ('WKM','tblRAWMNG','2026-11-01','{"CONTRACTOR":"A","L-DAY":2,"H-DAY":1,"PIT":"P2"}'),
 ('WKM','tblRAWMNG','2026-11-01','{"CONTRACTOR":"B","L-DAY":7}'),
 ('WKM','tblRAWMNG','2026-11-02','{"CONTRACTOR":"A","L-DAY":"x"}'),
 ('WKM','tblRAWMNG','2026-12-01','{"CONTRACTOR":"A","L-DAY":99}'),
 ('WKM','tblRAWSHIP','2026-11-02','{"CONTRACTOR":"A","DAY":4}'),
 ('WKM','tblCALENDAR','2026-11-01','{"CONTRACTOR":"A","L-DAY":20,"PHYSICAL AVAILABILITY (PA)":0.9}'),
 ('WKM','tblRAWHAZARD','2026-11-02','{"IDENTIFIED HAZARD":"h1","RISK LEVEL":"High"}'),
 ('WKM','tblRAWCONS','2026-10-01','{"AREA":"Road","CONSTRUCTION ITEM":"Hauling","PROGRESS":10}'),
 ('WKM','tblRAWCONS','2026-11-02','{"AREA":"Road","CONSTRUCTION ITEM":"Hauling","PROGRESS":40}'),
 ('WKM','tblRAWBARGE',null,'{"SI":"1"}'),
 ('BM','tblRAWMNG','2026-11-01','{"CONTRACTOR":"Z","L-DAY":1000}');
grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated, anon;
set role authenticated; select set_config('test.uid','00000000-0000-0000-0000-000000000001',false);
do $$ declare r jsonb; begin
  r := public.etl_dash_data('2026-11-01','2026-11-30');
  assert r->>'site' = 'WKM';
  assert jsonb_array_length(r->'daily'->'tblRAWMNG') = 3, 'A on 1 Nov, B on 1 Nov, A on 2 Nov';
  assert (r->'daily'->'tblRAWMNG'->0->'v'->>'L-DAY')::numeric = 12 and (r->'daily'->'tblRAWMNG'->0->'v'->>'H-DAY')::numeric = 6 and (r->'daily'->'tblRAWMNG'->0->>'n')::int = 2, 'rows of one contractor and day are summed, text numbers read';
  assert not (r->'daily'->'tblRAWMNG'->2->'v' ? 'L-DAY'), 'a value that is not a number is left out';
  assert r->'daily' ? 'tblCALENDAR' and (r->'daily'->'tblCALENDAR'->0->'v'->>'PHYSICAL AVAILABILITY (PA)')::numeric = 0.9;
  assert jsonb_array_length(r->'hazard') = 1 and (r->'cons'->0->>'PROGRESS') = '40' and jsonb_array_length(r->'cons') = 1, 'latest construction state';
  assert jsonb_array_length(r->'barge') = 1;
  assert r->>'first' = '2026-11-01' and r->>'last' = '2026-12-01', 'first and last loaded day of the site';
  assert not (r->'daily' ? 'tblRAWHAZARD'), 'only the dashboard tables';
  r := public.etl_dash_data('2026-11-03','2026-11-04');
  assert r->'daily' = '{}'::jsonb, 'empty range';
  begin perform public.etl_dash_data('2025-01-01','2026-11-30'); raise exception 'FAIL long'; exception when others then assert sqlerrm like '%400 days%', sqlerrm; end;
  begin perform public.etl_dash_data('2026-11-30','2026-11-01'); raise exception 'FAIL order'; exception when others then assert sqlerrm like '%not valid%', sqlerrm; end;
  raise notice 'viewer read OK';
end $$;
do $$ begin begin perform 1 from public.etl_history; raise exception 'FAIL direct read'; exception when insufficient_privilege then raise notice 'direct read refused OK'; end; end $$;
select set_config('test.uid','00000000-0000-0000-0000-000000000009',false);
do $$ begin begin perform public.etl_dash_data('2026-11-01','2026-11-30'); raise exception 'FAIL inactive'; exception when others then assert sqlerrm like 'ETL: not allowed', sqlerrm; raise notice 'inactive refused OK'; end; end $$;
reset role;
