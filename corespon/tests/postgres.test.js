'use strict';

/*
 * Pruebas del store de PostgreSQL usando pg-mem (Postgres en memoria).
 *
 * No sustituyen a una base real, pero ejecutan el esquema y todas las
 * consultas del store: es la única forma de detectar SQL inválido o columnas
 * desalineadas sin una instancia de Postgres.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');

const { createPostgresStore } = require('../server/db');

function crearStore() {
  const db = newDb();
  const store = createPostgresStore('postgres://pg-mem/aje', {
    quiet: true,
    pg: db.adapters.createPg()
  });
  return { db, store };
}

const ahora = Date.now();

function partida(overrides = {}) {
  return {
    roomCode: 'ABC234',
    blancas: 'Manuel',
    negras: 'Fernan',
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    pgn: null,
    snapshot: { version: 1, status: { over: false }, state: { turn: 'white' } },
    turno: 'blancas',
    estado: 'abierta',
    resultado: null,
    creadoEn: new Date(ahora).toISOString(),
    movidaEn: new Date(ahora).toISOString(),
    plazoHasta: new Date(ahora + 2 * 86400000).toISOString(),
    graciaHasta: new Date(ahora + 2 * 86400000 + 3600000).toISOString(),
    prorrogas: [],
    ultimaProrrogaHasta: null,
    ...overrides
  };
}

function resultado(overrides = {}) {
  return {
    blancas: 'Manuel',
    negras: 'Fernan',
    resultado: 'blancas',
    pgn: '1. e4 e5',
    duracionMs: 120000,
    movimientos: 2,
    prorrogas: 1,
    terminoPor: 'renuncia',
    terminadoEn: new Date(ahora).toISOString(),
    parentRoom: null,
    ...overrides
  };
}

test('postgres: esquema y roster con administrador', async () => {
  const { store } = crearStore();

  await store.initRoster(['Manuel', 'Fernan', 'Abuelo'], ['Abuelo']);
  let players = await store.getPlayers();
  assert.equal(players.length, 3);

  const abuelo = players.find(p => p.nombre === 'Abuelo');
  assert.equal(abuelo.admin, true);
  assert.equal(players.find(p => p.nombre === 'Manuel').admin, false);

  // Un administrador existente nunca se degrada.
  await store.initRoster(['Manuel', 'Abuelo'], ['Manuel']);
  players = await store.getPlayers();
  assert.equal(players.find(p => p.nombre === 'Abuelo').admin, true);
  assert.equal(players.find(p => p.nombre === 'Manuel').admin, true);

  const actualizado = await store.updatePlayer('manuel', { whatsapp: '+34600000000' });
  assert.equal(actualizado.whatsapp, '+34600000000');
  assert.equal(await store.updatePlayer('nadie', { whatsapp: '+34' }), null);

  const roster = await store.initRoster(['Manuel', 'Fernan', 'Abuelo']);
  assert.equal(roster.length, 3);
  assert.equal(roster.find(p => p.nombre === 'Manuel').whatsapp, '+34600000000');

  await store.close();
});

test('postgres: partidas, snapshot y borrado', async () => {
  const { store } = crearStore();
  await store.initRoster(['Manuel', 'Fernan']);

  await store.savePartida(partida());
  await store.savePartida(partida({
    roomCode: 'XYZ789', blancas: 'Fernan', negras: 'Manuel',
    turno: 'negras', estado: 'terminada', resultado: 'tablas'
  }));

  const abiertas = await store.getPartidasAbiertas();
  assert.equal(abiertas.length, 1);
  assert.equal(abiertas[0].roomCode, 'ABC234');
  assert.equal(typeof abiertas[0].snapshot, 'object');
  assert.equal(abiertas[0].snapshot.status.over, false);

  const porCodigo = await store.getPartidaPorCodigo('XYZ789');
  assert.equal(porCodigo.estado, 'terminada');
  assert.equal(porCodigo.resultado, 'tablas');
  assert.equal(await store.getPartidaPorCodigo('NOEXIS'), null);

  // upsert: mismo room_code actualiza, no duplica
  await store.savePartida(partida({ turno: 'negras', pgn: '1. e4' }));
  const todas = await store.getPartidas();
  assert.equal(todas.length, 2);
  assert.equal(todas.find(p => p.roomCode === 'ABC234').turno, 'negras');

  const deManuel = await store.getPartidasPorJugador('Manuel');
  assert.equal(deManuel.length, 1);

  await store.deletePartida('ABC234');
  assert.equal(await store.getPartidaPorCodigo('ABC234'), null);

  await store.close();
});

test('postgres: resultados y clasificación', async () => {
  const { store } = crearStore();
  await store.initRoster(['Manuel', 'Fernan']);

  await store.saveResultado(resultado());
  await store.saveResultado(resultado({
    resultado: 'tablas', terminoPor: 'acuerdo',
    terminadoEn: new Date(ahora + 1000).toISOString()
  }));

  const resultados = await store.getResultados();
  assert.equal(resultados.length, 2);
  assert.equal(resultados[0].terminoPor, 'renuncia');
  assert.equal(resultados[1].duracionMs, 120000);
  assert.equal(resultados[1].parentRoom, null);

  const pareja = await store.getPartidasTerminadasPorPareja('Fernan', 'Manuel');
  assert.equal(pareja.length, 2);

  const stats = await store.obtenerEstadisticas();
  assert.equal(stats.partidasTotales, 2);
  assert.equal(stats.jugadores, 2);
  assert.equal(stats.partidasAbiertas, 0);

  await store.close();
});

test('postgres: prórrogas', async () => {
  const { store } = crearStore();

  const prorroga = await store.addProrroga({
    roomCode: 'ABC234',
    jugador: 'Manuel',
    motivo: 'solicitud',
    solicitadoEn: new Date(ahora).toISOString(),
    concedidaEn: new Date(ahora + 100).toISOString(),
    nuevaFecha: new Date(ahora + 86400000).toISOString()
  });

  assert.ok(prorroga.id > 0);
  assert.equal(prorroga.roomCode, 'ABC234');

  const lista = await store.getProrrogasDePartida('ABC234');
  assert.equal(lista.length, 1);
  assert.equal(lista[0].jugador, 'Manuel');
  assert.equal(lista[0].motivo, 'solicitud');

  await store.close();
});

test('postgres: cola de notificaciones con reintentos', async () => {
  const { store } = crearStore();

  const notif = await store.addNotificacion({
    roomCode: 'ABC234',
    tipo: 'turno',
    destinatario: '+34600000000',
    jugador: 'Manuel',
    texto: 'Te toca mover en ABC234'
  });

  assert.ok(notif.id > 0);
  assert.equal(notif.estado, 'pendiente');
  assert.equal(notif.intentos, 0);

  let pendientes = await store.getNotificacionesPendientes();
  assert.equal(pendientes.length, 1);
  assert.match(pendientes[0].texto, /ABC234/);

  // Fallo con backoff: sigue pendiente pero no se reintenta aún.
  const futuro = new Date(Date.now() + 60000).toISOString();
  let actualizada = await store.marcaNotificacionComoEnviada(notif.id, 'sin red', futuro);
  assert.equal(actualizada.estado, 'pendiente');
  assert.equal(actualizada.intentos, 1);
  assert.equal(actualizada.error, 'sin red');
  assert.equal(actualizada.proximoIntento, futuro);

  pendientes = await store.getNotificacionesPendientes();
  assert.equal(pendientes.length, 0);

  const recientes = await store.getNotificacionesRecientes(10, 'pendiente');
  assert.equal(recientes.length, 1);

  // Éxito: enviado y fuera de la cola.
  actualizada = await store.marcaNotificacionComoEnviada(notif.id, null);
  assert.equal(actualizada.estado, 'enviado');
  assert.equal(actualizada.intentos, 2);
  assert.ok(actualizada.enviadoEn);

  const resumen = await store.resumenNotificaciones();
  assert.deepEqual(resumen, { pendiente: 0, enviado: 1, fallido: 0 });

  // Fallo definitivo (sin próxima fecha).
  const otra = await store.addNotificacion({
    roomCode: 'ABC234', tipo: 'fin', jugador: 'Fernan', texto: 'Fin'
  });
  const fallida = await store.marcaNotificacionComoEnviada(otra.id, 'telegram caido');
  assert.equal(fallida.estado, 'fallido');
  assert.equal(fallida.proximoIntento, null);

  assert.deepEqual(await store.resumenNotificaciones(), {
    pendiente: 0, enviado: 1, fallido: 1
  });
  assert.equal((await store.getNotificacionesRecientes(10, 'enviado')).length, 1);
  assert.equal((await store.getNotificacionesRecientes(10, 'fallido')).length, 1);

  await store.close();
});
