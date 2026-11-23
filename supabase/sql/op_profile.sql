-- One Portal Data: the role table of a production project (WKM, BM, TMS, Hub production).
-- Run in the SQL editor of EACH of those four projects. Safe to run twice.
-- Review before running in production. If public.op_profile already exists with another shape, stop and compare first.

create table if not exists public.op_profile (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  full_name  text,
  role       text not null default 'viewer' check (role in ('viewer','data_entry','site_admin','super_admin')),
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists op_profile_email_key on public.op_profile (lower(email));

alter table public.op_profile enable row level security;

-- A person reads their own row (the portal login does this). Super admins read everyone.
create or replace function public.op_is_super() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.op_profile where user_id = auth.uid() and role = 'super_admin' and is_active);
$$;

drop policy if exists op_profile_self on public.op_profile;
create policy op_profile_self on public.op_profile for select to authenticated using (user_id = auth.uid());
drop policy if exists op_profile_super on public.op_profile;
create policy op_profile_super on public.op_profile for select to authenticated using (public.op_is_super());
-- No insert/update/delete policy on purpose: writes go through the op-admin-users Edge Function (service role).

-- The last active super admin cannot be deleted, demoted or deactivated (the Edge Function checks too).
create or replace function public.op_profile_keep_super() returns trigger
language plpgsql as $$
begin
  if old.role = 'super_admin' and old.is_active
     and (tg_op = 'DELETE' or new.role <> 'super_admin' or not new.is_active)
     and not exists (select 1 from public.op_profile where role = 'super_admin' and is_active and user_id <> old.user_id) then
    raise exception 'The last super admin cannot be removed or demoted.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists op_profile_keep_super on public.op_profile;
create trigger op_profile_keep_super before update or delete on public.op_profile
  for each row execute function public.op_profile_keep_super();

create or replace function public.op_profile_touch() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists op_profile_touch on public.op_profile;
create trigger op_profile_touch before update on public.op_profile for each row execute function public.op_profile_touch();

-- Existing auth users become viewers (portal only; real data access is still decided by each project's RLS).
insert into public.op_profile (user_id, email, full_name, role)
select u.id, u.email, coalesce(u.raw_user_meta_data->>'full_name', split_part(u.email,'@',1)), 'viewer'
from auth.users u where u.email is not null
on conflict (user_id) do nothing;

-- Make yourself the first super admin (edit the email, run once):
-- update public.op_profile set role = 'super_admin' where lower(email) = lower('your-email@example.com');
