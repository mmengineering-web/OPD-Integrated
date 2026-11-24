-- (run from the repo root: psql -f tests/etl_core_test.sql, on an EMPTY scratch database, never on a real project)
-- Local Postgres test for supabase/sql/etl_01_core.sql. Run: psql -v ON_ERROR_STOP=1 -f tests/etl_core_test.sql
-- Stubs the Supabase pieces (auth.uid, roles, op_profile, fact tables) and checks the 4.1 exit tests.
\set ON_ERROR_STOP on
drop schema if exists auth cascade; create schema auth;
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true),'')::uuid $$;
do $$ begin
  if not exists (select from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated; end if;
end $$;
drop table if exists public.fact_production_actual, public.fact_production_plan, public.op_profile cascade;
create table public.op_profile (user_id uuid primary key, email text, role text, is_active boolean default true);
create table public.fact_production_actual (id bigserial primary key, date date, site text, pit text, contractor text, shift text, category text, metric_group text, metric text, value numeric, text_value text);
create table public.fact_production_plan   (id bigserial primary key, date date, site text, pit text, contractor text, shift text, category text, metric_group text, metric text, value numeric, text_value text);
\i supabase/sql/etl_01_core.sql
insert into public.etl_config(site) values ('TMS');
insert into public.op_profile values ('00000000-0000-0000-0000-000000000001','v@x','viewer'),('00000000-0000-0000-0000-000000000002','d@x','data_entry'),('00000000-0000-0000-0000-000000000003','a@x','site_admin');
grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
-- existing rows: one actual group that the batch will not touch, one it will replace
insert into public.fact_production_actual(date,site,pit,contractor,shift,category,metric_group,metric,value) values
 ('2026-11-20','TMS','APL','C1','ALL','ACTUAL','Production','OB-DAY',100),
 ('2026-11-20','TMS',null,null,'ALL','ACTUAL','HSE','LTI',0);
insert into public.fact_production_plan(date,site,pit,contractor,shift,category,metric_group,metric,value) values
 ('2026-11-20','TMS',null,null,'ALL','PLAN','OB','DAY',500);

create temp table res(name text, ok boolean);
set role authenticated;
select set_config('test.uid','00000000-0000-0000-0000-000000000002',false);   -- data_entry
\set act '\'[{"date":"2026-11-20","site":"TMS","pit":"APL","contractor":"C1","shift":"ALL","category":"ACTUAL","metric_group":"Production","metric":"OB-DAY","value":150},{"date":"2026-11-20","site":"TMS","pit":"APL","contractor":"C1","shift":"ALL","category":"ACTUAL","metric_group":"Production","metric":"L-DAY","value":20}]\''
\set plan '\'[{"date":"2026-11-20","site":"TMS","category":"PLAN","shift":"ALL","metric_group":"OB","metric":"DAY","value":600}]\''
select public.etl_stage('TMS','2026-11-20','tms-dpr','t.xlsx', :act::jsonb, :plan::jsonb, '{"Production":"ok","HSE":"error"}') as b1 \gset
select public.etl_load(:'b1');
reset role; select (select count(*) from fact_production_actual)=3 and (select value from fact_production_actual where metric='OB-DAY')=150 and (select count(*) from fact_production_actual where metric_group='HSE')=1 as ok \gset t1_
\echo T1 load replaces Production only, keeps HSE:  :t1_ok
select (select value from fact_production_plan)=500 as ok \gset t2_
\echo T2 plan NOT written without replace:           :t2_ok
-- load twice = same rows
create temp table snap as select date,site,pit,contractor,shift,category,metric_group,metric,value from fact_production_actual order by 1,2,3,4,5,6,7,8;
set role authenticated; select set_config('test.uid','00000000-0000-0000-0000-000000000002',false);
select public.etl_stage('TMS','2026-11-20','tms-dpr','t.xlsx', :act::jsonb, :plan::jsonb, '{"Production":"ok"}') as b2 \gset
select public.etl_load(:'b2');
reset role;
select not exists (select * from snap except select date,site,pit,contractor,shift,category,metric_group,metric,value from fact_production_actual)
   and not exists (select date,site,pit,contractor,shift,category,metric_group,metric,value from fact_production_actual except select * from snap) as ok \gset t3_
\echo T3 load twice gives the same rows:             :t3_ok
-- undo b2 restores exactly the state after b1; undoing b1 while b2 loaded is refused
set role authenticated; select set_config('test.uid','00000000-0000-0000-0000-000000000002',false);
do $$ begin perform public.etl_undo((select batch_id from etl_batch where status='loaded' order by loaded_at limit 1)); raise exception 'should have been refused'; exception when others then if sqlerrm like 'ETL: a later load%' then raise notice 'T4 older undo refused while later load exists: true'; else raise; end if; end $$;
select public.etl_undo(:'b2');
reset role;
select not exists (select * from snap except select date,site,pit,contractor,shift,category,metric_group,metric,value from fact_production_actual)
   and not exists (select date,site,pit,contractor,shift,category,metric_group,metric,value from fact_production_actual except select * from snap) as ok \gset t5_
\echo T5 undo restores the previous rows:            :t5_ok
set role authenticated; select set_config('test.uid','00000000-0000-0000-0000-000000000002',false);
select public.etl_undo(:'b1');
reset role;
select (select count(*) from fact_production_actual)=2 and (select value from fact_production_actual where metric='OB-DAY')=100 and not exists (select 1 from fact_production_actual where metric='L-DAY') as ok \gset t6_
\echo T6 undo of first load restores the original:   :t6_ok
-- viewer, wrong site, error section, duplicate keys, plan replace role
set role authenticated;
select set_config('test.uid','00000000-0000-0000-0000-000000000001',false);
do $$ begin begin perform public.etl_stage('TMS','2026-11-20','x','x','[]'); raise exception 'viewer allowed'; exception when others then if sqlerrm like 'ETL: not allowed%' then raise notice 'T7 viewer refused: true'; else raise; end if; end; end $$;
select set_config('test.uid','00000000-0000-0000-0000-000000000002',false);
do $$ begin begin perform public.etl_stage('WKM','2026-11-20','x','x','[]'); raise exception 'wrong site allowed'; exception when others then if sqlerrm like 'ETL: this project serves%' then raise notice 'T8 other site refused: true'; else raise; end if; end; end $$;
do $$ begin begin perform public.etl_stage('TMS','2026-11-20','x','x','[{"date":"2026-11-20","site":"TMS","category":"ACTUAL","metric_group":"HSE","metric":"LTI","value":1}]','[]','{"HSE":"error"}'); raise exception 'error section allowed'; exception when others then if sqlerrm like 'ETL: % row(s) belong to a section%' then raise notice 'T9 ERROR section refused: true'; else raise; end if; end; end $$;
do $$ begin begin perform public.etl_stage('TMS','2026-11-20','x','x','[{"date":"2026-11-20","site":"TMS","category":"ACTUAL","metric_group":"P","metric":"M","value":1},{"date":"2026-11-20","site":"TMS","category":"ACTUAL","metric_group":"P","metric":"M","value":2}]'); raise exception 'dup allowed'; exception when others then if sqlerrm like 'ETL: % duplicate key%' then raise notice 'T10 duplicate keys refused: true'; else raise; end if; end; end $$;
select public.etl_stage('TMS','2026-11-20','tms-dpr','t.xlsx', :act::jsonb, :plan::jsonb, '{}') as b3 \gset
do $$ begin begin perform public.etl_load((select max(batch_id::text)::uuid from etl_batch where status='staged'), true); raise exception 'plan replace allowed'; exception when others then if sqlerrm like 'ETL: only a site admin%' then raise notice 'T11 data_entry cannot replace plan: true'; else raise; end if; end; end $$;
select count(*) as diffs from public.etl_plan_diff(:'b3') where state='changed' \gset
\echo T12 plan diff shows 1 changed value:           :diffs
select set_config('test.uid','00000000-0000-0000-0000-000000000003',false);
select public.etl_load(:'b3', true);
reset role;
select (select value from fact_production_plan)=600 as ok \gset t13_
\echo T13 site admin replace plan writes it:         :t13_ok
set role authenticated; select set_config('test.uid','00000000-0000-0000-0000-000000000003',false);
select public.etl_undo(:'b3');
reset role;
select (select value from fact_production_plan)=500 as ok \gset t14_
\echo T14 undo restores the old plan value:          :t14_ok
-- direct writes from the browser role are blocked
set role authenticated;
do $$ begin begin insert into public.etl_batch(site,report_date,kind) values ('TMS','2026-11-20','x'); raise exception 'direct insert allowed'; exception when insufficient_privilege then raise notice 'T15 direct insert blocked: true'; end; end $$;
