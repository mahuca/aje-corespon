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
const { WhatsAppGateway } = require('../server/whatsapp');
const { PLAZO_DEFAULT_MS } = require('../server/rooms');

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

async function boot(store = createMemoryStore(), extra = {}) {
  const instance = createServer({ quiet: true, store, ...extra });
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
  assert.equal(joinedWhite.code, room.code);
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

test('resultados: rendirse guarda el resultado, la clasificación y el estado', async (t) => {
  const { instance, store, port, base } = await boot();
  t.after(() => cleanup(instance));

  const { room } = await invite(base);
  const white = await connect(port);
  const black = await connect(port);
  await request(white, 'corespon:join', { code: room.code, name: 'Manuel' });
  await request(black, 'corespon:join', { code: room.code, name: 'Fernan' });

  const resign = await request(black, 'corespon:resign', { code: room.code });
  assert.equal(resign.ok, true);
  assert.equal(resign.room.status.winner, 'white');

  // Un segundo intento no duplica el resultado
  const again = await request(black, 'corespon:resign', { code: room.code });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'game_over');

  const guardados = await store.getPartidasTerminadasPorPareja('Manuel', 'Fernan');
  assert.equal(guardados.length, 1);
  assert.equal(guardados[0].resultado, 'blancas');
  assert.equal(guardados[0].terminoPor, 'renuncia');

  const classification = await fetch(base + '/api/classification').then(r => r.json());
  assert.equal(classification.ok, true);
  // Los 6 del roster aparecen aunque solo dos hayan jugado.
  assert.equal(classification.clasificacion.length, 6);

  const manuel = classification.clasificacion.find(f => f.nombre === 'Manuel');
  assert.equal(manuel.rating, 1525);
  assert.equal(manuel.victorias, 1);

  const fernan = classification.clasificacion.find(f => f.nombre === 'Fernan');
  assert.equal(fernan.rating, 1475);
  assert.equal(fernan.derrotas, 1);

  const resto = classification.clasificacion.filter(f => !['Manuel', 'Fernan'].includes(f.nombre));
  assert.equal(resto.length, 4);
  assert.ok(resto.every(f => f.rating === 1500));

  const status = await fetch(base + '/api/status').then(r => r.json());
  assert.equal(status.ok, true);
  assert.equal(status.estadisticas.partidasTotales, 1);
  assert.equal(status.estadisticas.partidasAbiertas, 0);
});

test('revancha: con los dos votos se intercambian los colores y se reinicia', async (t) => {
  const { instance, port, base } = await boot();
  t.after(() => cleanup(instance));

  const { room } = await invite(base);
  const white = await connect(port);
  const black = await connect(port);
  await request(white, 'corespon:join', { code: room.code, name: 'Manuel' });
  await request(black, 'corespon:join', { code: room.code, name: 'Fernan' });

  // Blancas se rinde: gana Fernan y la partida queda cerrada
  await request(white, 'corespon:resign', { code: room.code });

  const firstVote = await request(white, 'corespon:rematch', { code: room.code });
  assert.equal(firstVote.ok, true);
  assert.equal(firstVote.started, false);

  const whiteColor = nextEvent(white, 'corespon:color');
  const blackColor = nextEvent(black, 'corespon:color');
  const secondVote = await request(black, 'corespon:rematch', { code: room.code });
  assert.equal(secondVote.ok, true);
  assert.equal(secondVote.started, true);

  // Cada asiento recibe su color nuevo
  assert.equal((await whiteColor).color, 'black');
  assert.equal((await blackColor).color, 'white');

  const live = instance.rooms.getRoom(room.code);
  assert.equal(live.players.white.name, 'Fernan');
  assert.equal(live.players.black.name, 'Manuel');
  assert.equal(live.history.length, 0);
  assert.equal(live.status.over, false);
  assert.equal(live.turnColor(), 'white');

  // El que era blancas ya no puede mover; el que era negras (ahora blancas) sí
  const oldWhite = await request(white, 'corespon:move', {
    code: room.code, from: [6, 1], to: [4, 1]
  });
  assert.equal(oldWhite.ok, false);
  assert.equal(oldWhite.error, 'not_your_turn');

  const newWhite = await request(black, 'corespon:move', {
    code: room.code, from: [6, 1], to: [4, 1]
  });
  assert.equal(newWhite.ok, true);
  assert.equal(newWhite.room.turn, 'black');
});

test('partida terminada: los jugadores pueden volver a abrirla para ver el resultado', async (t) => {
  const { instance, port, base } = await boot();
  t.after(() => cleanup(instance));

  const { room } = await invite(base);
  const white = await connect(port);
  const joined = await request(white, 'corespon:join', { code: room.code, name: 'Manuel' });
  const token = joined.token;
  await request(white, 'corespon:resign', { code: room.code });

  white.close();
  await wait(120);

  const again = await connect(port);
  const reopened = await request(again, 'corespon:join', {
    code: room.code, name: 'Manuel', token
  });
  assert.equal(reopened.ok, true);
  assert.equal(reopened.resumed, true);
  assert.equal(reopened.room.status.over, true);
  assert.equal(reopened.room.status.winner, 'black');
});

test('notificaciones: las jugadas encolan mensajes completos y se envían una vez', async (t) => {
  const store = createMemoryStore();
  const enviados = [];
  const gateway = new WhatsAppGateway({
    store,
    providerName: 'fake',
    provider: async (text, destino) => {
      enviados.push({ text, destino });
      return { id: 'mensaje' };
    }
  });

  const { instance, port, base } = await boot(store, { gateway });
  t.after(() => cleanup(instance));

  const { room } = await invite(base);
  const white = await connect(port);
  const black = await connect(port);
  await request(white, 'corespon:join', { code: room.code, name: 'Manuel' });
  await request(black, 'corespon:join', { code: room.code, name: 'Fernan' });
  await request(white, 'corespon:move', { code: room.code, from: [6, 1], to: [4, 1] });
  await wait(60);

  const pendientes = await store.getNotificacionesPendientes();
  assert.ok(pendientes.length >= 3, 'debe haber invitación y avisos de turno');

  for (const notif of pendientes) {
    assert.equal(typeof notif.texto, 'string');
    assert.ok(notif.texto.includes(room.code), 'el mensaje debe incluir el código');
    assert.doesNotMatch(notif.texto, /\$\{/);
    assert.doesNotMatch(notif.texto, /undefined/);
  }

  const destinatarios = new Set(pendientes.map(n => n.jugador));
  assert.ok(destinatarios.has('Manuel'));
  assert.ok(destinatarios.has('Fernan'));

  await gateway.processQueue(50);
  assert.ok(enviados.length >= 3);
  assert.equal((await store.getNotificacionesPendientes()).length, 0);
});

test('api: la cola de notificaciones filtra por estado y muestra el resumen', async (t) => {
  const store = createMemoryStore();
  const gateway = new WhatsAppGateway({
    store, providerName: 'fake', provider: async () => ({ id: 'x' })
  });
  const { instance, base } = await boot(store, { gateway });
  t.after(() => cleanup(instance));

  await store.addNotificacion({
    roomCode: 'ABC234', tipo: 'turno', destinatario: '+34600000000',
    jugador: 'Manuel', texto: 'Te toca mover en ABC234'
  });

  const todas = await fetch(`${base}/api/whatsapp/queue`).then(r => r.json());
  assert.equal(todas.ok, true);
  assert.equal(todas.estado, 'todas');
  assert.equal(todas.resumen.pendiente, 1);
  assert.equal(todas.notificaciones.length, 1);

  await gateway.processQueue();

  const enviadas = await fetch(`${base}/api/whatsapp/queue?estado=enviado`).then(r => r.json());
  assert.equal(enviadas.estado, 'enviado');
  assert.equal(enviadas.resumen.enviado, 1);
  assert.ok(enviadas.notificaciones.every(n => n.estado === 'enviado'));

  const pendientes = await fetch(`${base}/api/whatsapp/queue?estado=pendiente`).then(r => r.json());
  assert.equal(pendientes.notificaciones.length, 0);

  const invalido = await fetch(`${base}/api/whatsapp/queue?estado=inventado`).then(r => r.json());
  assert.equal(invalido.estado, 'todas');
});

test('api: la cola exige el token de administración si está definido', async (t) => {
  const previo = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'secreto-de-prueba';
  t.after(() => {
    if (previo === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = previo;
  });

  const store = createMemoryStore();
  const { instance, base } = await boot(store);
  t.after(() => cleanup(instance));

  const sinToken = await fetch(`${base}/api/whatsapp/queue`);
  assert.equal(sinToken.status, 401);

  const conToken = await fetch(`${base}/api/whatsapp/queue`, {
    headers: { 'x-admin-token': 'secreto-de-prueba' }
  });
  assert.equal(conToken.status, 200);
  const data = await conToken.json();
  assert.equal(data.ok, true);
});

test('cierre: close() detiene el servidor y libera el puerto', async () => {
  const { instance } = await boot();
  assert.equal(instance.server.listening, true);

  await instance.close();
  assert.equal(instance.server.listening, false);

  // Un segundo cierre no debe lanzar.
  await instance.close();
});

test('espectador: recibe la sala y las jugadas, pero no puede mover', async (t) => {
  const { instance, port, base } = await boot();
  t.after(() => cleanup(instance));

  const { room } = await invite(base);
  const white = await connect(port);
  const black = await connect(port);
  await request(white, 'corespon:join', { code: room.code, name: 'Manuel' });
  await request(black, 'corespon:join', { code: room.code, name: 'Fernan' });

  const spectator = await connect(port);
  const watched = await request(spectator, 'corespon:watch', { code: room.code });
  assert.equal(watched.ok, true);
  assert.equal(watched.room.code, room.code);
  assert.equal(watched.room.spectators, 1);

  const update = nextEvent(spectator, 'corespon:room:update');
  const movida = await request(white, 'corespon:move', {
    code: room.code, from: [6, 1], to: [4, 1]
  });
  assert.equal(movida.ok, true);

  const payload = await update;
  assert.equal(payload.code, room.code);
  assert.equal(payload.state.turn, 'black');

  const intento = await request(spectator, 'corespon:move', {
    code: room.code, from: [1, 1], to: [2, 1]
  });
  assert.equal(intento.ok, false);

  const fuera = await request(spectator, 'corespon:unwatch', { code: room.code });
  assert.equal(fuera.ok, true);
});

test('invitación: el creador puede elegir negras', async (t) => {
  const { instance, base } = await boot();
  t.after(() => cleanup(instance));

  const response = await fetch(base + '/api/partidas/invitar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jugador: 'Manuel', rival: 'Fernan', color: 'black' })
  });
  const data = await response.json();

  assert.equal(data.ok, true);
  assert.equal(data.color, 'black');
  assert.equal(data.room.players.white.name, 'Fernan');
  assert.equal(data.room.players.black.name, 'Manuel');
  assert.equal(data.room.state.turn, 'white');
});

test('invitación: el duplicado en orden inverso reutiliza la sala', async (t) => {
  const { instance, base } = await boot();
  t.after(() => cleanup(instance));

  const primera = await invite(base, 'Manuel', 'Fernan');

  const response = await fetch(base + '/api/partidas/invitar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jugador: 'Fernan', rival: 'Manuel', color: 'white' })
  });
  const data = await response.json();

  assert.equal(data.ok, true);
  assert.equal(data.existing, true);
  assert.equal(data.room.code, primera.room.code);
  // En la partida ya abierta Manuel es blancas y Fernan negras.
  assert.equal(data.color, 'black');
});

test('invitación: no se puede crear una partida contra uno mismo', async (t) => {
  const { instance, base } = await boot();
  t.after(() => cleanup(instance));

  const response = await fetch(base + '/api/partidas/invitar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jugador: 'Manuel', rival: 'Manuel', color: 'white' })
  });
  assert.equal(response.status, 400);
});

test('salir: abandonar una partida en curso da la victoria al rival', async (t) => {
  const store = createMemoryStore();
  const { instance, port, base } = await boot(store);
  t.after(() => cleanup(instance));

  const { room } = await invite(base);
  const white = await connect(port);
  const black = await connect(port);
  await request(white, 'corespon:join', { code: room.code, name: 'Manuel' });
  await request(black, 'corespon:join', { code: room.code, name: 'Fernan' });

  const update = nextEvent(black, 'corespon:room:update');
  const leave = await request(white, 'corespon:leave', { code: room.code });
  assert.equal(leave.ok, true);

  const payload = await update;
  assert.equal(payload.status.over, true);
  assert.equal(payload.status.reason, 'resignation');
  assert.equal(payload.status.winner, 'black');

  const stats = await store.obtenerEstadisticas();
  assert.equal(stats.partidasTotales, 1);
});

test('partida abierta: el resultado queda vacío hasta que termina', async (t) => {
  const { instance, base } = await boot();
  t.after(() => cleanup(instance));

  const { room } = await invite(base);
  const response = await fetch(`${base}/api/partidas/${room.code}`);
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.partida.estado, 'abierta');
  assert.equal(data.partida.resultado, null);
});

test('cambiar de partida: salir sin rendirse mantiene la partida abierta', async (t) => {
  const store = createMemoryStore();
  const { instance, port, base } = await boot(store);
  t.after(() => cleanup(instance));

  const { room } = await invite(base);
  const white = await connect(port);
  const black = await connect(port);
  const joinedWhite = await request(white, 'corespon:join', {
    code: room.code, name: 'Manuel'
  });
  await request(black, 'corespon:join', { code: room.code, name: 'Fernan' });

  const leave = await request(white, 'corespon:leave', {
    code: room.code, resign: false
  });
  assert.equal(leave.ok, true);
  await wait(30);

  const live = instance.rooms.getRoom(room.code);
  assert.equal(live.status.over, false);
  assert.equal(live.players.white.connected, false);

  const rejoin = await request(white, 'corespon:join', {
    code: room.code, name: 'Manuel', token: joinedWhite.token
  });
  assert.equal(rejoin.ok, true);
  assert.equal(rejoin.color, 'white');
  assert.equal(live.status.over, false);
  assert.equal(live.players.white.connected, true);
});

test('movimiento: el rival desconectado no impide mover', async (t) => {
  const { instance, port, base } = await boot();
  t.after(() => cleanup(instance));

  const { room } = await invite(base);
  const white = await connect(port);
  const black = await connect(port);
  await request(white, 'corespon:join', { code: room.code, name: 'Manuel' });
  await request(black, 'corespon:join', { code: room.code, name: 'Fernan' });

  const leave = await request(black, 'corespon:leave', {
    code: room.code, resign: false
  });
  assert.equal(leave.ok, true);
  await wait(30);

  const live = instance.rooms.getRoom(room.code);
  assert.equal(live.players.black.connected, false);
  assert.equal(live.status.over, false);

  const move = await request(white, 'corespon:move', {
    code: room.code, from: [6, 1], to: [4, 1]
  });
  assert.equal(move.ok, true);
  assert.equal(move.room.history.length, 1);
  assert.equal(move.room.turn, 'black');
});

test('plazo: empieza a contar cuando entran los dos', async (t) => {
  const { instance, port, base } = await boot();
  t.after(() => cleanup(instance));

  const { room } = await invite(base);
  const white = await connect(port);
  const black = await connect(port);
  await request(white, 'corespon:join', { code: room.code, name: 'Manuel' });

  const live = instance.rooms.getRoom(room.code);
  const antes = live.plazos.plazoHasta;
  await wait(20);

  await request(black, 'corespon:join', { code: room.code, name: 'Fernan' });
  assert.ok(live.plazos.plazoHasta > antes, 'el plazo debe reiniciarse al entrar el rival');
  assert.ok(
    live.plazos.plazoHasta >= Date.now() + PLAZO_DEFAULT_MS - 2000,
    'el plazo debe dar los dos días completos desde la entrada'
  );
});

test('notificaciones: reconectar no repite el aviso de turno', async (t) => {
  const store = createMemoryStore();
  const gateway = new WhatsAppGateway({
    store,
    providerName: 'fake',
    provider: async () => ({ id: 'mensaje' })
  });
  const { instance, port, base } = await boot(store, { gateway });
  t.after(() => cleanup(instance));

  const { room } = await invite(base);
  const white = await connect(port);
  const black = await connect(port);
  await request(white, 'corespon:join', { code: room.code, name: 'Manuel' });
  const joinedBlack = await request(black, 'corespon:join', {
    code: room.code, name: 'Fernan'
  });

  await request(black, 'corespon:leave', { code: room.code, resign: false });
  await wait(20);

  const black2 = await connect(port);
  await request(black2, 'corespon:join', {
    code: room.code, name: 'Fernan', token: joinedBlack.token
  });
  await wait(50);

  const turnos = (await store.getNotificacionesPendientes())
    .filter(n => n.tipo === 'turno');
  assert.equal(turnos.length, 1);
});

test('tablas: proponer, aceptar y guardar el resultado', async (t) => {
  const store = createMemoryStore();
  const { instance, port, base } = await boot(store);
  t.after(() => cleanup(instance));

  const { room } = await invite(base);
  const white = await connect(port);
  const black = await connect(port);
  await request(white, 'corespon:join', { code: room.code, name: 'Manuel' });
  await request(black, 'corespon:join', { code: room.code, name: 'Fernan' });

  const updateOferta = nextEvent(black, 'corespon:room:update');
  const oferta = await request(white, 'corespon:draw', { code: room.code });
  assert.equal(oferta.ok, true);

  const trasOferta = await updateOferta;
  assert.equal(trasOferta.drawOffer, 'white');

  const propia = await request(white, 'corespon:draw:accept', { code: room.code });
  assert.equal(propia.ok, false);
  assert.equal(propia.error, 'no_offer');

  const update = nextEvent(white, 'corespon:room:update');
  const acepta = await request(black, 'corespon:draw:accept', { code: room.code });
  assert.equal(acepta.ok, true);

  const payload = await update;
  assert.equal(payload.status.over, true);
  assert.equal(payload.status.reason, 'agreement');
  assert.equal(payload.status.winner, null);
  assert.equal(payload.drawOffer, null);

  const stats = await store.obtenerEstadisticas();
  assert.equal(stats.partidasTotales, 1);
});

test('tablas: rechazar mantiene la partida en curso', async (t) => {
  const { instance, port, base } = await boot();
  t.after(() => cleanup(instance));

  const { room } = await invite(base);
  const white = await connect(port);
  const black = await connect(port);
  await request(white, 'corespon:join', { code: room.code, name: 'Manuel' });
  await request(black, 'corespon:join', { code: room.code, name: 'Fernan' });

  await request(white, 'corespon:draw', { code: room.code });
  const rechazo = await request(black, 'corespon:draw:decline', { code: room.code });
  assert.equal(rechazo.ok, true);
  assert.equal(rechazo.room.status.over, false);
  assert.equal(rechazo.room.drawOffer, null);
});

test('api: /healthz responde sin tocar la base de datos', async (t) => {
  const { instance, base } = await boot();
  t.after(() => cleanup(instance));

  const res = await fetch(base + '/healthz');
  assert.equal(res.status, 200);

  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.servicio, 'aje-corespon');
  assert.equal(data.storage, 'memory');
  assert.ok(data.uptime >= 0);
});

test('admin: borrar una partida exige token y la elimina', async (t) => {
  const previo = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'clave-admin';
  t.after(() => {
    if (previo === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = previo;
  });

  const { instance, base } = await boot();
  t.after(() => cleanup(instance));

  const { room } = await invite(base);
  assert.notEqual(instance.rooms.getRoom(room.code), null);

  const sinToken = await fetch(`${base}/api/partidas/${room.code}`, { method: 'DELETE' });
  assert.equal(sinToken.status, 401);

  const borrada = await fetch(`${base}/api/partidas/${room.code}`, {
    method: 'DELETE',
    headers: { 'x-admin-token': 'clave-admin' }
  });
  assert.equal(borrada.status, 200);

  const data = await borrada.json();
  assert.equal(data.ok, true);
  assert.equal(data.estabaEnMemoria, true);

  assert.equal(instance.rooms.getRoom(room.code), null);
  assert.equal((await fetch(`${base}/api/partidas/${room.code}`)).status, 404);

  const lista = await fetch(`${base}/api/partidas`).then(r => r.json());
  assert.equal(lista.partidas.length, 0);
});

test('notificaciones: el fin de partida incluye el rating', async (t) => {
  const store = createMemoryStore();
  const enviados = [];
  const gateway = new WhatsAppGateway({
    store,
    providerName: 'fake',
    provider: async (text) => {
      enviados.push(text);
      return { id: 'mensaje' };
    }
  });

  const { instance, port, base } = await boot(store, { gateway });
  t.after(() => cleanup(instance));

  const { room } = await invite(base);
  const white = await connect(port);
  const black = await connect(port);
  await request(white, 'corespon:join', { code: room.code, name: 'Manuel' });
  await request(black, 'corespon:join', { code: room.code, name: 'Fernan' });

  const resign = await request(black, 'corespon:resign', { code: room.code });
  assert.equal(resign.ok, true);
  await wait(80);

  const fin = (await store.getNotificacionesPendientes())
    .filter(n => n.tipo === 'fin');
  assert.equal(fin.length, 2);
  for (const notif of fin) {
    assert.match(notif.texto, /Manuel 1525/);
    assert.match(notif.texto, /Fernan 1475/);
  }
});
