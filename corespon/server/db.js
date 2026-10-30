'use strict';

/*
 * Almacenamiento de la correspondencia.
 *
 * - Con DATABASE_URL usa PostgreSQL (Neon, Supabase, Render…).
 * - Sin DATABASE_URL, o si la conexión falla, guarda en memoria para que la
 *   aplicación siga funcionando (los datos se pierden al reiniciar).
 *
 * Tablas:
 *  - corespon_players     : lista fija de jugadores invitados.
 *  - corespon_partidas    : partida en curso / terminada.
 *  - corespon_prorrogas   : solicitudes de ampliación de plazo.
 *  - corespon_notificaciones : registro de notificaciones WhatsApp enviadas.
 *  - corespon_clasificacion : tabla de clasificación derivada (se recalcula).
 *
 * La interfaz es la misma en ambos casos, así que el resto del servidor no
 * necesita saber cuál está activo.
 */

const MAX_PLAYERS = 6;
const MIN_PLAYERS = 2;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS corespon_players (
     id TEXT PRIMARY KEY,
     nombre TEXT NOT NULL UNIQUE,
     activa BOOLEAN NOT NULL DEFAULT TRUE,
     admin BOOLEAN NOT NULL DEFAULT FALSE,
     whatsapp TEXT,
     creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  `ALTER TABLE corespon_players ADD COLUMN IF NOT EXISTS admin BOOLEAN NOT NULL DEFAULT FALSE`,

  `CREATE TABLE IF NOT EXISTS corespon_partidas (
     room_code TEXT PRIMARY KEY,
     blancas TEXT NOT NULL,
     negras TEXT NOT NULL,
     fen TEXT,
     pgn TEXT,
     turno TEXT NOT NULL,          -- 'blancas' | 'negras'
     estado TEXT NOT NULL,         -- 'abierta' | 'terminada' | 'cancelada'
     resultado TEXT,               -- 'blancas' | 'negras' | 'tablas'
     creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
     movida_en TIMESTAMPTZ,
     plazo_hasta TIMESTAMPTZ NOT NULL,
     gracia_hasta TIMESTAMPTZ,
     prorrogas JSONB NOT NULL DEFAULT '[]'::jsonb,
     ultima_prorroga_hasta TIMESTAMPTZ
   )`,

  // Estado completo de la sala (tablero, historial, plazos, tokens) para poder
  // restaurar una partida tras un reinicio del servidor.
  `ALTER TABLE corespon_partidas ADD COLUMN IF NOT EXISTS snapshot JSONB`,

  `CREATE TABLE IF NOT EXISTS corespon_prorrogas (
     id BIGSERIAL PRIMARY KEY,
     room_code TEXT NOT NULL,
     jugador TEXT NOT NULL,
     motivo TEXT,
     solicitado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
     concedida_en TIMESTAMPTZ,
     nueva_fecha TIMESTAMPTZ NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS corespon_notificaciones (
     id BIGSERIAL PRIMARY KEY,
     room_code TEXT,
     tipo TEXT NOT NULL,           -- 'invitacion' | 'turno' | 'recordatorio' | 'prorroga' | 'tiempo' | 'fin'
     destinatario TEXT,
     jugador TEXT,
     texto TEXT,
     estado TEXT NOT NULL DEFAULT 'pendiente',  -- 'pendiente' | 'enviado' | 'fallido'
     intentos INT NOT NULL DEFAULT 0,
     proximo_intento TIMESTAMPTZ,   -- backoff: no reintentar antes de esta hora
     ultimo_intento TIMESTAMPTZ,
     enviado_en TIMESTAMPTZ,
     error TEXT
   )`,

  `ALTER TABLE corespon_notificaciones ADD COLUMN IF NOT EXISTS jugador TEXT`,
  `ALTER TABLE corespon_notificaciones ADD COLUMN IF NOT EXISTS texto TEXT`,
  `ALTER TABLE corespon_notificaciones ADD COLUMN IF NOT EXISTS intentos INT NOT NULL DEFAULT 0`,
  `ALTER TABLE corespon_notificaciones ADD COLUMN IF NOT EXISTS proximo_intento TIMESTAMPTZ`,
  `ALTER TABLE corespon_notificaciones ADD COLUMN IF NOT EXISTS ultimo_intento TIMESTAMPTZ`,

  `CREATE TABLE IF NOT EXISTS corespon_resultados (
     blancas TEXT NOT NULL,
     negras TEXT NOT NULL,
     resultado TEXT NOT NULL,      -- 'blancas' | 'negras' | 'tablas'
     pgn TEXT,
     duracion_ms BIGINT,
     movimientos INT,
     prorrogas INT DEFAULT 0,
     termino_por TEXT,             -- 'jugada' | 'renuncia' | 'tiempo'
     terminado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
     parent_room TEXT,             -- room_code de la partida anterior (revancha)
     PRIMARY KEY (blancas, negras, terminado_en)
   )`,

  `CREATE INDEX IF NOT EXISTS idx_corespon_partidas_estado ON corespon_partidas (estado)`
];

// ============================ ALMACENAMIENTO EN MEMORIA ============================

function iso(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function pick(record, snake, camel) {
  return record[snake] !== undefined ? record[snake] : record[camel];
}

function emptyPlayer(record) {
  return {
    id: record.id,
    nombre: record.nombre,
    activa: !!record.activa,
    admin: !!record.admin,
    whatsapp: record.whatsapp || null,
    creadoEn: iso(record.creadoEn || record.creado_en)
  };
}

function emptyPartida(record) {
  return {
    roomCode: record.room_code || record.roomCode,
    blancas: record.blancas,
    negras: record.negras,
    fen: record.fen || null,
    pgn: record.pgn || null,
    snapshot: record.snapshot || null,
    turno: record.turno,
    estado: record.estado,
    resultado: record.resultado || null,
    creadoEn: iso(pick(record, 'creado_en', 'creadoEn')),
    movidaEn: iso(pick(record, 'movida_en', 'movidaEn')),
    plazoHasta: iso(pick(record, 'plazo_hasta', 'plazoHasta')),
    graciaHasta: iso(pick(record, 'gracia_hasta', 'graciaHasta')),
    prorrogas: Array.isArray(record.prorrogas) ? record.prorrogas : [],
    ultimaProrrogaHasta: iso(pick(record, 'ultima_prorroga_hasta', 'ultimaProrrogaHasta'))
  };
}

function emptyProrroga(record) {
  return {
    id: record.id,
    roomCode: record.room_code,
    jugador: record.jugador,
    motivo: record.motivo || null,
    solicitadoEn: iso(record.solicitadoEn || record.solicitado_en),
    concedidaEn: record.concedidaEn ? new Date(record.concedida_en).toISOString() : null,
    nuevaFecha: record.nuevaFecha ? new Date(record.nueva_fecha).toISOString() : null
  };
}

function emptyNotificacion(record) {
  return {
    id: record.id,
    roomCode: record.roomCode || record.room_code || null,
    tipo: record.tipo,
    destinatario: record.destinatario || null,
    jugador: record.jugador || null,
    texto: record.texto || null,
    estado: record.estado,
    intentos: Number(record.intentos || 0),
    proximoIntento: iso(record.proximoIntento || record.proximo_intento),
    ultimoIntento: iso(record.ultimoIntento || record.ultimo_intento),
    enviadoEn: iso(record.enviadoEn || record.enviado_en),
    error: record.error || null
  };
}

function emptyResultado(record) {
  return {
    blancas: record.blancas,
    negras: record.negras,
    resultado: record.resultado,
    pgn: record.pgn || null,
    duracionMs: Number.isFinite(record.duracionMs) ? record.duracionMs
      : Number.isFinite(record.duracion_ms) ? record.duracion_ms : null,
    movimientos: Number.isFinite(record.movimientos) ? record.movimientos : null,
    prorrogas: Number.isFinite(record.prorrogas) ? record.prorrogas : 0,
    terminoPor: record.terminoPor || record.termino_por || 'jugada',
    terminadoEn: iso(record.terminadoEn || record.terminado_en),
    parentRoom: record.parentRoom || record.parent_room || null
  };
}

function createMemoryStore() {
  const players = new Map();
  const partidas = new Map();
  const prorrogas = [];
  const notificaciones = [];
  const resultados = [];
  let notificacionSeq = 0;

  return {
    kind: 'memory',
    init: async () => {},
    close: async () => {},

    // --- Jugadores ---
    async getPlayers() {
      return Array.from(players.values()).map(emptyPlayer);
    },

    async initRoster(names, adminNames = []) {
      const admins = new Set(adminNames.map(nombre => nombre.toLowerCase()));
      for (const nombre of names) {
        const id = nombre.toLowerCase();
        const esAdmin = admins.has(id);
        if (!players.has(id)) {
          players.set(id, emptyPlayer({
            id, nombre, activa: true, admin: esAdmin, whatsapp: null,
            creadoEn: new Date().toISOString()
          }));
        } else if (esAdmin && !players.get(id).admin) {
          // Nunca se degrada a un administrador existente.
          players.get(id).admin = true;
        }
      }
      return Array.from(players.values()).map(emptyPlayer);
    },

    async savePlayer(player) {
      players.set(player.id, player);
      return player;
    },

    async updatePlayer(id, updates) {
      const player = players.get(id);
      if (!player) return null;
      Object.assign(player, updates);
      return player;
    },

    // --- Partidas ---
    async getPartidas() {
      return Array.from(partidas.values()).map(emptyPartida);
    },

    async getPartidaPorCodigo(roomCode) {
      const p = partidas.get(roomCode);
      return p ? emptyPartida(p) : null;
    },

    async savePartida(partida) {
      // Copia profunda: el snapshot no debe compartir referencias con la sala
      // viva (en modo memoria el proceso sigue mutando el mismo objeto).
      const record = structuredClone(partida);
      partidas.set(record.roomCode, record);
      return record;
    },

    async deletePartida(roomCode) {
      partidas.delete(roomCode);
    },

    async getPartidasAbiertas() {
      return Array.from(partidas.values())
        .filter(p => p.estado === 'abierta')
        .map(emptyPartida);
    },

    async getPartidasPorJugador(jugador) {
      return Array.from(partidas.values())
        .filter(p => p.estado === 'abierta' && (p.blancas === jugador || p.negras === jugador))
        .map(emptyPartida);
    },

    // --- Resultados ---
    async saveResultado(resultado) {
      const record = {
        blancas: resultado.blancas,
        negras: resultado.negras,
        resultado: resultado.resultado,
        pgn: resultado.pgn || null,
        duracionMs: Number.isFinite(resultado.duracionMs) ? resultado.duracionMs : null,
        movimientos: Number.isFinite(resultado.movimientos) ? resultado.movimientos : null,
        prorrogas: Number.isFinite(resultado.prorrogas) ? resultado.prorrogas : 0,
        terminoPor: resultado.terminoPor || 'jugada',
        terminadoEn: resultado.terminadoEn || new Date().toISOString(),
        parentRoom: resultado.parentRoom || null
      };
      resultados.push(record);
      return emptyResultado(record);
    },

    async getResultados() {
      return resultados
        .slice()
        .sort((a, b) => new Date(a.terminadoEn) - new Date(b.terminadoEn))
        .map(emptyResultado);
    },

    async getPartidasTerminadasPorPareja(blancas, negras) {
      return resultados
        .filter(r => (r.blancas === blancas && r.negras === negras)
          || (r.blancas === negras && r.negras === blancas))
        .map(emptyResultado);
    },

    // --- Prórrogas ---
    async getProrrogasDePartida(roomCode) {
      return prorrogas
        .filter(p => p.roomCode === roomCode)
        .map(emptyProrroga);
    },

    async addProrroga(prorroga) {
      prorrogas.push({ ...prorroga });
      return prorroga;
    },

    // --- Notificaciones ---
    async addNotificacion(notif) {
      const record = {
        id: ++notificacionSeq,
        roomCode: notif.roomCode || null,
        tipo: notif.tipo,
        destinatario: notif.destinatario || null,
        jugador: notif.jugador || null,
        texto: notif.texto || null,
        estado: 'pendiente',
        intentos: 0,
        proximoIntento: null,
        ultimoIntento: null,
        enviadoEn: null,
        error: null
      };
      notificaciones.push(record);
      return emptyNotificacion(record);
    },

    async getNotificacionesPendientes(limit = 200) {
      const ahora = Date.now();
      return notificaciones
        .filter(n => n.estado === 'pendiente')
        .filter(n => !n.proximoIntento || Date.parse(n.proximoIntento) <= ahora)
        .sort((a, b) => a.id - b.id)
        .slice(0, limit)
        .map(emptyNotificacion);
    },

    async getNotificacionesRecientes(limit = 100, estado = null) {
      return notificaciones
        .filter(n => !estado || n.estado === estado)
        .sort((a, b) => b.id - a.id)
        .slice(0, limit)
        .map(emptyNotificacion);
    },

    async resumenNotificaciones() {
      const resumen = { pendiente: 0, enviado: 0, fallido: 0 };
      for (const n of notificaciones) {
        if (resumen[n.estado] !== undefined) resumen[n.estado] += 1;
      }
      return resumen;
    },

    /*
     * Registra el resultado de un intento. Sin error -> enviado; con error y
     * `proximoIntento` -> sigue pendiente (backoff); con error y sin fecha ->
     * fallido definitivo. Devuelve la notificación actualizada.
     */
    async marcaNotificacionComoEnviada(id, error = null, proximoIntento = null) {
      const n = notificaciones.find(x => x.id === id);
      if (!n) return null;

      const ahora = new Date().toISOString();
      n.intentos = (n.intentos || 0) + 1;
      n.ultimoIntento = ahora;
      n.error = error || null;

      if (!error) {
        n.estado = 'enviado';
        n.proximoIntento = null;
        n.enviadoEn = ahora;
      } else if (proximoIntento) {
        n.estado = 'pendiente';
        n.proximoIntento = proximoIntento;
      } else {
        n.estado = 'fallido';
        n.proximoIntento = null;
        n.enviadoEn = ahora;
      }
      return emptyNotificacion(n);
    },

    // --- Estadísticas ---
    async obtenerEstadisticas() {
      return {
        partidasAbiertas: Array.from(partidas.values()).filter(p => p.estado === 'abierta').length,
        partidasTotales: resultados.length,
        jugadores: players.size,
        notificacionesPendientes: notificaciones.filter(n => n.estado === 'pendiente').length
      };
    }
  };
}

// ============================ ALMACENAMIENTO POSTGRES ============================

function createPostgresStore(connectionString, options = {}) {
  // `options.pg` permite inyectar un adaptador compatible (pruebas con pg-mem).
  // eslint-disable-next-line global-require
  const { Pool } = options.pg || require('pg');
  const local = /localhost|127\.0\.0\.1/.test(connectionString);
  const pool = new Pool({
    connectionString,
    ssl: local ? false : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX) || 4,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  pool.on('error', (error) => {
    if (!options.quiet) console.error('PostgreSQL (pool):', error.message);
  });

  let ready = null;
  function init() {
    if (!ready) {
      ready = (async () => {
        for (const statement of SCHEMA) {
          await pool.query(statement);
        }
      })();
    }
    return ready;
  }

  function toDate(v) {
    return v ? new Date(v) : null;
  }

  return {
    kind: 'postgres',
    init,
    async close() {
      await pool.end().catch(() => {});
    },

    // --- Jugadores ---
    async getPlayers() {
      await init();
      const { rows } = await pool.query(
        `SELECT id, nombre, activa, admin, whatsapp, creado_en FROM corespon_players ORDER BY nombre`
      );
      return rows.map(emptyPlayer);
    },

    async savePlayer(player) {
      await init();
      const { rows } = await pool.query(
        `INSERT INTO corespon_players (id, nombre, activa, admin, whatsapp)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET nombre = EXCLUDED.nombre, activa = EXCLUDED.activa,
           admin = (corespon_players.admin OR EXCLUDED.admin), whatsapp = EXCLUDED.whatsapp
         RETURNING id, nombre, activa, admin, whatsapp, creado_en`,
        [player.id, player.nombre, player.activa, !!player.admin, player.whatsapp || null]
      );
      return emptyPlayer(rows[0]);
    },

    async updatePlayer(id, updates) {
      await init();
      if (updates.whatsapp !== undefined) {
        const { rows } = await pool.query(
          `UPDATE corespon_players SET whatsapp = $2, nombre = COALESCE(nombre, $3)
           WHERE id = $1 RETURNING id, nombre, activa, admin, whatsapp, creado_en`,
          [id, updates.whatsapp, updates.nombre]
        );
        return rows.length ? emptyPlayer(rows[0]) : null;
      }
      return null;
    },

    async initRoster(names, adminNames = []) {
      await init();
      const admins = new Set(adminNames.map(nombre => nombre.toLowerCase()));

      // BEGIN/COMMIT deben ir por la misma conexión: pool.query() puede
      // repartirlas entre clientes distintos y dejar el roster a medias.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const nombre of names) {
          const id = nombre.toLowerCase();
          await client.query(
            `INSERT INTO corespon_players (id, nombre, activa, admin)
             VALUES ($1, $2, TRUE, $3)
             ON CONFLICT (id) DO UPDATE SET admin = (corespon_players.admin OR EXCLUDED.admin)`,
            [id, nombre, admins.has(id)]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      return this.getPlayers();
    },

    // --- Partidas ---
    async getPartidas() {
      await init();
      const { rows } = await pool.query(
        `SELECT * FROM corespon_partidas ORDER BY creado_en DESC`
      );
      return rows.map(emptyPartida);
    },

    async getPartidaPorCodigo(roomCode) {
      await init();
      const { rows } = await pool.query(
        `SELECT * FROM corespon_partidas WHERE room_code = $1`,
        [roomCode]
      );
      return rows.length ? emptyPartida(rows[0]) : null;
    },

    async savePartida(partida) {
      await init();
      const { rows } = await pool.query(
        `INSERT INTO corespon_partidas
          (room_code, blancas, negras, fen, pgn, snapshot, turno, estado, resultado,
           creado_en, movida_en, plazo_hasta, gracia_hasta, prorrogas, ultima_prorroga_hasta)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (room_code) DO UPDATE SET
           fen = EXCLUDED.fen, pgn = EXCLUDED.pgn, snapshot = EXCLUDED.snapshot,
           turno = EXCLUDED.turno,
           estado = EXCLUDED.estado, resultado = EXCLUDED.resultado,
           movida_en = EXCLUDED.movida_en, plazo_hasta = EXCLUDED.plazo_hasta,
           gracia_hasta = EXCLUDED.gracia_hasta, prorrogas = EXCLUDED.prorrogas,
           ultima_prorroga_hasta = EXCLUDED.ultima_prorroga_hasta
         RETURNING *`,
        [
          partida.roomCode, partida.blancas, partida.negras, partida.fen || null,
          partida.pgn || null, partida.snapshot ? JSON.stringify(partida.snapshot) : null,
          partida.turno, partida.estado, partida.resultado || null,
          new Date(partida.creadoEn).toISOString(),
          partida.movidaEn ? new Date(partida.movidaEn).toISOString() : null,
          partida.plazoHasta ? new Date(partida.plazoHasta).toISOString() : null,
          partida.graciaHasta ? new Date(partida.graciaHasta).toISOString() : null,
          JSON.stringify(partida.prorrogas || []),
          partida.ultimaProrrogaHasta ? new Date(partida.ultimaProrrogaHasta).toISOString() : null
        ]
      );
      return emptyPartida(rows[0]);
    },

    async deletePartida(roomCode) {
      await init();
      await pool.query('DELETE FROM corespon_partidas WHERE room_code = $1', [roomCode]);
    },

    async getPartidasAbiertas() {
      await init();
      const { rows } = await pool.query(
        `SELECT * FROM corespon_partidas WHERE estado = 'abierta' ORDER BY creado_en`
      );
      return rows.map(emptyPartida);
    },

    async getPartidasPorJugador(jugador) {
      await init();
      const { rows } = await pool.query(
        `SELECT * FROM corespon_partidas
         WHERE estado = 'abierta' AND (blancas = $1 OR negras = $1)
         ORDER BY creado_en`,
        [jugador]
      );
      return rows.map(emptyPartida);
    },

    async getPartidasTerminadasPorPareja(blancas, negras) {
      await init();
      const { rows } = await pool.query(
        `SELECT * FROM corespon_resultados WHERE (blancas = $1 AND negras = $2)
         OR (blancas = $2 AND negras = $1) ORDER BY terminado_en DESC`,
        [blancas, negras]
      );
      return rows.map(emptyResultado);
    },

    async getResultados() {
      await init();
      const { rows } = await pool.query(
        `SELECT * FROM corespon_resultados ORDER BY terminado_en`
      );
      return rows.map(emptyResultado);
    },

    async saveResultado(resultado) {
      await init();
      await pool.query(
        `INSERT INTO corespon_resultados
          (blancas, negras, resultado, pgn, duracion_ms, movimientos, prorrogas, termino_por,
           terminado_en, parent_room)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          resultado.blancas, resultado.negras, resultado.resultado,
          resultado.pgn || null, resultado.duracionMs || null,
          resultado.movimientos || null, resultado.prorrogas || 0,
          resultado.terminoPor || 'jugada', resultado.terminadoEn || new Date().toISOString(),
          resultado.parentRoom || null
        ]
      );
    },

    // --- Prórrogas ---
    async getProrrogasDePartida(roomCode) {
      await init();
      const { rows } = await pool.query(
        `SELECT * FROM corespon_prorrogas WHERE room_code = $1 ORDER BY solicitado_en`,
        [roomCode]
      );
      return rows.map(emptyProrroga);
    },

    async addProrroga(prorroga) {
      await init();
      const { rows } = await pool.query(
        `INSERT INTO corespon_prorrogas
          (room_code, jugador, motivo, solicitado_en, concedida_en, nueva_fecha)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [
          prorroga.roomCode, prorroga.jugador, prorroga.motivo || null,
          prorroga.solicitadoEn ? new Date(prorroga.solicitadoEn).toISOString() : new Date().toISOString(),
          prorroga.concedidaEn ? new Date(prorroga.concedidaEn).toISOString() : null,
          prorroga.nuevaFecha ? new Date(prorroga.nuevaFecha).toISOString() : null
        ]
      );
      return emptyProrroga(rows[0]);
    },

    // --- Notificaciones ---
    async addNotificacion(notif) {
      await init();
      const { rows } = await pool.query(
        `INSERT INTO corespon_notificaciones
          (room_code, tipo, destinatario, jugador, texto, estado, intentos, enviado_en, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [notif.roomCode || null, notif.tipo, notif.destinatario || null,
         notif.jugador || null, notif.texto || null,
         notif.estado || 'pendiente', notif.intentos || 0,
         notif.enviadoEn || null, notif.error || null]
      );
      return emptyNotificacion(rows[0]);
    },

    async getNotificacionesPendientes(limit = 200) {
      await init();
      const { rows } = await pool.query(
        `SELECT * FROM corespon_notificaciones
         WHERE estado = 'pendiente'
           AND (proximo_intento IS NULL OR proximo_intento <= now())
         ORDER BY id ASC LIMIT $1`,
        [limit]
      );
      return rows.map(emptyNotificacion);
    },

    async getNotificacionesRecientes(limit = 100, estado = null) {
      await init();
      const { rows } = await pool.query(
        `SELECT * FROM corespon_notificaciones
         WHERE ($2::text IS NULL OR estado = $2)
         ORDER BY id DESC LIMIT $1`,
        [limit, estado || null]
      );
      return rows.map(emptyNotificacion);
    },

    async resumenNotificaciones() {
      await init();
      const { rows } = await pool.query(
        `SELECT estado, COUNT(*)::int AS total
         FROM corespon_notificaciones GROUP BY estado`
      );
      const resumen = { pendiente: 0, enviado: 0, fallido: 0 };
      for (const row of rows) {
        if (resumen[row.estado] !== undefined) resumen[row.estado] = row.total;
      }
      return resumen;
    },

    async marcaNotificacionComoEnviada(id, error = null, proximoIntento = null) {
      await init();
      const { rows } = await pool.query(
        `UPDATE corespon_notificaciones
         SET intentos = intentos + 1,
             ultimo_intento = now(),
             error = $2,
             estado = CASE
               WHEN $2 IS NULL THEN 'enviado'
               WHEN $3::timestamptz IS NOT NULL THEN 'pendiente'
               ELSE 'fallido'
             END,
             proximo_intento = $3::timestamptz,
             enviado_en = CASE WHEN $2 IS NULL OR $3::timestamptz IS NULL
                               THEN now() ELSE enviado_en END
         WHERE id = $1 RETURNING *`,
        [id, error || null, proximoIntento || null]
      );
      return rows.length ? emptyNotificacion(rows[0]) : null;
    },

    async obtenerEstadisticas() {
      await init();
      const [abiertas, totales, jugadores, pendientes] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS total FROM corespon_partidas WHERE estado = 'abierta'`),
        pool.query(`SELECT COUNT(*)::int AS total FROM corespon_resultados`),
        pool.query(`SELECT COUNT(*)::int AS total FROM corespon_players WHERE activa`),
        pool.query(`SELECT COUNT(*)::int AS total FROM corespon_notificaciones WHERE estado = 'pendiente'`)
      ]);
      const total = (res) => (res.rows[0] && res.rows[0].total) || 0;
      return {
        partidasAbiertas: total(abiertas),
        partidasTotales: total(totales),
        jugadores: total(jugadores),
        notificacionesPendientes: total(pendientes)
      };
    }
  };
}

function createStore(options = {}) {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString) {
    return createPostgresStore(connectionString, options);
  }
  return createMemoryStore();
}

module.exports = {
  MAX_PLAYERS,
  MIN_PLAYERS,
  SCHEMA,
  createMemoryStore,
  createPostgresStore,
  createStore
};
