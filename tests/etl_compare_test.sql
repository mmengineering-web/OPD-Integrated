-- Phase 4.5: compare week and go-live tools (supabase/sql/etl_06_compare.sql).
-- Run on an empty database: psql -v ON_ERROR_STOP=1 -f tests/etl_compare_test.sql
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
create table prod_v2.fact_production_plan   (id bigserial primary key, date date, site text, pit text, contractor text, category text, metric_group text, metric text, value numeric, text_value text, source_file text, loaded_at timestamptz default now());
\i supabase/sql/etl_01_core.sql
\i supabase/sql/etl_02_history.sql
\i supabase/sql/etl_03_safe_target.sql
\i supabase/sql/etl_04_barge.sql
\i supabase/sql/etl_05_hazard.sql
\i supabase/sql/etl_06_compare.sql
\i supabase/sql/etl_06_compare.sql
create table prod_v2.fact_barge (id bigserial primary key, like public.etl_shadow_barge);
insert into public.etl_config(site) values ('WKM');
insert into public.op_profile values ('00000000-0000-0000-0000-000000000001','v@x','viewer'),('00000000-0000-0000-0000-000000000002','d@x','data_entry'),('00000000-0000-0000-0000-000000000003','a@x','site_admin');
grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;

-- what the desktop ETL already has: 10 Nov and 11 Nov (12 Nov arrives later), one barge
insert into prod_v2.fact_production_actual(date,site,pit,contractor,shift,category,metric_group,metric,value,source_file) values
 ('2026-11-10','WKM','P1','C1','ALL','ACTUAL','Production','OB-DAY',100,'desktop'),
 ('2026-11-11','WKM','P1','C1','ALL','ACTUAL','Production','OB-DAY',200,'desktop');
insert into prod_v2.fact_barge(si,site,vessel_barge,actual_capacity,status,source_file) values ('S1','WKM','V1',5000,'DONE','desktop');

\set d1 '\'[{"date":"2026-11-10","site":"WKM","pit":"P1","contractor":"C1","shift":"ALL","category":"ACTUAL","metric_group":"Production","metric":"OB-DAY","value":100}]\''
\set d2bad '\'[{"date":"2026-11-11","site":"WKM","pit":"P1","contractor":"C1","shift":"ALL","category":"ACTUAL","metric_group":"Production","metric":"OB-DAY","value":250}]\''
\set d2ok '\'[{"date":"2026-11-11","site":"WKM","pit":"P1","contractor":"C1","shift":"ALL","category":"ACTUAL","metric_group":"Production","metric":"OB-DAY","value":200}]\''
\set d3 '\'[{"date":"2026-11-12","site":"WKM","pit":"P1","contractor":"C1","shift":"ALL","category":"ACTUAL","metric_group":"Production","metric":"OB-DAY","value":300}]\''
\set bg '\'[{"si":"S1","hist":{"SI":"S1","FINISHDATE":"2026-11-10"},"fact":{"si":"S1","site":"WKM","vessel_barge":"V1","actual_capacity":5000,"status":"DONE"},"old":null}]\''

-- day 1 clean, with a barge row
set role authenticated; select set_config('test.uid','00000000-0000-0000-0000-000000000002',false);
select public.etl_stage('WKM','2026-11-10','pdf','dr_10.pdf', :d1::jsonb, '[]', '{"Production":"ok"}') as b1 \gset
select public.etl_stage_barge(:'b1', :bg::jsonb);
select public.etl_load(:'b1');
select public.etl_compare_record(:'b1')->>'verdict' as v \gset c1_
select :'c1_v' = 'clean' as ok \gset
\echo C1 matching day and barge is clean:                   :ok

-- day 2 different (250 vs 200)
select public.etl_stage('WKM','2026-11-11','pdf','dr_11.pdf', :d2bad::jsonb, '[]', '{"Production":"ok"}') as b2 \gset
select public.etl_load(:'b2');
select public.etl_compare_record(:'b2')->>'verdict' as v \gset c2_
select :'c2_v' = 'different' as ok \gset
\echo C2 different value is different:                      :ok

-- day 3 only here (the desktop has nothing yet)
select public.etl_stage('WKM','2026-11-12','pdf','dr_12.pdf', :d3::jsonb, '[]', '{"Production":"ok"}') as b3 \gset
select public.etl_load(:'b3');
select public.etl_compare_record(:'b3')->>'verdict' as v \gset c3_
select :'c3_v' = 'only_here' as ok \gset
\echo C3 rows only in the portal need an explanation:       :ok

-- explain: data entry refused, short note refused, different cannot be explained, site admin with a reason works
do $$ begin begin perform public.etl_compare_explain((select batch_id from etl_batch where report_date='2026-11-12'), true, 'desktop is late today'); raise exception 'allowed';
  exception when others then raise notice 'C4 data entry cannot explain: %', sqlerrm like 'ETL: only a site admin%'; end; end $$;
select set_config('test.uid','00000000-0000-0000-0000-000000000003',false);
do $$ begin begin perform public.etl_compare_explain((select batch_id from etl_batch where report_date='2026-11-12'), true, 'late'); raise exception 'allowed';
  exception when others then raise notice 'C5 short note refused: %', sqlerrm like 'ETL: write the reason%'; end; end $$;
do $$ begin begin perform public.etl_compare_explain((select batch_id from etl_batch where report_date='2026-11-11'), true, 'the desktop value is a typo'); raise exception 'allowed';
  exception when others then raise notice 'C6 a different value cannot be explained: %', sqlerrm like 'ETL: only rows that exist only in the portal%'; end; end $$;
select public.etl_compare_explain(:'b3', true, 'desktop loads this day tomorrow');
select (public.etl_compare_status(3)->'days'->0->>'verdict') = 'explained' as ok \gset
\echo C7 explained day counts as passed:                    :ok

-- status: newest day passes, the day before is different, so the run is 1 day
select (public.etl_compare_status(3)->>'streak')::int = 1 and not (public.etl_compare_status(3)->>'ready')::boolean as ok \gset
\echo C8 a different day breaks the run:                    :ok

-- fix day 2: load the corrected file again (same file name replaces the first load in the status)
select public.etl_stage('WKM','2026-11-11','pdf','dr_11.pdf', :d2ok::jsonb, '[]', '{"Production":"ok"}') as b2b \gset
select public.etl_load(:'b2b');
select (public.etl_compare_status(3)->'days'->1->>'verdict') = 'unchecked' as ok \gset
\echo C9 a load that was never compared is unchecked:       :ok
select public.etl_compare_record(:'b2b')->>'verdict' as v \gset c10_
select :'c10_v' = 'clean' as ok \gset
\echo C10 corrected day is clean:                           :ok
select (public.etl_compare_status(3)->>'streak')::int = 3 and (public.etl_compare_status(3)->>'ready')::boolean
   and jsonb_array_length(public.etl_compare_status(3)->'days') = 3 as ok \gset
\echo C11 three days in a row are ready, replaced load not listed: :ok

-- re-check after the desktop wrote 12 Nov: the explanation is no longer needed, the day is clean
reset role;
insert into prod_v2.fact_production_actual(date,site,pit,contractor,shift,category,metric_group,metric,value,source_file) values
 ('2026-11-12','WKM','P1','C1','ALL','ACTUAL','Production','OB-DAY',300,'desktop');
set role authenticated; select set_config('test.uid','00000000-0000-0000-0000-000000000002',false);
select public.etl_compare_record(:'b3')->>'verdict' as v \gset c12_
select :'c12_v' = 'clean' as ok \gset
\echo C12 re-check after the desktop loaded the day:        :ok

-- a day loaded and not compared breaks the run; an undone load is ignored
select public.etl_stage('WKM','2026-11-13','pdf','dr_13.pdf', replace(:d3, '2026-11-12', '2026-11-13')::jsonb, '[]', '{"Production":"ok"}') as b4 \gset
select public.etl_load(:'b4');
select (public.etl_compare_status(3)->>'streak')::int = 0 as ok \gset
\echo C13 an unchecked newest day gives a run of 0:         :ok
select public.etl_undo(:'b4');
select (public.etl_compare_status(3)->>'streak')::int = 3 as ok \gset
\echo C14 undone load is ignored:                           :ok

-- people
select set_config('test.uid','00000000-0000-0000-0000-000000000001',false);
do $$ begin begin perform public.etl_compare_status(); raise exception 'allowed'; exception when others then raise notice 'C15 viewer cannot read the status: %', sqlerrm = 'ETL: not allowed'; end; end $$;
select count(*) = 0 as ok from public.etl_compare_log \gset
\echo C16 viewer reads no log rows:                         :ok
do $$ begin begin perform public.etl_go_live('DESKTOP STEP IS OFF'); raise exception 'allowed'; exception when others then raise notice 'C17 portal role cannot go live: %', sqlerrm like 'permission denied%'; end; end $$;
do $$ begin begin perform public.etl_golive_backup(); raise exception 'allowed'; exception when others then raise notice 'C18 portal role cannot back up or restore: %', sqlerrm like 'permission denied%'; end; end $$;
select set_config('test.uid','00000000-0000-0000-0000-000000000002',false);
do $$ begin begin perform public.etl_compare_record(gen_random_uuid()); raise exception 'allowed'; exception when others then raise notice 'C19 unknown batch refused: %', sqlerrm = 'ETL: batch not found'; end; end $$;
reset role;

-- go live (owner)
select count(*) filter (where ok is false) as n, bool_or(item like '4%' and ok) as streak_ok, bool_or(item like '5%' and ok is false) as no_backup from public.etl_golive_check(3) \gset g1_
select :g1_n = 1 and :'g1_streak_ok' = 't' and :'g1_no_backup' = 't' as ok \gset
\echo G1 check lists only the missing backup:               :ok
do $$ begin begin perform public.etl_go_live('DESKTOP STEP IS OFF', 3); raise exception 'allowed'; exception when others then raise notice 'G2 no backup, no go-live: %', sqlerrm like 'ETL: not ready:%'; end; end $$;
select public.etl_golive_backup()->>'taken_at' as t \gset snap_
select (select count(*) from etl_prelive_snapshot) = 3 and (select row_count from etl_prelive_snapshot where tbl='actual') = 3
   and (select row_count from etl_prelive_snapshot where tbl='barge') = 1 as ok \gset
\echo G3 backup holds the rows of all three tables:    :ok
do $$ begin begin perform public.etl_go_live(null, 3); raise exception 'allowed'; exception when others then raise notice 'G4 needs the confirmation text: %', sqlerrm like 'ETL: confirm that the desktop%'; end; end $$;
do $$ begin begin perform public.etl_go_live('DESKTOP STEP IS OFF', 10); raise exception 'allowed'; exception when others then raise notice 'G5 needs 10 clean days by default: %', sqlerrm like 'ETL: not ready:%4 clean days%'; end; end $$;
select public.etl_go_live('DESKTOP STEP IS OFF', 3)->>'live' = 'true' as r \gset go_
select :'go_r' and (select live from etl_config) as ok \gset
\echo G6 go live when all checks pass:                      :ok
select count(*) filter (where ok is false) = 1 as ok from public.etl_golive_check(3) \gset
\echo G7 a project that is live fails check 3:              :ok
do $$ begin begin perform public.etl_golive_restore('2026-01-01', 'RESTORE WKM'); raise exception 'allowed'; exception when others then raise notice 'G8 no restore while live: %', sqlerrm like 'ETL: switch back to test mode first%'; end; end $$;

-- rollback: back to test mode, damage the prod tables, restore, compare with the snapshot
select md5(string_agg(t::text, '|' order by t::text)) as h from (select * from prod_v2.fact_production_actual) t \gset hash_a_
select md5(string_agg(t::text, '|' order by t::text)) as h from (select * from prod_v2.fact_barge) t \gset hash_b_
select (public.etl_go_back()->>'live')::boolean = false as ok \gset
\echo G9 go back to test mode:                              :ok
delete from prod_v2.fact_production_actual where date = '2026-11-10';
insert into prod_v2.fact_production_actual(date,site,metric_group,metric,value) values ('2026-11-30','WKM','Junk','X',1);
update prod_v2.fact_barge set actual_capacity = 1;
do $$ begin begin perform public.etl_golive_restore((select taken_at from etl_prelive_snapshot limit 1), 'restore'); raise exception 'allowed'; exception when others then raise notice 'G10 needs the confirmation text: %', sqlerrm like 'ETL: to restore, confirm%'; end; end $$;
select public.etl_golive_restore(:'snap_t'::timestamptz, 'RESTORE WKM') is not null as ok \gset
select md5(string_agg(t::text, '|' order by t::text)) = :'hash_a_h' as ok from (select * from prod_v2.fact_production_actual) t \gset
\echo G11 restore puts the actual table back exactly:       :ok
select md5(string_agg(t::text, '|' order by t::text)) = :'hash_b_h' as ok from (select * from prod_v2.fact_barge) t \gset
\echo G12 restore puts the barge table back exactly:        :ok
do $$ begin begin perform public.etl_golive_restore((select taken_at from etl_prelive_snapshot limit 1), 'RESTORE WKM'); raise exception 'allowed'; exception when others then raise notice 'G13 a backup restores once: %', sqlerrm like 'ETL: no complete, unrestored backup%'; end; end $$;
select (select count(*) from etl_golive_log) = 4 as ok \gset
\echo G14 backup, go live, go back, restore are logged:     :ok
