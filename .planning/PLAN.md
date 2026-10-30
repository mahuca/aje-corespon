# Plan de Desarrollo: Ajedrez por Correspondencia

## Objetivo

Aplicación de ajedrez por correspondencia (2 días por jugada, ampliables),
con lista fija de jugadores, notificaciones por WhatsApp y clasificación.

## Estado actual

**Fases A y B completadas** — la partida es jugable de punta a punta,
sobrevive a recargas y reinicios, guarda resultados y tiene clasificación y
revancha. El roster fijo son 6 jugadores y **Abuelo es administrador**.

- [x] A0. `createServer()` sin `listen` interno, `start()`/`close()`, `PORT`.
- [x] A1. URL base única (`BASE_URL` / Host / handshake). Corregido el crash
      `req.get is not a function` al entrar por socket.
- [x] A2. Autorización por identidad del socket (fin de la suplantación de
      color); `move`/`extend` solo en el turno propio.
- [x] A3. Token devuelto en `join`, sesión persistida y reanudación al recargar;
      enlaces `/corespon/CODE` interpretados.
- [x] A4. Snapshot completo en `corespon_partidas.snapshot` (JSONB) y
      rehidratación de partidas abiertas al arrancar. Corregido
      `EXCLUDED.porrogas`.
- [x] A5. Fechas camelCase/snake_case toleradas por el store en memoria.
- [x] A6. Carga de `.env` sin dependencias y `BASE_URL` documentada.
- [x] A7. Tests migrados a `node:test` (40 en verde) + integración con sockets.

Verificación: `npm test` (47 pruebas).

## Fase B — Resultados, clasificación y revancha (completada)

- [x] B1. `GET /api/classification` calculada desde `corespon_resultados`
      (victoria 1, tablas 0.5; orden por puntos, victorias y nombre).
- [x] B2. Resultado guardado una sola vez al terminar (jugada, tiempo o
      rendición) y `addProrroga` al prorrogar.
- [x] B3. Revancha con votos, intercambio de colores (`corespon:color`) y
      reinicio de la sala.
- [x] B4. `GET /api/status` con `obtenerEstadisticas` en memoria y en Postgres.
- [x] B5. Tabla de clasificación del cliente corregida y ordenada.
- [x] B6. Las partidas terminadas se pueden volver a abrir para ver el
      resultado.

## Fase C — Notificaciones por Telegram

- [x] C1. `enqueue()` acepta el objeto `{ tipo, vars }` o el mapa de variables
      ya extraído; los mensajes salen con código, jugador y tiempo reales.
- [x] C2. `turnoMsg`/`recordatorioMsg` usan `room.plazoInfo().texto`
      (`room.plazos.texto` no existía).
- [x] C3. `corespon_notificaciones` guarda `jugador` y `texto`; la cola envía
      el texto ya renderizado (sin `undefined`).
- [x] C4. Ids en el store en memoria (antes las notificaciones se reenviaban
      cada minuto para siempre).
- [x] C5. Reintentos con backoff (1 y 5 min, 3 intentos) y visibilidad
      pendiente/enviado/fallido en `GET /api/whatsapp/queue?estado=`, con
      `ADMIN_TOKEN` opcional.
- [x] C6. Sustituir CallMeBot por Telegram: bot + grupo (`TELEGRAM_BOT_TOKEN`,
      `TELEGRAM_CHAT_ID`) con chat privado opcional por jugador
      (`TELEGRAM_CHAT_<JUGADOR>`).

## Fase D — Despliegue, modo espectador y calidad

- [ ] D1. `render.yaml` correcto: `startCommand` apunta a
      `corespon/server.js`, que no existe.
- [ ] D2. `.gitignore` y sacar `node_modules` del repo;
      resolver `online-chess` (gitlink sin `.gitmodules`).
- [ ] D3. Cerrar la sesión del servidor en `SIGTERM` (usar `close()`).
- [ ] D4. Modo espectador: `O.watch()` nunca se llama; falta `/corespon/CODE?ver=1`.
- [ ] D5. "Salir" avisa de abandono pero no lo aplica: decidir comportamiento.
- [ ] D6. Revocar el token de GitHub expuesto en `.git/config` y usar SSH.
- [ ] D7. README con variables, arranque local y despliegue.

## Fase E — Reglas de negocio pendientes

- [ ] E1. "Solicitud de tiempo extra": hoy se concede automáticamente.
- [ ] E2. Elegir color al crear la partida (hoy el creador siempre es blancas)
      y evitar duplicados en orden inverso.
- [ ] E3. Tablas por acuerdo / repetición triple (opcional).

## Reglas de negocio

- **Plazo:** 2 días por jugada + 1 hora de gracia; la caducidad da la partida
  por perdida.
- **Prórrogas:** +1 día, máximo 3, solo el jugador del turno y antes de caducar.
- **Invitaciones:** cada jugador crea su sala; el rival entra por código/enlace.
- **Revanchas:** intercambio de colores (pendiente, Fase B).
- **Estado:** vanilla JS/HTML + Socket.IO, sin cuentas de usuario.

## Cómo ejecutar

```bash
npm test                 # 40 pruebas
npm start                # http://localhost:3001/corespon
npm run init-db          # alta de los 5 jugadores
```

Variables: ver `.env.example` (`PORT`, `BASE_URL`, `DATABASE_URL`,
`WHATSAPP_*`).
