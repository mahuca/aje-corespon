# Aje-Corespon ♟

Ajedrez por correspondencia para un grupo fijo de jugadores: partidas 1v1 con
plazos de días, prórrogas, revancha, clasificación y avisos por Telegram.

## Características

- **6 jugadores fijos** (`Manuel`, `Fernan`, `Alberto`, `Alvaro`, `Alejandro`
  y `Abuelo`, que además es administrador).
- Plazo de **2 días por jugada**, con prórroga y margen de gracia.
- Persistencia en **PostgreSQL** (Neon) o en memoria para desarrollo; las
  partidas abiertas se restauran al reiniciar.
- **Revancha** en la misma sala con intercambio de colores.
- **Tablas por acuerdo**: un jugador propone y el otro acepta o rechaza.
- **Modo espectador** con `/corespon/CODE?ver=1`.
- **Ranking**: todos empiezan con **1500**; victoria **+25**, derrota **−25**,
  tablas **0**. Desempate por rating, victorias y nombre.
- **Notificaciones por Telegram**: invitación, turno, recordatorio, prórroga,
  tiempo agotado y fin de partida, con reintentos y backoff.

## Arranque local

```bash
npm install
cp .env.example .env      # edita DATABASE_URL y TELEGRAM_*
npm start                 # http://localhost:3001/corespon
```

Sin `DATABASE_URL` la aplicación funciona en memoria (los datos se pierden al
reiniciar). Para crear el roster fijo en Postgres:

```bash
npm run init-db
```

### Pruebas

```bash
npm test
```

No necesitan base de datos ni red: usan el store en memoria, un proveedor de
notificaciones falso y **pg-mem** para ejecutar el esquema y las consultas de
PostgreSQL sin levantar un servidor. Aun así, conviene probar contra Neon antes
de confiar en una migración.

## Variables de entorno

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `PORT` | no | Puerto HTTP (por defecto `3001`). |
| `BASE_URL` | recomendada | URL pública usada en los enlaces de los mensajes. |
| `DATABASE_URL` | no | Cadena de conexión de PostgreSQL; sin ella, memoria. |
| `PG_POOL_MAX` | no | Tamaño del pool de Postgres (por defecto `4`). |
| `TZ` | recomendada | Zona horaria, p. ej. `Europe/Madrid`. |
| `NOTIFY_PROVIDER` | no | `telegram` (por defecto si hay token), `meta`, `twilio` o `sendgrid`. |
| `TELEGRAM_BOT_TOKEN` | Telegram | Token del bot de @BotFather. |
| `TELEGRAM_CHAT_ID` | Telegram | Chat o grupo donde publicar. |
| `TELEGRAM_CHAT_<JUGADOR>` | no | Chat privado por jugador; si falta, va al grupo. |
| `ADMIN_TOKEN` | recomendada | Protege `GET /api/whatsapp/queue` con `x-admin-token`. |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` | solo Meta | Credenciales de Meta Cloud API. |
| `WHATSAPP_ACCOUNT_SID`, `WHATSAPP_AUTH_TOKEN`, `WHATSAPP_FROM` | solo Twilio | Credenciales de Twilio. |

La variable histórica `WHATSAPP_PROVIDER` sigue funcionando como alias de
`NOTIFY_PROVIDER`.

## Configurar Telegram

1. Habla con **@BotFather**, crea un bot con `/newbot` y copia el token.
2. Crea un grupo con los jugadores, añade el bot y dale permiso para escribir.
3. Envía un mensaje al grupo y consulta
   `https://api.telegram.org/bot<TOKEN>/getUpdates` para obtener el `chat.id`
   del grupo (empieza por `-100`).
4. Define `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID`.
5. Opcional: cada jugador escribe `/start` al bot y defines su chat privado en
   `TELEGRAM_CHAT_MANUEL`, `TELEGRAM_CHAT_ABUELO`, etc.

Los mensajes se encolan en `corespon_notificaciones`. Un fallo se reintenta a
los 1 y 5 minutos; al tercer intento queda como `fallido`. Puedes ver la cola:

```bash
curl -H "x-admin-token: $ADMIN_TOKEN" \
  "https://tu-app.onrender.com/api/whatsapp/queue?estado=fallido"
```

## Despliegue en Render

Servicio ya creado: **`aje-corespon`** → <https://aje-corespon.onrender.com>
(plan free, región `oregon`, misma que Neon `us-west-2`).

`render.yaml` describe el servicio:

- `buildCommand: npm ci --omit=dev`
- `startCommand: node server.js`
- `healthCheckPath: /healthz` (liveness sin base de datos)
- `TZ=Europe/Madrid` y `NOTIFY_PROVIDER=telegram`

Variables que deben existir en el panel **Environment**:

| Variable | Estado |
| --- | --- |
| `DATABASE_URL` | configurada (Neon, `/neondb`). |
| `ADMIN_TOKEN` | configurada; protege `/api/whatsapp/queue`. |
| `BASE_URL` | configurada; enlaces de los avisos de los temporizadores. |
| `TELEGRAM_BOT_TOKEN` | configurada (bot `@ajecorespon_abuelo_bot`). |
| `TELEGRAM_CHAT_ID` | configurada (grupo familiar). |

El roster (6 jugadores, Abuelo administrador) se crea solo al arrancar; no
hace falta ejecutar `npm run init-db` en producción.

Comprobación rápida:

```bash
curl https://aje-corespon.onrender.com/healthz
# {"ok":true,"servicio":"aje-corespon","storage":"postgres",...}

curl https://aje-corespon.onrender.com/api/status
curl https://aje-corespon.onrender.com/api/players
```

Cambiar una variable de entorno en Render **no redespliega solo**: pulsa
**Manual Deploy → Deploy latest commit** (o `render deploys create <service>`)
después de guardarla.

> El servicio antiguo `ajedrez-online` sigue vivo (torneo en curso) y comparte
> la instancia Neon, pero usa tablas `torneo_*`. Este servicio solo toca
> `corespon_*`, así que no se pisan. Se puede suspender cuando acabe el torneo.

## API

| Ruta | Descripción |
| --- | --- |
| `GET /corespon`, `GET /corespon/:code` | Interfaz de juego. |
| `GET /api/players` | Roster (incluye `admin`). |
| `POST /api/players/:id/whatsapp` | Guarda el teléfono de un jugador. |
| `GET /api/partidas` | Partidas abiertas. |
| `GET /api/partidas/:code` | Estado de una partida. |
| `POST /api/partidas/invitar` | Crea una invitación. |
| `DELETE /api/partidas/:code` | Borra una partida (solo con `ADMIN_TOKEN`). |
| `GET /api/classification` | Ranking (1500 ±25). |
| `GET /healthz` | Liveness (no toca la base de datos). |
| `GET /api/status` | Estadísticas y salud (consulta Postgres). |
| `GET /api/whatsapp/queue` | Cola de notificaciones (`?estado=`, con `ADMIN_TOKEN`). |

El juego en tiempo real usa **Socket.IO** (`corespon:join`, `corespon:move`,
`corespon:resign`, `corespon:extend`, `corespon:draw`, `corespon:draw:accept`,
`corespon:draw:decline`, `corespon:rematch`, `corespon:watch`).

Salir de una partida en curso desde el botón **Salir** cuenta como rendición;
cerrar la pestaña o perder la conexión permite reanudar al volver.

## Estructura

```
server.js                 entrada de producción (SIGTERM, arranque)
init-db.js                crea el roster fijo en Postgres
render.yaml               despliegue en Render
corespon/
  server/server.js        rutas HTTP + Socket.IO + temporizadores
  server/rooms.js         sala, reglas, plazos, snapshot
  server/db.js            store en memoria y PostgreSQL
  server/classification.js clasificación
  server/whatsapp.js      canal de notificaciones (Telegram, Meta, Twilio)
  public/                 cliente (tablero, sesión, clasificación)
  tests/                  pruebas con node:test
.planning/PLAN.md         hoja de ruta y estado
```
