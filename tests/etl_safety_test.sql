-- Proves the portal does not change prod_v2 (Looker's tables) in shadow mode, and only the uploaded partitions when live.
-- Run on an empty database: psql -v ON_ERROR_STOP=1 -f tests/etl_safety_test.sql
\set ON_ERROR_STOP on
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true),'')::uuid $$;
do $$ begin
  if not exists (select from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated; end if;
end $$;
create table public.op_profile (user_id uuid primary key, email text, role text, is_active boolean default true);
create schema prod_v2;
create table prod_v2.fact_production_actual (id bigserial primary key, date date, site text, pit text, contractor text, category text, metric_group text, metric text, value numeric, text_value text, source_file text, loaded_at timestamptz default now(), shift text);
create table prod_v2.fact_production_plan   (id bigserial primary key, date date, site text, pit text, contractor text, category text, metric_group text, metric text, value numeric, text_value text, source_file text, loaded_at timestamptz default now());   -- NO shift column, as in the real WKM project
\i supabase/sql/etl_01_core.sql
\i supabase/sql/etl_02_history.sql
\i supabase/sql/etl_03_safe_target.sql
insert into public.etl_config(site) values ('WKM');
insert into public.op_profile values ('00000000-0000-0000-0000-000000000002','d@x','data_entry'),('00000000-0000-0000-0000-000000000003','a@x','site_admin');
grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
insert into prod_v2.fact_production_actual(date,site,pit,contractor,shift,category,metric_group,metric,value,source_file,loaded_at) values
 ('2026-11-19','WKM','P1','C1','ALL','ACTUAL','Production','OB-DAY',100,'desktop-A','2026-11-20 08:00+00'),
 ('2026-11-20','WKM','P1','C1','ALL','ACTUAL','Production','OB-DAY',200,'desktop-B','2026-11-21 08:00+00'),
 ('2026-11-20','WKM',null,null,'ALL','ACTUAL','HSE','LTI',0,'desktop-B','2026-11-21 08:00+00');
insert into prod_v2.fact_production_plan(date,site,category,metric_group,metric,value,source_file) values ('2026-11-20','WKM','PLAN','OB','DAY',500,'desktop-P');
create table snap_a as select md5(string_agg(t::text, '|' order by t::text)) h from (select date,site,pit,contractor,shift,category,metric_group,metric,value,text_value,source_file,loaded_at from prod_v2.fact_production_actual) t;
create table snap_p as select md5(string_agg(t::text, '|' order by t::text)) h from (select date,site,pit,contractor,category,metric_group,metric,value,text_value,source_file,loaded_at from prod_v2.fact_production_plan) t;

set role authenticated; select set_config('test.uid','00000000-0000-0000-0000-000000000003',false);
\set act '\'[{"date":"2026-11-20","site":"WKM","pit":"P1","contractor":"C1","shift":"ALL","category":"ACTUAL","metric_group":"Production","metric":"OB-DAY","value":250}]\''
\set plan '\'[{"date":"2026-11-20","site":"WKM","category":"PLAN","shift":"ALL","metric_group":"OB","metric":"DAY","value":900}]\''
select public.etl_stage('WKM','2026-11-20','wkm-pdf','dr.pdf', :act::jsonb, :plan::jsonb, '{"Production":"ok"}') as b1 \gset
select public.etl_load(:'b1', true);
reset role;
select (select h from snap_a) = (select md5(string_agg(t::text, '|' order by t::text)) from (select date,site,pit,contractor,shift,category,metric_group,metric,value,text_value,source_file,loaded_at from prod_v2.fact_production_actual) t)
   and (select h from snap_p) = (select md5(string_agg(t::text, '|' order by t::text)) from (select date,site,pit,contractor,category,metric_group,metric,value,text_value,source_file,loaded_at from prod_v2.fact_production_plan) t) as ok \gset s1_
\echo S1 shadow load leaves prod_v2 byte-identical:   :s1_ok
select (select count(*) from etl_shadow_actual)=1 and (select value from etl_shadow_plan)=900 as ok \gset s2_
\echo S2 rows landed in the shadow tables:            :s2_ok
set role authenticated; select set_config('test.uid','00000000-0000-0000-0000-000000000003',false);
select state, prod_value, portal_value from public.etl_shadow_diff(:'b1');
select public.etl_undo(:'b1');
reset role;
select (select count(*) from etl_shadow_actual)=0 and (select count(*) from etl_shadow_plan)=0 as ok \gset s3_
\echo S3 undo empties the shadow tables:              :s3_ok

-- live (owner flips it)
update public.etl_config set live = true;
set role authenticated; select set_config('test.uid','00000000-0000-0000-0000-000000000003',false);
do $$ begin begin update public.etl_config set live = false; raise exception 'portal flipped live'; exception when insufficient_privilege then raise notice 'S4 portal role cannot change live flag: true'; end; end $$;
select public.etl_stage('WKM','2026-11-20','wkm-pdf','dr.pdf', :act::jsonb, :plan::jsonb, '{"Production":"ok"}') as b2 \gset
select public.etl_load(:'b2');
reset role;
select (select value from prod_v2.fact_production_actual where date='2026-11-20' and metric='OB-DAY')=250
   and (select value from prod_v2.fact_production_actual where date='2026-11-19')=100
   and (select count(*) from prod_v2.fact_production_actual where metric_group='HSE')=1
   and (select value from prod_v2.fact_production_plan)=500 as ok \gset s5_
\echo S5 live load changes only the uploaded partition: :s5_ok
set role authenticated; select set_config('test.uid','00000000-0000-0000-0000-000000000003',false);
select public.etl_undo(:'b2');
reset role;
select (select h from snap_a) = (select md5(string_agg(t::text, '|' order by t::text)) from (select date,site,pit,contractor,shift,category,metric_group,metric,value,text_value,source_file,loaded_at from prod_v2.fact_production_actual) t) as ok \gset s6_
\echo S6 live undo restores prod_v2 values exactly (ids are new):  :s6_ok
-- flag flipped between load and undo: undo still goes to the table the load wrote to
update public.etl_config set live = false;
set role authenticated; select set_config('test.uid','00000000-0000-0000-0000-000000000003',false);
select public.etl_stage('WKM','2026-11-20','x','x', :act::jsonb, '[]', '{"Production":"ok"}') as b3 \gset
select public.etl_load(:'b3');
reset role; update public.etl_config set live = true; set role authenticated; select set_config('test.uid','00000000-0000-0000-0000-000000000003',false);
select public.etl_undo(:'b3');
reset role;
select (select count(*) from etl_shadow_actual)=0 and (select value from prod_v2.fact_production_actual where date='2026-11-20' and metric='OB-DAY')=200 as ok \gset s7_
\echo S7 undo targets the table the load used:         :s7_ok

-- real column shape: portal fills source_file / loaded_at on live loads, undo restores the originals
update public.etl_config set live = true;
set role authenticated; select set_config('test.uid','00000000-0000-0000-0000-000000000003',false);
select public.etl_stage('WKM','2026-11-20','wkm-pdf','Daily_Report_WKM_20.pdf', :act::jsonb, '[]', '{"Production":"ok"}') as b4 \gset
select public.etl_load(:'b4');
reset role;
select (select source_file from prod_v2.fact_production_actual where date='2026-11-20' and metric='OB-DAY')='OPD: Daily_Report_WKM_20.pdf'
   and (select loaded_at from prod_v2.fact_production_actual where date='2026-11-20' and metric='OB-DAY') > '2026-11-22'::timestamptz as ok \gset s8_
\echo S8 live load fills source_file and loaded_at:       :s8_ok
set role authenticated; select set_config('test.uid','00000000-0000-0000-0000-000000000003',false);
select public.etl_undo(:'b4');
reset role;
select (select source_file from prod_v2.fact_production_actual where date='2026-11-20' and metric='OB-DAY')='desktop-B'
   and (select loaded_at from prod_v2.fact_production_actual where date='2026-11-20' and metric='OB-DAY')='2026-11-21 08:00+00' as ok \gset s9_
\echo S9 undo restores the original source_file/loaded_at: :s9_ok

-- plan table without shift: replace-plan works in shadow and live, diff is correct, undo restores
update public.etl_config set live = false;
set role authenticated; select set_config('test.uid','00000000-0000-0000-0000-000000000003',false);
select public.etl_stage('WKM','2026-11-20','x','x', '[]', :plan::jsonb, '{}') as b5 \gset
select count(*) filter (where state='changed') as chg from public.etl_plan_diff(:'b5') \gset
\echo S10 plan diff works without a shift column:           :chg changed (expect 1)
select public.etl_load(:'b5', true);
reset role;
select (select value from etl_shadow_plan)=900 and (select value from prod_v2.fact_production_plan)=500 as ok \gset s11_
\echo S11 shadow plan replace, prod plan untouched:        :s11_ok
set role authenticated; select set_config('test.uid','00000000-0000-0000-0000-000000000003',false);
select public.etl_undo(:'b5');
reset role;
update public.etl_config set live = true;
set role authenticated; select set_config('test.uid','00000000-0000-0000-0000-000000000003',false);
select public.etl_stage('WKM','2026-11-20','x','Daily_Report_P.pdf', '[]', :plan::jsonb, '{}') as b6 \gset
select public.etl_load(:'b6', true);
reset role;
select (select value from prod_v2.fact_production_plan)=900 and (select source_file from prod_v2.fact_production_plan)='OPD: Daily_Report_P.pdf' as ok \gset s12_
\echo S12 live plan replace on a table without shift:      :s12_ok
set role authenticated; select set_config('test.uid','00000000-0000-0000-0000-000000000003',false);
select public.etl_undo(:'b6');
reset role;
select (select value from prod_v2.fact_production_plan)=500 and (select source_file from prod_v2.fact_production_plan)='desktop-P' as ok \gset s13_
\echo S13 undo restores the old plan row and its source_file: :s13_ok
