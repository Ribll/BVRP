-- ============================================================
--  CALENDARIO PRESENZE — Schema Supabase
--  Esegui questo file dentro Supabase → SQL Editor → New query
--
--  Include la gerarchia dei gruppi (groups.parent_id):
--  chi appartiene a un gruppo può vedere e modificare le presenze
--  dei membri dei gruppi che gli stanno SOTTO (discendenti stretti).
--  L'admin resta globale: is_admin() può tutto, ovunque.
-- ============================================================

-- ---------- TABELLE ----------

-- Gruppi / team. parent_id costruisce l'albero gerarchico:
-- NULL = gruppo di primo livello. on delete set null: eliminando
-- il padre, i figli risalgono di livello (non vengono cancellati).
create table if not exists public.groups (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  manager_email text not null,
  parent_id     uuid references public.groups(id) on delete set null,
  require_office boolean not null default false,  -- richiede almeno una presenza in sede
  created_at    timestamptz default now()
);

-- Per i database creati prima dell'introduzione della gerarchia
alter table public.groups
  add column if not exists parent_id uuid
  references public.groups(id) on delete set null;

alter table public.groups
  add column if not exists require_office boolean not null default false;

create index if not exists groups_parent_id_idx on public.groups (parent_id);

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
-- Legge i metadati passati alla creazione dell'utente (name, group_id, role,
-- avatar, color). Vale sia per signUp sia per admin.createUser (Edge Function).
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
--  GERARCHIA DEI GRUPPI
-- ============================================================

-- Protezione anti-ciclo: impedisce che un gruppo diventi, anche
-- indirettamente, padre di sé stesso (manderebbe in loop la ricorsione).
create or replace function public.check_group_cycle()
returns trigger
language plpgsql
as $$
declare
  cur   uuid;
  depth int := 0;
begin
  if new.parent_id is null then
    return new;
  end if;
  if new.parent_id = new.id then
    raise exception 'Un gruppo non può essere padre di sé stesso';
  end if;

  cur := new.parent_id;
  while cur is not null loop
    depth := depth + 1;
    if depth > 50 then
      raise exception 'Gerarchia dei gruppi troppo profonda o ciclica';
    end if;
    if cur = new.id then
      raise exception 'Ciclo nella gerarchia dei gruppi';
    end if;
    select parent_id into cur from public.groups where id = cur;
  end loop;

  return new;
end;
$$;

drop trigger if exists groups_no_cycle on public.groups;
create trigger groups_no_cycle
  before insert or update of parent_id on public.groups
  for each row execute function public.check_group_cycle();

-- Discendenti STRETTI di un gruppo: figli, nipoti, ... a qualsiasi
-- profondità. NON include il gruppo stesso: così due colleghi dello
-- stesso team non acquisiscono potere l'uno sull'altro.
create or replace function public.group_descendants(root uuid)
returns table (id uuid)
language sql
stable
security definer set search_path = public
as $$
  with recursive t as (
    select g.id from public.groups g where g.parent_id = root
    union all
    select g.id from public.groups g join t on g.parent_id = t.id
  )
  select id from t;
$$;

-- manages_user(target): il chiamante sta in un gruppo gerarchicamente
-- superiore a quello di target? Qui NON si controlla il ruolo: l'admin
-- è già coperto dalle policy basate su is_admin().
create or replace function public.manages_user(target uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1
    from public.profiles me
    join public.profiles t on t.id = target
    where me.id = auth.uid()
      and me.group_id is not null
      and t.group_id is not null
      and t.group_id in (select id from public.group_descendants(me.group_id))
  );
$$;

grant execute on function public.group_descendants(uuid) to authenticated;
grant execute on function public.manages_user(uuid)      to authenticated;

-- ============================================================
--  PRESIDIO MINIMO IN UFFICIO
--  Un gruppo con require_office=true deve avere sempre almeno una
--  persona con status 'presente' nei giorni feriali. È un TRIGGER e
--  non una policy: l'RLS valuta una riga per volta e non sa contare.
-- ============================================================

-- 2) Il guardiano. È un TRIGGER, non una policy RLS: l'RLS valuta una
--    riga alla volta e non può contare quante persone del gruppo sono
--    in ufficio quel giorno.
create or replace function public.check_office_presence()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  g_id             uuid;
  g_name           text;
  req              boolean;
  member_count     int;
  others_in_office int;
begin
  -- Tornare in ufficio è sempre permesso.
  if new.status = 'presente' then
    return new;
  end if;

  -- Sabato (6) e domenica (7): nessun presidio richiesto.
  if extract(isodow from new.date) >= 6 then
    return new;
  end if;

  -- Gruppo dell'utente interessato.
  select p.group_id into g_id from public.profiles p where p.id = new.user_id;
  if g_id is null then
    return new;
  end if;

  select g.require_office, g.name into req, g_name
  from public.groups g where g.id = g_id;
  if not coalesce(req, false) then
    return new;
  end if;

  -- Soglia: gruppi piccoli esentati, altrimenti nessuno potrebbe assentarsi.
  select count(*) into member_count from public.profiles where group_id = g_id;
  if member_count < 3 then
    return new;
  end if;

  -- Scavalco: admin globale, oppure superiore gerarchico dell'utente.
  -- NB: manages_user(sé stesso) è falso, quindi un manager che modifica
  -- il PROPRIO stato resta soggetto al vincolo.
  if public.is_admin() or public.manages_user(new.user_id) then
    return new;
  end if;

  -- Quanti ALTRI membri del gruppo risultano in ufficio quel giorno?
  -- coalesce(...,'presente'): chi non ha riga è in ufficio per default.
  select count(*) into others_in_office
  from public.profiles p
  where p.group_id = g_id
    and p.id <> new.user_id
    and coalesce(
          (select a.status from public.attendance a
            where a.user_id = p.id and a.date = new.date),
          'presente'
        ) = 'presente';

  if others_in_office = 0 then
    raise exception
      'Sei l''ultima persona in ufficio per il gruppo "%": è richiesta almeno una presenza in sede.', g_name
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists attendance_office_guard on public.attendance;
create trigger attendance_office_guard
  before insert or update on public.attendance
  for each row execute function public.check_office_presence();

-- NB: non serve un trigger su DELETE: cancellare una riga riporta la
-- persona al default 'presente' e non può svuotare l'ufficio.
-- NB: le festività sono calcolate lato client, il DB non le conosce.

-- ============================================================
--  ROW LEVEL SECURITY
--  NB: tutte le policy sono PERMISSIVE (default): si sommano in OR.
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

-- Chi sta in un gruppo superiore scrive le presenze dei sottoposti.
-- Policy separate per insert/update/delete: upsertAttendance() genera un
-- INSERT ... ON CONFLICT DO UPDATE, che richiede il via libera da entrambe.
drop policy if exists attendance_manager_insert on public.attendance;
create policy attendance_manager_insert on public.attendance
  for insert to authenticated
  with check (public.manages_user(user_id));

drop policy if exists attendance_manager_update on public.attendance;
create policy attendance_manager_update on public.attendance
  for update to authenticated
  using (public.manages_user(user_id))
  with check (public.manages_user(user_id));

drop policy if exists attendance_manager_delete on public.attendance;
create policy attendance_manager_delete on public.attendance
  for delete to authenticated
  using (public.manages_user(user_id));

-- ============================================================
--  SEED — gruppi iniziali (opzionale)
--  Gli utenti si creano dall'Amministrazione (Edge Function manage-users).
--  NB: "name" non ha un vincolo di unicità, quindi "on conflict do nothing"
--  non intercetterebbe nulla: si usa "where not exists" per evitare
--  duplicati se questo file viene rieseguito.
-- ============================================================
insert into public.groups (name, manager_email)
select 'Team Alpha', 'manager.alpha@azienda.it'
where not exists (select 1 from public.groups where name = 'Team Alpha');

insert into public.groups (name, manager_email)
select 'Team Beta', 'manager.beta@azienda.it'
where not exists (select 1 from public.groups where name = 'Team Beta');
