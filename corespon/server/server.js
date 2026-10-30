'use strict';

/*
 * Servidor de ajedrez por correspondencia.
 *
 * Flujo de una jugada:
 *  1. El cliente envía `corespon:move` con origen, destino y pieza de promoción.
 *  2. El servidor valida que es el turno del jugador y que la jugada es legal
 *     con el motor `shared/engine.js`.
 *  3. Si es legal, actualiza el estado, guarda el PGN en la base de datos,
 *     avanza el plazo y emite `corespon:room:update` a toda la sala.
 *  4. Si caduca el plazo sin jugada → derrota por tiempo.
 */

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const engine = require('../shared/engine');
const { loadEnv } = require('./env');

loadEnv();

const { RoomManager, Room, normalizeCode, sameName, PLAZO_DEFAULT_MS, GRACIA_DEFAULT_MS, MAX_PRORROGAS, buildPgn } = require('./rooms');
const { createStore } = require('./db');
const { computeClassification } = require('./classification');
const {
  WhatsAppGateway, INVITACION, TURNO, RECORDATORIO, PRORROGA, TIEMPO, FIN,
  invitacionMsg, turnoMsg, recordatorioMsg, prorrogaMsg, tiempoMsg, finMsg
} = require('./whatsapp');

const CLEANUP_INTERVAL_MS = 60 * 1000;
const CHECK_DEADLINE_MS = 60 * 1000;
const CHECK_RECORDATORIO_MS = 30 * 60 * 1000;

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function createServer(options = {}) {
  const quiet = !!options.quiet;
  let currentPort = Number(options.port) || Number(process.env.PORT) || 3001;
  const log = (...args) => {
    if (!quiet) console.log('[corespon]', ...args);
  };

  /*
   * URL pública de la aplicación.
   *
   * - `BASE_URL` (recomendado en producción) tiene prioridad.
   * - Con una petición HTTP de Express se usa `protocol` + `Host`.
   * - Con un socket se leen las cabeceras del handshake, porque
   *   `socket.request` es un IncomingMessage crudo sin los ayudantes de Express.
   * - Sin contexto (temporizadores) se usa el último puerto de escucha.
   */
  function baseUrl(reqOrSocket) {
    if (process.env.BASE_URL) return trimSlash(process.env.BASE_URL);

    if (reqOrSocket && typeof reqOrSocket.get === 'function'
        && typeof reqOrSocket.protocol === 'string') {
      const host = reqOrSocket.get('host');
      if (host) return trimSlash(reqOrSocket.protocol + '://' + host);
    }

    const handshake = reqOrSocket && reqOrSocket.handshake;
    if (handshake) {
      const headers = handshake.headers || {};
      const proto = String(headers['x-forwarded-proto'] || '').split(',')[0].trim()
        || (handshake.secure ? 'https' : 'http');
      const host = String(headers['x-forwarded-host'] || headers.host || '').split(',')[0].trim();
      if (host) return trimSlash(proto + '://' + host);
    }

    return trimSlash(options.baseUrl || 'http://localhost:' + currentPort);
  }

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    pingInterval: 30000,
    pingTimeout: 25000,
    maxHttpBufferSize: 200 * 1024
  });

  const rooms = new RoomManager();
  const store = options.store || createStore({ quiet });
  const gateway = options.gateway || new WhatsAppGateway({ store, debug: !quiet });
  const timers = [];

  // Registrar los jugadores invitados por defecto
  const JUGADORES_POR_DEFECTO = ['Manuel', 'Fernan', 'Alberto', 'Alvaro', 'Alejandro', 'Abuelo'];
  const ADMINISTRADORES = ['Abuelo'];
  store.initRoster(JUGADORES_POR_DEFECTO, ADMINISTRADORES).catch((error) => {
    if (!quiet) console.error('[corespon] Error registrando jugadores:', error.message);
  });

  const publicDir = path.join(__dirname, '..', 'public');
  const sharedDir = path.join(__dirname, '..', 'shared');

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
      + "img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'self'"
    );
    next();
  });

  app.use(express.static(publicDir, { index: false, maxAge: '5m' }));
  app.use('/shared', express.static(sharedDir, { maxAge: '5m' }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  const coresponFile = path.join(publicDir, 'corespon.html');

  // ============================ API REST ============================

  app.get('/api/players', async (req, res) => {
    try {
      const players = await store.getPlayers();
      res.json({ ok: true, players: players.filter(p => p.activa).map(p => ({
        id: p.id, nombre: p.nombre, whatsapp: p.whatsapp, admin: !!p.admin
      })) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/players/:id/whatsapp', async (req, res) => {
    try {
      const player = await store.updatePlayer(req.params.id, { whatsapp: req.body.whatsapp });
      if (!player) return res.status(404).json({ ok: false, error: 'jugador no encontrado' });
      res.json({ ok: true, player });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/partidas', async (req, res) => {
    try {
      const partidas = await store.getPartidasAbiertas();
      res.json({ ok: true, partidas: partidas.map(p => ({
        roomCode: p.roomCode, blancas: p.blancas, negras: p.negras,
        turno: p.turno, plazoHasta: p.plazoHasta, creadoEn: p.creadoEn
      })) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/partidas/:code', async (req, res) => {
    try {
      const partida = await store.getPartidaPorCodigo(req.params.code);
      if (!partida) return res.status(404).json({ ok: false, error: 'partida no encontrada' });
      res.json({ ok: true, partida });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // Crear una invitación de partida
  app.post('/api/partidas/invitar', async (req, res) => {
    try {
      const { blancas, negras } = req.body;
      if (!blancas || !negras) {
        return res.status(400).json({ ok: false, error: 'Se necesitan blancas y negras' });
      }

      const roster = await store.getPlayers();
      const blancoObj = roster.find(p => sameName(p.nombre, blancas));
      const negroObj = roster.find(p => sameName(p.nombre, negras));

      const whiteName = blancoObj ? blancoObj.nombre : blancas;
      const blackName = negroObj ? negroObj.nombre : negras;

      // Registrar jugadores si no existen
      for (const [obj, nombre] of [[blancoObj, blancas], [negroObj, negras]]) {
        if (!obj) {
          await store.savePlayer({
            id: nombre.toLowerCase(),
            nombre: nombre,
            activa: true,
            admin: false,
            whatsapp: null
          });
        }
      }

      // Verificar que no haya partido abierto entre ellos
      const abiertas = await store.getPartidasAbiertas();
      const yaJuegan = abiertas.some(p =>
        sameName(p.blancas, blancas) && sameName(p.negras, negras)
      );
      if (yaJuegan) {
        const p = abiertas.find(p =>
          sameName(p.blancas, blancas) && sameName(p.negras, negras)
        );
        return res.json({ ok: true, color: 'white', room: { code: p.roomCode }, existing: true });
      }

      const room = rooms.createRoom(whiteName, blackName);
      room.players.white.token = crypto.randomUUID();
      room.players.white.joinedAt = Date.now();
      // no marcar connected aquí: el cliente se conectará por socket

      // Guardar en DB (incluye el snapshot completo para poder restaurar)
      await persistRoom(room);

      // Notificar a los dos jugadores. El gateway decide si el canal necesita
      // teléfono y no encola nada si no está configurado.
      const host = baseUrl(req);
      gateway.enqueue(
        room.code, INVITACION,
        { nombre: blackName, whatsapp: negroObj && negroObj.whatsapp },
        invitacionMsg(room, 'black', host), host
      );
      gateway.enqueue(
        room.code, TURNO,
        { nombre: whiteName, whatsapp: blancoObj && blancoObj.whatsapp },
        turnoMsg(room, 'white', host), host
      );

      res.json({
        ok: true,
        color: 'white',
        room: room.toPublic()
      });
    } catch (error) {
      log('Error creando invitación:', error);
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // ============================ SOCKET.IO ============================

  const tokenMap = new Map();

  io.on('connection', (socket) => {
    const now = Date.now();

    socket.on('corespon:join', async (data, respond) => {
      const room = rooms.getRoom(normalizeCode(data.code));
      if (!room) return respond({ ok: false, error: 'not_found' });

      const color = room.colorForName(data.name);
      if (!color) {
        return respond({ ok: false, error: 'not_your_game' });
      }

      const player = room.players[color];
      const isReconnect = !!(data.token && player.token && data.token === player.token);

      // El asiento ya está ocupado por otro socket (no es este cliente)
      if (player.connected && !isReconnect) {
        return respond({ ok: false, error: 'seat_taken' });
      }

      player.token = player.token || crypto.randomUUID();
      player.connected = true;
      player.joinedAt = player.joinedAt || Date.now();
      // El socket que ocupa el asiento ahora mismo. Un socket anterior deja
      // de poder mover/rendirse porque socketContext() valida este id.
      player.socketId = socket.id;
      socket.data.corespon = { code: room.code, color };
      if (socket.data.spectator) {
        const watched = rooms.getRoom(socket.data.spectator);
        if (watched) watched.spectators.delete(socket.id);
        socket.data.spectator = null;
      }

      tokenMap.set(player.token, room.code);

      // Notificar al otro jugador por WhatsApp (no en partidas terminadas:
      // se entra solo a consultar el resultado).
      if (!room.status.over) {
        const otherColor = color === 'white' ? 'black' : 'white';
        const otherPlayer = room.players[otherColor];
        const host = baseUrl(socket);
        gateway.enqueue(room.code, TURNO, otherPlayer, turnoMsg(room, otherColor, host), host);
      }

      if (!room.status.over && bothConnected(room)) room.timing.runningSince = now;

      await persistRoom(room);

      socket.join(room.code);
      respond({ ok: true, room: room.toPublic(), color, token: player.token, resumed: isReconnect });
    });

    socket.on('corespon:leave', async (data, respond) => {
      const room = rooms.getRoom(normalizeCode(data.code));
      if (!room) return respond({ ok: true });

      const color = socketContext(socket, room) ? socket.data.corespon.color : data.color;
      if (room.players[color] && room.players[color].socketId === socket.id) {
        room.players[color].connected = false;
        room.players[color].socketId = null;
        tokenMap.delete(room.players[color].token);
        socket.data.corespon = null;
        await persistRoom(room);
      }

      if (bothConnected(room)) {
        room.timing.runningSince = null;
        io.to(room.code).emit('corespon:room:update', room.toPublic());
      }
      respond({ ok: true });
    });

    socket.on('corespon:watch', (data, respond) => {
      const room = rooms.getRoom(normalizeCode(data.code));
      if (!room) return respond({ ok: false, error: 'not_found' });

      socket.data.spectator = room.code;
      room.spectators.add(socket.id);
      socket.join(room.code);
      respond({ ok: true, room: room.toPublic() });
    });

    socket.on('corespon:unwatch', (data, respond) => {
      const room = rooms.getRoom(normalizeCode(data.code));
      if (room) room.spectators.delete(socket.id);
      if (socket.data) socket.data.spectator = null;
      respond({ ok: true });
    });

    // Movimiento
    socket.on('corespon:move', async (data, respond) => {
      const room = rooms.getRoom(normalizeCode(data.code));
      if (!room) return respond({ ok: false, error: 'not_found' });

      const ctx = socketContext(socket, room);
      if (!ctx || !ctx.player.connected) {
        return respond({ ok: false, error: 'not_in_room' });
      }
      if (ctx.color !== room.turnColor()) {
        return respond({ ok: false, error: 'not_your_turn' });
      }

      const result = room.aplicarJugada(data.from, data.to, data.promotion);

      if (!result.ok) {
        return respond(result);
      }

      await persistRoom(room);

      io.to(room.code).emit('corespon:room:update', room.toPublic());

      if (!room.status.over) {
        const host = baseUrl(socket);
        const otherColor = room.turnColor() === 'white' ? 'black' : 'white';
        gateway.enqueue(room.code, TURNO, room.players[otherColor], turnoMsg(room, otherColor, host), host);
      } else {
        const host = baseUrl(socket);
        gateway.enqueue(room.code, FIN, room.players.white, finMsg(room, host), host);
        gateway.enqueue(room.code, FIN, room.players.black, finMsg(room, host), host);
      }

      respond({ ok: true, room: room.toPublic() });
    });

    // Prórroga
    socket.on('corespon:extend', async (data, respond) => {
      const room = rooms.getRoom(normalizeCode(data.code));
      if (!room) return respond({ ok: false, error: 'not_found' });

      const ctx = socketContext(socket, room);
      if (!ctx || !ctx.player.connected) {
        return respond({ ok: false, error: 'not_in_room' });
      }
      if (ctx.color !== room.turnColor()) {
        return respond({ ok: false, error: 'not_your_turn' });
      }

      const result = room.extenderPlazo(ctx.color);
      if (result.ok) {
        await persistRoom(room);
        // Registro histórico de la prórroga (auditoría)
        store.addProrroga({
          roomCode: room.code,
          jugador: result.registro.jugador,
          motivo: result.registro.motivo || 'solicitud',
          solicitadoEn: result.registro.solicitadoEn,
          concedidaEn: new Date().toISOString(),
          nuevaFecha: result.registro.nuevaFecha
        }).catch((error) => {
          if (!quiet) console.error('[corespon] Error guardando la prórroga', room.code + ':', error.message);
        });
        io.to(room.code).emit('corespon:room:update', room.toPublic());
        const host = baseUrl(socket);
        gateway.enqueue(room.code, PRORROGA, room.players[room.turnColor()], prorrogaMsg(room, room.turnColor(), host), host);
        respond(result);
      } else {
        respond(result);
      }
    });

    // Rendición
    socket.on('corespon:resign', async (data, respond) => {
      const room = rooms.getRoom(normalizeCode(data.code));
      if (!room) return respond({ ok: false, error: 'not_found' });

      const ctx = socketContext(socket, room);
      if (!ctx || !ctx.player.connected) {
        return respond({ ok: false, error: 'not_in_room' });
      }
      if (room.status.over) {
        return respond({ ok: false, error: 'game_over' });
      }

      room.rendir(ctx.color);
      await persistRoom(room);
      io.to(room.code).emit('corespon:room:update', room.toPublic());

      const host = baseUrl(socket);
      gateway.enqueue(room.code, FIN, room.players.white, finMsg(room, host), host);
      gateway.enqueue(room.code, FIN, room.players.black, finMsg(room, host), host);

      respond({ ok: true, room: room.toPublic() });
    });

    // Revancha: cuando ambos votan, la sala reinicia con colores cambiados
    socket.on('corespon:rematch', async (data, respond) => {
      const room = rooms.getRoom(normalizeCode(data && data.code));
      if (!room) return respond({ ok: false, error: 'not_found' });

      const ctx = socketContext(socket, room);
      if (!ctx || !ctx.player.connected) {
        return respond({ ok: false, error: 'not_in_room' });
      }
      if (!room.status.over) return respond({ ok: false, error: 'not_finished' });

      // Asegurar el resultado de la partida terminada antes de reiniciar.
      await registrarResultado(room);

      const result = room.voteRematch(ctx.color);
      if (!result.ok) return respond(result);

      if (result.started) {
        await persistRoom(room);

        // Los colores han cambiado: cada socket recibe el suyo y actualiza su
        // contexto en el servidor para poder mover en la nueva partida.
        for (const color of ['white', 'black']) {
          const player = room.players[color];
          if (!player.socketId) continue;
          const target = io.sockets.sockets.get(player.socketId);
          if (!target) continue;
          target.data.corespon = { code: room.code, color };
          target.emit('corespon:color', { code: room.code, color });
        }

        io.to(room.code).emit('corespon:room:update', room.toPublic());
      }

      respond(result);
    });

    // Reconexión
    socket.on('corespon:reconnect', (data, respond) => {
      const room = rooms.getRoom(normalizeCode(data.code));
      if (!room) {
        return respond({ ok: false, error: 'not_found' });
      }
      socket.id.roomCode = room.code;
      socket.join(room.code);
      respond({ ok: true, room: room.toPublic() });
    });

    socket.on('disconnect', () => {
      if (socket.data && socket.data.spectator) {
        const watching = rooms.getRoom(socket.data.spectator);
        if (watching) watching.spectators.delete(socket.id);
        socket.data.spectator = null;
      }

      const ctx = socket.data && socket.data.corespon;
      if (ctx && ctx.code) {
        const room = rooms.getRoom(ctx.code);
        if (room) {
          const player = room.players[ctx.color];
          if (player && player.socketId === socket.id) {
            player.connected = false;
            player.socketId = null;
            if (bothConnected(room)) room.timing.runningSince = null;
            persistRoom(room);
          }
        }
      }
    });
  });

  // ============================ TASKS ASÍNCRONOS ============================

  // 1. Revisar plazos caducados → derrota por tiempo
  timers.push(setInterval(async () => {
    const now = Date.now();
    const perdidas = rooms.checkDeadlines(now);
    for (const room of perdidas) {
      await persistRoom(room);
      io.to(room.code).emit('corespon:room:update', room.toPublic());

      const loser = room.turnColor();
      const winner = loser === 'white' ? 'black' : 'white';
      const host = baseUrl();
      gateway.enqueue(room.code, TIEMPO, room.players[loser], tiempoMsg(room, loser, host), host);
      gateway.enqueue(room.code, FIN, room.players[winner], finMsg(room, host), host);
    }
  }, CHECK_DEADLINE_MS));

  // 2. Recordatorios
  timers.push(setInterval(async () => {
    const salas = rooms.needReminder();
    for (const room of salas) {
      const host = baseUrl();
      gateway.enqueue(room.code, RECORDATORIO, room.players[room.turnColor()], recordatorioMsg(room, room.turnColor(), host), host);
    }
  }, CHECK_RECORDATORIO_MS));

  // 3. Limpieza
  timers.push(setInterval(() => {
    const removed = rooms.cleanup();
    for (const code of removed) log('Sala eliminada (vacía):', code);
  }, CLEANUP_INTERVAL_MS));

  // 4. Procesa colas de WhatsApp
  timers.push(setInterval(async () => {
    const res = await gateway.processQueue(50);
    if (res.processed) log('Notificaciones procesadas:', res.processed);
  }, 60 * 1000));

  // ============================ RUTAS + SERVIDOR ============================

  app.get('/corespon', (req, res) => res.sendFile(coresponFile));
  app.get('/corespon/:code', (req, res) => res.sendFile(coresponFile));

  /*
   * Visibilidad de la cola: ?estado=pendiente|enviado|fallido y recuento por
   * estado. Si existe ADMIN_TOKEN, exige la cabecera x-admin-token.
   */
  app.get('/api/whatsapp/queue', async (req, res) => {
    try {
      const adminToken = process.env.ADMIN_TOKEN;
      if (adminToken && req.get('x-admin-token') !== adminToken) {
        return res.status(401).json({ ok: false, error: 'No autorizado' });
      }

      const estados = ['pendiente', 'enviado', 'fallido'];
      const filtro = estados.includes(req.query.estado) ? req.query.estado : null;
      const [notificaciones, resumen] = await Promise.all([
        store.getNotificacionesRecientes(100, filtro),
        store.resumenNotificaciones()
      ]);
      res.json({ ok: true, estado: filtro || 'todas', resumen, notificaciones });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/status', async (req, res) => {
    try {
      const stats = await store.obtenerEstadisticas();
      res.json({ ok: true, estadisticas: stats });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/classification', async (req, res) => {
    try {
      const resultados = await store.getResultados();
      res.json({ ok: true, clasificacion: computeClassification(resultados) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  function randomToken() {
    return crypto.randomUUID();
  }

  function bothConnected(room) {
    return !!(room.players.white && room.players.black
      && room.players.white.connected && room.players.black.connected);
  }

  /*
   * Contexto de juego del socket.
   *
   * Devuelve null si el socket no ocupa un asiento en esa sala: espectadores,
   * salas inexistentes o asientos reemplazados por otro socket. El color
   * siempre sale de aquí, nunca del payload del cliente.
   */
  function socketContext(socket, expectedRoom) {
    const ctx = socket.data && socket.data.corespon;
    if (!ctx || !ctx.code) return null;
    const room = rooms.getRoom(ctx.code);
    if (!room) return null;
    if (expectedRoom && room !== expectedRoom) return null;
    const player = room.players[ctx.color];
    if (!player) return null;
    if (player.socketId && player.socketId !== socket.id) return null;
    return { room, color: ctx.color, player };
  }

  function estadoAFen(state) {
    const pieceToFen = {
      '♙': 'P', '♖': 'R', '♘': 'N', '♗': 'B', '♕': 'Q', '♔': 'K',
      '♟': 'p', '♜': 'r', '♞': 'n', '♝': 'b', '♛': 'q', '♚': 'k'
    };
    let fen = '';
    for (let r = 0; r < 8; r++) {
      let empty = 0;
      for (let c = 0; c < 8; c++) {
        const p = state.board[r][c];
        if (p === ' ') {
          empty++;
        } else {
          if (empty > 0) { fen += empty; empty = 0; }
          fen += pieceToFen[p] || '?';
        }
      }
      if (empty > 0) fen += empty;
      if (r < 7) fen += '/';
    }
    fen += ' ' + (state.turn === 'white' ? 'w' : 'b');
    let castling = '';
    if (!state.kingMoved.white) {
      if (!state.rookMoved.white.kingside) castling += 'K';
      if (!state.rookMoved.white.queenside) castling += 'Q';
    }
    if (!state.kingMoved.black) {
      if (!state.rookMoved.black.kingside) castling += 'k';
      if (!state.rookMoved.black.queenside) castling += 'q';
    }
    fen += ' ' + (castling || '-');
    if (state.epTarget) {
      fen += ' ' + engine.squareName(state.epTarget.row, state.epTarget.col);
    } else {
      fen += ' -';
    }
    fen += ' ' + state.halfmove + ' ' + state.fullmove;
    return fen;
  }

  function estadoAPgn(room) {
    return buildPgn(room);
  }

  /*
   * Guarda el resultado definitivo de la partida, una sola vez.
   * Las revanchas reinician la sala, así que cada partida produce su fila.
   */
  async function registrarResultado(room) {
    if (!room.status.over || room.resultadoGuardado) return null;
    room.resultadoGuardado = true;

    const registro = {
      blancas: room.players.white.name,
      negras: room.players.black.name,
      resultado: room.status.winner === 'white' ? 'blancas'
        : room.status.winner === 'black' ? 'negras'
        : 'tablas',
      pgn: room.history.length ? estadoAPgn(room) : null,
      duracionMs: Math.max(0, Date.now() - room.plazos.creadoEn),
      movimientos: room.history.length,
      prorrogas: room.plazos.prorrogas.length,
      terminoPor: room.status.reason === 'resignation' ? 'renuncia'
        : room.status.reason === 'time' ? 'tiempo'
        : 'jugada',
      terminadoEn: new Date().toISOString(),
      parentRoom: room.parentCode || null
    };

    try {
      await store.saveResultado(registro);
      return registro;
    } catch (error) {
      // Permitir reintento en la siguiente escritura de la sala.
      room.resultadoGuardado = false;
      if (!quiet) console.error('[corespon] Error guardando el resultado', room.code + ':', error.message);
      return null;
    }
  }

  async function persistRoom(room) {
    const pgn = room.history.length ? estadoAPgn(room) : null;

    try {
      await store.savePartida({
        roomCode: room.code,
        blancas: room.players.white.name,
        negras: room.players.black.name,
        fen: estadoAFen(room.state),
        pgn,
        snapshot: room.snapshot(),
        turno: room.turnColor(),
        estado: room.status.over ? 'terminada' : 'abierta',
        resultado: room.status.winner === 'white' ? 'blancas'
          : room.status.winner === 'black' ? 'negras'
          : 'tablas',
        creadoEn: room.plazos.creadoEn,
        movidaEn: new Date().toISOString(),
        plazoHasta: new Date(room.plazos.plazoHasta).toISOString(),
        graciaHasta: new Date(room.plazos.graciaHasta).toISOString(),
        prorrogas: room.plazos.prorrogas,
        ultimaProrrogaHasta: room.plazos.ultimaProrrogaHasta
          ? new Date(room.plazos.ultimaProrrogaHasta).toISOString() : null
      });
    } catch (error) {
      // Persistir nunca debe tumbar el proceso: la partida sigue en memoria.
      if (!quiet) console.error('[corespon] Error guardando la partida', room.code + ':', error.message);
      return null;
    }

    if (room.status.over) await registrarResultado(room);
    return true;
  }

  /*
   * Recarga las partidas abiertas guardadas en la base de datos.
   * Se ejecuta una vez, antes de abrir el puerto.
   */
  async function restoreRooms() {
    try {
      const abiertas = await store.getPartidasAbiertas();
      const restored = rooms.hydrateAll(abiertas);
      const skipped = abiertas.length - restored.length;
      if (restored.length) log('Partidas restauradas:', restored.length);
      if (skipped > 0) log('Partidas sin snapshot, no restauradas:', skipped);
      return restored;
    } catch (error) {
      if (!quiet) console.error('[corespon] Error restaurando partidas:', error.message);
      return [];
    }
  }

  let readyPromise = null;
  function ready() {
    if (!readyPromise) readyPromise = restoreRooms();
    return readyPromise;
  }

  /*
   * Arranca el servidor HTTP. No se llama automáticamente: los tests usan
   * `server.listen(0)` sobre la instancia devuelta.
   */
  function start(port) {
    const chosen = Number(port) || Number(options.port) || Number(process.env.PORT) || 3001;
    return ready().then(() => new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        const actual = server.address() && typeof server.address() === 'object'
          ? server.address().port
          : chosen;
        currentPort = actual;
        log('Servidor de correspondencia en puerto ' + actual);
        log('Abre http://localhost:' + actual + '/corespon');
        resolve(actual);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(chosen);
    }));
  }

  /*
   * Libera temporizadores, conexiones y el pool de base de datos.
   * Imprescindible para que los tests de integración terminen.
   */
  async function close() {
    for (const timer of timers) clearInterval(timer);
    timers.length = 0;

    // Corta las conexiones de socket.io y el servidor HTTP (si sigue abierto).
    await new Promise((resolve) => io.close(() => resolve()));
    await new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    });

    await store.close().catch(() => {});
  }

  return { app, server, io, rooms, store, gateway, start, close, ready };
}

module.exports = { createServer, Room };

if (require.main === module) {
  const instance = createServer({ quiet: false });
  instance.start().catch((error) => {
    console.error('[corespon] No se pudo arrancar el servidor:', error.message);
    process.exit(1);
  });
}
