'use strict';

const engine = require('../shared/engine');
const { RoomManager, Room, sameName, buildPgn } = require('../server/rooms');
const { createStore } = require('../server/db');

function limpiar() {
  const s = engine.newState();
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      s.board[r][c] = ' ';
  return s;
}

let pasaron = 0;
let fallaron = 0;

function test(nombre, fn) {
  pasaron++;
  try {
    fn();
    console.log(`  ✓ ${nombre}`);
  } catch (error) {
    fallaron++;
    console.error(`  ✗ ${nombre}`);
    console.error(`      ${error.message}`);
  }
}

function eq(a, b, msg) {
  if (a !== b) throw new Error(msg || `esperado ${b}, got ${a}`);
}

// ---- motor ----
test('motor: estado inicial válido', () => {
  const s = engine.newState();
  eq(s.board[0][0], '♜');
  eq(s.board[1].every(p => p === '♟'), true);
  eq(s.board[6].every(p => p === '♙'), true);
  eq(s.board[7][0], '♖');
});

test('motor: peón avanza una casilla', () => {
  const s = limpiar();
  s.board[6][1] = '♙';
  const r = engine.validateAndApply(s, [6, 1], [5, 1], null);
  eq(r.ok, true);
  eq(r.state.board[5][1], '♙');
});

test('motor: peón avanza dos casillas', () => {
  const s = limpiar();
  s.board[6][1] = '♙';
  const r = engine.validateAndApply(s, [6, 1], [4, 1], null);
  eq(r.ok, true);
  eq(r.state.board[4][1], '♙');
});

test('motor: peón blanco captura diagonal', () => {
  const s = limpiar();
  s.board[4][1] = '♙';
  s.board[3][2] = '♟';
  const r = engine.validateAndApply(s, [4, 1], [3, 2], null);
  eq(r.ok, true);
  eq(r.state.board[3][2], '♙');
});

test('motor: alfil mueve en diagonal', () => {
  const s = limpiar();
  s.board[3][3] = '♗';
  const r = engine.validateAndApply(s, [3, 3], [5, 5], null);
  eq(r.ok, true);
  eq(r.state.board[5][5], '♗');
});

test('motor: caballo mueve en L', () => {
  const s = limpiar();
  s.board[3][3] = '♘';
  const r = engine.validateAndApply(s, [3, 3], [4, 5], null);
  eq(r.ok, true);
  eq(r.state.board[4][5], '♘');
});

test('motor: torre mueve recta', () => {
  const s = limpiar();
  s.board[3][3] = '♖';
  const r = engine.validateAndApply(s, [3, 3], [3, 6], null);
  eq(r.ok, true);
  eq(r.state.board[3][6], '♖');
});

test('motor: dama mueve diagonal y recta', () => {
  const s = limpiar();
  s.board[3][3] = '♕';
  const r1 = engine.validateAndApply(s, [3, 3], [5, 5], null);
  eq(r1.ok, true);
  const r2 = engine.validateAndApply(s, [3, 3], [3, 5], null);
  eq(r2.ok, true);
  eq(r2.state.board[3][5], '♕');
});

test('motor: enroque corto (tablero inicial)', () => {
  const s = engine.newState();
  const r = engine.validateAndApply(s, [7, 4], [7, 6], null);
  eq(r.ok, true);
  eq(r.state.board[7][6], '♔');
  eq(r.state.board[7][5], '♖');
});

test('motor: enroque largo (tablero inicial)', () => {
  const s = engine.newState();
  const r = engine.validateAndApply(s, [7, 4], [7, 2], null);
  eq(r.ok, true);
  eq(r.state.board[7][2], '♔');
  eq(r.state.board[7][3], '♖');
});

test('motor: peón coronado a dama (negra)', () => {
  const s = limpiar();
  s.board[1][4] = '♟';
  const r = engine.validateAndApply(s, [1, 4], [0, 4], 'queen');
  eq(r.ok, true);
  eq(r.state.board[0][4], '♕');
});

test('motor: no se puede mover pieza del rival', () => {
  const s = engine.newState();
  const r = engine.validateAndApply(s, [1, 1], [2, 3], null);
  eq(r.ok, false);
  eq(r.error, 'not_your_turn');
});

test('motor: jugada ilegal de torre (diagonal)', () => {
  const s = limpiar();
  s.board[3][3] = '♖';
  const r = engine.validateAndApply(s, [3, 3], [4, 4], null);
  eq(r.ok, false);
});

test('motor: jaque mate con dama y rey', () => {
  const s = limpiar();
  s.board[0][4] = '♚'; // rey negro en e8
  s.board[2][4] = '♛'; // dama blanca en e6
  s.board[7][4] = '♔'; // rey blanco en e1
  const r = engine.validateAndApply(s, [2, 4], [0, 4], null);
  eq(r.ok, true);
  eq(r.status.over, true);
  eq(r.status.reason, 'checkmate');
});

test('motor: ahogado', () => {
  const s = limpiar();
  s.board[0][0] = '♚';
  s.board[2][1] = '♜';
  s.board[7][7] = '♔';
  const r = engine.validateAndApply(s, [2, 1], [0, 0], null);
  eq(r.ok, true);
  eq(r.status.over, true);
  eq(r.status.reason, 'stalemate');
});

test('motor: jaque mate con alfil y caballo', () => {
  const s = limpiar();
  s.board[0][4] = '♚';
  s.board[2][3] = '♝';
  s.board[2][5] = '♞';
  s.board[7][7] = '♔';
  const r = engine.validateAndApply(s, [2, 5], [3, 3], null);
  eq(r.ok, true);
  eq(r.status.over, true);
  eq(r.status.reason, 'checkmate');
});

// ---- jugador y plazos ----
test('jugador: sameName ignora mayúsculas y espacios', () => {
  eq(sameName('Manuel', 'manuel'), true);
  eq(sameName('Manu El', 'manu el'), true);
  eq(sameName('Manuel', 'FERNAN'), false);
});

test('jugador: Room tiene 2 jugadores al crear', () => {
  const rm = new RoomManager();
  const room = rm.createRoom('Manuel', 'Fernan');
  eq(room.players.white.name, 'Manuel');
  eq(room.players.black.name, 'Fernan');
  eq(room.state.turn, 'white');
});

test('jugador: plazos iniciales = 2 días + 1 h', () => {
  const room = new Room('ABC123', 'Manuel', 'Fernan');
  eq(room.plazos.plazoHasta - room.plazos.creadoEn, 2 * 24 * 60 * 60 * 1000);
  eq(room.plazos.graciaHasta - room.plazos.plazoHasta, 60 * 60 * 1000);
});

test('jugador: turno pasa tras jugada', () => {
  const room = new Room('DEF456', 'Manuel', 'Fernan');
  room.aplicarJugada([6, 1], [4, 1], null);
  eq(room.turnColor(), 'black');
});

test('jugador: extensión de plazo +1 día', () => {
  const room = new Room('DEF456', 'Alvaro', 'Alejandro');
  const ahora = Date.now();
  room.reiniciarPlazo(ahora);
  const ok = room.extenderPlazo('white');
  eq(ok.ok, true);
  eq(room.plazos.prorrogas.length, 1);
  const plazo2 = room.plazoInfo(ahora);
  eq(plazo2.msPlazo, 3 * 24 * 60 * 60 * 1000);
});

test('jugador: 3 prorrogas máximas', () => {
  const room = new Room('GHI789', 'Alberto', 'Manuel');
  const ahora = Date.now();
  room.reiniciarPlazo(ahora);
  for (let i = 0; i < 3; i++) room.extenderPlazo('white');
  eq(room.plazos.prorrogas.length, 3);
  eq(room.canExtend(ahora + 3 * 24 * 60 * 60 * 1000 + 1), false);
});

test('jugador: PGN se genera', () => {
  const room = new Room('JKL012', 'Fernan', 'Alvaro');
  room.aplicarJugada([6, 1], [4, 1], null);
  room.aplicarJugada([1, 5], [3, 5], null);
  const pgn = buildPgn(room);
  eq(typeof pgn, 'string');
  eq(pgn.includes('Fernan'), true);
  eq(pgn.includes('Alvaro'), true);
  eq(pgn.includes('*'), true);
});

// ---- base de datos ----
test('db: memoria guarda jugador y partida', async () => {
  const store = createStore();
  await store.initRoster(['Manuel', 'Fernan']);
  const jugadores = await store.getPlayers();
  eq(jugadores.length, 2);
  eq(jugadores[0].nombre, 'Manuel');
  eq(jugadores[1].nombre, 'Fernan');
});

console.log(`\n${pasaron} pruebas ejecutadas, ${fallaron} fallidas.\n`);
process.exit(fallaron ? 1 : 0);