'use strict';

/*
 * Envío de notificaciones por WhatsApp.
 *
 * Proveedores soportados (configurables con la variable WHATSAPP_PROVIDER):
 *
 *   meta         Meta Cloud API (https://developers.facebook.com/docs/whatsapp/cloud-api)
 *     Requires: WHATSAPP_TOKEN, WHATSAPP_PHONE_ID
 *
 *   twilio       Twilio WhatsApp (https://www.twilio.com/whatsapp)
 *     Requires: WHATSAPP_ACCOUNT_SID, WHATSAPP_AUTH_TOKEN, WHATSAPP_FROM, WHATSAPP_TO
 *
 *   sendgrid     SendGrid (usado como fallback cuando el proveedor falla o no hay token)
 *     Requires: SENDGRID_API_KEY
 *
 * El mensaje se envía asíncronamente. Cada intento se registra en la base de datos
 * (corespon_notificaciones) para auditoría y reintentos.
 */

const { createStore } = require('./db');

const PROVIDERS = { meta: metaProvider, twilio: twilioProvider, sendgrid: sendgridProvider };

// Mensajes predeterminados (pueden sobreescribirse por proveedor)
const MESSAGES = {
  invitacion:
    '♟ *Nueva partida de ajedrez*\n\n${rival} te ha invitado a una partida de ' +
    'correspondencia. Tienes 2 días por jugada (ampliables). ' +
    'Entra en https://${host}/corespon y usa el código *${code}* ' +
    '(o copia el enlace).',

  turno:
    '♟ *Te toca mover*\n\nEs tu turno en la partida ${code}. ' +
    'Tu jugada caduca en *${tiempo}*.\n\nEntra a jugar: ' +
    'https://${host}/corespon/${code}',

  recordatorio:
    '⏰ *Recordatorio de ajedrez*\n\nTe queda poco tiempo para mover en ' +
    'la partida ${code}: *${tiempo}*.\n\nEntra a jugar: ' +
    'https://${host}/corespon/${code}',

  prorroga:
    '♟ *Ampliación concedida*\n\nTu prórroga en la partida ${code} ha sido ' +
    'aceptada automáticamente. Tienes hasta ${fecha} para mover.',

  tiempo:
    '☠ *Tiempo agotado*\n\nSe acabó el plazo en la partida ${code}. ' +
    'Has perdido por tiempo.',

  fin:
    '♟ *Partida terminada*\n\nResultado de ${code}: ${resultado} gana. ' +
    '¿Aceptar revancha?'
};

async function metaProvider(text, to) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) {
    throw new Error('Meta Cloud API: WHATSAPP_TOKEN y WHATSAPP_PHONE_ID no configurados');
  }

  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text }
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

async function twilioProvider(text, to) {
  const accountSid = process.env.WHATSAPP_ACCOUNT_SID;
  const authToken = process.env.WHATSAPP_AUTH_TOKEN;
  const from = process.env.WHATSAPP_FROM;
  const toDest = process.env.WHATSAPP_TO;

  if (!accountSid || !authToken || !from || !toDest) {
    throw new Error('Twilio: WHATSAPP_ACCOUNT_SID, WHATSAPP_AUTH_TOKEN, WHATSAPP_FROM y WHATSAPP_TO no configurados');
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
      Body: text
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Twilio error ${res.status}: ${errText}`);
  }

  const json = await res.json().catch(() => ({}));
  return { id: json.sid || null, meta: json };
}

async function sendgridProvider(text, to) {
  // SendGrid no envía por WhatsApp directamente; esta función simula un "fallback"
  // guardando el mensaje en un archivo local para que el operador lo reenvíe.
  const key = process.env.SENDGRID_API_KEY;
  if (!key) throw new Error('SendGrid: SENDGRID_API_KEY no configurado');

  const fs = require('fs');
  const path = require('path');
  const fallbackDir = process.env.WHATSAPP_FALLBACK_DIR || '/tmp/whatsapp-fallback';
  if (!fs.existsSync(fallbackDir)) fs.mkdirSync(fallbackDir, { recursive: true });

  const file = path.join(fallbackDir, `${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(file, `To: ${to}\n\n${text}`);
  return { id: file, meta: { path: file } };
}

async function formatMessage(template, vars, host) {
  let text = MESSAGES[template] || MESSAGES.invitacion;
  text = text.replace(/\$\{(\w+)\}/g, (m, key) => {
    switch (key) {
      case 'host': return host || 'http://localhost:3001';
      default: return String(vars[key] ?? '');
    }
  });
  return text;
}

class WhatsAppGateway {
  constructor(options = {}) {
    this.providerName = options.provider || (process.env.WHATSAPP_PROVIDER || 'meta').toLowerCase();
    this.provider = PROVIDERS[this.providerName];
    if (!this.provider) {
      throw new Error(`Proveedor WhatsApp desconocido: ${this.providerName}`);
    }
    this.store = options.store || createStore();
    this.debug = !!options.debug;
  }

  // Registra un mensaje pendiente de enviar
  async enqueue(roomCode, tipo, destinatario, texto, vars, host) {
    const formatted = await formatMessage(tipo, vars, host);
    const notif = {
      roomCode,
      tipo,
      destinatario,
      estado: 'pendiente',
      enviadoEn: null,
      error: null,
      texto: formatted
    };
    await this.store.addNotificacion(notif);
    return notif;
  }

  // Envía un mensaje inmediato (sin registro)
  async send(tipo, destinatario, vars, host) {
    const formatted = await formatMessage(tipo, vars, host);
    return this._sendText(formatted, destinatario);
  }

  async _sendText(text, to) {
    const start = Date.now();
    try {
      const res = await this.provider(text, to);
      if (this.debug) console.log(`[WhatsApp ${this.providerName}] enviado a ${to} (${Date.now() - start}ms)`, res);
      return { ok: true, timeMs: Date.now() - start, provider: this.providerName, externalId: res.id };
    } catch (error) {
      if (this.debug) console.error(`[WhatsApp ${this.providerName}] error a ${to}:`, error.message);
      return { ok: false, error: error.message, timeMs: Date.now() - start, provider: this.providerName };
    }
  }

  // Procesa todas las notificaciones pendientes (llamado por el scheduler)
  async processQueue(limit = 50) {
    const pending = await this.store.getNotificacionesPendientes(limit);
    if (!pending.length) return { processed: 0 };

    const results = [];
    for (const n of pending) {
      const res = await this._sendText(n.texto, n.destinatario || '');
      const updated = await this.store.marcaNotificacionComoEnviada(n.id, res.error || null);
      results.push({ ...n, ...res });
    }
    return { processed: results.length, results };
  }

  // Comprueba qué notificaciones se pueden enviar ahora (rate limiting simple)
  static isSendable(now, lastSent) {
    // mínimo 3 segundos entre mensajes al mismo destinatario
    return !lastSent || (now - lastSent) > 3000;
  }
}

// Singleton global (por proceso)
let _gateway = null;
function getGateway(options) {
  if (!_gateway) _gateway = new WhatsAppGateway(options);
  return _gateway;
}

// ============================ MENSAJES DEPARTIDA ============================

function invitacionMsg(room, rivalName, host) {
  const vars = {
    rival: rivalName,
    code: room.code,
    host
  };
  return { tipo: 'invitacion', vars };
}

function turnoMsg(room, player, host) {
  const rival = room.turnColor() === 'white' ? room.players.black.name : room.players.white.name;
  const vars = {
    rival,
    code: room.code,
    tiempo: room.plazos.texto,
    host
  };
  return { tipo: 'turno', vars };
}

function recordatorioMsg(room, host) {
  const vars = {
    code: room.code,
    tiempo: room.plazos.texto,
    host
  };
  return { tipo: 'recordatorio', vars };
}

function prorrogaMsg(room, host) {
  const rival = room.turnColor() === 'white' ? room.players.black.name : room.players.white.name;
  const fecha = new Date(room.plazos.plazoHasta).toLocaleString('es-ES', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  const vars = {
    rival,
    code: room.code,
    fecha,
    host
  };
  return { tipo: 'prorroga', vars };
}

function tiempoMsg(room, perdedor, host) {
  const ganador = perdedor === 'white' ? room.players.black.name : room.players.white.name;
  const vars = {
    rival: ganador,
    code: room.code,
    host
  };
  return { tipo: 'tiempo', vars };
}

function finMsg(room, host) {
  const ganador = room.status.winner === 'white' ? room.players.white.name : room.players.black.name;
  const perdedor = room.status.winner === 'white' ? room.players.black.name : room.players.white.name;
  const resultado = room.status.winner === 'draw' ? 'tablas' : `${ganador} gana`;
  const vars = {
    code: room.code,
    ganador,
    perdedor,
    resultado,
    host
  };
  return { tipo: 'fin', vars };
}

module.exports = {
  WhatsAppGateway,
  getGateway,
  formatMessage,
  MESSAGES,
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
