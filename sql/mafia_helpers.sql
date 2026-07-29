-- Helper function: возвращает список мафии в комнате для игрока, если он сам мафия.
create or replace function public.get_mafia_team(room_id uuid, viewer_id uuid)
returns table(user_id uuid, nickname text) as $$
begin
  -- Проверяем, что viewer сам мафия в этой комнате
  if not exists (
    select 1 from public.room_players rp
    where rp.room_id = room_id and rp.user_id = viewer_id and (rp.role->>'name') = 'mafia'
  ) then
    return;
  end if;

  return query
    select rp.user_id, rp.nickname
    from public.room_players rp
    where rp.room_id = room_id and (rp.role->>'name') = 'mafia'
    order by rp.joined_at;
end;
$$ language plpgsql security definer;

-- Пример вызова (в Supabase SQL Editor):
-- select * from public.get_mafia_team('ROOM_UUID'::uuid, 'VIEWER_UUID'::uuid);
