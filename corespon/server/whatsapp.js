'use strict';

/*
 * Canal de notificaciones.
 *
 * Proveedores soportados (se elige con NOTIFY_PROVIDER; se acepta también la
 * variable histórica WHATSAPP_PROVIDER):
 *
 *   telegram     Bot de Telegram (recomendado)
 *     Requiere: TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID (grupo o chat).
 *     Opcional: TELEGRAM_CHAT_<JUGADOR> para enviar a un chat privado
 *     (p. ej. TELEGRAM_CHAT_MANUEL=-100123...). Si no existe, usa el grupo.
 *
 *   meta         Meta Cloud API (https://developers.facebook.com/docs/whatsapp/cloud-api)
 *     Requiere: WHATSAPP_TOKEN, WHATSAPP_PHONE_ID
 *
 *   twilio       Twilio WhatsApp (https://www.twilio.com/whatsapp)
 *     Requiere: WHATSAPP_ACCOUNT_SID, WHATSAPP_AUTH_TOKEN, WHATSAPP_FROM, WHATSAPP_TO
 *
 *   sendgrid     Volcado a archivo local (fallback de desarrollo)
 *     Requiere: SENDGRID_API_KEY
 *
 * El mensaje se envía asíncronamente. Cada intento se registra en la base de
 * datos (corespon_notificaciones) con el texto ya renderizado, para auditoría
 * y reintentos.
 */

const { createStore } = require('./db');

const PROVIDERS = {
  telegram: telegramProvider,
  meta: metaProvider,
  twilio: twilioProvider,
  sendgrid: sendgridProvider
};

// Mensajes predeterminados. ${jugador} identifica al destinatario, útil cuando
// las notificaciones llegan a un grupo de Telegram.
const MESSAGES = {
  invitacion:
    '♟ *Nueva partida de ajedrez*\n\n${rival} ha invitado a ${jugador} a una ' +
    'partida de correspondencia. Tienes 2 días por jugada (ampliables). ' +
    'Entra en ${host}/corespon y usa el código *${code}* ' +
    '(o copia el enlace).',

  turno:
    '♟ *Te toca mover, ${jugador}*\n\nEs tu turno en la partida ${code}. ' +
    'Tu jugada caduca en *${tiempo}*.\n\nEntra a jugar: ' +
    '${host}/corespon/${code}',

  recordatorio:
    '⏰ *Recordatorio para ${jugador}*\n\nTe queda poco tiempo para mover en ' +
    'la partida ${code}: *${tiempo}*.\n\nEntra a jugar: ' +
    '${host}/corespon/${code}',

  prorroga:
    '♟ *Prórroga de ${jugador}*\n\nLa partida ${code} se ha ampliado. ' +
    'Tienes hasta ${fecha} para mover.',

  tiempo:
    '☠ *Tiempo agotado*\n\n${jugador} ha perdido por tiempo la partida ${code}.',

  fin:
    '♟ *Partida terminada*\n\n${resultado} en la partida ${code}.\n\n' +
    '¿Aceptar revancha?'
};

// ============================ TELEGRAM ============================

function envKeyForPlayer(nombre) {
  const limpio = String(nombre || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return 'TELEGRAM_CHAT_' + limpio;
}

/*
 * Chat de Telegram para un jugador: TELEGRAM_CHAT_<JUGADOR> si existe y, si no,
 * el chat común TELEGRAM_CHAT_ID (normalmente un grupo).
 */
function telegramChatFor(nombre) {
  if (nombre) {
    const key = envKeyForPlayer(nombre);
    if (key !== 'TELEGRAM_CHAT_' && process.env[key]) return process.env[key];
  }
  return process.env.TELEGRAM_CHAT_ID || null;
}

function telegramHtml(text) {
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
}

function plainText(text) {
  return String(text).replace(/\*/g, '');
}

async function telegramProvider(text, destino) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Telegram: TELEGRAM_BOT_TOKEN no configurado');

  const chatId = telegramChatFor(destino && destino.nombre);
  if (!chatId) throw new Error('Telegram: TELEGRAM_CHAT_ID no configurado');

  const endpoint = `https://api.telegram.org/bot${token}/sendMessage`;

  async function call(useHtml) {
    const body = {
      chat_id: chatId,
      text: useHtml ? telegramHtml(text) : plainText(text),
      disable_web_page_preview: true
    };
    if (useHtml) body.parse_mode = 'HTML';

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  let { res, data } = await call(true);

  // Si el HTML no es válido, reintentar en texto plano antes de fallar.
  if ((!res.ok || data.ok === false) && /parse entities/i.test(String(data.description || ''))) {
    ({ res, data } = await call(false));
  }

  if (!res.ok || data.ok === false) {
    throw new Error(`Telegram error ${res.status}: ${data.description || 'sin detalle'}`);
  }

  return { id: data.result && data.result.message_id, meta: data };
}

// ============================ OTROS CANALES ============================

async function metaProvider(text, destino) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) {
    throw new Error('Meta Cloud API: WHATSAPP_TOKEN y WHATSAPP_PHONE_ID no configurados');
  }
  const to = destino && destino.whatsapp;
  if (!to) throw new Error('Meta Cloud API: el destinatario no tiene WhatsApp');

  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: plainText(text) }
  };

  const res = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Meta Cloud API error ${res.status}: ${errText}`);
  }

  const json = await res.json().catch(() => ({}));
  return { id: json.messages?.[0]?.id || null, meta: json };
}

async function twilioProvider(text, destino) {
  const accountSid = process.env.WHATSAPP_ACCOUNT_SID;
  const authToken = process.env.WHATSAPP_AUTH_TOKEN;
  const from = process.env.WHATSAPP_FROM;
  const toDest = (destino && destino.whatsapp) || process.env.WHATSAPP_TO;

  if (!accountSid || !authToken || !from || !toDest) {
    throw new Error('Twilio: WHATSAPP_ACCOUNT_SID, WHATSAPP_AUTH_TOKEN, WHATSAPP_FROM y teléfono no configurados');
  }

  const encoded = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const res = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + accountSid + '/Messages.json', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${encoded}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      From: `whatsapp:${from}`,
      To: `whatsapp:${toDest}`,
      Body: plainText(text)
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Twilio error ${res.status}: ${errText}`);
  }

  const json = await res.json().catch(() => ({}));
  return { id: json.sid || null, meta: json };
}

async function sendgridProvider(text, destino) {
  // SendGrid no envía por WhatsApp: se vuelca a un archivo para desarrollo.
  const key = process.env.SENDGRID_API_KEY;
  if (!key) throw new Error('SendGrid: SENDGRID_API_KEY no configurado');

  const fs = require('fs');
  const path = require('path');
  const fallbackDir = process.env.WHATSAPP_FALLBACK_DIR || '/tmp/whatsapp-fallback';
  if (!fs.existsSync(fallbackDir)) fs.mkdirSync(fallbackDir, { recursive: true });

  const file = path.join(fallbackDir, `${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const to = (destino && (destino.whatsapp || destino.nombre)) || 'sin destinatario';
  fs.writeFileSync(file, `To: ${to}\n\n${plainText(text)}`);
  return { id: file, meta: { path: file } };
}

// ============================ FORMATO ============================

async function formatMessage(template, vars, host) {
  let text = MESSAGES[template] || MESSAGES.invitacion;
  text = text.replace(/\$\{(\w+)\}/g, (m, key) => {
    if (key === 'host') return host || 'http://localhost:3001';
    return String((vars && vars[key]) ?? '');
  });
  return text;
}

function normalizeDestino(destino) {
  if (!destino) return { nombre: null, whatsapp: null };
  if (typeof destino === 'string') return { nombre: null, whatsapp: destino };
  // Los asientos de una sala usan `name`; los destinos ad-hoc, `nombre`.
  return {
    nombre: destino.nombre || destino.name || null,
    whatsapp: destino.whatsapp || null
  };
}

// ============================ GATEWAY ============================

class WhatsAppGateway {
  constructor(options = {}) {
    const configured = (options.providerName
      || process.env.NOTIFY_PROVIDER
      || process.env.WHATSAPP_PROVIDER
      || (process.env.TELEGRAM_BOT_TOKEN ? 'telegram' : 'meta')).toLowerCase();

    if (typeof options.provider === 'function') {
      // Proveedor inyectado (pruebas)
      this.providerName = configured;
      this.provider = options.provider;
    } else {
      this.providerName = ((options.provider && String(options.provider)) || configured).toLowerCase();
      this.provider = PROVIDERS[this.providerName];
    }

    if (!this.provider) {
      throw new Error(`Proveedor de notificaciones desconocido: ${this.providerName}`);
    }

    this.store = options.store || createStore();
    this.debug = !!options.debug;

    if (this.providerName === 'telegram' && !this.ready && this.debug) {
      console.warn('[notificaciones] Telegram sin configurar: define TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID');
    }
  }

  /*
   * Un canal está listo si tiene credenciales. Sin Telegram configurado no se
   * encolan mensajes (evita una cola que crece sin poder enviarse nunca).
   */
  get ready() {
    if (this.providerName !== 'telegram') return true;
    if (!process.env.TELEGRAM_BOT_TOKEN) return false;
    if (process.env.TELEGRAM_CHAT_ID) return true;
    return Object.keys(process.env).some(key => key.startsWith('TELEGRAM_CHAT_'));
  }

  async enqueue(roomCode, tipo, destino, vars, host) {
    const target = normalizeDestino(destino);

    // Los canales de WhatsApp necesitan el teléfono del destinatario.
    if ((this.providerName === 'meta' || this.providerName === 'twilio') && !target.whatsapp) {
      return null;
    }
    if (!this.ready) return null;

    // Los constructores de mensajes devuelven { tipo, vars }; se acepta tanto
    // ese objeto como el mapa de variables ya extraído.
    const datos = vars && vars.vars ? vars.vars : vars;
    const texto = await formatMessage(tipo, datos, host);
    const notif = {
      roomCode,
      tipo,
      destinatario: target.whatsapp || target.nombre || null,
      jugador: target.nombre,
      texto,
      estado: 'pendiente',
      enviadoEn: null,
      error: null
    };

    try {
      await this.store.addNotificacion(notif);
      return notif;
    } catch (error) {
      if (this.debug) console.error('[notificaciones] error al encolar:', error.message);
      return null;
    }
  }

  // Envía un mensaje inmediato (sin registro)
  async send(tipo, destino, vars, host) {
    const target = normalizeDestino(destino);
    // Los constructores de mensajes devuelven { tipo, vars }; se acepta tanto
    // ese objeto como el mapa de variables ya extraído.
    const datos = vars && vars.vars ? vars.vars : vars;
    const texto = await formatMessage(tipo, datos, host);
    return this._sendText(texto, target);
  }

  async _sendText(text, destino) {
    const target = normalizeDestino(destino);
    const start = Date.now();
    try {
      const res = await this.provider(text, target);
      if (this.debug) {
        console.log(`[${this.providerName}] enviado a ${target.whatsapp || target.nombre || 'grupo'} (${Date.now() - start}ms)`);
      }
      return { ok: true, timeMs: Date.now() - start, provider: this.providerName, externalId: res && res.id };
    } catch (error) {
      if (this.debug) console.error(`[${this.providerName}] error:`, error.message);
      return { ok: false, error: error.message, timeMs: Date.now() - start, provider: this.providerName };
    }
  }

  // Procesa todas las notificaciones pendientes (llamado por el scheduler)
  async processQueue(limit = 50) {
    const pending = await this.store.getNotificacionesPendientes(limit);
    if (!pending.length) return { processed: 0 };

    const results = [];
    for (const n of pending) {
      if (!n.texto) {
        await this.store.marcaNotificacionComoEnviada(n.id, 'sin_texto');
        results.push({ ...n, ok: false, error: 'sin_texto' });
        continue;
      }
      const res = await this._sendText(n.texto, { nombre: n.jugador, whatsapp: n.destinatario });
      await this.store.marcaNotificacionComoEnviada(n.id, res.error || null);
      results.push({ ...n, ...res });
    }
    return { processed: results.length, results };
  }

  static isSendable(now, lastSent) {
    // mínimo 3 segundos entre mensajes al mismo destinatario
    return !lastSent || (now - lastSent) > 3000;
  }
}

// Singleton global (por proceso). El servidor crea el suyo propio.
let _gateway = null;
function getGateway(options) {
  if (!_gateway) _gateway = new WhatsAppGateway(options);
  return _gateway;
}

// ============================ MENSAJES DE PARTIDA ============================

function jugadorDe(room, color) {
  return room.players[color] ? room.players[color].name : '';
}

function rivalDe(room, color) {
  return color === 'white' ? jugadorDe(room, 'black') : jugadorDe(room, 'white');
}

function invitacionMsg(room, color, host) {
  return {
    tipo: 'invitacion',
    vars: {
      rival: rivalDe(room, color),
      jugador: jugadorDe(room, color),
      code: room.code,
      host
    }
  };
}

function turnoMsg(room, color, host) {
  return {
    tipo: 'turno',
    vars: {
      jugador: jugadorDe(room, color),
      rival: rivalDe(room, color),
      code: room.code,
      tiempo: room.plazoInfo().texto,
      host
    }
  };
}

function recordatorioMsg(room, color, host) {
  return {
    tipo: 'recordatorio',
    vars: {
      jugador: jugadorDe(room, color),
      code: room.code,
      tiempo: room.plazoInfo().texto,
      host
    }
  };
}

function prorrogaMsg(room, color, host) {
  const limite = new Date(room.plazos.plazoHasta);
  const pad = (n) => String(n).padStart(2, '0');
  const fecha = `${pad(limite.getDate())}/${pad(limite.getMonth() + 1)}, `
    + `${pad(limite.getHours())}:${pad(limite.getMinutes())}`;
  return {
    tipo: 'prorroga',
    vars: {
      jugador: jugadorDe(room, color),
      code: room.code,
      fecha,
      host
    }
  };
}

function tiempoMsg(room, perdedor, host) {
  return {
    tipo: 'tiempo',
    vars: {
      jugador: jugadorDe(room, perdedor),
      rival: rivalDe(room, perdedor),
      code: room.code,
      host
    }
  };
}

function finMsg(room, host) {
  const ganador = room.status.winner === 'white' ? room.players.white.name
    : room.status.winner === 'black' ? room.players.black.name : null;
  const perdedor = room.status.winner === 'white' ? room.players.black.name
    : room.status.winner === 'black' ? room.players.white.name : null;
  const resultado = ganador ? `${ganador} gana` : 'Tablas';
  return {
    tipo: 'fin',
    vars: {
      code: room.code,
      ganador: ganador || '',
      perdedor: perdedor || '',
      resultado,
      host
    }
  };
}

module.exports = {
  WhatsAppGateway,
  NotificationGateway: WhatsAppGateway,
  getGateway,
  formatMessage,
  MESSAGES,
  telegramProvider,
  telegramChatFor,
  telegramHtml,
  INVITACION: 'invitacion',
  TURNO: 'turno',
  RECORDATORIO: 'recordatorio',
  PRORROGA: 'prorroga',
  TIEMPO: 'tiempo',
  FIN: 'fin',
  invitacionMsg,
  turnoMsg,
  recordatorioMsg,
  prorrogaMsg,
  tiempoMsg,
  finMsg
};
