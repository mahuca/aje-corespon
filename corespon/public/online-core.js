/*
 * Capa de red para la correspondencia.
 *
 * Mantiene la sesión (código + token) y la reconexión automática,
 * usando los eventos `corespon:*` del servidor.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'ajeCoresponSession_v1';
  const NAME_KEY = 'ajeCoresponName_v1';
  const REQUEST_TIMEOUT_MS = 15000;
  const CONNECT_TIMEOUT_MS = 8000;

  const socket = io({
    autoConnect: true,
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 4000,
    timeout: 10000
  });

  const listeners = new Map();
  let session = null;
  let room = null;
  let autoResume = false;
  let resumePromise = null;

  // ==================== EVENTOS LOCALES ====================

  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => off(event, fn);
  }

  function off(event, fn) {
    const set = listeners.get(event);
    if (set) set.delete(fn);
  }

  function emitLocal(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (error) {
        console.error('Error en listener', event, error);
      }
    }
  }

  // ==================== SESIÓN ====================

  function loadSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.code !== 'string' || typeof parsed.token !== 'string') {
        return null;
      }
      return {
        code: parsed.code,
        token: parsed.token,
        color: parsed.color === 'black' ? 'black' : 'white',
        name: parsed.name || ''
      };
    } catch (error) {
      return null;
    }
  }

  function saveSession(next) {
    if (!next || typeof next.code !== 'string' || typeof next.token !== 'string') {
      // Sin token no hay forma de recuperar el asiento: no guardamos una
      // sesión que luego no se podría reanudar.
      return;
    }
    session = next;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (error) {
      // almacenamiento no disponible (modo privado): seguimos en memoria
    }
  }

  function clearSession() {
    session = null;
    room = null;
  }

  function getName() {
    try {
      return localStorage.getItem(NAME_KEY) || '';
    } catch (error) {
      return '';
    }
  }

  function setName(name) {
    try {
      if (name) localStorage.setItem(NAME_KEY, name);
    } catch (error) {
      // nada que hacer
    }
  }

  // ==================== TRANSPORTE ====================

  function waitForConnect(timeoutMs) {
    if (socket.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.off('connect', onConnect);
        resolve(value);
      };
      const onConnect = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      socket.on('connect', onConnect);
    });
  }

  function send(event, payload) {
    return new Promise((resolve) => {
      socket.timeout(REQUEST_TIMEOUT_MS).emit(event, payload, (error, response) => {
        if (error) return resolve({ ok: false, error: 'timeout' });
        if (!response || typeof response !== 'object') {
          return resolve({ ok: false, error: 'server_error' });
        }
        resolve(response);
      });
    });
  }

  function request(event, payload, wait = true) {
    if (!socket.connected) {
      if (!wait) return Promise.resolve({ ok: false, error: 'offline' });
      return waitForConnect(CONNECT_TIMEOUT_MS).then((connected) => {
        if (!connected) return { ok: false, error: 'timeout' };
        return send(event, payload);
      });
    }
    return send(event, payload);
  }

  // ==================== CONEXIÓN ====================

  socket.on('connect', () => {
    emitLocal('connection', { status: 'connected' });
    if (autoResume && session) resume();
  });

  socket.on('disconnect', (reason) => {
    emitLocal('connection', { status: 'disconnected', reason });
  });

  socket.io.on('reconnect_attempt', () => {
    emitLocal('connection', { status: 'reconnecting' });
  });

  socket.io.on('reconnect_failed', () => {
    emitLocal('connection', { status: 'offline' });
  });

  socket.on('corespon:room:update', (payload) => {
    if (!payload || typeof payload.code !== 'string') return;
    room = payload;
    emitLocal('room', room);
  });

  socket.on('corespon:extendResult', (payload) => {
    if (!payload) return;
    room = payload.room;
    emitLocal('room', room);
    emitLocal('extendResult', payload);
  });

  // ==================== API ====================

  async function joinRoom(code, name) {
    const normalized = String(code || '').trim().toUpperCase();
    // El token debe leerse ANTES de leaveRoom(): esa llamada limpia la sesión.
    const token = session && session.code === normalized ? session.token : undefined;
    if (session) await leaveRoom({ silent: true });

    const response = await request('corespon:join', {
      code: normalized,
      token,
      name
    });
    if (!response.ok) return response;

    room = response.room;
    saveSession({
      code: response.code,
      token: response.token,
      color: response.color,
      name: name || (session ? session.name : '')
    });
    emitLocal('joined', response);
    emitLocal('room', room);
    return response;
  }

  async function leaveRoom(options = {}) {
    const hadSession = !!session;
    if (hadSession && socket.connected) {
      await request('corespon:leave', { code: session.code, color: session.color }, false);
    }
    clearSession();
    if (!options.silent) emitLocal('left');
    return { ok: true };
  }

  async function sendMove(from, to, promotion) {
    if (!session) return { ok: false, error: 'no_session' };
    if (!socket.connected) return { ok: false, error: 'offline' };
    return request('corespon:move', { code: session.code, color: session.color, from, to, promotion });
  }

  async function extendRoom(code, color) {
    if (!session) return { ok: false, error: 'no_session' };
    return request('corespon:extend', { code, color });
  }

  async function resign(code, color) {
    if (!session) return { ok: false, error: 'no_session' };
    return request('corespon:resign', { code, color });
  }

  async function rematch(code) {
    if (!session) return { ok: false, error: 'no_session' };
    return request('corespon:rematch', { code });
  }

  async function watch(code) {
    const normalized = String(code || '').trim().toUpperCase();
    const response = await request('corespon:watch', { code: normalized });
    if (!response.ok) return response;

    room = response.room;
    emitLocal('room', room);
    return response;
  }

  async function stopWatching() {
    if (!socket.connected) return Promise.resolve({ ok: true });
    return request('corespon:unwatch', { code: session.code }, false);
  }

  async function resume() {
    if (!session) return { ok: false, error: 'no_session' };
    if (resumePromise) return resumePromise;

    resumePromise = (async () => {
      const response = await request('corespon:join', {
        code: session.code,
        token: session.token,
        name: session.name
      });

      if (response.ok) {
        room = response.room;
        saveSession({
          code: response.code,
          token: response.token,
          color: response.color,
          name: session.name
        });
        emitLocal('joined', { ...response, resumed: true });
        emitLocal('room', room);
        return response;
      }

      if (response.error === 'not_found' || response.error === 'invalid_code'
          || response.error === 'full') {
        clearSession();
        emitLocal('session-lost', response);
      }
      return response;
    })();

    try {
      return await resumePromise;
    } finally {
      resumePromise = null;
    }
  }

  window.CoresponOnline = {
    on,
    off,
    getSession: () => (session ? { ...session } : null),
    setSession: (s) => { saveSession(s); },
    clearSession,
    getName,
    setName,
    isConnected: () => socket.connected,
    getColor: () => (session ? session.color : null),
    getRoom: () => room,
    enableAutoResume: () => {
      autoResume = true;
      if (socket.connected && session) resume();
    },
    resume,
    joinRoom,
    leaveRoom,
    sendMove,
    extendRoom,
    resign,
    rematch,
    watch,
    stopWatching,
    reconnect: () => {
      if (!socket.connected) socket.connect();
    }
  };

  window.Online = window.CoresponOnline;
})();
