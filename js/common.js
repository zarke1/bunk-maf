function emailFromNick(nick) {
  return nick.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_\-]/g, "") + "@bunkermafia.local";
}

async function getSessionUser() {
  const { data: { session } } = await sb.auth.getSession();
  return session ? session.user : null;
}

async function requireAuth() {
  const user = await getSessionUser();
  if (!user) { location.href = "index.html"; return null; }
  return user;
}

async function getProfile(userId) {
  const { data, error } = await sb.from("profiles").select("*").eq("id", userId).single();
  if (error) { console.error(error); return null; }
  return data;
}

async function getStats(userId) {
  const { data } = await sb.from("stats").select("*").eq("user_id", userId).single();
  return data;
}

async function updateNickname(userId, nickname) {
  if (!userId) throw new Error('no user');
  const clean = (nickname || '').trim();
  if (!clean) throw new Error('empty nickname');
  const { data, error } = await sb.from('profiles').update({ nickname: clean }).eq('id', userId).select().single();
  if (error) throw error;
  // update any room_players rows so display name stays consistent
  try{
    await sb.from('room_players').update({ nickname: clean }).eq('user_id', userId);
  }catch(e){ console.warn('failed to update room_players', e); }
  return data;
}

function genRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function touchRoomActivity(roomId) {
  if (!roomId) return;
  try {
    const { data, error } = await sb.from("rooms").select("settings").eq("id", roomId).single();
    if (error || !data) return;
    const settings = { ...(data.settings || {}), last_activity: new Date().toISOString() };
    await sb.from("rooms").update({ settings }).eq("id", roomId);
  } catch (e) {
    console.error(e);
  }
}

async function cleanupInactiveRooms() {
  try {
    const { data: rooms, error } = await sb.from("rooms").select("id, created_at, settings").order("created_at", { ascending: false });
    if (error || !rooms?.length) return;
    const now = Date.now();
    for (const room of rooms) {
      const lastActivity = room.settings?.last_activity || room.created_at;
      const lastTime = new Date(lastActivity).getTime();
      if (Number.isNaN(lastTime)) continue;
      if (now - lastTime <= 5 * 60 * 1000) continue;
      const { data: players } = await sb.from("room_players").select("user_id").eq("room_id", room.id);
      const count = players?.length || 0;
      if (count <= 1) {
        await sb.from("rooms").delete().eq("id", room.id);
      }
    }
  } catch (e) {
    console.error(e);
  }
}

if (typeof window !== "undefined") {
  setInterval(cleanupInactiveRooms, 30000);
}

async function logout() {
  await sb.auth.signOut();
  location.href = "index.html";
}

function toast(msg) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.className = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => t.classList.remove("show"), 2500);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}
