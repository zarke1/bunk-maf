const params = new URLSearchParams(location.search);
const roomId = params.get('room');
const SHIP_SIZES = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
const BOARD_SIZE = 10;
let me, profile, room, players = [];
let selectedShipIndex = 0;
let currentOrientation = 'horizontal';

async function init(){
  me = await requireAuth();
  if(!me) return;
  if(!roomId){ location.href='lobby.html'; return; }
  profile = await getProfile(me.id);
  await loadRoom();
  sb.channel('battleship-'+roomId)
    .on('postgres_changes',{event:'*',schema:'public',table:'rooms',filter:'id=eq.'+roomId}, loadRoom)
    .on('postgres_changes',{event:'*',schema:'public',table:'room_players',filter:'room_id=eq.'+roomId}, loadRoom)
    .subscribe();
}

async function loadRoom(){
  const { data: r, error } = await sb.from('rooms').select('*').eq('id', roomId).single();
  if(error || !r){ toast('Комната не найдена'); return; }
  room = r;
  await touchRoomActivity(roomId);
  const { data: p } = await sb.from('room_players').select('*').eq('room_id', roomId).order('seat');
  players = p || [];
  const existing = players.find(x=>x.user_id===me.id);
  if(!existing){
    if(room.status === 'waiting' && players.length < 2){
      await sb.from('room_players').insert({ room_id: roomId, user_id: me.id, nickname: profile.nickname, seat: players.length });
      await touchRoomActivity(roomId);
      const { data: p2 } = await sb.from('room_players').select('*').eq('room_id', roomId).order('seat');
      players = p2 || [];
    } else {
      toast('Вы не можете войти в эту комнату');
      location.href = 'lobby.html';
      return;
    }
  }
  await touchRoomActivity(roomId);
  if(!room.state || !room.state.phase){
    const state = initialState();
    await sb.from('rooms').update({ state }).eq('id', roomId);
    room.state = state;
  }
  render();
}

function initialState(){
  return {
    phase: 'placement',
    turn: 1,
    placements: {
      1: playerPlacementState(),
      2: playerPlacementState()
    },
    shots: {
      1: createBoard(),
      2: createBoard()
    },
    ready: { 1:false, 2:false },
    log: ['Игроки подключены. Расставьте корабли.']
  };
}

function playerPlacementState(){
  return {
    board: createBoard(),
    ships: SHIP_SIZES.map(size => ({ size, coords: [], placed: false }))
  };
}

function createBoard(){
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill('empty'));
}

function mergeDeep(target, source){
  if(typeof target !== 'object' || target === null) return source;
  if(typeof source !== 'object' || source === null) return source;
  const result = Array.isArray(target) ? [...target] : { ...target };
  for(const key of Object.keys(source)){
    if(source[key] instanceof Array){
      result[key] = source[key];
    } else if(typeof source[key] === 'object' && source[key] !== null){
      result[key] = mergeDeep(result[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

async function updateRoomState(patch){
  const { data: latest, error } = await sb.from('rooms').select('state').eq('id', roomId).single();
  if(error || !latest){ toast('Ошибка обновления комнаты'); return; }
  const nextState = mergeDeep(latest.state || {}, patch);
  await touchRoomActivity(roomId);
  await sb.from('rooms').update({ state: nextState }).eq('id', roomId);
  room.state = nextState;
  render();
}

function getMyPlayer(){
  return players.find(p=>p.user_id===me.id);
}

function getPlayerNumber(){
  const player = getMyPlayer();
  return player ? player.seat + 1 : 1;
}

function isHost(){
  return room.host_id === me.id;
}

function render(){
  const app = document.getElementById('app');
  if(!room){ app.innerHTML = 'Загрузка...'; return; }
  const myPlayer = getMyPlayer();
  const meNumber = getPlayerNumber();
  const state = room.state;
  if(room.status === 'waiting'){
    renderPlacement(app, meNumber, state);
    return;
  }
  if(room.status === 'playing'){
    renderBattle(app, meNumber, state);
    return;
  }
  if(room.status === 'finished'){
    renderFinished(app, meNumber, state);
    return;
  }
  app.innerHTML = '<div class="card"><p class="muted">Неизвестный статус комнаты.</p></div>';
}

function renderPlacement(app, meNumber, state){
  const placement = state.placements[meNumber];
  const placedCount = placement.ships.filter(s=>s.placed).length;
  const ready = state.ready[meNumber];
  const allReady = state.ready[1] && state.ready[2] && players.length===2;
  let html = `<div class="battleship-header">
    <div><h1>Морской бой</h1><p>Игрок ${meNumber}, расставь корабли</p></div>
  </div>`;
  html += `<div class="battleship-grid-wrapper">
    <div class="battleship-grid">${renderBoard(placement.board)}</div>
    <div class="battleship-panel">
      <h2>Корабли (${placedCount}/${SHIP_SIZES.length})</h2>
      <div class="battleship-settings">
        <button class="btn small ${currentOrientation==='horizontal'?'active':''}" onclick="toggleOrientation()">Горизонтально</button>
        <button class="btn small ${currentOrientation==='vertical'?'active':''}" onclick="toggleOrientation()">Вертикально</button>
      </div>
      <div class="ship-list">${placement.ships.map((ship,index)=>`
        <button class="btn small ${selectedShipIndex===index?'active':''} ${ship.placed?'disabled':''}" onclick="selectShip(${index})" ${ship.placed?'disabled':''}>
          ${ship.size}-палубный ${ship.placed?'✓':''}
        </button>`).join('')}</div>
      <button class="btn" onclick="markReady()" ${placedCount<SHIP_SIZES.length || ready ? 'disabled' : ''}>${ready ? 'Готово' : 'Я готов'}</button>
      <p class="muted">Нажми на поле, чтобы поставить корабль. Используй кнопки для смены ориентации.</p>
      <p class="muted">${players.length}/2 игроков подключено.</p>
      ${!isHost() ? '' : `<button class="btn" onclick="startBattle()" ${allReady ? '' : 'disabled'}>Начать игру</button>`}
      ${allReady && !isHost() ? '<p class="muted">Ждём, пока хост начнёт игру.</p>' : ''}
    </div>
  </div>`;
  html += `<div class="card"><h2>Игроки</h2><div class="player-list">${players.map((p,i)=>`
      <div class="player-item ${p.user_id===me.id?'me':''}"><span>${esc(p.nickname)} ${p.user_id===room.host_id?'👑':''}</span><span class="badge">${state.ready[i+1]?'Готов':'Не готов'}</span></div>`).join('')}</div></div>`;
  app.innerHTML = html;
}

function renderBoard(board){
  return board.map((row,y)=>`
    <div class="battleship-row">${row.map((cell,x)=>`
      <button class="battleship-cell ${cell} ${cell==='ship'?'ship-cell':''}" onclick="placeShip(${x},${y})"></button>`).join('')}</div>`).join('');
}

function selectShip(index){
  selectedShipIndex = index;
  render();
}

function toggleOrientation(){
  currentOrientation = currentOrientation==='horizontal' ? 'vertical' : 'horizontal';
  render();
}

async function placeShip(x,y){
  if(room.status !== 'waiting') return;
  const meNumber = getPlayerNumber();
  const state = room.state;
  const placement = state.placements[meNumber];
  if(!placement) return;
  const ship = placement.ships[selectedShipIndex];
  if(!ship || ship.placed) return;
  const coords = [];
  for(let i=0;i<ship.size;i++){
    const dx = currentOrientation==='horizontal' ? x+i : x;
    const dy = currentOrientation==='vertical' ? y+i : y;
    if(dx>=BOARD_SIZE || dy>=BOARD_SIZE) return;
    coords.push([dx,dy]);
  }
  for(const [dx,dy] of coords){
    if(placement.board[dy][dx] !== 'empty') return;
    for(const nx of [dx-1,dx,dx+1]){
      for(const ny of [dy-1,dy,dy+1]){
        if(nx>=0 && ny>=0 && nx<BOARD_SIZE && ny<BOARD_SIZE && placement.board[ny][nx] === 'ship') return;
      }
    }
  }
  const updatedBoard = placement.board.map(row=>[...row]);
  coords.forEach(([dx,dy])=> updatedBoard[dy][dx] = 'ship');
  const updatedShips = placement.ships.map((s,i) => i===selectedShipIndex ? { ...s, coords, placed:true } : s);
  state.placements[meNumber] = { board: updatedBoard, ships: updatedShips };
  selectedShipIndex = state.placements[meNumber].ships.findIndex(s=>!s.placed);
  if(selectedShipIndex===-1) selectedShipIndex=0;
  await updateRoomState(state);
}

async function markReady(){
  const meNumber = getPlayerNumber();
  const state = room.state;
  const placement = state.placements[meNumber];
  if(placement.ships.some(s=>!s.placed)) return;
  state.ready[meNumber] = true;
  state.log = [...(state.log||[]), `Игрок ${meNumber} готов.`];
  await updateRoomState(state);
}

async function startBattle(){
  if(!isHost()) return;
  const state = room.state;
  if(!state.ready[1] || !state.ready[2] || players.length < 2) return;
  state.phase = 'battle';
  state.turn = 1;
  state.log = [...(state.log||[]), 'Игра началась. Ходит игрок 1.'];
  await touchRoomActivity(roomId);
  await sb.from('rooms').update({ status:'playing', state }).eq('id', roomId);
  room.status = 'playing';
  room.state = state;
  render();
}

function renderBattle(app, meNumber, state){
  const myShots = state.shots[meNumber];
  const myBoard = state.placements[meNumber].board;
  const canShoot = state.turn === meNumber;
  let html = `<div class="battleship-header"><div><h1>Морской бой</h1><p>Ход игрока ${state.turn}</p></div></div>`;
  html += `<div class="battleship-grid-wrapper">
    <div class="battleship-panel">
      <h2>Поле противника</h2>
      <p>${canShoot ? 'Выберите клетку для выстрела.' : 'Ждём ход соперника.'}</p>
      <div class="battleship-grid">${renderBattleBoard(myShots, canShoot)}</div>
      <div class="log" id="battleLog">${state.log.map(line=>`<p>${esc(line)}</p>`).join('')}</div>
    </div>
    <div class="battleship-panel">
      <h2>Ваше поле</h2>
      <div class="battleship-grid">${renderBattleOverview(myBoard,true)}</div>
    </div>
  </div>`;
  app.innerHTML = html;
}

function renderBattleBoard(board, canShoot){
  return board.map((row,y)=>`
    <div class="battleship-row">${row.map((cell,x)=>{
      const disabled = cell !== 'empty' || !canShoot;
      return `<button class="battleship-cell ${cell} ${cell==='hit' ? 'hit' : ''} ${cell==='miss' ? 'miss' : ''}" ${disabled ? 'disabled' : `onclick="playerShoot(${x},${y})"`}></button>`;
    }).join('')}</div>`).join('');
}

function renderBattleOverview(board, showShips){
  return board.map((row,y)=>`
    <div class="battleship-row">${row.map((cell,x)=>{
      const visibleCell = cell === 'ship' && !showShips ? 'empty' : cell;
      return `<button class="battleship-cell ${visibleCell}"></button>`;
    }).join('')}</div>`).join('');
}

async function playerShoot(x,y){
  const state = room.state;
  const meNumber = getPlayerNumber();
  if(room.status !== 'playing' || state.phase !== 'battle' || state.turn !== meNumber) return;
  const shots = state.shots[meNumber];
  if(shots[y][x] !== 'empty') return;
  const opponentNumber = meNumber===1?2:1;
  const opponentBoard = state.placements[opponentNumber].board;
  const updatedShots = shots.map(row=>[...row]);
  const hit = opponentBoard[y][x] === 'ship';
  updatedShots[y][x] = hit ? 'hit' : 'miss';
  state.shots[meNumber] = updatedShots;
  state.log = [...(state.log||[]), `Игрок ${meNumber} ${hit ? 'попал' : 'промахнулся'} в (${x+1},${y+1}).`];
  if(!hit){ state.turn = opponentNumber; }
  await updateRoomState(state);
  await checkWinner(meNumber, state);
}

async function checkWinner(meNumber, state){
  const opponentNumber = meNumber===1?2:1;
  const sunk = state.placements[opponentNumber].ships.every(ship => ship.coords.every(([x,y]) => state.shots[meNumber][y][x] === 'hit'));
  if(sunk){
    state.phase = 'finished';
    state.log = [...(state.log||[]), `Игрок ${meNumber} победил!`];
    await sb.from('rooms').update({ status:'finished', state }).eq('id', roomId);
    room.status = 'finished';
    room.state = state;
    render();
  }
}

function renderFinished(app, meNumber, state){
  const winner = state.log[state.log.length-1]?.match(/Игрок (\d+) победил/)?.[1] || '1';
  app.innerHTML = `<div class="battleship-header"><h1>Игра окончена</h1><p>Победил игрок ${winner}</p><button class="btn" onclick="location.href='lobby.html'">В лобби</button></div>`;
}

async function updateRoomState(state){
  await touchRoomActivity(roomId);
  await sb.from('rooms').update({ state }).eq('id', roomId);
  room.state = state;
  render();
}

init();
