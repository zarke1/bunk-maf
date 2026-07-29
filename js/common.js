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

function genRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
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
