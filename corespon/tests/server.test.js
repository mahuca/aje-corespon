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

// Clave de los jugadores en las pruebas. La primera vez que un jugador entra
// con ella, el servidor la registra como suya.
const TEST_PIN = '4321';

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
  // Los tests no repiten la clave en cada join: se inyecta aquí. Un test que
  // quiera probar la falta de clave manda `pin: ''` explícitamente.
  const datos = event === 'corespon:join' && payload && payload.pin === undefined
    ? { ...payload, pin: TEST_PIN }
    : payload;

  return new Promise((resolve) => {
    socket.timeout(timeout).emit(event, datos, (error, response) => {
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
  // El alta de claves está cerrada por defecto en producción. En las pruebas
  // se abre para poder entrar con normalidad; los tests que comprueban el
  // cierre la cierran explícitamente.
  await store.setAjuste('alta_claves_hasta', new Date(Date.now() + 3600000).toISOString());

  const instance = createServer({ quiet: true, store, ...extra });
  const port = await instance.start(0);
  return { instance, store, port, base: `http://127.0.0.1:${port}` };
}

/*
 * Deja el alta de claves cerrada (o abierta hasta dentro de `horas`).
 */
async function enrollment(store, { abierta = false, horas = 2 } = {}) {
  const valor = abierta
    ? new Date(Date.now() + horas * 3600000).toISOString()
    : null;
  await store.setAjuste('alta_claves_hasta', valor);
  return valor;
}

async function invite(base, blancas = 'Manuel', negras = 'Fernan', pin = TEST_PIN) {
  const response = await fetch(base + '/api/partidas/invitar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blancas, negras, pin })
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

test('torneo: con los 6 jugadores por defecto son 30 partidas', async (t) => {
  const { instance, base } = await boot();
  t.after(() => cleanup(instance));

  const response = await fetch(base + '/api/tournament');
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.formato, 'round-robin');
  assert.equal(data.numeroJugadores, 6);
  assert.equal(data.totalParejas, 15);
  assert.equal(data.partidasPorPareja, 2);
  assert.equal(data.totalPartidas, 30);
  assert.equal(data.partidasJugadas, 0);
  assert.match(data.descripcion, /15 parejas .* 30 partidas/);
  assert.equal(data.jugadores.length, 6);
});

test('torneo: el mismo resumen está en /api/tournament/start', async (t) => {
  const { instance, base } = await boot();
  t.after(() => cleanup(instance));

  const [a, b] = await Promise.all([
    fetch(base + '/api/tournament').then(r => r.json()),
    fetch(base + '/api/tournament/start').then(r => r.json())
  ]);

  assert.deepEqual(a, b);
});

test('torneo: el cálculo se adapta al número de jugadores', async (t) => {
  const { instance, base } = await boot();
  t.after(() => cleanup(instance));

  // 6 por defecto + 2 nuevos = 8 jugadores → 8 * 7 = 56 partidas.
  for (const nombre of ['Nuria', 'Pablo']) {
    const alta = await fetch(base + '/api/tournament/players', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nombre })
    });
    assert.equal(alta.status, 201);
  }

  const data = await fetch(base + '/api/tournament').then(r => r.json());
  assert.equal(data.numeroJugadores, 8);
  assert.equal(data.totalParejas, 28);
  assert.equal(data.totalPartidas, 56);
});

test('torneo: el alta de jugadores valida nombre y duplicados', async (t) => {
  const { instance, base } = await boot();
  t.after(() => cleanup(instance));

  const sinNombre = await fetch(base + '/api/tournament/players', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(sinNombre.status, 400);

  const vacio = await fetch(base + '/api/tournament/players', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nombre: '   ' })
  });
  assert.equal(vacio.status, 400);

  const existente = await fetch(base + '/api/tournament/players', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nombre: 'Manuel' })
  });
  assert.equal(existente.status, 409);
});

test('torneo: el alta de jugadores exige token si está definido', async (t) => {
  const previo = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'secreto-de-prueba';
  t.after(() => {
    if (previo === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = previo;
  });

  const { instance, base } = await boot();
  t.after(() => cleanup(instance));

  const sinToken = await fetch(base + '/api/tournament/players', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nombre: 'Nuria' })
  });
  assert.equal(sinToken.status, 401);

  const conToken = await fetch(base + '/api/tournament/players', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': 'secreto-de-prueba' },
    body: JSON.stringify({ nombre: 'Nuria' })
  });
  assert.equal(conToken.status, 201);
  const data = await conToken.json();
  assert.equal(data.ok, true);
  assert.equal(data.torneo.numeroJugadores, 7);
  assert.equal(data.torneo.totalPartidas, 42);
});

test('torneo: el alta normaliza el nombre y el jugador entra en la clasificación', async (t) => {
  const { instance, base } = await boot();
  t.after(() => cleanup(instance));

  const alta = await fetch(base + '/api/tournament/players', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nombre: '  Nuria  ', admin: true })
  });
  assert.equal(alta.status, 201);

  const creado = await alta.json();
  assert.equal(creado.jugador.nombre, 'Nuria');
  assert.equal(creado.jugador.id, 'nuria');
  assert.equal(creado.jugador.admin, true);

  const jugadores = await fetch(base + '/api/players').then(r => r.json());
  const nuria = jugadores.players.find(p => p.nombre === 'Nuria');
  assert.ok(nuria, 'el jugador añadido debe aparecer en /api/players');
  assert.equal(nuria.admin, true);

  const clasificacion = await fetch(base + '/api/classification').then(r => r.json());
  const fila = clasificacion.clasificacion.find(f => f.nombre === 'Nuria');
  assert.ok(fila, 'el jugador añadido debe aparecer en la clasificación');
  assert.equal(fila.rating, 1500);
  assert.equal(fila.partidas, 0);
});

test('torneo: el alta rechaza nombres demasiado largos', async (t) => {
  const { instance, base } = await boot();
  t.after(() => cleanup(instance));

  const alta = await fetch(base + '/api/tournament/players', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nombre: 'x'.repeat(41) })
  });

  assert.equal(alta.status, 400);
  const data = await alta.json();
  assert.equal(data.ok, false);
  assert.match(data.error, /largo/i);
});

test('ui: el lobby incluye el formulario de administración y el endpoint del torneo', async (t) => {
  const { instance, base } = await boot();
  t.after(() => cleanup(instance));

  const html = await fetch(base + '/corespon').then(r => r.text());
  for (const id of ['adminForm', 'adminToken', 'adminPlayerName', 'adminAddBtn', 'adminStatus']) {
    assert.match(html, new RegExp(`id="${id}"`), `falta #${id} en el lobby`);
  }

  const js = await fetch(base + '/corespon.js').then(r => r.text());
  assert.match(js, /\/api\/tournament\/players/);
  assert.match(js, /x-admin-token/);
  assert.match(js, /\/api\/players/);
});

test('admin: dar de baja saca al jugador del torneo y de la clasificación', async (t) => {
  const { instance, base } = await boot();
  t.after(() => cleanup(instance));

  const baja = await fetch(base + '/api/tournament/players/alberto', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ activa: false })
  });
  assert.equal(baja.status, 200);

  const data = await baja.json();
  assert.equal(data.ok, true);
  assert.equal(data.jugador.activa, false);
  assert.equal(data.torneo.numeroJugadores, 5);
  assert.equal(data.torneo.totalPartidas, 20);

  const jugadores = await fetch(base + '/api/players').then(r => r.json());
  assert.equal(jugadores.players.some(p => p.nombre === 'Alberto'), false);

  const clasificacion = await fetch(base + '/api/classification').then(r => r.json());
  assert.equal(clasificacion.clasificacion.some(f => f.nombre === 'Alberto'), false);

  const alta = await fetch(base + '/api/tournament/players/alberto', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ activa: true })
  });
  assert.equal(alta.status, 200);

  const reactivado = await alta.json();
  assert.equal(reactivado.torneo.numeroJugadores, 6);
  assert.equal(reactivado.torneo.totalPartidas, 30);
});

test('admin: no se puede bajar de 2 jugadores activos', async (t) => {
  const { instance, base } = await boot();
  t.after(() => cleanup(instance));

  for (const id of ['alberto', 'alvaro', 'alejandro', 'fernan']) {
    const res = await fetch(base + '/api/tournament/players/' + id, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activa: false })
    });
    assert.equal(res.status, 200);
  }

  const bloqueada = await fetch(base + '/api/tournament/players/manuel', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ activa: false })
  });
  assert.equal(bloqueada.status, 400);

  const data = await bloqueada.json();
  assert.match(data.error, /2 jugadores activos/);
});

test('admin: un jugador de baja con historial sigue en la clasificación', async (t) => {
  const { instance, store, base } = await boot();
  t.after(() => cleanup(instance));

  await store.saveResultado({
    blancas: 'Manuel',
    negras: 'Alberto',
    resultado: 'blancas'
  });

  await fetch(base + '/api/tournament/players/alberto', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ activa: false })
  });

  const clasificacion = await fetch(base + '/api/classification').then(r => r.json());
  const alberto = clasificacion.clasificacion.find(f => f.nombre === 'Alberto');
  assert.ok(alberto, 'con historial debe seguir apareciendo');
  assert.equal(alberto.partidas, 1);
  assert.equal(alberto.rating, 1475);
});

test('admin: el listado y el cambio de estado exigen token', async (t) => {
  const previo = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'secreto-de-prueba';
  t.after(() => {
    if (previo === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = previo;
  });

  const { instance, base } = await boot();
  t.after(() => cleanup(instance));

  const listadoSinToken = await fetch(base + '/api/tournament/players');
  assert.equal(listadoSinToken.status, 401);

  const listado = await fetch(base + '/api/tournament/players', {
    headers: { 'x-admin-token': 'secreto-de-prueba' }
  });
  assert.equal(listado.status, 200);
  const lista = await listado.json();
  assert.equal(lista.jugadores.length, 6);

  const bajaSinToken = await fetch(base + '/api/tournament/players/alberto', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ activa: false })
  });
  assert.equal(bajaSinToken.status, 401);

  const baja = await fetch(base + '/api/tournament/players/alberto', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-admin-token': 'secreto-de-prueba' },
    body: JSON.stringify({ activa: false })
  });
  assert.equal(baja.status, 200);
});

test('api: /api/partidas informa de a quién le toca mover', async (t) => {
  const { instance, port, base } = await boot();
  t.after(() => cleanup(instance));

  const { room } = await invite(base);

  const inicial = await fetch(base + '/api/partidas').then(r => r.json());
  assert.equal(inicial.partidas.length, 1);
  assert.equal(inicial.partidas[0].turno, 'white');
  assert.equal(inicial.partidas[0].blancas, 'Manuel');
  assert.equal(inicial.partidas[0].negras, 'Fernan');

  const white = await connect(port);
  const black = await connect(port);
  await request(white, 'corespon:join', { code: room.code, name: 'Manuel' });
  await request(black, 'corespon:join', { code: room.code, name: 'Fernan' });

  const move = await request(white, 'corespon:move', {
    code: room.code, from: [6, 1], to: [4, 1]
  });
  assert.equal(move.ok, true);
  await wait(80);

  const tras = await fetch(base + '/api/partidas').then(r => r.json());
  assert.equal(tras.partidas[0].turno, 'black');
});

test('ui: la lista de partidas pinta el nombre de quien tiene el turno', async (t) => {
  const { instance, base } = await boot();
  t.after(() => cleanup(instance));

  const js = await fetch(base + '/corespon.js').then(r => r.text());
  assert.match(js, /turno-badge/);
  assert.match(js, /p\.turno === 'white' \? p\.blancas : p\.negras/);

  const css = await fetch(base + '/styles.css').then(r => r.text());
  assert.match(css, /\.turno-badge/);
});

test('pin: la primera vez hay que elegir clave y queda registrada', async (t) => {
  const { instance, port, store, base } = await boot();
  t.after(() => cleanup(instance));

  // Crear la partida ya registra la clave del creador, así que el que aún no
  // tiene clave es el rival (Fernan).
  const { room } = await invite(base);
  const white = await connect(port);

  const sinClave = await request(white, 'corespon:join', {
    code: room.code, name: 'Fernan', pin: ''
  });
  assert.equal(sinClave.ok, false);
  assert.equal(sinClave.error, 'pin_requerido');

  const primera = await request(white, 'corespon:join', {
    code: room.code, name: 'Fernan', pin: '2468'
  });
  assert.equal(primera.ok, true);
  assert.equal(primera.pinGuardado, true);

  const fernan = (await store.getPlayers()).find(p => p.nombre === 'Fernan');
  assert.ok(fernan.pinHash, 'la clave debe quedar registrada');
  assert.notEqual(fernan.pinHash, '2468');
  assert.equal(fernan.pinHash.length, 64);
});

test('pin: la clave incorrecta no entra y la correcta sí', async (t) => {
  const { instance, port, base } = await boot();
  t.after(() => cleanup(instance));

  const { room } = await invite(base);
  const white = await connect(port);
  await request(white, 'corespon:join', { code: room.code, name: 'Fernan', pin: '2468' });
  white.close();
  await wait(80);

  const otro = await connect(port);
  const mala = await request(otro, 'corespon:join', {
    code: room.code, name: 'Fernan', pin: '1111'
  });
  assert.equal(mala.ok, false);
  assert.equal(mala.error, 'pin_incorrecto');

  const buena = await request(otro, 'corespon:join', {
    code: room.code, name: 'Fernan', pin: '2468'
  });
  assert.equal(buena.ok, true);
  assert.equal(buena.pinGuardado, false);
});

test('pin: el formato debe tener de 4 a 6 dígitos', async (t) => {
  const { instance, port, base } = await boot();
  t.after(() => cleanup(instance));

  const { room } = await invite(base);
  const white = await connect(port);

  for (const invalida of ['12', '1234567', 'abcd', '12 34']) {
    const res = await request(white, 'corespon:join', {
      code: room.code, name: 'Fernan', pin: invalida
    });
    assert.equal(res.error, 'pin_invalido', 'clave rechazada: ' + invalida);
  }
});

test('pin: reconectar con el token del asiento no pide la clave', async (t) => {
  const { instance, port, base } = await boot();
  t.after(() => cleanup(instance));

  const { room } = await invite(base);
  const white = await connect(port);
  const joined = await request(white, 'corespon:join', {
    code: room.code, name: 'Fernan', pin: '2468'
  });
  const token = joined.token;
  white.close();
  await wait(80);

  const again = await connect(port);
  const resumed = await request(again, 'corespon:join', {
    code: room.code, name: 'Fernan', token, pin: ''
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.pinGuardado, false);
});

test('pin: crear una partida exige la clave del creador', async (t) => {
  const { instance, base } = await boot();
  t.after(() => cleanup(instance));

  const invitar = (cuerpo) => fetch(base + '/api/partidas/invitar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo)
  });

  const sinClave = await invitar({ jugador: 'Manuel', rival: 'Fernan' });
  assert.equal(sinClave.status, 401);
  assert.equal((await sinClave.json()).error, 'pin_requerido');

  const ok = await invitar({ jugador: 'Manuel', rival: 'Fernan', pin: '2468' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).ok, true);

  // Otra clave no puede crear partidas en nombre de Manuel.
  const ajeno = await invitar({ jugador: 'Manuel', rival: 'Alberto', pin: '9999' });
  assert.equal(ajeno.status, 401);
  assert.equal((await ajeno.json()).error, 'pin_incorrecto');
});

test('pin: demasiados intentos fallidos bloquean temporalmente', async (t) => {
  const { instance, port, base } = await boot();
  t.after(() => cleanup(instance));

  const { room } = await invite(base);
  const white = await connect(port);
  await request(white, 'corespon:join', { code: room.code, name: 'Fernan', pin: '2468' });
  white.close();
  await wait(80);

  const otro = await connect(port);
  for (let intento = 0; intento < 5; intento += 1) {
    const res = await request(otro, 'corespon:join', {
      code: room.code, name: 'Fernan', pin: '1111'
    });
    assert.equal(res.error, 'pin_incorrecto');
  }

  const bloqueado = await request(otro, 'corespon:join', {
    code: room.code, name: 'Fernan', pin: '2468'
  });
  assert.equal(bloqueado.error, 'rate_limited');
});

test('admin: puede asignar y borrar la clave de un jugador', async (t) => {
  const { instance, port, base } = await boot();
  t.after(() => cleanup(instance));

  const listado = await fetch(base + '/api/tournament/players').then(r => r.json());
  assert.equal(listado.jugadores.every(j => j.tieneClave === false), true);

  const asignar = await fetch(base + '/api/tournament/players/manuel', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: '1357' })
  });
  assert.equal(asignar.status, 200);
  const conClave = await asignar.json();
  assert.equal(conClave.jugador.tieneClave, true);

  // Con la clave asignada ya se puede crear partida y entrar.
  const { room } = await invite(base, 'Manuel', 'Fernan', '1357');
  const white = await connect(port);
  const joined = await request(white, 'corespon:join', {
    code: room.code, name: 'Manuel', pin: '1357'
  });
  assert.equal(joined.ok, true);
  assert.equal(joined.pinGuardado, false);

  // Y con una clave distinta, no.
  const otro = await connect(port);
  const ajeno = await request(otro, 'corespon:join', {
    code: room.code, name: 'Alberto', pin: '1357'
  });
  assert.equal(ajeno.ok, false);

  const borrar = await fetch(base + '/api/tournament/players/manuel', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: null })
  });
  assert.equal((await borrar.json()).jugador.tieneClave, false);

  const malFormato = await fetch(base + '/api/tournament/players/manuel', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: '12' })
  });
  assert.equal(malFormato.status, 400);
});

test('admin: cerrar sesiones cambia los tokens sin tocar la partida', async (t) => {
  const { instance, port, store, base } = await boot();
  t.after(() => cleanup(instance));

  const { room } = await invite(base);
  const white = await connect(port);
  const joined = await request(white, 'corespon:join', {
    code: room.code, name: 'Fernan', pin: '2468'
  });
  const tokenViejo = joined.token;
  await request(white, 'corespon:move', { code: room.code, from: [6, 1], to: [4, 1] });
  await wait(80);

  const antes = await store.getPartidaPorCodigo(room.code);

  const rotar = await fetch(base + '/api/admin/rotate-seats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(rotar.status, 200);
  const data = await rotar.json();
  assert.equal(data.ok, true);
  assert.equal(data.salas, 1);

  // La partida sigue exactamente igual: solo cambia la credencial.
  const despues = await store.getPartidaPorCodigo(room.code);
  assert.equal(despues.fen, antes.fen);
  assert.equal(despues.pgn, antes.pgn);
  assert.equal(despues.turno, antes.turno);
  assert.equal(despues.plazoHasta, antes.plazoHasta);

  const room2 = instance.rooms.getRoom(room.code);
  assert.notEqual(room2.players.black.token, tokenViejo);

  // El token viejo ya no reengancha: hay que dar la clave otra vez.
  const nuevo = await connect(port);
  const conTokenViejo = await request(nuevo, 'corespon:join', {
    code: room.code, name: 'Fernan', token: tokenViejo, pin: '2468'
  });
  assert.equal(conTokenViejo.ok, true);
  assert.equal(conTokenViejo.resumed, false);
  assert.notEqual(conTokenViejo.token, tokenViejo);
});

test('pin: la clave sobrevive al reinicio y la partida sigue jugable', async (t) => {
  const store = createMemoryStore();
  const first = await boot(store);

  // Manuel es blancas (mueve primero); su clave la registra invite().
  const { room } = await invite(first.base);
  const white = await connect(first.port);
  const joined = await request(white, 'corespon:join', {
    code: room.code, name: 'Manuel', pin: TEST_PIN
  });
  await request(white, 'corespon:move', { code: room.code, from: [6, 1], to: [4, 1] });

  white.close();
  await wait(80);
  await first.instance.close();

  const second = await boot(store);
  t.after(() => cleanup(second.instance));

  const restored = second.instance.rooms.getRoom(room.code);
  assert.ok(restored, 'la sala debe existir tras reiniciar');
  assert.equal(restored.state.board[4][1], '♙');
  assert.equal(restored.turnColor(), 'black');

  // La clave incorrecta no entra tras el reinicio...
  const malo = await connect(second.port);
  const mala = await request(malo, 'corespon:join', {
    code: room.code, name: 'Manuel', pin: '0000'
  });
  assert.equal(mala.ok, false);
  assert.equal(mala.error, 'pin_incorrecto');

  // ...y el token del asiento sí reengancha sin pedir la clave.
  const bueno = await connect(second.port);
  const buena = await request(bueno, 'corespon:join', {
    code: room.code, name: 'Manuel', token: joined.token, pin: ''
  });
  assert.equal(buena.ok, true);
  assert.equal(buena.resumed, true);
});

test('alta: cerrada no deja registrar claves nuevas', async (t) => {
  const store = createMemoryStore();
  const { instance, port, base } = await boot(store);
  t.after(() => cleanup(instance));

  // invite() registra la clave del creador (Manuel); Fernan no tiene clave.
  const { room } = await invite(base);

  await enrollment(store, { abierta: false });

  const rival = await connect(port);
  const fuera = await request(rival, 'corespon:join', {
    code: room.code, name: 'Fernan', pin: '1357'
  });
  assert.equal(fuera.ok, false);
  assert.equal(fuera.error, 'alta_cerrada');

  // Tampoco se puede crear una partida con un nombre sin clave.
  const crear = await fetch(base + '/api/partidas/invitar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jugador: 'Alberto', rival: 'Alvaro', pin: '2468' })
  });
  assert.equal(crear.status, 401);
  assert.equal((await crear.json()).error, 'alta_cerrada');

  // Quien ya tiene clave sigue entrando con normalidad.
  const manuel = await connect(port);
  const conClave = await request(manuel, 'corespon:join', {
    code: room.code, name: 'Manuel', pin: TEST_PIN
  });
  assert.equal(conClave.ok, true);
  assert.equal(conClave.pinGuardado, false);
});

test('alta: cerrada no afecta a quien ya tiene clave, y el token sigue valiendo', async (t) => {
  const store = createMemoryStore();
  const { instance, port, base } = await boot(store);
  t.after(() => cleanup(instance));

  // El administrador asigna la clave de Manuel, así que el alta no le afecta.
  await fetch(base + '/api/tournament/players/manuel', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: '1357' })
  });
  await enrollment(store, { abierta: false });

  const { room } = await invite(base, 'Manuel', 'Fernan', '1357');
  const s1 = await connect(port);
  const joined = await request(s1, 'corespon:join', {
    code: room.code, name: 'Manuel', pin: '1357'
  });
  assert.equal(joined.ok, true);
  s1.close();
  await wait(80);

  const s2 = await connect(port);
  const resumed = await request(s2, 'corespon:join', {
    code: room.code, name: 'Manuel', token: joined.token, pin: ''
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.resumed, true);

  // El rival, sin clave y con el alta cerrada, no puede entrar.
  const rival = await connect(port);
  const fuera = await request(rival, 'corespon:join', {
    code: room.code, name: 'Fernan', pin: '2468'
  });
  assert.equal(fuera.error, 'alta_cerrada');
});

test('alta: abrir y cerrar la ventana desde el panel', async (t) => {
  const store = createMemoryStore();
  const { instance, base } = await boot(store);
  t.after(() => cleanup(instance));

  await enrollment(store, { abierta: false });

  const cerrado = await fetch(base + '/api/admin/enrollment').then(r => r.json());
  assert.equal(cerrado.abierta, false);
  assert.equal(cerrado.hasta, null);
  assert.equal(cerrado.jugadores, 6);
  assert.equal(cerrado.sinClave, 6);

  const abrir = await fetch(base + '/api/admin/enrollment', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ abrir: true, horas: 2 })
  });
  assert.equal(abrir.status, 200);
  const abierto = await abrir.json();
  assert.equal(abierto.abierta, true);
  assert.ok(Date.parse(abierto.hasta) > Date.now());

  const malasHoras = await fetch(base + '/api/admin/enrollment', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ abrir: true, horas: 0 })
  });
  assert.equal(malasHoras.status, 400);

  const cerrar = await fetch(base + '/api/admin/enrollment', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ abrir: false })
  });
  assert.equal((await cerrar.json()).abierta, false);
});

test('alta: una ventana caducada cuenta como cerrada', async (t) => {
  const store = createMemoryStore();
  const { instance, base } = await boot(store);
  t.after(() => cleanup(instance));

  await store.setAjuste('alta_claves_hasta', new Date(Date.now() - 1000).toISOString());

  const estado = await fetch(base + '/api/admin/enrollment').then(r => r.json());
  assert.equal(estado.abierta, false);
  assert.equal(estado.hasta, null);
});

test('alta: el panel exige token cuando está definido', async (t) => {
  const previo = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'secreto-de-alta';
  t.after(() => {
    if (previo === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = previo;
  });

  const { instance, base } = await boot();
  t.after(() => cleanup(instance));

  assert.equal((await fetch(base + '/api/admin/enrollment')).status, 401);
  assert.equal((await fetch(base + '/api/admin/enrollment', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ abrir: true, horas: 2 })
  })).status, 401);

  const bien = await fetch(base + '/api/admin/enrollment', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': 'secreto-de-alta' },
    body: JSON.stringify({ abrir: true, horas: 2 })
  });
  assert.equal(bien.status, 200);
  assert.equal((await bien.json()).abierta, true);
});

test('ui: al caducar la sesión el lobby pide la clave sin quedarse a medias', async (t) => {
  const { instance, base } = await boot();
  t.after(() => cleanup(instance));

  const js = await fetch(base + '/corespon.js').then(r => r.text());
  assert.match(js, /O\.on\('pin-required'/);
  // El manejador no puede descartarse por estar "ocupado": si lo hace, el
  // lobby se queda sin código, sin nombre y sin foco.
  assert.doesNotMatch(js, /O\.on\('pin-required',[\s\S]{0,60}\n\s*if \(busy\) return;/);
  assert.match(js, /function esErrorDeClave/);
  // La clave se escribe en cualquiera de los dos campos: se sincronizan.
  assert.match(js, /function sincronizarPin/);
  assert.match(js, /function pinActual/);
  // Los dos desplegables de nombre son el mismo dato (antes no se hablaban y
  // entrar con el nombre vacío daba not_your_game sin explicación).
  assert.match(js, /function sincronizarNombre/);
  assert.match(js, /function nombreActual/);
  // Los errores de asiento no deben acabar en el mensaje genérico.
  assert.match(js, /seat_taken:/);
  assert.match(js, /not_your_game:/);

  const core = await fetch(base + '/online-core.js').then(r => r.text());
  assert.match(core, /emitLocal\('pin-required'/);
  assert.match(core, /'alta_cerrada'/);
});

test('ui: se puede mirar la jugada anterior y el último movimiento se ve', async (t) => {
  const { instance, base } = await boot();
  t.after(() => cleanup(instance));

  const html = await fetch(base + '/corespon').then(r => r.text());
  for (const id of ['moveNav', 'movePrevBtn', 'moveNextBtn', 'moveLiveBtn', 'moveViewLabel']) {
    assert.match(html, new RegExp('id="' + id + '"'), 'falta #' + id);
  }

  const js = await fetch(base + '/corespon.js').then(r => r.text());
  // El tablero se pinta con la posición que se está mirando, no solo con la actual.
  assert.match(js, /function estadoVista/);
  assert.match(js, /const estado = estadoVista\(\)/);
  assert.match(js, /function fijarVista/);
  assert.match(js, /function crearEntradaMovimiento/);
  // Mirando una jugada anterior no se puede mover.
  assert.match(js, /if \(!enVivo\(\)\) return false;/);

  const css = await fetch(base + '/styles.css').then(r => r.text());
  // El último movimiento ya no es un azul al 30 %: casilla de destino marcada.
  assert.match(css, /\.square\.last-move\.last-move-to/);
  assert.match(css, /body\.is-reviewing \.board-shell/);
});

test('ui: los estáticos se revalidan en cada carga (sin caché de 5 min)', async (t) => {
  const { instance, base } = await boot();
  t.after(() => cleanup(instance));

  for (const ruta of ['/corespon.js', '/online-core.js', '/styles.css', '/corespon']) {
    const res = await fetch(base + ruta);
    const cache = (res.headers.get('cache-control') || '').toLowerCase();
    assert.match(cache, /max-age=0/, ruta + ' debe revalidarse: ' + cache);
  }
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
    body: JSON.stringify({ jugador: 'Manuel', rival: 'Fernan', color: 'black', pin: TEST_PIN })
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
    body: JSON.stringify({ jugador: 'Fernan', rival: 'Manuel', color: 'white', pin: TEST_PIN })
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

test('notificaciones: el aviso de turno va al jugador que le toca, no al que movió', async (t) => {
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

  // Manuel (blancas) mueve: el aviso de turno debe ir a Fernan (negras).
  await request(white, 'corespon:move', { code: room.code, from: [6, 4], to: [4, 4] });
  await wait(60);

  const turnos = (await store.getNotificacionesPendientes())
    .filter(n => n.tipo === 'turno');
  const fernanTurnos = turnos.filter(n => n.jugador === 'Fernan');
  // Manuel (blancas) movió, así que el turno ahora es de las negras: el aviso debe ir a Fernan.
  assert.ok(fernanTurnos.length >= 1, 'debe enviarse al menos un turno a Fernan tras la jugada de Manuel');
  assert.equal(turnos[turnos.length - 1].jugador, 'Fernan', 'el último aviso de turno debe ser para Fernan');
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
