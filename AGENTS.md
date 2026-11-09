# Aje-Corespon — Agent Quickstart

**Repo:** https://github.com/mahuca/aje-corespon
**Producción:** https://aje-corespon.onrender.com (`/corespon`)

## 1. Comandos

| Acción | Comando |
|---|---|
| Instalar | `npm install` |
| Servidor | `npm start` → `http://localhost:3001/corespon` |
| Auto-reload | `npm run dev` |
| Tests (128) | `npm test` |
| Un solo test | `cd corespon && node --test --test-name-pattern="vuelta" tests/server.test.js` |
| Crear roster en Postgres | `npm run init-db` (opcional: se crea solo al arrancar) |
| Liveness / readiness | `curl /healthz` (no toca BD) · `curl /api/status` (sí toca BD) |
| Cola de avisos (admin) | `curl -H "x-admin-token: $ADMIN_TOKEN" /api/whatsapp/queue` |

- `cp .env.example .env` para configurar. **Sin `DATABASE_URL` todo va a memoria volátil** (se pierde al reiniciar).
- Los tests usan `pg-mem` y un notificador falso: no necesitan red ni base de datos.

## 2. Entrypoints y arquitectura

- **Arranque real:** `server.js` (raíz) → `createServer({ completarAlArrancar: true })` → `corespon/server/server.js`. Render ejecuta `node server.js` desde la raíz (sin `rootDirectory`).
- **No arranques `corespon/server/server.js` directamente**: se autoarranca, pero **sin** `completarAlArrancar`, así que no crea las partidas ni vueltas que falten al inicio.
- Hay dos `package.json` (raíz y `corespon/`). **Manda el de la raíz** (`npm test` hace `cd corespon && node --test tests/*.test.js`).
- Backend: `corespon/server/server.js` (Express + Socket.IO), `rooms.js` (salas y vuelta), `db.js` (Postgres/memoria), `classification.js` (rating), `whatsapp.js` (Telegram/cola).
- Cliente: `corespon/public/` (`corespon.html`, `corespon.js`, `online-core.js`, `styles.css`). Motor compartido: `corespon/shared/engine.js`, servido en `/shared/engine.js`.
- Tests en 4 archivos: `server`, `engine`, `notifications`, `postgres`.
- `online-chess/` es **otro proyecto clonado** dentro del repo (gitignored): no editarlo ni usarlo como referencia.

## 3. Entorno y admin

| Variable | Qué hace |
|---|---|
| `DATABASE_URL` | Postgres (Neon `/neondb` en prod). Sin ella, memoria volátil. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Avisos al grupo. |
| `TELEGRAM_CHAT_<JUGADOR>` | Chat privado de ese jugador; si falta, el aviso va al grupo. |
| `ADMIN_TOKEN` | Protege los endpoints admin. **Si no está definido quedan abiertos**; si está, exigen `x-admin-token`. |
| `PIN_PEPPER` | Sal del hash de claves. Cambiarla invalida **todas** las claves existentes. |
| `BASE_URL` / `TZ` | Enlaces de los mensajes / `Europe/Madrid`. |

- Endpoints admin: `GET /api/whatsapp/queue`, `GET/POST/PATCH /api/tournament/players`, `POST /api/admin/rotate-seats`, `POST /api/admin/vueltas`, `POST /api/admin/partidas-pendientes`, `GET/POST /api/admin/enrollment`.
- `Abuelo` es admin **de aplicación** (`ADMINISTRADORES` en `server.js`), distinto del `ADMIN_TOKEN` de entorno.
- Este servicio usa tablas `corespon_*` en la **misma BD que `ajedrez-online`**: no tocar las tablas `torneo_*`.

## 4. Reglas de partida (lo que se rompe fácil)

- **Vuelta automática**: al terminar la primera partida de una pareja (mate, rendición, tiempo o tablas) la **misma sala** se reinicia con los colores cambiados. Nadie acepta nada y **no hay tercera partida**. Lógica: `crearVuelta()` (`server.js`), `Room.iniciarVuelta()` y bandera `vueltaCreada` (`rooms.js`).
- Guardia contra duplicados: la vuelta solo se crea si la pareja tiene 1 resultado, 0 partidas abiertas y ambos jugadores activos.
- `Abandonar` = rendición; `Partidas` = volver a la lista sin rendirse; cerrar pestaña = partida guardada. En el servidor, `corespon:leave` con `resign:false` solo desconecta el asiento.
- Un jugador puede tener **varias partidas abiertas** a la vez, pero el cliente guarda **una sola sesión** (`ajeCoresponSession_v1`): la última sala abierta.
- El plazo de 2 días **empieza cuando ambos han entrado**, no al crear la sala. Hay 1 h de gracia y hasta 3 prórrogas de 1 día.
- Etiquetas: `joined:false` → "«rival» aún no ha entrado"; `connected:false` → "Rival sin conexión (la partida sigue)". En ambos casos se puede mover.
- El aviso de turno va a quien **debe mover**, no a quien se movió.
- **Tablas por acuerdo**: `Proponer tablas` (en la tarjeta del plazo) avisa al rival por Telegram (`tablasMsg`) y deja `drawOffer` en la sala; el rival ve `Aceptar tablas` / `Rechazar`. La oferta se guarda y sobrevive a reinicios. Repetir la propuesta no duplica el aviso.
- El listado va por `plazo_hasta` (la que caduca antes, primero); el cliente lo agrupa en *Te toca mover* / *Esperando al rival* / *Otras* usando el nombre del lobby.

## 5. Claves (PIN) y alta cerrada

- Clave de 4–6 dígitos por jugador; sin ella cualquiera con el código de sala puede escribir su nombre y mover por él.
- Se guarda `sha256(nombre + ':' + pin + PIN_PEPPER)`, nunca en claro. 5 fallos seguidos → bloqueo 10 min (`rate_limited`).
- Se pide **una vez por navegador** (`localStorage`, clave `corespon.pin.<Nombre>`). Reconectar con el token del asiento **no** pide clave: el token viaja en el snapshot y sobrevive a los deploys.
- **El alta está cerrada por defecto**: registrar una clave nueva exige abrir la ventana (`POST /api/admin/enrollment { abrir:true, horas }`); si no, error `alta_cerrada`.
- Puesta en marcha con partidas en curso: deploy → abrir alta 2 h → `POST /api/admin/rotate-seats` → avisar a los jugadores → verificar "6 de 6 con clave" → cerrar el alta.
- `rotate-seats` cambia los tokens sin tocar FEN, PGN, plazos ni turno.

## 6. UI: gotchas

- **Confirmar jugada**: soltar o tocar el destino **no envía** la jugada. Se prepara (`pendingMove`), el tablero pinta la posición resultante (`estadoVista()` devuelve `pendingMove.preview`) y aparece **OK en rojo** (`#confirmMoveBtn`). OK o `Enter` envía; `Cancelar`, tocar el tablero o `Escape` la descarta. Mientras hay jugada preparada, `canInteract()` es `false`.
- La coronación también se confirma: elegir pieza abre la vista previa y luego OK.
- El botón que rinde debe llamarse **Abandonar**, no "Salir", para no confundirlo con cerrar la pestaña.
- Repaso de jugadas: el servidor solo manda la posición actual; el cliente reconstruye el pasado con `E.newState()` + `E.validateAndApply()` sobre `room.history`. Mientras se revisa, `enVivo()` es `false` y el tablero queda bloqueado.
- El badge `▶ Nombre` de quien mueve se calcula en el cliente desde `turno`; el servidor no manda ese texto.

## 7. Despliegue (Render)

- Servicio `aje-corespon`, plan free, región `oregon`: `buildCommand: npm ci --omit=dev`, `startCommand: node server.js`, `healthCheckPath: /healthz`.
- Variables con `sync: false` en `render.yaml` (`DATABASE_URL`, `ADMIN_TOKEN`, `TELEGRAM_*`) se definen en el panel.
- Tras desplegar, comprobar `GET /api/status` (`estadisticas` desde Postgres) y que las salas abiertas siguen ahí.
