'use strict';

/*
 * Pruebas del canal de notificaciones: formato de los mensajes, resolución de
 * chats de Telegram y cola de envío con un proveedor falso.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { Room } = require('../server/rooms');
const { createMemoryStore } = require('../server/db');
const {
  WhatsAppGateway, formatMessage, telegramHtml, telegramChatFor,
  invitacionMsg, turnoMsg, recordatorioMsg, prorrogaMsg, tiempoMsg, finMsg
} = require('../server/whatsapp');

test('formato: sustituye las variables sin anidarlas', async () => {
  const texto = await formatMessage('turno', {
    jugador: 'Manuel', code: 'ABC234', tiempo: '1d 5h', host: 'https://aje.example'
  }, 'https://aje.example');

  assert.match(texto, /Manuel/);
  assert.match(texto, /ABC234/);
  assert.match(texto, /1d 5h/);
  assert.match(texto, /https:\/\/aje\.example\/corespon\/ABC234/);
  assert.doesNotMatch(texto, /\$\{/);
});

test('mensajes: el turno incluye jugador, código y plazo real', () => {
  const room = new Room('ABC234', 'Manuel', 'Fernan');
  const { tipo, vars } = turnoMsg(room, 'white', 'https://aje.example');

  assert.equal(tipo, 'turno');
  assert.equal(vars.jugador, 'Manuel');
  assert.equal(vars.code, 'ABC234');
  assert.equal(typeof vars.tiempo, 'string');
  assert.ok(vars.tiempo.length > 0);
  assert.notEqual(vars.tiempo, 'undefined');
});

test('mensajes: invitación, recordatorio, prórroga y tiempo', () => {
  const room = new Room('ABC234', 'Manuel', 'Fernan');

  const invitacion = invitacionMsg(room, 'black', 'https://aje.example').vars;
  assert.equal(invitacion.rival, 'Manuel');
  assert.equal(invitacion.jugador, 'Fernan');

  const recordatorio = recordatorioMsg(room, 'white', 'https://aje.example').vars;
  assert.equal(recordatorio.jugador, 'Manuel');
  assert.ok(recordatorio.tiempo.length > 0);

  const prorroga = prorrogaMsg(room, 'white', 'https://aje.example').vars;
  assert.equal(prorroga.jugador, 'Manuel');
  assert.match(prorroga.fecha, /\d{2}\/\d{2}/);

  const tiempo = tiempoMsg(room, 'white', 'https://aje.example').vars;
  assert.equal(tiempo.jugador, 'Manuel');
  assert.equal(tiempo.rival, 'Fernan');
});

test('mensajes: resultado con ganador y con tablas', () => {
  const room = new Room('ABC234', 'Manuel', 'Fernan');
  room.rendir('black');
  assert.equal(finMsg(room, 'https://aje.example').vars.resultado, 'Manuel gana');

  const tablas = new Room('ABC235', 'Manuel', 'Fernan');
  tablas.status = { over: true, reason: 'stalemate', winner: null, inCheck: false };
  assert.equal(finMsg(tablas, 'https://aje.example').vars.resultado, 'Tablas');
});

test('telegram: convierte el marcado a HTML seguro', () => {
  assert.equal(
    telegramHtml('♟ *Te toca mover*\nEntra en https://x/corespon?j=1&x=2'),
    '♟ <b>Te toca mover</b>\nEntra en https://x/corespon?j=1&amp;x=2'
  );
  assert.equal(telegramHtml('<script>'), '&lt;script&gt;');
});

test('telegram: chat por jugador con caída al grupo', () => {
  const previo = {
    grupo: process.env.TELEGRAM_CHAT_ID,
    manuel: process.env.TELEGRAM_CHAT_MANUEL
  };
  process.env.TELEGRAM_CHAT_ID = '-100999';
  process.env.TELEGRAM_CHAT_MANUEL = '111';
  delete process.env.TELEGRAM_CHAT_ALVARO;

  try {
    assert.equal(telegramChatFor('Manuel'), '111');
    assert.equal(telegramChatFor('Alvaro'), '-100999');
    assert.equal(telegramChatFor(null), '-100999');
    assert.equal(telegramChatFor('Abuelo'), '-100999');
  } finally {
    if (previo.grupo === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = previo.grupo;
    if (previo.manuel === undefined) delete process.env.TELEGRAM_CHAT_MANUEL;
    else process.env.TELEGRAM_CHAT_MANUEL = previo.manuel;
  }
});

test('cola: encola el texto renderizado y lo envía una sola vez', async () => {
  const store = createMemoryStore();
  const enviados = [];
  const gateway = new WhatsAppGateway({
    store,
    providerName: 'fake',
    provider: async (text, destino) => {
      enviados.push({ text, destino });
      return { id: 'mensaje-1' };
    }
  });

  const room = new Room('ABC234', 'Manuel', 'Fernan');
  await gateway.enqueue(
    room.code, 'turno',
    { nombre: 'Manuel', whatsapp: '+34600000000' },
    turnoMsg(room, 'white', 'https://aje.example').vars,
    'https://aje.example'
  );

  const pendientes = await store.getNotificacionesPendientes();
  assert.equal(pendientes.length, 1);
  assert.equal(pendientes[0].jugador, 'Manuel');
  assert.equal(pendientes[0].destinatario, '+34600000000');
  assert.match(pendientes[0].texto, /Manuel/);
  assert.match(pendientes[0].texto, /ABC234/);

  const primero = await gateway.processQueue();
  assert.equal(primero.processed, 1);
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].destino.nombre, 'Manuel');
  assert.match(enviados[0].text, /ABC234/);

  const segundo = await gateway.processQueue();
  assert.equal(segundo.processed, 0);
  assert.equal(enviados.length, 1);
});

test('cola: sin Telegram configurado no se encola nada', async () => {
  const previo = {
    token: process.env.TELEGRAM_BOT_TOKEN,
    chat: process.env.TELEGRAM_CHAT_ID
  };
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;

  try {
    const store = createMemoryStore();
    const gateway = new WhatsAppGateway({ store, providerName: 'telegram' });
    const room = new Room('ABC234', 'Manuel', 'Fernan');
    const result = await gateway.enqueue(
      room.code, 'turno', { nombre: 'Manuel' }, turnoMsg(room, 'white', 'https://x').vars, 'https://x'
    );
    assert.equal(result, null);
    assert.equal((await store.getNotificacionesPendientes()).length, 0);
  } finally {
    if (previo.token !== undefined) process.env.TELEGRAM_BOT_TOKEN = previo.token;
    if (previo.chat !== undefined) process.env.TELEGRAM_CHAT_ID = previo.chat;
  }
});

test('cola: reintenta con backoff y acaba en fallido', async () => {
  const store = createMemoryStore();
  let intentos = 0;
  const gateway = new WhatsAppGateway({
    store,
    providerName: 'fake',
    retryDelaysMs: [0, 0],
    provider: async () => {
      intentos += 1;
      throw new Error('telegram caido');
    }
  });

  const room = new Room('ABC234', 'Manuel', 'Fernan');
  await gateway.enqueue(
    room.code, 'turno', { nombre: 'Manuel' },
    turnoMsg(room, 'white', 'https://x').vars, 'https://x'
  );

  await gateway.processQueue();
  let [notif] = await store.getNotificacionesRecientes(10);
  assert.equal(notif.estado, 'pendiente');
  assert.equal(notif.intentos, 1);
  assert.match(notif.error, /telegram caido/);

  await gateway.processQueue();
  [notif] = await store.getNotificacionesRecientes(10);
  assert.equal(notif.estado, 'pendiente');
  assert.equal(notif.intentos, 2);

  await gateway.processQueue();
  [notif] = await store.getNotificacionesRecientes(10);
  assert.equal(notif.estado, 'fallido');
  assert.equal(notif.intentos, 3);
  assert.equal((await store.getNotificacionesPendientes()).length, 0);
  assert.deepEqual(await store.resumenNotificaciones(), { pendiente: 0, enviado: 0, fallido: 1 });
  assert.equal(intentos, 3);
});

test('cola: el backoff evita reintentos inmediatos', async () => {
  const store = createMemoryStore();
  const gateway = new WhatsAppGateway({
    store,
    providerName: 'fake',
    provider: async () => { throw new Error('sin red'); }
  });

  const room = new Room('ABC234', 'Manuel', 'Fernan');
  await gateway.enqueue(
    room.code, 'turno', { nombre: 'Manuel' },
    turnoMsg(room, 'white', 'https://x').vars, 'https://x'
  );

  await gateway.processQueue();
  const [notif] = await store.getNotificacionesRecientes(10);
  assert.equal(notif.estado, 'pendiente');
  assert.ok(Date.parse(notif.proximoIntento) > Date.now() + 30 * 1000);

  assert.equal((await store.getNotificacionesPendientes()).length, 0);
  assert.equal((await gateway.processQueue()).processed, 0);
});

test('cola: el resumen cuenta pendientes, enviados y fallidos', async () => {
  const store = createMemoryStore();
  const room = new Room('ABC234', 'Manuel', 'Fernan');
  const base = turnoMsg(room, 'white', 'https://x').vars;

  const gateway = new WhatsAppGateway({
    store,
    providerName: 'fake',
    retryDelaysMs: [],
    maxIntentos: 1,
    provider: async (text, destino) => {
      if (destino.nombre === 'Fernan') throw new Error('no');
      return { id: '1' };
    }
  });

  await gateway.enqueue(room.code, 'turno', { nombre: 'Manuel' }, base, 'https://x');
  await gateway.enqueue(room.code, 'turno', { nombre: 'Fernan' }, base, 'https://x');

  await gateway.processQueue();

  assert.deepEqual(await store.resumenNotificaciones(), { pendiente: 0, enviado: 1, fallido: 1 });
  assert.equal((await store.getNotificacionesRecientes(10, 'enviado')).length, 1);
  assert.equal((await store.getNotificacionesRecientes(10, 'fallido')).length, 1);
});

test('cola: un fallo al guardar el estado no rechaza processQueue', async () => {
  const store = createMemoryStore();
  const gateway = new WhatsAppGateway({
    store,
    providerName: 'fake',
    provider: async () => ({ id: '1' })
  });

  const room = new Room('ABC234', 'Manuel', 'Fernan');
  await gateway.enqueue(
    room.code, 'turno', { nombre: 'Manuel' },
    turnoMsg(room, 'white', 'https://x').vars, 'https://x'
  );

  const original = store.marcaNotificacionComoEnviada;
  store.marcaNotificacionComoEnviada = async () => {
    throw new Error('db caida');
  };

  const res = await gateway.processQueue();
  assert.equal(res.processed, 1);
  assert.equal(res.results[0].ok, true);

  store.marcaNotificacionComoEnviada = original;
});
