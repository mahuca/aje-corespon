'use strict';

/*
 * Pruebas de integración del servidor: salas, autorización, sesión y
 * persistencia. Usan Socket.IO real sobre `listen(0)` y un store en memoria
 * por prueba (no tocan ninguna base de datos externa).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');

const { createServer } = require('../server/server');
const { createMemoryStore } = require('../server/db');

const sockets = [];

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = io(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    });
    sockets.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function request(socket, event, payload, timeout = 5000) {
  return new Promise((resolve) => {
    socket.timeout(timeout).emit(event, payload, (error, response) => {
      resolve(error ? { ok: false, error: 'timeout' } : response);
    });
  });
}

function nextEvent(socket, event, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout esperando ' + event)), timeout);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function boot(store = createMemoryStore()) {
  const instance = createServer({ quiet: true, store });
  const port = await instance.start(0);
  return { instance, store, port, base: `http://127.0.0.1:${port}` };
}

async function invite(base, blancas = 'Manuel', negras = 'Fernan') {
  const response = await fetch(base + '/api/partidas/invitar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blancas, negras })
  });
  const data = await response.json();
  assert.equal(data.ok, true, 'la invitación debe responder ok');
  return data;
}

async function cleanup(instance) {
  for (const socket of sockets.splice(0)) {
    if (socket.connected) socket.close();
  }
  await wait(20);
  await instance.close();
}

test('flujo: invitar, unirse, mover y recibir la actualización', async (t) => {
  const { instance, port, base } = await boot();
  t.after(() => cleanup(instance));

  const { room } = await invite(base);
  const white = await connect(port);
  const black = await connect(port);

  const joinedWhite = await request(white, 'corespon:join', { code: room.code, name: 'Manuel' });
  assert.equal(joinedWhite.ok, true);
  assert.equal(joinedWhite.color, 'white');
  assert.equal(typeof joinedWhite.token, 'string');
  assert.ok(joinedWhite.token.length > 0);

  const joinedBlack = await request(black, 'corespon:join', { code: room.code, name: 'Fernan' });
  assert.equal(joinedBlack.ok, true);
  assert.equal(joinedBlack.color, 'black');

  const update = nextEvent(black, 'corespon:room:update');
  const move = await request(white, 'corespon:move', {
    code: room.code, from: [6, 1], to: [4, 1]
  });
  assert.equal(move.ok, true);
  assert.equal(move.room.turn, 'black');

  const broadcast = await update;
  assert.equal(broadcast.code, room.code);
  assert.equal(broadcast.history.length, 1);
  assert.equal(broadcast.state.board[4][1], '♙');
});

test('autorización: el rival no puede mover ni rendirse por el otro', async (t) => {
  const { instance, port, base } = await boot();
  t.after(() => cleanup(instance));

  const { room } = await invite(base);
  const white = await connect(port);
  const black = await connect(port);
  const outsider = await connect(port);

  await request(white, 'corespon:join', { code: room.code, name: 'Manuel' });
  await request(black, 'corespon:join', { code: room.code, name: 'Fernan' });

  // Negras intenta mover una pieza blanca suplantando el color
  const cheatMove = await request(black, 'corespon:move', {
    code: room.code, color: 'white', from: [6, 1], to: [4, 1]
  });
  assert.equal(cheatMove.ok, false);
  assert.equal(cheatMove.error, 'not_your_turn');

  // Un socket que no se unió no puede tocar la partida
  const outsiderMove = await request(outsider, 'corespon:move', {
    code: room.code, color: 'white', from: [6, 1], to: [4, 1]
  });
  assert.equal(outsiderMove.ok, false);
  assert.equal(outsiderMove.error, 'not_in_room');

  // Rendirse solo rinde el asiento propio: gana blancas
  const resign = await request(black, 'corespon:resign', { code: room.code, color: 'white' });
  assert.equal(resign.ok, true);
  assert.equal(resign.room.status.over, true);
  assert.equal(resign.room.status.reason, 'resignation');
  assert.equal(resign.room.status.winner, 'white');
});

test('sesión: el token permite reanudar el asiento tras desconectar', async (t) => {
  const { instance, port, base } = await boot();
  t.after(() => cleanup(instance));

  const { room } = await invite(base);
  const first = await connect(port);
  const joined = await request(first, 'corespon:join', { code: room.code, name: 'Manuel' });
  const token = joined.token;

  first.close();
  await wait(120);

  const second = await connect(port);
  const resumed = await request(second, 'corespon:join', {
    code: room.code, name: 'Manuel', token
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.color, 'white');
  assert.equal(resumed.resumed, true);
});

test('sesión: sin token, el asiento queda libre tras desconectar', async (t) => {
  const { instance, port, base } = await boot();
  t.after(() => cleanup(instance));

  const { room } = await invite(base);
  const first = await connect(port);
  await request(first, 'corespon:join', { code: room.code, name: 'Manuel' });
  first.close();
  await wait(120);

  const second = await connect(port);
  const rejoin = await request(second, 'corespon:join', { code: room.code, name: 'Manuel' });
  assert.equal(rejoin.ok, true);
  assert.equal(rejoin.resumed, false);
});

test('prórrogas: solo el jugador del turno puede ampliar', async (t) => {
  const { instance, port, base } = await boot();
  t.after(() => cleanup(instance));

  const { room } = await invite(base);
  const white = await connect(port);
  const black = await connect(port);
  await request(white, 'corespon:join', { code: room.code, name: 'Manuel' });
  await request(black, 'corespon:join', { code: room.code, name: 'Fernan' });

  const wrongTurn = await request(black, 'corespon:extend', { code: room.code });
  assert.equal(wrongTurn.ok, false);
  assert.equal(wrongTurn.error, 'not_your_turn');

  const extended = await request(white, 'corespon:extend', { code: room.code });
  assert.equal(extended.ok, true);
  assert.equal(extended.registro.color, 'white');

  const liveRoom = instance.rooms.getRoom(room.code);
  assert.equal(liveRoom.plazos.prorrogas.length, 1);
  assert.equal(liveRoom.canExtend(), true);
});

test('persistencia: la partida se restaura al reiniciar el servidor', async (t) => {
  const store = createMemoryStore();
  const first = await boot(store);

  const { room } = await invite(first.base);
  const white = await connect(first.port);
  const joined = await request(white, 'corespon:join', { code: room.code, name: 'Manuel' });
  const token = joined.token;
  await request(white, 'corespon:move', { code: room.code, from: [6, 1], to: [4, 1] });

  white.close();
  await wait(80);
  await first.instance.close();

  // Nueva instancia con el mismo almacenamiento: simula un reinicio
  const second = await boot(store);
  t.after(() => cleanup(second.instance));

  const restored = second.instance.rooms.getRoom(room.code);
  assert.ok(restored, 'la sala debe existir tras reiniciar');
  assert.equal(restored.history.length, 1);
  assert.equal(restored.turnColor(), 'black');
  assert.equal(restored.state.board[4][1], '♙');
  assert.equal(restored.players.white.token, token);

  const again = await connect(second.port);
  const resumed = await request(again, 'corespon:join', {
    code: room.code, name: 'Manuel', token
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.resumed, true);

  // Y la partida sigue jugable: ahora mueve negras
  const black = await connect(second.port);
  await request(black, 'corespon:join', { code: room.code, name: 'Fernan' });
  const move = await request(black, 'corespon:move', { code: room.code, from: [1, 1], to: [3, 1] });
  assert.equal(move.ok, true);
  assert.equal(move.room.turn, 'white');
});

test('api: /api/partidas responde en modo memoria', async (t) => {
  const { instance, base } = await boot();
  t.after(() => cleanup(instance));

  const { room } = await invite(base);
  const response = await fetch(base + '/api/partidas');
  const data = await response.json();

  assert.equal(data.ok, true);
  assert.equal(data.partidas.length, 1);
  assert.equal(data.partidas[0].roomCode, room.code);
  assert.match(data.partidas[0].plazoHasta, /^\d{4}-\d{2}-\d{2}T/);
});

test('api: invitar dos veces devuelve la misma partida abierta', async (t) => {
  const { instance, base } = await boot();
  t.after(() => cleanup(instance));

  const first = await invite(base);
  const second = await invite(base);

  assert.equal(second.room.code, first.room.code);
  assert.equal(second.existing, true);
});
