-- ============================================================
--  CALENDARIO PRESENZE — Schema Supabase
--  Esegui questo file dentro Supabase → SQL Editor → New query
-- ============================================================

-- ---------- TABELLE ----------

-- Gruppi / team
create table if not exists public.groups (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  manager_email text not null,
  created_at    timestamptz default now()
);

-- Profili utente (collegati 1:1 all'utente di autenticazione)
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text not null,
  email      text not null,
  group_id   uuid references public.groups(id) on delete set null,
  role       text not null default 'user',   -- 'user' | 'admin'
  avatar     text,
  color      text,
  created_at timestamptz default now()
);

-- Presenze: una riga per (utente, giorno)
create table if not exists public.attendance (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  date       date not null,
  status     text not null,                  -- presente | smartworking | ferie | trasferta | permesso | assente
  location   text default '',
  updated_at timestamptz default now(),
  unique (user_id, date)
);

create index if not exists attendance_user_date_idx on public.attendance (user_id, date);

-- ---------- FUNZIONE: crea il profilo automaticamente alla registrazione ----------
-- Legge i metadati passati in fase di signUp (name, group_id, role, avatar, color)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, name, email, group_id, role, avatar, color)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
    new.email,
    nullif(new.raw_user_meta_data ->> 'group_id', '')::uuid,
    coalesce(new.raw_user_meta_data ->> 'role', 'user'),
    coalesce(new.raw_user_meta_data ->> 'avatar', upper(substr(new.email, 1, 2))),
    coalesce(new.raw_user_meta_data ->> 'color', '#60a5fa')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- HELPER: l'utente corrente è admin? ----------
create or replace function public.is_admin()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ============================================================
--  ROW LEVEL SECURITY
-- ============================================================
alter table public.groups     enable row level security;
alter table public.profiles   enable row level security;
alter table public.attendance enable row level security;

-- --- GROUPS ---
-- Tutti gli utenti autenticati possono leggere i gruppi
drop policy if exists groups_read on public.groups;
create policy groups_read on public.groups
  for select to authenticated using (true);

-- Solo gli admin creano / modificano / eliminano gruppi
drop policy if exists groups_admin_write on public.groups;
create policy groups_admin_write on public.groups
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- --- PROFILES ---
-- Tutti gli autenticati vedono tutti i profili (serve per calendario/team)
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select to authenticated using (true);

-- Un utente aggiorna il proprio profilo; gli admin aggiornano chiunque
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- Solo gli admin eliminano profili
drop policy if exists profiles_admin_delete on public.profiles;
create policy profiles_admin_delete on public.profiles
  for delete to authenticated using (public.is_admin());

-- --- ATTENDANCE ---
-- Tutti gli autenticati leggono tutte le presenze
drop policy if exists attendance_read on public.attendance;
create policy attendance_read on public.attendance
  for select to authenticated using (true);

-- Un utente scrive le proprie presenze; gli admin scrivono per chiunque
drop policy if exists attendance_write on public.attendance;
create policy attendance_write on public.attendance
  for all to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

-- ============================================================
--  SEED — gruppi iniziali (opzionale)
--  Gli utenti si creano registrandosi (vedi README).
-- ============================================================
insert into public.groups (name, manager_email)
values
  ('Team Alpha', 'manager.alpha@azienda.it'),
  ('Team Beta',  'manager.beta@azienda.it')
on conflict do nothing;
