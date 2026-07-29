const params = new URLSearchParams(location.search);
const roomId = params.get("room");
let me, profile, room, players = [];

const PROFESSIONS = ["Врач-хирург","Инженер-электрик","Учитель истории","Программист","Повар","Военный","Полицейский","Фермер","Психолог","Строитель","Юрист","Электромонтёр","Биолог","Механик","Пожарный","Артист цирка","Пилот","Сантехник","Ветеринар","Журналист"];
const HEALTH = ["Полностью здоров(а)","Астма","Аллергия на пыльцу","Диабет 2 типа","Плохое зрение","Хроническая бессонница","Клаустрофобия","Порок сердца (лёгкий)","Частые мигрени","Недавно переболел(а), сейчас в порядке","Проблемы со спиной","Здоров(а) как бык"];
const HOBBIES = ["Игра на гитаре","Рисование","Шахматы","Охота и рыбалка","Кулинария","Программирование","Йога","Садоводство","Ремонт техники","Чтение","Резьба по дереву","Пение","Боевые искусства","Astronomy / астрономия"];
const PHOBIAS = ["Боязнь замкнутых пространств","Боязнь высоты","Боязнь темноты","Боязнь насекомых","Боязнь крови","Фобий нет","Боязнь громких звуков","Боязнь воды","Боязнь людей (социофобия)"];
const BAGGAGE = ["Аптечка первой помощи","Набор инструментов","Мешок семян","Портативная рация","Книги по выживанию","Гитара","Ноутбук с картами местности","Швейный набор","Охотничий нож","Запас батареек","Генератор на ручной тяге","Фильтр для воды"];
const FACTS = ["Бывший заключённый","Тайно недолюбливает одного из присутствующих","Влюблён(а) в другого участника","Уже был(а) в похожей ситуации 10 лет назад","Знает секрет одного из участников","Не спал(а) нормально 3 года","Имеет двойное гражданство","Дальний родственник известного политика","Раньше служил(а) в армии","Работал(а) под прикрытием"];
const CATASTROPHES = ["Ядерная война","Падение крупного метеорита","Глобальная пандемия","Извержение супервулкана","Восстание ИИ","Нашествие мутантов","Экологический коллапс","Вторжение инопланетян","Глобальное затопление"];

async function init(){
  me = await requireAuth();
  if(!me) return;
  if(!roomId){ location.href="lobby.html"; return; }
  profile = await getProfile(me.id);
  await loadRoom();
  sb.channel("bunker-"+roomId)
    .on("postgres_changes",{event:"*",schema:"public",table:"rooms",filter:"id=eq."+roomId}, loadRoom)
    .on("postgres_changes",{event:"*",schema:"public",table:"room_players",filter:"room_id=eq."+roomId}, loadRoom)
    .subscribe();
  setInterval(()=>{ if(room && room.host_id===me.id) maybeResolveVote(); }, 3000);
}

async function loadRoom(){
  const { data:r, error } = await sb.from("rooms").select("*").eq("id", roomId).single();
  if(error || !r){ toast("Комната не найдена"); return; }
  room = r;
  const { data:p } = await sb.from("room_players").select("*").eq("room_id", roomId).order("seat");
  players = p || [];
  await touchRoomActivity(roomId);
  render();
}

async function startGame(){
  if(room.host_id !== me.id){ toast("Только хост может начать игру"); return; }
  if(players.length < 4){ toast("Нужно минимум 4 игрока"); return; }
  const catastrophe = randPick(CATASTROPHES);
  const capacity = Math.max(2, Math.ceil(players.length/2));
  const order = shuffle(players.map(p=>p.user_id));
  const state = {
    phase:"reveal", round:1, turnIndex:0, order, capacity,
    revealUsage:{}, votes:{}, log:[`☢ Катастрофа: ${catastrophe}. Бункер выдержит ${capacity} из ${players.length} человек.`]
  };
  for(const p of players){
    const cards = {
      profession: randPick(PROFESSIONS), health: randPick(HEALTH), hobby: randPick(HOBBIES),
      phobia: randPick(PHOBIAS), baggage: randPick(BAGGAGE), fact: randPick(FACTS),
      age: 18 + Math.floor(Math.random()*50), gender: Math.random()<0.5 ? "Мужчина" : "Женщина"
    };
    await sb.from("room_players").update({ cards, revealed:{}, alive:true }).eq("room_id", roomId).eq("user_id", p.user_id);
  }
  await touchRoomActivity(roomId);
  await sb.from("rooms").update({
    status:"playing", state, settings:{ ...room.settings, catastrophe, capacity }
  }).eq("id", roomId);
}

function aliveOrdered(){
  return room.state.order.map(id=>players.find(p=>p.user_id===id)).filter(p=>p && p.alive);
}

function isMyTurn(){
  const ord = aliveOrdered();
  return ord.length>0 && ord[room.state.turnIndex % ord.length]?.user_id === me.id;
}

async function revealCard(type){
  const st = { ...room.state };
  if(st.phase !== "reveal"){ toast("Раскрывать карточки можно только в фазе раскрытия"); return; }
  if(st.revealUsage?.[me.id]){ toast("В этом раунде ты уже открыл(а) одну карточку"); return; }
  const p = players.find(x=>x.user_id===me.id);
  const revealed = { ...(p.revealed||{}), [type]: true };
  await sb.from("room_players").update({ revealed }).eq("room_id", roomId).eq("user_id", me.id);
  await touchRoomActivity(roomId);
  await sb.from("rooms").update({ state:{ ...st, revealUsage:{ ...(st.revealUsage||{}), [me.id]: true } } }).eq("id", roomId);
}

const VOTE_TIME_MS = 2*60*1000;

async function passTurn(){
  if(!isMyTurn()) return;
  const st = { ...room.state };
  const ord = aliveOrdered();
  st.turnIndex = (st.turnIndex + 1);
  if(st.turnIndex >= ord.length){
    st.phase = "vote"; st.votes = {}; st.voteDeadline = Date.now() + VOTE_TIME_MS;
  }
  await touchRoomActivity(roomId);
  await sb.from("rooms").update({ state: st }).eq("id", roomId);
}

async function castVote(targetId){
  const st = { ...room.state };
  st.votes = { ...st.votes, [me.id]: targetId };
  await touchRoomActivity(roomId);
  await sb.from("rooms").update({ state: st }).eq("id", roomId);
  if(room.host_id === me.id) setTimeout(maybeResolveVote, 400);
}

async function maybeResolveVote(){
  const { data:r } = await sb.from("rooms").select("*").eq("id", roomId).single();
  if(!r || r.status !== "playing") return;
  const st = r.state;
  if(st.phase !== "vote") return;

  const { data:p } = await sb.from("room_players").select("*").eq("room_id", roomId);
  const allPlayers = p || [];
  const alive = allPlayers.filter(x=>x.alive);
  const votesCount = Object.keys(st.votes||{}).length;
  const timeUp = st.voteDeadline && Date.now() >= st.voteDeadline;

  if(votesCount < alive.length && !timeUp) return; // ждём остальных или таймер

  if(votesCount === 0){
    await sb.from("rooms").update({ state:{
      ...st, phase:"reveal", round:st.round+1, turnIndex:0, votes:{}, voteDeadline:null, revealUsage:{},
      log:[...st.log, `⌛ Время голосования (раунд ${st.round}) истекло — никто не проголосовал, никто не изгнан.`]
    }}).eq("id", roomId);
    return;
  }

  const tally = {};
  for(const v of Object.values(st.votes)) tally[v] = (tally[v]||0)+1;
  let max=-1, out=null;
  for(const [id,c] of Object.entries(tally)){ if(c>max){ max=c; out=id; } }

  await sb.from("room_players").update({ alive:false }).eq("room_id", roomId).eq("user_id", out);
  const outNick = allPlayers.find(x=>x.user_id===out)?.nickname || "?";
  const remaining = alive.length - 1;
  const missed = alive.length - votesCount;
  const missedNote = timeUp && missed>0 ? ` · не успели проголосовать: ${missed}` : "";
  const newLog = [...st.log, `🚪 Изгнан(а) из бункера: ${outNick} (раунд ${st.round})${missedNote}`];

  if(remaining <= st.capacity){
    const survivors = alive.filter(x=>x.user_id!==out);
    await sb.from("rooms").update({ status:"finished", state:{ ...st, phase:"end", log:newLog, survivors: survivors.map(s=>s.user_id), voteDeadline:null } }).eq("id", roomId);
    for(const pl of allPlayers){
      const { data:s } = await sb.from("stats").select("*").eq("user_id", pl.user_id).single();
      const won = survivors.some(x=>x.user_id===pl.user_id);
      await sb.from("stats").update({
        bunker_played:(s?.bunker_played||0)+1, bunker_won:(s?.bunker_won||0)+(won?1:0)
      }).eq("user_id", pl.user_id);
    }
  } else {
    await sb.from("rooms").update({ state:{ ...st, phase:"reveal", round:st.round+1, turnIndex:0, votes:{}, voteDeadline:null, revealUsage:{}, log:newLog } }).eq("id", roomId);
  }
}

const CARD_LABELS = { profession:"Профессия", health:"Здоровье", hobby:"Хобби", phobia:"Фобия", baggage:"Багаж", fact:"Особый факт", age:"Возраст/Пол" };

let voteTimerInterval = null;
function stopVoteTimerDisplay(){
  if(voteTimerInterval){ clearInterval(voteTimerInterval); voteTimerInterval = null; }
}
function startVoteTimerDisplay(deadline){
  stopVoteTimerDisplay();
  function tick(){
    const el = document.getElementById("voteTimer");
    if(!el){ stopVoteTimerDisplay(); return; }
    const left = Math.max(0, deadline - Date.now());
    const m = Math.floor(left/60000);
    const s = Math.floor((left%60000)/1000);
    el.textContent = `⏱ ${m}:${s.toString().padStart(2,'0')}`;
  }
  tick();
  voteTimerInterval = setInterval(tick, 1000);
}

function render(){
  const app = document.getElementById("app");
  stopVoteTimerDisplay();
  if(!room){ app.innerHTML = "Загрузка..."; return; }

  let html = `<div class="header">
    <div class="brand">🏕 <span>Бункер</span></div>
    <div style="display:flex;gap:8px;align-items:center">
      <span class="pill">Код: <b>${esc(room.code)}</b></span>
      <button class="btn small secondary" onclick="location.href='lobby.html'">В лобби</button>
    </div>
  </div>`;

  if(room.status === "waiting"){
    html += `<div class="card"><h2>Ожидание игроков (${players.length}/15)</h2>
      <div class="code-box">${esc(room.code)}</div>
      <p class="muted">Скинь этот код друзьям — пусть введут его в лобби.</p>
      <div class="player-list">${players.map(p=>`
        <div class="player-item ${p.user_id===me.id?'me':''}">
          <span>${esc(p.nickname)} ${p.user_id===room.host_id?'👑':''}</span>
        </div>`).join("")}</div>`;
    if(room.host_id === me.id){
      html += players.length>=4
        ? `<button class="btn" onclick="startGame()">Начать игру</button>`
        : `<p class="muted">Нужно минимум 4 игрока.</p>`;
    } else {
      html += `<p class="muted">Ждём, пока хост начнёт игру...</p>`;
    }
    html += `</div>`;
    app.innerHTML = html;
    return;
  }

  const st = room.state;
  const myPlayer = players.find(p=>p.user_id===me.id);

  if(st.phase === "end"){
    const survivors = players.filter(p=>st.survivors?.includes(p.user_id));
    const won = st.survivors?.includes(me.id);
    html += `<div class="phase-banner end">🏁 Игра окончена — ${won ? "ты выжил(а)! 🎉" : "ты не попал(а) в бункер"}</div>
      <div class="card"><h2>Выжившие (${survivors.length})</h2>
      <div class="player-list">${survivors.map(p=>`<div class="player-item">${esc(p.nickname)}</div>`).join("")}</div>
      <div class="log">${st.log.map(l=>`<div>${esc(l)}</div>`).join("")}</div>
      <button class="btn" onclick="location.href='lobby.html'">В лобби</button></div>`;
    app.innerHTML = html;
    return;
  }

  html += `<div class="phase-banner">Раунд ${st.round} · Вместимость бункера: ${st.capacity} из ${players.length}</div>`;

  html += `<div class="card"><h2>Твои карточки</h2>`;
  const revealAllowed = st.phase === "reveal" && !st.revealUsage?.[me.id];
  for(const key of Object.keys(CARD_LABELS)){
    const revealed = myPlayer?.revealed?.[key];
    const val = myPlayer?.cards?.[key];
    html += `<div class="card-tile">
      <div><div class="label">${CARD_LABELS[key]}</div>
      <div class="value">${revealed ? esc(String(val)) : "🔒 скрыто"}</div></div>
      ${!revealed ? (revealAllowed ? `<button class="btn small" onclick="revealCard('${key}')">Раскрыть</button>` : `<span class="muted">В этом раунде уже раскрыта одна карточка</span>`) : ""}
    </div>`;
  }
  html += `</div>`;

  if(st.phase === "reveal"){
    const ord = aliveOrdered();
    const current = ord[st.turnIndex % ord.length];
    html += `<div class="card"><h2>Ход раскрытия карт</h2>
      <p>Сейчас говорит: <b>${esc(current?.nickname || "?")}</b></p>`;
    if(isMyTurn()){
      html += `<button class="btn" onclick="passTurn()">Я закончил(а) — передать ход</button>`;
    } else {
      html += `<p class="muted">Дождись своей очереди.</p>`;
    }
    html += `</div>`;
  }

  if(st.phase === "vote"){
    const alive = players.filter(p=>p.alive);
    const myVote = st.votes?.[me.id];
    html += `<div class="card"><h2>🗳 Голосование за изгнание <span id="voteTimer" class="pill"></span></h2>
      <p class="muted">Выберите, кого исключить из бункера в этом раунде. Не успеешь проголосовать за 2 минуты — твой голос просто не учтётся.</p>
      <div class="player-list">${alive.map(p=>`
        <div class="player-item ${p.user_id===myVote?'me':''}">
          <span>${esc(p.nickname)}</span>
          ${p.user_id!==me.id ? `<button class="btn small" onclick="castVote('${p.user_id}')">${myVote===p.user_id?'✓ Голос отдан':'Голосовать'}</button>` : `<span class="muted">это ты</span>`}
        </div>`).join("")}</div>
      <p class="muted">Проголосовало: ${Object.keys(st.votes||{}).length}/${alive.length}</p>
    </div>`;
  }

  html += `<div class="card"><h2>Все игроки</h2>
    <div class="player-list">${players.map(p=>`
      <div class="player-item ${!p.alive?'dead':''} ${p.user_id===me.id?'me':''}">
        <span>${esc(p.nickname)} ${p.user_id===room.host_id?'👑':''}</span>
        <span class="badge">${p.alive?'в игре':'изгнан'}</span>
      </div>`).join("")}</div>
  </div>`;

  html += `<div class="card"><h2>Журнал событий</h2><div class="log">${st.log.map(l=>`<div>${esc(l)}</div>`).join("")}</div></div>`;

  app.innerHTML = html;
  if(st.phase === "vote" && st.voteDeadline) startVoteTimerDisplay(st.voteDeadline);
}

init();
