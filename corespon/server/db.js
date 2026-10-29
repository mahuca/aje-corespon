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
     whatsapp TEXT,
     creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

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
     estado TEXT NOT NULL DEFAULT 'pendiente',  -- 'pendiente' | 'enviado' | 'fallido'
     enviado_en TIMESTAMPTZ,
     error TEXT
   )`,

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

function emptyPlayer(record) {
  return {
    id: record.id,
    nombre: record.nombre,
    activa: !!record.activa,
    whatsapp: record.whatsapp || null,
    creadoEn: record.creadoEn || new Date(record.creado_en).toISOString()
  };
}

function emptyPartida(record) {
  return {
    roomCode: record.room_code,
    blancas: record.blancas,
    negras: record.negras,
    fen: record.fen || null,
    pgn: record.pgn || null,
    turno: record.turno,
    estado: record.estado,
    resultado: record.resultado || null,
    creadoEn: record.creadoEn || new Date(record.creado_en).toISOString(),
    movidaEn: record.movidaEn || null,
    plazoHasta: record.plazoHasta ? new Date(record.plazo_hasta).toISOString() : null,
    graciaHasta: record.graciaHasta ? new Date(record.gracia_hasta).toISOString() : null,
    prorrogas: Array.isArray(record.prorrogas) ? record.prorrogas : [],
    ultimaProrrogaHasta: record.ultimaProrrogaHasta ? new Date(record.ultima_prorroga_hasta).toISOString() : null
  };
}

function emptyProrroga(record) {
  return {
    id: record.id,
    roomCode: record.room_code,
    jugador: record.jugador,
    motivo: record.motivo || null,
    solicitadoEn: record.solicitadoEn || new Date(record.solicitado_en).toISOString(),
    concedidaEn: record.concedidaEn ? new Date(record.concedida_en).toISOString() : null,
    nuevaFecha: record.nuevaFecha ? new Date(record.nueva_fecha).toISOString() : null
  };
}

function emptyNotificacion(record) {
  return {
    id: record.id,
    roomCode: record.room_code,
    tipo: record.tipo,
    destinatario: record.destinatario || null,
    estado: record.estado,
    enviadoEn: record.enviadoEn ? new Date(record.enviado_en).toISOString() : null,
    error: record.error || null
  };
}

function createMemoryStore() {
  const players = new Map();
  const partidas = new Map();
  const prorrogas = [];
  const notificaciones = [];

  return {
    kind: 'memory',
    init: async () => {},
    close: async () => {},

    // --- Jugadores ---
    async getPlayers() {
      return Array.from(players.values()).map(emptyPlayer);
    },

    async initRoster(names) {
      for (const nombre of names) {
        const id = nombre.toLowerCase();
        if (!players.has(id)) {
          players.set(id, emptyPlayer({
            id, nombre, activa: true, whatsapp: null,
            creadoEn: new Date().toISOString()
          }));
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
      partidas.set(partida.roomCode, { ...partida });
      return partida;
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
      notificaciones.push({ ...notif, estado: 'pendiente', enviadoEn: null, error: null });
      return notif;
    },

    async getNotificacionesPendientes(limit = 200) {
      return notificaciones
        .filter(n => n.estado === 'pendiente')
        .sort((a, b) => a.id - b.id)
        .slice(0, limit)
        .map(emptyNotificacion);
    },

    async marcaNotificacionComoEnviada(id, error = null) {
      const n = notificaciones.find(x => x.id === id);
      if (n) {
        n.estado = error ? 'fallido' : 'enviado';
        n.enviadoEn = new Date().toISOString();
        n.error = error;
      }
      return n;
    }
  };
}

// ============================ ALMACENAMIENTO POSTGRES ============================

function createPostgresStore(connectionString, options = {}) {
  // eslint-disable-next-line global-require
  const { Pool } = require('pg');
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
        `SELECT id, nombre, activa, whatsapp, creado_en FROM corespon_players ORDER BY nombre`
      );
      return rows.map(emptyPlayer);
    },

    async savePlayer(player) {
      await init();
      const { rows } = await pool.query(
        `INSERT INTO corespon_players (id, nombre, activa, whatsapp)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET nombre = EXCLUDED.nombre, activa = EXCLUDED.activa, whatsapp = EXCLUDED.whatsapp
         RETURNING id, nombre, activa, whatsapp, creado_en`,
        [player.id, player.nombre, player.activa, player.whatsapp]
      );
      return emptyPlayer(rows[0]);
    },

    async updatePlayer(id, updates) {
      await init();
      if (updates.whatsapp !== undefined) {
        const { rows } = await pool.query(
          `UPDATE corespon_players SET whatsapp = $2, nombre = COALESCE(nombre, $3)
           WHERE id = $1 RETURNING id, nombre, activa, whatsapp, creado_en`,
          [id, updates.whatsapp, updates.nombre]
        );
        return rows.length ? emptyPlayer(rows[0]) : null;
      }
      return null;
    },

    async initRoster(names) {
      await init();
      await pool.query('BEGIN');
      try {
        for (const nombre of names) {
          await pool.query(
            `INSERT INTO corespon_players (id, nombre, activa)
             VALUES ($1, $2, TRUE)
             ON CONFLICT (id) DO NOTHING`,
            [nombre.toLowerCase(), nombre]
          );
        }
        await pool.query('COMMIT');
      } catch (err) {
        await pool.query('ROLLBACK');
        throw err;
      }
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
          (room_code, blancas, negras, fen, pgn, turno, estado, resultado,
           creado_en, movida_en, plazo_hasta, gracia_hasta, prorrogas, ultima_prorroga_hasta)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (room_code) DO UPDATE SET
           fen = EXCLUDED.fen, pgn = EXCLUDED.pgn, turno = EXCLUDED.turno,
           estado = EXCLUDED.estado, resultado = EXCLUDED.resultado,
           movida_en = EXCLUDED.movida_en, plazo_hasta = EXCLUDED.plazo_hasta,
           gracia_hasta = EXCLUDED.gracia_hasta, prorrogas = EXCLUDED.porrogas,
           ultima_prorroga_hasta = EXCLUDED.ultima_prorroga_hasta
         RETURNING *`,
        [
          partida.roomCode, partida.blancas, partida.negras, partida.fen || null,
          partida.pgn || null, partida.turno, partida.estado, partida.resultado || null,
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
      return rows;
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
          (room_code, tipo, destinatario, estado, enviado_en, error)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [notif.roomCode || null, notif.tipo, notif.destinatario || null,
         notif.estado || 'pendiente', notif.enviadoEn || null, notif.error || null]
      );
      return emptyNotificacion(rows[0]);
    },

    async getNotificacionesPendientes(limit = 200) {
      await init();
      const { rows } = await pool.query(
        `SELECT * FROM corespon_notificaciones WHERE estado = 'pendiente'
         ORDER BY id ASC LIMIT $1`,
        [limit]
      );
      return rows.map(emptyNotificacion);
    },

    async marcaNotificacionComoEnviada(id, error = null) {
      await init();
      const { rows } = await pool.query(
        `UPDATE corespon_notificaciones
         SET estado = CASE WHEN $2 IS NOT NULL THEN 'fallido' ELSE 'enviado' END,
             enviado_en = now(), error = $2
         WHERE id = $1 RETURNING *`,
        [id, error]
      );
      return rows.length ? emptyNotificacion(rows[0]) : null;
    },

    async obtenerEstadisticas() {
      await init();
      const stats = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM corespon_partidas WHERE estado = 'abierta') AS partidas_abiertas,
          (SELECT COUNT(*) FROM corespon_resultados) AS partidas_totales
      `);
      return JSON.parse(stats.rows[0])[0];
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
