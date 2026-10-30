'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../shared/engine');
const { Room, RoomManager, sameName, buildPgn } = require('../server/rooms');
const { createMemoryStore } = require('../server/db');
const { parseLine } = require('../server/env');
const { computeClassification } = require('../server/classification');

function emptyBoard() {
  const state = engine.newState();
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) state.board[r][c] = ' ';
  }
  return state;
}

// ---- motor ----

test('motor: estado inicial válido', () => {
  const s = engine.newState();
  assert.equal(s.board[0][0], '♜');
  assert.equal(s.board[1].every(p => p === '♟'), true);
  assert.equal(s.board[6].every(p => p === '♙'), true);
  assert.equal(s.board[7][0], '♖');
  assert.equal(s.turn, 'white');
});

test('motor: peón avanza una casilla', () => {
  const s = emptyBoard();
  s.board[6][1] = '♙';
  const r = engine.validateAndApply(s, [6, 1], [5, 1], null);
  assert.equal(r.ok, true);
  assert.equal(r.state.board[5][1], '♙');
});

test('motor: peón avanza dos casillas', () => {
  const s = emptyBoard();
  s.board[6][1] = '♙';
  const r = engine.validateAndApply(s, [6, 1], [4, 1], null);
  assert.equal(r.ok, true);
  assert.equal(r.state.board[4][1], '♙');
  assert.deepEqual(r.state.epTarget, { row: 5, col: 1, pawnRow: 4, pawnCol: 1 });
});

test('motor: al paso', () => {
  const s = emptyBoard();
  s.board[3][4] = '♙';   // peón blanco en e5
  s.board[3][3] = '♟';   // peón negro en d5 (recién movido)
  s.epTarget = { row: 2, col: 3, pawnRow: 3, pawnCol: 3 };
  const r = engine.validateAndApply(s, [3, 4], [2, 3], null);
  assert.equal(r.ok, true);
  assert.equal(r.state.board[2][3], '♙');
  assert.equal(r.state.board[3][3], ' ');
});

test('motor: peón blanco captura diagonal', () => {
  const s = emptyBoard();
  s.board[4][1] = '♙';
  s.board[3][2] = '♟';
  const r = engine.validateAndApply(s, [4, 1], [3, 2], null);
  assert.equal(r.ok, true);
  assert.equal(r.state.board[3][2], '♙');
});

test('motor: alfil mueve en diagonal', () => {
  const s = emptyBoard();
  s.board[3][3] = '♗';
  const r = engine.validateAndApply(s, [3, 3], [5, 5], null);
  assert.equal(r.ok, true);
});

test('motor: caballo mueve en L', () => {
  const s = emptyBoard();
  s.board[3][3] = '♘';
  const r = engine.validateAndApply(s, [3, 3], [4, 5], null);
  assert.equal(r.ok, true);
});

test('motor: torre mueve recta', () => {
  const s = emptyBoard();
  s.board[3][3] = '♖';
  const r = engine.validateAndApply(s, [3, 3], [3, 6], null);
  assert.equal(r.ok, true);
});

test('motor: dama mueve en diagonal y en recta', () => {
  const s = emptyBoard();
  s.board[3][3] = '♕';
  assert.equal(engine.validateAndApply(s, [3, 3], [5, 5], null).ok, true);
  assert.equal(engine.validateAndApply(s, [3, 3], [3, 5], null).ok, true);
});

test('motor: enroque corto', () => {
  const s = emptyBoard();
  s.board[7][4] = '♔';
  s.board[7][7] = '♖';
  s.board[0][4] = '♚';
  const r = engine.validateAndApply(s, [7, 4], [7, 6], null);
  assert.equal(r.ok, true);
  assert.equal(r.state.board[7][6], '♔');
  assert.equal(r.state.board[7][5], '♖');
});

test('motor: enroque largo', () => {
  const s = emptyBoard();
  s.board[7][4] = '♔';
  s.board[7][0] = '♖';
  s.board[0][4] = '♚';
  const r = engine.validateAndApply(s, [7, 4], [7, 2], null);
  assert.equal(r.ok, true);
  assert.equal(r.state.board[7][2], '♔');
  assert.equal(r.state.board[7][3], '♖');
});

test('motor: no se enroca con piezas en medio', () => {
  const s = engine.newState();
  const r = engine.validateAndApply(s, [7, 4], [7, 6], null);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'illegal_move');
});

test('motor: peón negro corona a dama', () => {
  const s = emptyBoard();
  s.board[6][4] = '♟';
  s.turn = 'black';
  const r = engine.validateAndApply(s, [6, 4], [7, 4], 'queen');
  assert.equal(r.ok, true);
  assert.equal(r.state.board[7][4], '♛');
});

test('motor: no se puede mover pieza del rival', () => {
  const s = engine.newState();
  const r = engine.validateAndApply(s, [1, 1], [2, 3], null);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not_your_turn');
});

test('motor: jugada ilegal de torre (diagonal)', () => {
  const s = emptyBoard();
  s.board[3][3] = '♖';
  const r = engine.validateAndApply(s, [3, 3], [4, 4], null);
  assert.equal(r.ok, false);
});

test('motor: jaque mate a la espalda', () => {
  const s = emptyBoard();
  s.board[0][6] = '♚';   // rey negro g8
  s.board[1][5] = '♟';   // peones f7 g7 h7
  s.board[1][6] = '♟';
  s.board[1][7] = '♟';
  s.board[0][0] = '♖';   // torre blanca a8
  s.board[7][4] = '♔';   // rey blanco e1
  const r = engine.validateAndApply(s, [0, 0], [0, 4], null);
  assert.equal(r.ok, true);
  assert.equal(r.status.over, true);
  assert.equal(r.status.reason, 'checkmate');
  assert.equal(r.status.winner, 'white');
});

test('motor: ahogado', () => {
  const s = emptyBoard();
  s.board[0][0] = '♚';   // rey negro a8
  s.board[2][2] = '♔';   // rey blanco c6
  s.board[3][1] = '♕';   // dama blanca b5 -> b6
  const r = engine.validateAndApply(s, [3, 1], [2, 1], null);
  assert.equal(r.ok, true);
  assert.equal(r.status.over, true);
  assert.equal(r.status.reason, 'stalemate');
  assert.equal(r.status.winner, null);
});

test('motor: estado inválido se rechaza', () => {
  assert.equal(engine.validateAndApply({}, [0, 0], [1, 1], null).ok, false);
  assert.equal(engine.validateAndApply(engine.newState(), [0, 0], [0, 0], null).ok, false);
});

// ---- jugadores y plazos ----

test('jugador: sameName ignora mayúsculas y espacios', () => {
  assert.equal(sameName('Manuel', 'manuel'), true);
  assert.equal(sameName('Manu El', 'manu el'), true);
  assert.equal(sameName('Manuel', 'FERNAN'), false);
});

test('jugador: la sala arranca con dos jugadores y blancas al turno', () => {
  const room = new Room('ABC234', 'Manuel', 'Fernan');
  assert.equal(room.players.white.name, 'Manuel');
  assert.equal(room.players.black.name, 'Fernan');
  assert.equal(room.turnColor(), 'white');
});

test('jugador: plazos iniciales = 2 días + 1 h', () => {
  const room = new Room('ABC234', 'Manuel', 'Fernan');
  assert.equal(room.plazos.plazoHasta - room.plazos.creadoEn, 2 * 24 * 60 * 60 * 1000);
  assert.equal(room.plazos.graciaHasta - room.plazos.plazoHasta, 60 * 60 * 1000);
});

test('jugador: el turno pasa tras una jugada', () => {
  const room = new Room('ABC234', 'Manuel', 'Fernan');
  assert.equal(room.aplicarJugada([6, 1], [4, 1], null).ok, true);
  assert.equal(room.turnColor(), 'black');
});

test('jugador: la prórroga suma un día', () => {
  const room = new Room('ABC234', 'Alvaro', 'Alejandro');
  const ahora = Date.now();
  room.reiniciarPlazo(ahora);
  assert.equal(room.extenderPlazo('white', ahora).ok, true);
  assert.equal(room.plazos.prorrogas.length, 1);
  assert.equal(room.plazoInfo(ahora).msPlazo, 3 * 24 * 60 * 60 * 1000);
});

test('jugador: máximo 3 prórrogas y solo antes de caducar', () => {
  const room = new Room('ABC234', 'Alberto', 'Manuel');
  const ahora = Date.now();
  room.reiniciarPlazo(ahora);
  for (let i = 0; i < 3; i++) assert.equal(room.extenderPlazo('white', ahora).ok, true);
  assert.equal(room.plazos.prorrogas.length, 3);
  assert.equal(room.canExtend(ahora), false);
});

test('jugador: perder por tiempo marca ganador al rival', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('Manuel', 'Fernan');
  room.plazos.graciaHasta = Date.now() - 1;
  const perdidas = manager.checkDeadlines(Date.now());
  assert.equal(perdidas.length, 1);
  assert.equal(room.status.reason, 'time');
  assert.equal(room.status.winner, 'black');
});

test('jugador: PGN se genera con cabeceras y resultado', () => {
  const room = new Room('ABC234', 'Fernan', 'Alvaro');
  room.aplicarJugada([6, 1], [4, 1], null);
  room.aplicarJugada([1, 5], [3, 5], null);
  const pgn = buildPgn(room);
  assert.match(pgn, /\[White "Fernan"\]/);
  assert.match(pgn, /\[Black "Alvaro"\]/);
  assert.match(pgn, /\*/);
});

// ---- persistencia ----

test('persistencia: el snapshot restaura tablero, historial y tokens', () => {
  const room = new Room('ABC234', 'Manuel', 'Fernan');
  room.players.white.token = 'token-white';
  room.players.black.token = 'token-black';
  room.players.white.connected = true;
  room.aplicarJugada([6, 1], [4, 1], null);

  const restored = Room.fromSnapshot('ABC234', JSON.parse(JSON.stringify(room.snapshot())));
  assert.ok(restored);
  assert.equal(restored.turnColor(), 'black');
  assert.equal(restored.history.length, 1);
  assert.equal(restored.state.board[4][1], '♙');
  assert.equal(restored.players.white.token, 'token-white');
  assert.equal(restored.players.black.token, 'token-black');
  assert.equal(restored.players.white.connected, false);
  assert.equal(restored.plazos.prorrogas.length, 0);
});

test('persistencia: un snapshot inválido no restaura nada', () => {
  assert.equal(Room.fromSnapshot('ABC234', null), null);
  assert.equal(Room.fromSnapshot('ABC234', { state: {} }), null);
  assert.equal(Room.fromSnapshot('ABC234', 'no-json'), null);
});

test('persistencia: hydrateAll ignora partidas sin snapshot', () => {
  const source = new RoomManager();
  const room = source.createRoom('Manuel', 'Fernan');
  const records = [
    { roomCode: room.code, snapshot: room.snapshot() },
    { roomCode: 'ZZZZZZ', snapshot: null }
  ];

  const manager = new RoomManager();
  const restored = manager.hydrateAll(records);
  assert.equal(restored.length, 1);
  assert.equal(manager.getRoom(room.code), restored[0]);
  assert.equal(manager.getRoom('ZZZZZZ'), null);
});

test('db: memoria guarda y devuelve partidas sin romper fechas', async () => {
  const store = createMemoryStore();
  const ahora = Date.now();
  await store.savePartida({
    roomCode: 'ABC234',
    blancas: 'Manuel',
    negras: 'Fernan',
    turno: 'white',
    estado: 'abierta',
    creadoEn: ahora,
    movidaEn: ahora,
    plazoHasta: new Date(ahora + 1000).toISOString(),
    graciaHasta: new Date(ahora + 2000).toISOString(),
    prorrogas: []
  });

  const abiertas = await store.getPartidasAbiertas();
  assert.equal(abiertas.length, 1);
  assert.match(abiertas[0].creadoEn, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(abiertas[0].plazoHasta, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(abiertas[0].roomCode, 'ABC234');
});

test('db: memoria registra jugadores sin duplicados', async () => {
  const store = createMemoryStore();
  await store.initRoster(['Manuel', 'Fernan']);
  await store.initRoster(['Manuel', 'Alberto']);
  const jugadores = await store.getPlayers();
  assert.deepEqual(jugadores.map(j => j.nombre).sort(), ['Alberto', 'Fernan', 'Manuel']);
});

// ---- clasificación y revancha ----

test('clasificación: puntos, partidas y desempates', () => {
  const filas = computeClassification([
    { blancas: 'Manuel', negras: 'Fernan', resultado: 'blancas' },
    { blancas: 'Fernan', negras: 'Manuel', resultado: 'tablas' },
    { blancas: 'Alberto', negras: 'Manuel', resultado: 'negras' }
  ]);

  assert.deepEqual(filas.map(f => f.nombre), ['Manuel', 'Fernan', 'Alberto']);

  const manuel = filas[0];
  assert.equal(manuel.partidas, 3);
  assert.equal(manuel.puntos, 2.5);
  assert.equal(manuel.victorias, 2);
  assert.equal(manuel.empates, 1);
  assert.equal(manuel.derrotas, 0);

  assert.equal(filas[1].puntos, 0.5);
  assert.equal(filas[2].puntos, 0);
});

test('clasificación: sin resultados devuelve una lista vacía', () => {
  assert.deepEqual(computeClassification([]), []);
  assert.deepEqual(computeClassification(null), []);
});

test('revancha: exige partida terminada y ambos votos', () => {
  const room = new Room('ABC234', 'Manuel', 'Fernan');
  assert.deepEqual(room.voteRematch('white'), { ok: false, error: 'not_finished' });

  room.rendir('white');
  assert.equal(room.voteRematch('white').started, false);
  assert.equal(room.players.white.name, 'Manuel');
});

test('revancha: cambia colores, conserva tokens y reinicia el estado', () => {
  const room = new Room('ABC234', 'Manuel', 'Fernan');
  room.players.white.token = 'token-white';
  room.players.black.token = 'token-black';
  room.aplicarJugada([6, 1], [4, 1], null);
  room.rendir('black');

  assert.equal(room.voteRematch('white').started, false);
  const result = room.voteRematch('black');
  assert.equal(result.ok, true);
  assert.equal(result.started, true);

  assert.equal(room.players.white.name, 'Fernan');
  assert.equal(room.players.black.name, 'Manuel');
  assert.equal(room.players.white.token, 'token-black');
  assert.equal(room.players.black.token, 'token-white');
  assert.equal(room.players.white.color, 'white');
  assert.equal(room.players.black.color, 'black');
  assert.equal(room.history.length, 0);
  assert.equal(room.status.over, false);
  assert.equal(room.turnColor(), 'white');
  assert.equal(room.plazos.prorrogas.length, 0);
  assert.equal(room.resultadoGuardado, false);
});

// ---- configuración ----

test('env: parseLine entiende comentarios, comillas y líneas inválidas', () => {
  assert.equal(parseLine('# comentario'), null);
  assert.equal(parseLine(''), null);
  assert.equal(parseLine('export MALO=1'), null);
  assert.deepEqual(parseLine('PORT=4567'), { key: 'PORT', value: '4567' });
  assert.deepEqual(parseLine('FOO="bar baz"'), { key: 'FOO', value: 'bar baz' });
  assert.deepEqual(parseLine("CLAVE='secreto'"), { key: 'CLAVE', value: 'secreto' });
});

// ---- tablas por acuerdo ----

test('tablas: oferta, rechazo y aceptación', () => {
  const room = new Room('ABC234', 'Manuel', 'Fernan');

  assert.equal(room.ofrecerTablas('white').ok, true);
  assert.equal(room.drawOffer, 'white');

  // Quien propone no puede aceptar su propia oferta.
  assert.equal(room.aceptarTablas('white').ok, false);
  assert.equal(room.rechazarTablas('black').ok, true);
  assert.equal(room.drawOffer, null);
  assert.equal(room.status.over, false);

  assert.equal(room.ofrecerTablas('white').ok, true);
  assert.equal(room.aceptarTablas('black').ok, true);
  assert.equal(room.status.over, true);
  assert.equal(room.status.reason, 'agreement');
  assert.equal(room.status.winner, null);
});

test('tablas: una jugada retira la oferta pendiente', () => {
  const room = new Room('ABC234', 'Manuel', 'Fernan');
  room.ofrecerTablas('white');

  const result = room.aplicarJugada([6, 1], [4, 1]);
  assert.equal(result.ok, true);
  assert.equal(room.drawOffer, null);
});

test('tablas: la oferta se conserva al serializar la sala', () => {
  const room = new Room('ABC234', 'Manuel', 'Fernan');
  room.ofrecerTablas('black');

  const copia = Room.fromSnapshot(room.code, room.snapshot());
  assert.equal(copia.drawOffer, 'black');
});
