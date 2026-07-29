const SHIP_SIZES = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
const BOARD_SIZE = 10;
let gameState = null;
let selectedShipIndex = 0;
let currentOrientation = 'horizontal';
let placingPlayer = 1;

function initBattleship(){
  gameState = {
    phase: 'placement',
    player: 1,
    boards: {
      1: createBoard(),
      2: createBoard()
    },
    shots: {
      1: createBoard(),
      2: createBoard()
    },
    ships: {
      1: SHIP_SIZES.map(size => ({ size, coords: [], placed: false })),
      2: SHIP_SIZES.map(size => ({ size, coords: [], placed: false }))
    }
  };
  renderBattleship();
}

function createBoard(){
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill('empty'));
}

function renderBattleship(){
  const app = document.getElementById('app');
  const player = placingPlayer;
  const board = gameState.boards[player];
  const s = gameState.ships[player];
  const placedCount = s.filter(ship => ship.placed).length;
  const totalCount = s.length;

  let html = `<div class="battleship-header">
    <div><h1>Морской бой</h1><p>Игрок ${player}, расставь корабли</p></div>
    <div class="battleship-settings">
      <button class="btn small ${currentOrientation==='horizontal' ? 'active' : ''}" onclick="toggleOrientation()">Горизонтально</button>
      <button class="btn small ${currentOrientation==='vertical' ? 'active' : ''}" onclick="toggleOrientation()">Вертикально</button>
      <button class="btn small" onclick="resetBoard()">Сбросить</button>
    </div>
  </div>`;

  html += `<div class="battleship-grid-wrapper">
    <div class="battleship-grid" data-player="${player}">${renderBoard(board, player)}</div>
    <div class="battleship-panel">
      <h2>Корабли (${placedCount}/${totalCount})</h2>
      <div class="ship-list">${s.map((ship, index) => `
        <button class="btn small ${selectedShipIndex===index ? 'active' : ''} ${ship.placed ? 'disabled' : ''}" onclick="selectShip(${index})" ${ship.placed ? 'disabled' : ''}>
          ${ship.size}-палубный ${ship.placed ? '✓' : ''}
        </button>
      `).join('')}</div>
      <button class="btn" onclick="completePlacement()" ${placedCount<totalCount ? 'disabled' : ''}>Готово</button>
      <p class="muted">Нажми на поле, чтобы поставить корабль. Используй кнопки для смены ориентации.</p>
    </div>
  </div>`;

  app.innerHTML = html;
}

function renderBoard(board, player){
  return board.map((row, y) => `
    <div class="battleship-row">${row.map((cell, x) => `
      <button class="battleship-cell ${cell} ${cell==='ship' ? 'ship-cell' : ''}" onclick="placeShip(${x}, ${y})"></button>`).join('')}</div>`).join('');
}

function selectShip(index){
  selectedShipIndex = index;
  renderBattleship();
}

function toggleOrientation(){
  currentOrientation = currentOrientation === 'horizontal' ? 'vertical' : 'horizontal';
  renderBattleship();
}

function resetBoard(){
  const player = placingPlayer;
  gameState.boards[player] = createBoard();
  gameState.ships[player] = SHIP_SIZES.map(size => ({ size, coords: [], placed: false }));
  selectedShipIndex = 0;
  renderBattleship();
}

function placeShip(x, y){
  const player = placingPlayer;
  const ship = gameState.ships[player][selectedShipIndex];
  if(!ship || ship.placed) return;
  const coords = [];
  for(let i=0;i<ship.size;i++){
    const dx = currentOrientation==='horizontal' ? x+i : x;
    const dy = currentOrientation==='vertical' ? y+i : y;
    if(dx>=BOARD_SIZE || dy>=BOARD_SIZE) return;
    coords.push([dx, dy]);
  }
  const board = gameState.boards[player];
  for(const [dx, dy] of coords){
    if(board[dy][dx] !== 'empty') return;
    for(const nx of [dx-1, dx, dx+1]){
      for(const ny of [dy-1, dy, dy+1]){
        if(nx>=0 && ny>=0 && nx<BOARD_SIZE && ny<BOARD_SIZE && board[ny][nx] === 'ship') return;
      }
    }
  }
  for(const [dx, dy] of coords){ board[dy][dx] = 'ship'; }
  ship.coords = coords;
  ship.placed = true;
  selectedShipIndex = gameState.ships[player].findIndex(s => !s.placed);
  if(selectedShipIndex === -1) selectedShipIndex = 0;
  renderBattleship();
}

function completePlacement(){
  if(gameState.ships[placingPlayer].some(ship => !ship.placed)) return;
  if(placingPlayer === 1){
    placingPlayer = 2;
    selectedShipIndex = 0;
    currentOrientation = 'horizontal';
    renderBattleship();
    return;
  }
  gameState.phase = 'battle';
  gameState.player = 1;
  renderBattle();
}

function renderBattle(){
  const player = gameState.player;
  const opponent = player===1?2:1;
  const opponentBoard = gameState.shots[opponent];
  const status = gameState.ships[player].map(ship => ship.coords.every(([x,y]) => gameState.shots[opponent][y][x] === 'hit')).filter(Boolean).length;

  let html = `<div class="battleship-header"><div><h1>Морской бой</h1><p>Ход игрока ${player}</p></div></div>`;
  html += `<div class="battleship-grid-wrapper">
    <div class="battleship-grid" data-player="${opponent}">${renderBattleBoard(opponentBoard)}</div>
    <div class="battleship-panel">
      <h2>Цель</h2>
      <p>Попробуй поразить все корабли соперника.</p>
      <button class="btn" onclick="switchTurn()">Передать ход</button>
      <div class="log" id="battleLog"></div>
    </div>
  </div>`;

  document.getElementById('app').innerHTML = html;
}

function renderBattleBoard(board){
  return board.map((row, y) => `
    <div class="battleship-row">${row.map((cell, x) => `
      <button class="battleship-cell ${cell} ${cell==='hit' ? 'hit' : ''} ${cell==='miss' ? 'miss' : ''}" onclick="shoot(${x}, ${y})"></button>`).join('')}</div>`).join('');
}

function shoot(x, y){
  if(gameState.phase !== 'battle') return;
  const player = gameState.player;
  const opponent = player===1?2:1;
  const opponentShips = gameState.boards[opponent];
  const shots = gameState.shots[opponent];
  if(shots[y][x] !== 'empty') return;
  if(opponentShips[y][x] === 'ship'){
    shots[y][x] = 'hit';
    setBattleLog(`Игрок ${player} попал!`);
  } else {
    shots[y][x] = 'miss';
    setBattleLog(`Игрок ${player} промахнулся.`);
    gameState.player = opponent;
  }
  renderBattle();
  checkWinner();
}

function setBattleLog(message){
  const log = document.getElementById('battleLog');
  if(log) log.innerHTML = `<p>${message}</p>`;
}

function switchTurn(){
  if(gameState.phase !== 'battle') return;
  gameState.player = gameState.player===1?2:1;
  renderBattle();
}

function checkWinner(){
  const opponent = gameState.player===1 ? 2 : 1;
  const ships = gameState.ships[opponent];
  const shots = gameState.shots[opponent];
  const allSunk = ships.every(ship => ship.coords.every(([x,y]) => shots[y][x] === 'hit'));
  if(allSunk){
    gameState.phase = 'finished';
    document.getElementById('app').innerHTML = `<div class="battleship-header"><h1>Победа!</h1><p>Игрок ${gameState.player} победил.</p><button class="btn" onclick="initBattleship()">Новая игра</button></div>`;
  }
}

window.onload = initBattleship;
