const params = new URLSearchParams(location.search);
const roomId = params.get("room");
let me, profile, room, players = [];

async function init(){
  me = await requireAuth();
  if(!me) return;
  if(!roomId){ location.href="lobby.html"; return; }
  profile = await getProfile(me.id);
  await loadRoom();
  sb.channel("mafia-"+roomId)
    .on("postgres_changes",{event:"*",schema:"public",table:"rooms",filter:"id=eq."+roomId}, loadRoom)
    .on("postgres_changes",{event:"*",schema:"public",table:"room_players",filter:"room_id=eq."+roomId}, loadRoom)
    .subscribe();
}

async function loadRoom(){
  const { data:r, error } = await sb.from("rooms").select("*").eq("id", roomId).single();
  if(error || !r){ toast("Комната не найдена"); return; }
  room = r;
  const { data:p } = await sb.from("room_players").select("*").eq("room_id", roomId).order("seat");
  players = p || [];
  render();
  if(room.host_id === me.id) setTimeout(hostAutoResolve, 500);
}

function buildRoles(n){
  const mafiaCount = Math.max(1, Math.floor(n/3));
  const roles = [];
  for(let i=0;i<mafiaCount;i++) roles.push("mafia");
  if(n>=5) roles.push("detective");
  if(n>=6) roles.push("doctor");
  while(roles.length < n) roles.push("civilian");
  return shuffle(roles);
}

const ROLE_NAMES = { mafia:"Мафия 🔪", detective:"Комиссар 🕵", doctor:"Доктор 💉", civilian:"Мирный житель 👤" };

async function startGame(){
  if(room.host_id !== me.id){ toast("Только хост может начать игру"); return; }
  if(players.length < 4){ toast("Нужно минимум 4 игрока"); return; }
  const roles = buildRoles(players.length);
  for(let i=0;i<players.length;i++){
    await sb.from("room_players").update({
      role: { name: roles[i] }, alive:true, revealed:{ checks:[] }
    }).eq("room_id", roomId).eq("user_id", players[i].user_id);
  }
  const state = {
    phase:"night", dayNumber:1,
    nightActions:{ mafia:{}, doctor:null, detective:null },
    votes:{}, log:["🌙 Ночь 1. Все закрывают глаза..."], winner:null, checks:[], mafiaChat:[]
  };
  await touchRoomActivity(roomId);
  await sb.from("rooms").update({ status:"playing", state }).eq("id", roomId);
}

function myRole(){
  return players.find(p=>p.user_id===me.id)?.role?.name;
}
function aliveList(){ return players.filter(p=>p.alive); }
function aliveMafia(){ return aliveList().filter(p=>p.role?.name==="mafia"); }
function aliveOthers(){ return aliveList().filter(p=>p.role?.name!=="mafia"); }

async function nightAction(kind, targetId){
  const st = { ...room.state };
  st.nightActions = { ...st.nightActions };
  if(kind==="mafia"){
    st.nightActions.mafia = { ...st.nightActions.mafia, [me.id]: targetId };
  } else if(kind==="doctor"){
    st.nightActions.doctor = targetId;
  } else if(kind==="detective"){
    st.nightActions.detective = targetId;
  }
  await touchRoomActivity(roomId);
  await sb.from("rooms").update({ state: st }).eq("id", roomId);
}

async function hostAutoResolve(){
  const { data:r } = await sb.from("rooms").select("*").eq("id", roomId).single();
  const { data:p } = await sb.from("room_players").select("*").eq("room_id", roomId);
  if(!r || r.status!=="playing") return;
  const st = r.state;
  const alivePlayers = p.filter(x=>x.alive);
  const mafiaAlive = alivePlayers.filter(x=>x.role?.name==="mafia");
  const doctorAlive = alivePlayers.find(x=>x.role?.name==="doctor");
  const detectiveAlive = alivePlayers.find(x=>x.role?.name==="detective");

  if(st.phase==="night"){
    const mafiaVotesCount = Object.keys(st.nightActions?.mafia||{}).length;
    const mafiaDone = mafiaAlive.length===0 || mafiaVotesCount >= mafiaAlive.length;
    const doctorDone = !doctorAlive || st.nightActions?.doctor;
    const detectiveDone = !detectiveAlive || st.nightActions?.detective;
    if(mafiaDone && doctorDone && detectiveDone){
      await resolveNight(r, p);
    }
  } else if(st.phase==="vote"){
    const votesCount = Object.keys(st.votes||{}).length;
    if(votesCount >= alivePlayers.length){
      await resolveVote(r, p);
    }
  }
}

async function resolveNight(r, allPlayers){
  const st = { ...r.state };
  const tally = {};
  for(const v of Object.values(st.nightActions.mafia||{})){ if(v) tally[v]=(tally[v]||0)+1; }
  let killTarget=null, max=-1;
  for(const [id,c] of Object.entries(tally)){ if(c>max){ max=c; killTarget=id; } }

  const saved = st.nightActions.doctor && st.nightActions.doctor===killTarget;
  const log = [...st.log];

  if(st.nightActions.detective){
    const target = allPlayers.find(x=>x.user_id===st.nightActions.detective);
    const isMafia = target?.role?.name==="mafia";
    st.checks = [...(st.checks||[]), { day: st.dayNumber, target: st.nightActions.detective, isMafia }];
  }

  if(killTarget && !saved){
    await sb.from("room_players").update({ alive:false }).eq("room_id", roomId).eq("user_id", killTarget);
    const nick = allPlayers.find(x=>x.user_id===killTarget)?.nickname || "?";
    log.push(`☠ Этой ночью погиб(ла): ${nick}`);
  } else if(killTarget && saved){
    log.push(`💉 Доктор спас цель мафии этой ночью.`);
  } else {
    log.push(`🌙 Ночь прошла без жертв.`);
  }

  const updatedAlive = allPlayers.map(p => p.user_id===killTarget && !saved ? {...p, alive:false} : p);
  const win = checkWin(updatedAlive);
  if(win){
    log.push(win==="mafia" ? "🔪 Мафия победила!" : "😇 Мирные жители победили!");
    await sb.from("rooms").update({ status:"finished", state:{ ...st, phase:"end", winner:win, log } }).eq("id", roomId);
    await applyStats(updatedAlive, win);
    return;
  }

  await sb.from("rooms").update({ state:{
    ...st, phase:"day", nightActions:{ mafia:{}, doctor:null, detective:null }, log
  }}).eq("id", roomId);
}

async function resolveVote(r, allPlayers){
  const st = { ...r.state };
  const tally = {};
  for(const v of Object.values(st.votes||{})){ if(v && v!=="skip") tally[v]=(tally[v]||0)+1; }
  let out=null, max=-1;
  for(const [id,c] of Object.entries(tally)){ if(c>max){ max=c; out=id; } }
  const log = [...st.log];

  let updatedAlive = allPlayers;
  if(out){
    await sb.from("room_players").update({ alive:false }).eq("room_id", roomId).eq("user_id", out);
    const nick = allPlayers.find(x=>x.user_id===out)?.nickname || "?";
    log.push(`🗳 По итогам голосования изгнан(а): ${nick}`);
    updatedAlive = allPlayers.map(p => p.user_id===out ? {...p, alive:false} : p);
  } else {
    log.push(`🗳 Голосование не выявило большинства — никто не изгнан.`);
  }

  const win = checkWin(updatedAlive);
  if(win){
    log.push(win==="mafia" ? "🔪 Мафия победила!" : "😇 Мирные жители победили!");
    await sb.from("rooms").update({ status:"finished", state:{ ...st, phase:"end", winner:win, log } }).eq("id", roomId);
    await applyStats(updatedAlive, win);
    return;
  }

  await sb.from("rooms").update({ state:{
    ...st, phase:"night", dayNumber:st.dayNumber+1, votes:{}, log:[...log, `🌙 Ночь ${st.dayNumber+1}. Все закрывают глаза...`]
  }}).eq("id", roomId);
}

function checkWin(allPlayers){
  const alive = allPlayers.filter(p=>p.alive);
  const mafia = alive.filter(p=>p.role?.name==="mafia");
  const others = alive.filter(p=>p.role?.name!=="mafia");
  if(mafia.length===0) return "civilians";
  if(mafia.length >= others.length) return "mafia";
  return null;
}

async function applyStats(allPlayers, win){
  for(const p of allPlayers){
    const { data:s } = await sb.from("stats").select("*").eq("user_id", p.user_id).single();
    const isMafia = p.role?.name==="mafia";
    const won = (win==="mafia" && isMafia) || (win==="civilians" && !isMafia);
    await sb.from("stats").update({
      mafia_played:(s?.mafia_played||0)+1, mafia_won:(s?.mafia_won||0)+(won?1:0)
    }).eq("user_id", p.user_id);
  }
}

async function goToVote(){
  const st = { ...room.state, phase:"vote", votes:{} };
  await touchRoomActivity(roomId);
  await sb.from("rooms").update({ state: st }).eq("id", roomId);
}

async function castVote(targetId){
  const st = { ...room.state };
  st.votes = { ...st.votes, [me.id]: targetId };
  await touchRoomActivity(roomId);
  await sb.from("rooms").update({ state: st }).eq("id", roomId);
}

function render(){
  const app = document.getElementById("app");
  if(!room){ app.innerHTML = "Загрузка..."; return; }

  let html = `<div class="header">
    <div class="brand">🔪 <span>Мафия</span></div>
    <div style="display:flex;gap:8px;align-items:center">
      <span class="pill">Код: <b>${esc(room.code)}</b></span>
      <button class="btn small secondary" onclick="location.href='lobby.html'">В лобби</button>
    </div>
  </div>`;

  if(room.status === "waiting"){
    html += `<div class="card"><h2>Ожидание игроков (${players.length}/12)</h2>
      <div class="code-box">${esc(room.code)}</div>
      <div class="player-list">${players.map(p=>`
        <div class="player-item ${p.user_id===me.id?'me':''}">
          <span>${esc(p.nickname)} ${p.user_id===room.host_id?'👑':''}</span>
        </div>`).join("")}</div>`;
    if(room.host_id === me.id){
      html += players.length>=4
        ? `<button class="btn" onclick="startGame()">Начать игру</button>`
        : `<p class="muted">Нужно минимум 4 игрока.</p>`;
    } else {
      html += `<p class="muted">Ждём хоста...</p>`;
    }
    html += `</div>`;
    app.innerHTML = html;
    return;
  }

  const st = room.state;
  const myPlayer = players.find(p=>p.user_id===me.id);
  const role = myPlayer?.role?.name;

  if(st.phase === "end"){
    html += `<div class="phase-banner end">🏁 ${st.winner==='mafia' ? 'Победила Мафия 🔪' : 'Победили Мирные жители 😇'}</div>
      <div class="card"><h2>Роли всех игроков</h2>
      <div class="player-list">${players.map(p=>`
        <div class="player-item ${!p.alive?'dead':''}">
          <span>${esc(p.nickname)}</span>
          <span class="badge ${p.role?.name==='mafia'?'mafia':'good'}">${ROLE_NAMES[p.role?.name]||'?'}</span>
        </div>`).join("")}</div>
      <div class="log">${st.log.map(l=>`<div>${esc(l)}</div>`).join("")}</div>
      <button class="btn" onclick="location.href='lobby.html'">В лобби</button></div>`;
    app.innerHTML = html;
    return;
  }

  html += `<div class="phase-banner ${st.phase}">${
    st.phase==='night' ? `🌙 Ночь ${st.dayNumber}` : st.phase==='day' ? `☀ День ${st.dayNumber} — обсуждение` : `🗳 Голосование`
  }</div>`;

  html += `<div class="card"><h2>Твоя роль</h2>
    <span class="badge ${role==='mafia'?'mafia':'good'}" style="font-size:15px;padding:8px 14px">${ROLE_NAMES[role]||'?'}</span>
    ${!myPlayer?.alive ? '<p class="muted" style="margin-top:10px">Ты выбыл(а) из игры, но можешь наблюдать.</p>' : ''}
  </div>`;

  if(role === "mafia" && myPlayer?.alive){
    const mafiaMessages = (st.mafiaChat||[]).filter(Boolean);
    html += `<div class="card"><h2>💬 Чат мафии</h2>
      <div class="chat-list">${mafiaMessages.length ? mafiaMessages.map(msg=>`<div class="chat-item"><b>${esc(msg.nickname)}</b>: ${esc(msg.text)}</div>`).join("") : '<p class="muted">Пока сообщений нет.</p>'}</div>
      <div class="chat-input-row">
        <input id="mafiaChatInput" placeholder="Сообщение для мафии" maxlength="160">
        <button class="btn small" onclick="sendMafiaMessage()">Отправить</button>
      </div>
    </div>`;
  }

  if(myPlayer?.alive && st.phase==="night"){
    if(role==="mafia"){
      const myVote = st.nightActions?.mafia?.[me.id];
      html += `<div class="card"><h2>🔪 Выбери жертву</h2>
        <div class="player-list">${aliveOthers().map(p=>`
          <div class="player-item ${p.user_id===myVote?'me':''}">
            <span>${esc(p.nickname)}</span>
            <button class="btn small" onclick="nightAction('mafia','${p.user_id}')">${myVote===p.user_id?'✓ Выбрано':'Выбрать'}</button>
          </div>`).join("")}</div></div>`;
    } else if(role==="doctor"){
      const myVote = st.nightActions?.doctor;
      html += `<div class="card"><h2>💉 Кого спасти этой ночью?</h2>
        <div class="player-list">${aliveList().map(p=>`
          <div class="player-item ${p.user_id===myVote?'me':''}">
            <span>${esc(p.nickname)}</span>
            <button class="btn small" onclick="nightAction('doctor','${p.user_id}')">${myVote===p.user_id?'✓ Выбрано':'Спасти'}</button>
          </div>`).join("")}</div></div>`;
    } else if(role==="detective"){
      const myVote = st.nightActions?.detective;
      html += `<div class="card"><h2>🕵 Кого проверить?</h2>
        <div class="player-list">${aliveOthers().map(p=>`
          <div class="player-item ${p.user_id===myVote?'me':''}">
            <span>${esc(p.nickname)}</span>
            <button class="btn small" onclick="nightAction('detective','${p.user_id}')">${myVote===p.user_id?'✓ Выбрано':'Проверить'}</button>
          </div>`).join("")}</div>
        ${(st.checks||[]).filter(c=>c.day<st.dayNumber || st.phase!=='night').length ? `<div class="log" style="margin-top:10px">
          ${(st.checks||[]).map(c=>`<div>День/ночь ${c.day}: ${esc(players.find(p=>p.user_id===c.target)?.nickname||'?')} — ${c.isMafia?'⚠ мафия':'чист(а)'}</div>`).join("")}
        </div>` : ""}
        </div>`;
    } else {
      html += `<div class="card"><p class="muted">Ночь. Ты мирный житель — просто жди рассвета.</p></div>`;
    }
  }

  if(st.phase==="day"){
    html += `<div class="card"><h2>Обсуждение</h2>
      <p class="muted">Обсудите вслух, кто может быть мафией. Когда готовы — переходите к голосованию.</p>
      <button class="btn" onclick="goToVote()">Перейти к голосованию</button>
    </div>`;
  }

  if(st.phase==="vote" && myPlayer?.alive){
    const myVote = st.votes?.[me.id];
    html += `<div class="card"><h2>🗳 Голосование за изгнание</h2>
      <div class="player-list">${aliveList().map(p=>`
        <div class="player-item ${p.user_id===myVote?'me':''}">
          <span>${esc(p.nickname)}</span>
          ${p.user_id!==me.id ? `<button class="btn small" onclick="castVote('${p.user_id}')">${myVote===p.user_id?'✓ Голос отдан':'Голосовать'}</button>` : `<span class="muted">это ты</span>`}
        </div>`).join("")}
        <div class="player-item">
          <span>Воздержаться</span>
          <button class="btn small secondary" onclick="castVote('skip')">${myVote==='skip'?'✓ Выбрано':'Выбрать'}</button>
        </div>
      </div>
      <p class="muted">Проголосовало: ${Object.keys(st.votes||{}).length}/${aliveList().length}</p>
    </div>`;
  }

  html += `<div class="card"><h2>Игроки</h2>
    <div class="player-list">${players.map(p=>`
      <div class="player-item ${!p.alive?'dead':''} ${p.user_id===me.id?'me':''}">
        <span>${esc(p.nickname)} ${p.user_id===room.host_id?'👑':''}</span>
        <span class="badge">${p.alive?'жив(а)':'выбыл(а)'}</span>
      </div>`).join("")}</div>
  </div>`;

  html += `<div class="card"><h2>Журнал событий</h2><div class="log">${st.log.map(l=>`<div>${esc(l)}</div>`).join("")}</div></div>`;

  app.innerHTML = html;
}

init();
