-- ============================================================
-- Расширенная схема статистики + helper-функции
-- Выполнить в Supabase -> SQL Editor -> Run
-- ============================================================

create extension if not exists pgcrypto;

-- Игры (история матчей)
create table if not exists public.games (
  id uuid default gen_random_uuid() primary key,
  room_id uuid references public.rooms on delete set null,
  game_type text not null check (game_type in ('bunker','mafia')),
  started_at timestamptz default now(),
  ended_at timestamptz,
  winner text
);

-- Участники конкретной игры
create table if not exists public.game_players (
  game_id uuid references public.games(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  nickname text,
  role text,
  won boolean default false,
  primary key (game_id, user_id)
);

create index if not exists idx_game_players_user on public.game_players(user_id);
create index if not exists idx_games_room on public.games(room_id);

-- Представление для быстрого лидерборда (агрегированные данные берём из таблицы stats)
create or replace view public.leaderboard_view as
select
  p.id as user_id,
  p.nickname,
  coalesce(s.bunker_played,0) as bunker_played,
  coalesce(s.bunker_won,0) as bunker_won,
  coalesce(s.mafia_played,0) as mafia_played,
  coalesce(s.mafia_won,0) as mafia_won,
  (coalesce(s.bunker_played,0) + coalesce(s.mafia_played,0)) as total_played,
  (coalesce(s.bunker_won,0) + coalesce(s.mafia_won,0)) as total_wins
from public.profiles p
left join public.stats s on s.user_id = p.id
order by total_wins desc;

-- Функция для записи результата игры и обновления агрегированных статистик
create or replace function public.record_game_result(
  _game_id uuid,
  _room_id uuid,
  _game_type text,
  _winner text,
  _players jsonb
) returns void as $$
declare
  rec jsonb;
  uid uuid;
  nick text;
  role text;
  won boolean;
begin
  -- Вставляем запись о игре (без конфликта)
  insert into public.games(id, room_id, game_type, winner, started_at, ended_at)
  values (_game_id, _room_id, _game_type, _winner, now(), now())
  on conflict (id) do update set ended_at = excluded.ended_at, winner = excluded.winner;

  -- Вставляем игроков и обновляем агрегированную статистику
  for rec in select * from jsonb_array_elements(_players) loop
    uid := (rec->>'user_id')::uuid;
    nick := rec->>'nickname';
    role := rec->>'role';
    won := coalesce((rec->>'won')::boolean, false);

    insert into public.game_players(game_id, user_id, nickname, role, won)
    values (_game_id, uid, nick, role, won)
    on conflict (game_id, user_id) do update set nickname = excluded.nickname, role = excluded.role, won = excluded.won;

    if _game_type = 'mafia' then
      update public.stats set mafia_played = coalesce(mafia_played,0) + 1, mafia_won = coalesce(mafia_won,0) + (case when won then 1 else 0 end)
      where user_id = uid;
    elsif _game_type = 'bunker' then
      update public.stats set bunker_played = coalesce(bunker_played,0) + 1, bunker_won = coalesce(bunker_won,0) + (case when won then 1 else 0 end)
      where user_id = uid;
    end if;
  end loop;
end;
$$ language plpgsql security definer;

-- Включаем RLS для истории игр и даём простые политики (MVP)
alter table public.games enable row level security;
alter table public.game_players enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='games' and policyname='games_select_all') then
    execute $q$create policy "games_select_all" on public.games for select using (true);$q$;
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='games' and policyname='games_insert_auth') then
    execute $q$create policy "games_insert_auth" on public.games for insert with check (auth.role() = 'authenticated');$q$;
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='game_players' and policyname='game_players_select_all') then
    execute $q$create policy "game_players_select_all" on public.game_players for select using (true);$q$;
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='game_players' and policyname='game_players_insert_auth') then
    execute $q$create policy "game_players_insert_auth" on public.game_players for insert with check (auth.role() = 'authenticated');$q$;
  end if;
end$$;

-- Пример использования функции record_game_result из клиента (вставьте реальный UUID и JSON):
-- select public.record_game_result('00000000-0000-0000-0000-000000000000'::uuid, 'ROOM_UUID'::uuid, 'mafia', 'mafia', '[{"user_id":"USER1","nickname":"A","role":"mafia","won":true}]'::jsonb);
