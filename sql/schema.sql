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
  game_type text not null check (game_type in ('bunker','mafia','battleship')),
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
-- Realtime: включаем публикацию изменений (без ошибки, если уже добавлено)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication p
    JOIN pg_publication_rel pr ON p.oid = pr.prpubid
    JOIN pg_class c ON pr.prrelid = c.oid
    WHERE p.pubname = 'supabase_realtime' AND c.relname = 'rooms'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE rooms;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication p
    JOIN pg_publication_rel pr ON p.oid = pr.prpubid
    JOIN pg_class c ON pr.prrelid = c.oid
    WHERE p.pubname = 'supabase_realtime' AND c.relname = 'room_players'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE room_players;
  END IF;
END$$;

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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='profiles' AND policyname='profiles_select_all'
  ) THEN
    CREATE POLICY "profiles_select_all" ON profiles FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='profiles' AND policyname='profiles_update_own'
  ) THEN
    CREATE POLICY "profiles_update_own" ON profiles FOR UPDATE USING (auth.uid() = id);
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='stats' AND policyname='stats_select_all'
  ) THEN
    CREATE POLICY "stats_select_all" ON stats FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='stats' AND policyname='stats_update_auth'
  ) THEN
    CREATE POLICY "stats_update_auth" ON stats FOR UPDATE USING (auth.role() = 'authenticated');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='rooms' AND policyname='rooms_select_all'
  ) THEN
    CREATE POLICY "rooms_select_all" ON rooms FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='rooms' AND policyname='rooms_insert_auth'
  ) THEN
    CREATE POLICY "rooms_insert_auth" ON rooms FOR INSERT WITH CHECK (auth.role() = 'authenticated');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='rooms' AND policyname='rooms_update_auth'
  ) THEN
    CREATE POLICY "rooms_update_auth" ON rooms FOR UPDATE USING (auth.role() = 'authenticated');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='rooms' AND policyname='rooms_delete_admin'
  ) THEN
    CREATE POLICY "rooms_delete_admin" ON rooms FOR DELETE USING (
      EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = auth.uid() AND p.is_admin = true
      )
    );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='room_players' AND policyname='room_players_select_all'
  ) THEN
    CREATE POLICY "room_players_select_all" ON room_players FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='room_players' AND policyname='room_players_insert_auth'
  ) THEN
    CREATE POLICY "room_players_insert_auth" ON room_players FOR INSERT WITH CHECK (auth.role() = 'authenticated');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='room_players' AND policyname='room_players_update_auth'
  ) THEN
    CREATE POLICY "room_players_update_auth" ON room_players FOR UPDATE USING (auth.role() = 'authenticated');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='room_players' AND policyname='room_players_delete_admin'
  ) THEN
    CREATE POLICY "room_players_delete_admin" ON room_players FOR DELETE USING (
      EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = auth.uid() AND p.is_admin = true
      )
    );
  END IF;
END$$;

-- После первой регистрации сделайте себя админом (замените ник):
-- update profiles set is_admin = true where nickname = 'ВАШ_НИК';
