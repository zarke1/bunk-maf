-- ============================================================
-- Схема БД для сайта "Бункер + Мафия"
-- Выполнить целиком в Supabase -> SQL Editor -> New query -> Run
-- ============================================================

create extension if not exists pgcrypto;

-- Профили пользователей (ник, флаг админа)
create table if not exists profiles (
  id uuid references auth.users on delete cascade primary key,
  nickname text unique not null,
  is_admin boolean default false,
  created_at timestamptz default now()
);

-- Статистика
create table if not exists stats (
  user_id uuid references profiles(id) on delete cascade primary key,
  bunker_played int default 0,
  bunker_won int default 0,
  mafia_played int default 0,
  mafia_won int default 0
);

-- Комнаты (игровые сессии)
create table if not exists rooms (
  id uuid default gen_random_uuid() primary key,
  code text unique not null,
  game_type text not null check (game_type in ('bunker','mafia')),
  host_id uuid references profiles(id),
  status text default 'waiting' check (status in ('waiting','playing','finished')),
  settings jsonb default '{}',
  state jsonb default '{}',
  created_at timestamptz default now()
);

-- Игроки в комнате
create table if not exists room_players (
  room_id uuid references rooms(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  nickname text not null,
  seat int default 0,
  alive boolean default true,
  role jsonb default '{}',
  cards jsonb default '{}',
  revealed jsonb default '{}',
  joined_at timestamptz default now(),
  primary key (room_id, user_id)
);

-- Автосоздание профиля и статистики при регистрации
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, nickname)
  values (new.id, coalesce(new.raw_user_meta_data->>'nickname', 'player_' || substr(new.id::text,1,6)));
  insert into public.stats (user_id) values (new.id);
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Realtime: включаем публикацию изменений
alter publication supabase_realtime add table rooms;
alter publication supabase_realtime add table room_players;

-- ============================================================
-- RLS (Row Level Security)
-- ВАЖНО: для простоты MVP политики довольно открытые —
-- любой залогиненный пользователь может писать в комнаты и статистику
-- (это нужно, чтобы ведущий/клиенты могли двигать состояние игры
-- без отдельного сервера). Для игры с друзьями это нормально,
-- но не используйте это для чего-то серьёзного без доработки.
-- ============================================================
alter table profiles enable row level security;
alter table stats enable row level security;
alter table rooms enable row level security;
alter table room_players enable row level security;

create policy "profiles_select_all" on profiles for select using (true);
create policy "profiles_update_own" on profiles for update using (auth.uid() = id);

create policy "stats_select_all" on stats for select using (true);
create policy "stats_update_auth" on stats for update using (auth.role() = 'authenticated');

create policy "rooms_select_all" on rooms for select using (true);
create policy "rooms_insert_auth" on rooms for insert with check (auth.role() = 'authenticated');
create policy "rooms_update_auth" on rooms for update using (auth.role() = 'authenticated');
create policy "rooms_delete_admin" on rooms for delete using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_admin = true
  )
);

create policy "room_players_select_all" on room_players for select using (true);
create policy "room_players_insert_auth" on room_players for insert with check (auth.role() = 'authenticated');
create policy "room_players_update_auth" on room_players for update using (auth.role() = 'authenticated');
create policy "room_players_delete_admin" on room_players for delete using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_admin = true
  )
);

-- После первой регистрации сделайте себя админом (замените ник):
-- update profiles set is_admin = true where nickname = 'ВАШ_НИК';
