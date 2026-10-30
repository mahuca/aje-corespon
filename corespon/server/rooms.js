'use strict';

/*
 * Gestión de salas de ajedrez por correspondencia.
 *
 * Diferencias con el ajedrez en tiempo real:
 *  - El plazo de cada jugada corre aunque los jugadores estén desconectados.
 *  - Cada jugador ocupa su asiento por NOMBRE (lista fija de invitados).
 *  - Al agotarse el plazo (+ 1 hora de gracia) el jugador del turno pierde.
 *  - El jugador del turno puede ampliar el plazo +1 día, hasta 3 veces.
 */

const crypto = require('crypto');
const engine = require('../shared/engine');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const MAX_NAME_LENGTH = 20;

// ============================ TIEMPOS ============================

const PLAZO_DEFAULT_MS = 2 * 24 * 60 * 60 * 1000; // 2 días por jugada
const GRACIA_DEFAULT_MS = 60 * 60 * 1000;        // 1 hora de gracia
const MAX_PRORROGAS = 3;
const PRORROGA_MS = 24 * 60 * 60 * 1000;         // +1 día por prórroga
const CHECK_DEADLINE_INTERVAL_MS = 60 * 1000;
const RECORDATORIO_UMBRAL_MS = 12 * 60 * 60 * 1000; // aviso cuando faltan < 12 h

const EMPTY_ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // sala sin jugar: 7 días

// ============================ AYUDANTES ============================

function sanitizeName(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  const clean = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return clean || fallback;
}

function normalizeCode(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return new RegExp('^[' + CODE_ALPHABET + ']{' + CODE_LENGTH + '}$').test(code)
    ? code
    : null;
}

function randomCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

function randomToken() {
  return crypto.randomUUID();
}

function sameName(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

/*
 * Texto legible del plazo restante.
 * Ej.: "1d 20h (hasta 31/10, 18:30), gracia hasta 31/10, 19:30"
 */
function formatPlazo(hastaMs, graciaHastaMs, now = Date.now()) {
  const msPlazo = Math.max(0, (hastaMs || now) - now);
  const msGracia = graciaHastaMs ? Math.max(0, graciaHastaMs - now) : msPlazo;

  const dur = (ms) => {
    const total = Math.floor(ms / 1000);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const parts = [];
    if (days) parts.push(days + 'd');
    if (hours) parts.push(hours + 'h');
    if (!days && minutes) parts.push(minutes + 'm');
    if (!parts.length) parts.push('<1m');
    return parts.join(' ');
  };

  const fecha = (ms) => new Date(ms).toLocaleString('es-ES', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  });

  return {
    msPlazo,
    msGracia,
    fecha: fecha(hastaMs || now),
    fechaGracia: fecha(graciaHastaMs || hastaMs || now),
    corto: dur(msPlazo),
    texto: dur(msPlazo) + ' (hasta ' + fecha(hastaMs || now) + ')',
    descripcion: msGracia > 0
      ? dur(msPlazo) + ' (hasta ' + fecha(hastaMs || now)
        + ', gracia hasta ' + fecha(graciaHastaMs) + ')'
      : dur(msPlazo) + ' (hasta ' + fecha(hastaMs || now) + ')'
  };
}

// ============================ PGN ============================

/*
 * PGN simplificado con la notación del motor (tipo "e2-e4").
 * Suficiente para archivar y revisar partidas.
 */
function buildPgn(room) {
  const date = new Date(room.plazos.creadoEn || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const d = `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;

  const result = room.status.over
    ? (room.status.winner === 'white' ? '1-0'
      : room.status.winner === 'black' ? '0-1' : '1/2-1/2')
    : '*';

  const headers = [
    '[Event "Aje-Corespon"]',
    `[Site "aje-corespon"]`,
    `[Date "${d}"]`,
    `[White "${room.players.white ? room.players.white.name : '?'}"]`,
    `[Black "${room.players.black ? room.players.black.name : '?'}"]`,
    `[Result "${result}"]`,
    `[Room "${room.code}"]`,
    `[Plazo "2 dias/jugada + ${MAX_PRORROGAS} prorrogas"]`
  ].join('\n');

  const tokens = [];
  room.history.forEach((move, index) => {
    if (index % 2 === 0) tokens.push((index / 2 + 1) + '.');
    tokens.push(move.notation || '?');
  });
  tokens.push(result);

  const body = tokens.join(' ');
  return headers + '\n\n' + (body.length > 76 ? wrapPgn(body) : body) + '\n';
}

function wrapPgn(text, width = 76) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > width) {
      lines.push(line.trim());
      line = word;
    } else {
      line += ' ' + word;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join('\n');
}

// ============================ SALA ============================

class Room {
  constructor(code, whiteName, blackName) {
    const now = Date.now();

    this.code = code;
    this.players = {
      white: {
        color: 'white',
        name: sanitizeName(whiteName, 'Blancas'),
        token: null,
        connected: false,
        joinedAt: null
      },
      black: {
        color: 'black',
        name: sanitizeName(blackName, 'Negras'),
        token: null,
        connected: false,
        joinedAt: null
      }
    };

    this.state = engine.newState();
    this.status = { over: false, reason: null, winner: null, inCheck: false };
    this.history = [];
    this.spectators = new Set();
    this.parentCode = null;

    // Plazos
    this.plazos = {
      plazoMs: PLAZO_DEFAULT_MS,
      graciaMs: GRACIA_DEFAULT_MS,
      plazoHasta: now + PLAZO_DEFAULT_MS,
      graciaHasta: now + PLAZO_DEFAULT_MS + GRACIA_DEFAULT_MS,
      prorrogas: [],
      creadoEn: now,
      ultimaJugadaEn: now,
      recordado: false,
      avisadoCaducidad: false
    };

    this.timing = { white: 0, black: 0, moves: [], partial: 0, runningSince: now };
  }

  // ---------- turno ----------

  turnColor() {
    return this.state.turn === 'white' ? 'white' : 'black';
  }

  playerOf(color) {
    return this.players[color] || null;
  }

  // Devuelve 'white' | 'black' | null según el nombre del jugador
  colorForName(name) {
    if (sameName(this.players.white.name, name)) return 'white';
    if (sameName(this.players.black.name, name)) return 'black';
    return null;
  }

  colorForToken(token) {
    if (!token) return null;
    if (this.players.white.token && this.players.white.token === token) return 'white';
    if (this.players.black.token && this.players.black.token === token) return 'black';
    return null;
  }

  // ---------- plazos ----------

  plazoInfo(now = Date.now()) {
    return formatPlazo(this.plazos.plazoHasta, this.plazos.graciaHasta, now);
  }

  canExtend(now = Date.now()) {
    if (this.status.over) return false;
    if (this.plazos.prorrogas.length >= MAX_PRORROGAS) return false;
    // Solo mientras el plazo normal no haya caducado
    return now < this.plazos.plazoHasta;
  }

  reiniciarPlazo(now = Date.now()) {
    this.plazos.plazoHasta = now + this.plazos.plazoMs;
    this.plazos.graciaHasta = this.plazos.plazoHasta + this.plazos.graciaMs;
    this.plazos.ultimaJugadaEn = now;
    this.plazos.recordado = false;
    this.plazos.avisadoCaducidad = false;
  }

  extenderPlazo(color, now = Date.now()) {
    if (!this.canExtend(now)) return { ok: false, error: 'no_extensions' };

    const base = Math.max(this.plazos.plazoHasta, now);
    this.plazos.plazoHasta = base + PRORROGA_MS;
    this.plazos.graciaHasta = this.plazos.plazoHasta + this.plazos.graciaMs;
    this.plazos.recordado = false;
    this.plazos.avisadoCaducidad = false;

    const registro = {
      color,
      jugador: this.players[color].name,
      solicitadoEn: new Date(now).toISOString(),
      nuevaFecha: new Date(this.plazos.plazoHasta).toISOString()
    };
    this.plazos.prorrogas.push(registro);
    return { ok: true, registro };
  }

  caducado(now = Date.now()) {
    return now >= this.plazos.graciaHasta;
  }

  // ---------- jugadas ----------

  aplicarJugada(from, to, promotion) {
    if (this.status.over) return { ok: false, error: 'game_over' };

    const result = engine.validateAndApply(this.state, from, to, promotion);
    if (!result.ok) return result;

    this.state = result.state;
    this.status = {
      over: result.status.over,
      reason: result.status.reason,
      winner: result.status.winner,
      inCheck: result.status.inCheck
    };

    this.history.push(result.move);
    this.timing.moves.push(Date.now() - this.plazos.ultimaJugadaEn);

    if (!this.status.over) this.reiniciarPlazo();

    return { ok: true, move: result.move, status: this.status };
  }

  rendir(color) {
    const winner = color === 'white' ? 'black' : 'white';
    this.status = { over: true, reason: 'resignation', winner, inCheck: false };
    return this.status;
  }

  perderPorTiempo() {
    const loser = this.turnColor();
    const winner = loser === 'white' ? 'black' : 'white';
    this.status = { over: true, reason: 'time', winner, inCheck: this.status.inCheck };
    return this.status;
  }

  // ---------- persistencia ----------

  /*
   * Estado completo de la sala para guardar en la base de datos y poder
   * restaurarla tras un reinicio. Incluye los tokens de ambos jugadores.
   */
  snapshot() {
    return {
      version: 1,
      state: this.state,
      status: this.status,
      history: this.history,
      players: {
        white: {
          name: this.players.white.name,
          token: this.players.white.token,
          joinedAt: this.players.white.joinedAt
        },
        black: {
          name: this.players.black.name,
          token: this.players.black.token,
          joinedAt: this.players.black.joinedAt
        }
      },
      plazos: { ...this.plazos, prorrogas: this.plazos.prorrogas.slice() },
      timing: { ...this.timing, moves: this.timing.moves.slice() },
      parentCode: this.parentCode
    };
  }

  static fromSnapshot(code, raw) {
    if (!raw) return null;

    let data = raw;
    if (typeof raw === 'string') {
      try {
        data = JSON.parse(raw);
      } catch (error) {
        return null;
      }
    }

    if (!data || !engine.validState(data.state)) return null;

    const savedWhite = data.players && data.players.white;
    const savedBlack = data.players && data.players.black;
    if (!savedWhite || !savedBlack || !savedWhite.name || !savedBlack.name) return null;

    const room = new Room(code, savedWhite.name, savedBlack.name);
    room.state = data.state;
    room.status = {
      over: !!(data.status && data.status.over),
      reason: (data.status && data.status.reason) || null,
      winner: (data.status && data.status.winner) || null,
      inCheck: !!(data.status && data.status.inCheck)
    };
    room.history = Array.isArray(data.history) ? data.history : [];

    for (const color of ['white', 'black']) {
      const saved = data.players[color];
      const player = room.players[color];
      player.token = typeof saved.token === 'string' && saved.token ? saved.token : null;
      player.connected = false;
      player.socketId = null;
      player.joinedAt = Number.isFinite(saved.joinedAt) ? saved.joinedAt : null;
    }

    if (data.plazos) {
      const saved = data.plazos;
      const num = (value, fallback) => (Number.isFinite(value) ? value : fallback);
      room.plazos = {
        plazoMs: num(saved.plazoMs, PLAZO_DEFAULT_MS),
        graciaMs: num(saved.graciaMs, GRACIA_DEFAULT_MS),
        plazoHasta: num(saved.plazoHasta, room.plazos.plazoHasta),
        graciaHasta: num(saved.graciaHasta, room.plazos.graciaHasta),
        prorrogas: Array.isArray(saved.prorrogas) ? saved.prorrogas : [],
        creadoEn: num(saved.creadoEn, room.plazos.creadoEn),
        ultimaJugadaEn: num(saved.ultimaJugadaEn, room.plazos.ultimaJugadaEn),
        recordado: !!saved.recordado,
        avisadoCaducidad: !!saved.avisadoCaducidad
      };
    }

    if (data.timing) {
      const saved = data.timing;
      room.timing = {
        white: Number.isFinite(saved.white) ? saved.white : 0,
        black: Number.isFinite(saved.black) ? saved.black : 0,
        moves: Array.isArray(saved.moves) ? saved.moves : [],
        // Al restaurar nadie está conectado: el reloj no corre.
        runningSince: null
      };
    }

    room.parentCode = typeof data.parentCode === 'string' ? data.parentCode : null;
    return room;
  }

  // ---------- serialización ----------

  toPublic() {
    const now = Date.now();
    const turn = this.turnColor();
    const plazo = this.plazoInfo(now);

    return {
      code: this.code,
      state: this.state,
      status: this.status,
      turn,
      players: {
        white: this.players.white.name
          ? { name: this.players.white.name, connected: this.players.white.connected, joined: !!this.players.white.token }
          : null,
        black: this.players.black.name
          ? { name: this.players.black.name, connected: this.players.black.connected, joined: !!this.players.black.token }
          : null
      },
      history: this.history,
      pgn: this.history.length ? buildPgn(this) : null,
      spectators: this.spectators.size,
      parentCode: this.parentCode,
      plazo: {
        plazoHasta: this.plazos.plazoHasta,
        graciaHasta: this.plazos.graciaHasta,
        msRestante: plazo.msPlazo,
        msGracia: plazo.msGracia,
        texto: plazo.texto,
        descripcion: plazo.descripcion,
        corto: plazo.corto
      },
      prorrogas: this.plazos.prorrogas.length,
      maxProrrogas: MAX_PRORROGAS,
      canExtend: this.canExtend(now),
      creadoEn: this.plazos.creadoEn,
      timing: {
        white: this.timing.white,
        black: this.timing.black,
        moves: this.timing.moves.slice()
      }
    };
  }
}

// ============================ GESTOR ============================

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  get size() {
    return this.rooms.size;
  }

  getRoom(code) {
    const normalized = normalizeCode(code);
    return normalized ? this.rooms.get(normalized) || null : null;
  }

  all() {
    return [...this.rooms.values()];
  }

  openRooms() {
    return this.all().filter(room => !room.status.over);
  }

  createRoom(whiteName, blackName) {
    let code;
    do {
      code = randomCode();
    } while (this.rooms.has(code));

    const room = new Room(code, whiteName, blackName);
    this.rooms.set(code, room);
    return room;
  }

  /*
   * Reconstruye una sala desde una partida guardada. Devuelve null si no hay
   * snapshot utilizable (partidas antiguas) o si el código ya está en memoria.
   */
  hydrate(record) {
    if (!record || !record.roomCode) return null;
    const code = normalizeCode(record.roomCode);
    if (!code || this.rooms.has(code)) return null;

    const room = Room.fromSnapshot(code, record.snapshot);
    if (!room) return null;

    this.rooms.set(code, room);
    return room;
  }

  hydrateAll(records) {
    const restored = [];
    for (const record of records || []) {
      const room = this.hydrate(record);
      if (room) restored.push(room);
    }
    return restored;
  }

  /*
   * Ocupa el asiento del jugador con ese nombre.
   * Devuelve { ok, color, token } o { ok: false, error }.
   */
  takeSeat(room, name, token) {
    if (!room) return { ok: false, error: 'not_found' };

    // Reconexión por token
    const tokenColor = room.colorForToken(token);
    if (tokenColor) {
      const player = room.players[tokenColor];
      player.connected = true;
      player.joinedAt = player.joinedAt || Date.now();
      return { ok: true, color: tokenColor, token: player.token, resumed: true };
    }

    const color = room.colorForName(name);
    if (!color) return { ok: false, error: 'not_your_game' };

    const player = room.players[color];
    if (player.token && !sameName(player.name, name)) {
      return { ok: false, error: 'seat_taken' };
    }

    player.token = player.token || randomToken();
    player.connected = true;
    player.joinedAt = player.joinedAt || Date.now();
    return { ok: true, color, token: player.token, resumed: false };
  }

  releaseSeat(room, color) {
    if (!room) return;
    const player = room.players[color];
    if (player) player.connected = false;
  }

  /*
   * Revisa plazos. Devuelve las salas que acaban de perderse por tiempo.
   */
  checkDeadlines(now = Date.now()) {
    const perdidas = [];
    for (const room of this.rooms.values()) {
      if (room.status.over) continue;
      if (!room.caducado(now)) continue;
      room.perderPorTiempo();
      perdidas.push(room);
    }
    return perdidas;
  }

  /*
   * Salas que necesitan recordatorio (faltan < 12 h y aún no se avisó).
   */
  needReminder(now = Date.now()) {
    const listas = [];
    for (const room of this.rooms.values()) {
      if (room.status.over) continue;
      if (room.plazos.recordado) continue;
      const restante = room.plazos.plazoHasta - now;
      if (restante <= RECORDATORIO_UMBRAL_MS) {
        room.plazos.recordado = true;
        listas.push(room);
      }
    }
    return listas;
  }

  cleanup(now = Date.now()) {
    const toRemove = [];
    for (const room of this.rooms.values()) {
      const sinJugadas = room.history.length === 0;
      const vieja = now - room.plazos.creadoEn > EMPTY_ROOM_TTL_MS;
      if (sinJugadas && vieja) toRemove.push(room.code);
    }
    for (const code of toRemove) this.rooms.delete(code);
    return toRemove;
  }
}

module.exports = {
  RoomManager,
  Room,
  normalizeCode,
  randomCode,
  randomToken,
  sanitizeName,
  sameName,
  formatPlazo,
  buildPgn,
  PLAZO_DEFAULT_MS,
  GRACIA_DEFAULT_MS,
  MAX_PRORROGAS,
  PRORROGA_MS,
  CHECK_DEADLINE_INTERVAL_MS,
  RECORDATORIO_UMBRAL_MS
};