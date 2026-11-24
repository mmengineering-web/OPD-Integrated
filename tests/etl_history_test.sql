-- Local Postgres test for supabase/sql/etl_02_history.sql. Run: psql -v ON_ERROR_STOP=1 -f tests/etl_history_test.sql
-- Fact tables are created in schema prod_v2 (as in the site projects); etl_03 is loaded last.
\set ON_ERROR_STOP on
drop schema if exists auth cascade; create schema auth;
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true),'')::uuid $$;
do $$ begin
  if not exists (select from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated; end if;
end $$;
drop schema public cascade; create schema public; grant usage on schema public to authenticated;
create table public.op_profile (user_id uuid primary key, email text, role text, is_active boolean default true);
create schema prod_v2; grant usage on schema prod_v2 to authenticated;
create table prod_v2.fact_production_actual (id bigserial primary key, date date, site text, pit text, contractor text, shift text, category text, metric_group text, metric text, value numeric, text_value text);
create table prod_v2.fact_production_plan   (id bigserial primary key, date date, site text, pit text, contractor text, shift text, category text, metric_group text, metric text, value numeric, text_value text);
\i supabase/sql/etl_01_core.sql
\i supabase/sql/etl_02_history.sql
\i supabase/sql/etl_02_history.sql
\i supabase/sql/etl_03_safe_target.sql
insert into public.etl_config(site) values ('WKM');
insert into public.op_profile values ('00000000-0000-0000-0000-000000000001','v@x','viewer'),('00000000-0000-0000-0000-000000000002','d@x','data_entry');
grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
-- seeded history (batch_id null) + one vocab list + one open barge (no date)
insert into public.etl_history(tbl,site,row_date,data) values
 ('tblRAWFUEL','WKM','2026-11-19','{"DATE":"2026-11-19","STOCK":100}'),
 ('tblRAWFUEL','WKM','2026-11-18','{"DATE":"2026-11-18","STOCK":90}'),
 ('tblIDPIT','WKM',null,'{"PIT":"P1"}'),
 ('tblRAWBARGE','WKM',null,'{"SI":"X1","STATUS":"OPEN"}');

set role authenticated;
select set_config('test.uid','00000000-0000-0000-0000-000000000001',false);
do $$ begin begin perform public.etl_history_read('tblRAWFUEL'); raise exception 'viewer allowed'; exception when others then if sqlerrm like 'ETL: not allowed%' then raise notice 'H1 viewer cannot read history: true'; else raise; end if; end; end $$;
select set_config('test.uid','00000000-0000-0000-0000-000000000002',false);
select (select count(*) from public.etl_history_read('tblRAWFUEL'))=2
   and (select count(*) from public.etl_history_read('tblRAWFUEL','2026-11-19','2026-11-19'))=1
   and (select count(*) from public.etl_history_read('tblIDPIT','2026-11-19','2026-11-19'))=1 as ok \gset h2_
\echo H2 read all / window / vocab always returned:  :h2_ok
do $$ begin begin perform * from public.etl_history; raise exception 'direct read allowed'; exception when insufficient_privilege then raise notice 'H3 direct table read blocked: true'; end; end $$;

select public.etl_stage('WKM','2026-11-20','wkm-pdf','dr.pdf',
  '[{"date":"2026-11-20","site":"WKM","category":"ACTUAL","metric_group":"Fuel","metric":"STOCK","value":120}]','[]','{"Fuel":"ok"}') as b1 \gset
select public.etl_stage_raw(:'b1','{"tblRAWFUEL":[{"DATE":"2026-11-20","STOCK":120},{"DATE":"2026-11-19","STOCK":105}]}');
do $$ begin begin perform public.etl_stage_raw((select batch_id from etl_batch limit 1),'{"tblRAWBARGE":[{"DATE":"2026-11-20"}]}'); raise exception 'barge staged'; exception when others then if sqlerrm like 'ETL: the barge list%' then raise notice 'H4 barge list not staged by date: true'; else raise; end if; end; end $$;
select public.etl_load(:'b1');
select (select count(*) from public.etl_history_read('tblRAWFUEL'))=3
   and (select (data->>'STOCK')::int from public.etl_history_read('tblRAWFUEL') data where data->>'DATE'='2026-11-19')=105 as ok \gset h5_
\echo H5 load adds new day and replaces 19 Nov:      :h5_ok
select public.etl_undo(:'b1');
select (select count(*) from public.etl_history_read('tblRAWFUEL'))=2
   and (select (data->>'STOCK')::int from public.etl_history_read('tblRAWFUEL') data where data->>'DATE'='2026-11-19')=100 as ok \gset h6_
\echo H6 undo restores the seeded 19 Nov row:        :h6_ok
-- re-seed counts untouched by load/undo
reset role;
select (select count(*) from public.etl_history where tbl='tblRAWBARGE')=1 and (select count(*) from public.etl_history where tbl='tblIDPIT')=1 as ok \gset h7_
\echo H7 other tables untouched:                     :h7_ok
-- later load on the same date blocks undo of the earlier one
set role authenticated; select set_config('test.uid','00000000-0000-0000-0000-000000000002',false);
select public.etl_stage('WKM','2026-11-21','x','x','[]','[]','{}') as c1 \gset
select public.etl_stage_raw(:'c1','{"tblRAWFUEL":[{"DATE":"2026-11-21","STOCK":1}]}');
select public.etl_load(:'c1');
select public.etl_stage('WKM','2026-11-21','x','x','[]','[]','{}') as c2 \gset
select public.etl_stage_raw(:'c2','{"tblRAWFUEL":[{"DATE":"2026-11-21","STOCK":2}]}');
select public.etl_load(:'c2');
do $$ begin begin perform public.etl_undo((select batch_id from etl_batch where status='loaded' order by loaded_at limit 1)); raise exception 'undo allowed'; exception when others then if sqlerrm like 'ETL: a later load%' then raise notice 'H8 older undo refused (history overlap): true'; else raise; end if; end; end $$;
select public.etl_undo(:'c2'); select public.etl_undo(:'c1');
select (select count(*) from public.etl_history_read('tblRAWFUEL'))=2 as ok \gset h9_
\echo H9 undo in reverse order leaves the seed:      :h9_ok
