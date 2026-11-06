# Aje-Corespon — Agent Quickstart

**Repo:** https://github.com/mahuca/aje-corespon  
**Producción:** https://aje-corespon.onrender.com

---

## 1. Comandos útiles

| Acción | Comando |
|---|---|
| Instalar dependencias | `npm install` |
| Iniciar servidor (producción) | `npm start` |
| Modo desarrollo (auto-reload) | `npm run dev` |
| Ejecutar tests (119 tests) | `npm test` |
| Crear roster en Postgres | `npm run init-db` |
| Ver cola de notificaciones (admin) | `curl -H "x-admin-token: $ADMIN_TOKEN" "https://<url>/api/whatsapp/queue"` |
| Health check | `curl https://<url>/healthz` |

---

## 2. Arquitectura y entrypoints

- **Servidor:** `server.js` — entrada Node/Express + Socket.IO. Escucha en `PORT=3001`.
- **Rutas principales:** `corespon/server/server.js` (HTTP + Socket.IO), `corespon/server/rooms.js` (reglas de sala), `corespon/server/db.js` (store), `corespon/server/classification.js` (ranking 1500±25), `corespon/server/whatsapp.js` (notificaciones Telegram).
- **Cliente:** `corespon/public/` — HTML/JS del tablero (`corespon.html`, `online-core.js`, `corespon.js`).
- **Tests:** `corespon/tests/server.test.js` — 119 tests de integración (5 del torneo, 7 de administración, 9 de claves y 6 del alta además de los de regresión). Se ejecutan con `cd corespon && node --test tests/*.test.js`.

---

## 3. Configuración y entorno

### Variables críticas (`.env` y Render)

| Variable | Importancia | Qué hace |
|---|---|---|
| `DATABASE_URL` | Alta | Cadena Postgres (Neon `/neondb` en prod). Sin ella, usa memoria volátil. |
| `TELEGRAM_BOT_TOKEN` | Alta | Token de @BotFather. |
| `TELEGRAM_CHAT_ID` | Alta | Chat o grupo donde van los mensajes de sistema (ej. `-100...`). |
| `TELEGRAM_CHAT_<JUGADOR>` | Media | Chat privado por jugador. Si existe, los avisos a ese jugador van privado; si falta, van al grupo. Ej: `TELEGRAM_CHAT_ABUELO=1385963387`. |
| `ADMIN_TOKEN` | Media | Protege el panel: `GET /api/whatsapp/queue`, `GET/PATCH /api/tournament/players`, `POST /api/admin/rotate-seats` y `GET/POST /api/admin/enrollment` (cabecera `x-admin-token`). |
| `PIN_PEPPER` | Media | Sal que se mezcla con la clave de cada jugador antes de guardarla (`sha256`). Si se cambia, **todas las claves existentes dejan de valer**. |
| `BASE_URL` | Recomendada | URL pública usada en enlaces de los mensajes de Telegram. |
| `TZ` | Recomendada | `Europe/Madrid` (afecta fechas en notificaciones). |
| `NOTIFY_PROVIDER` | Baja | `telegram` (por defecto si hay token). |

### Notas de configuración

- **Roster fijo de 6 jugadores**; `Abuelo` es administrador. Se crea solo al arrancar; no hace falta `init-db` en producción.
- El roster comparte base de datos Neon con `ajedrez-online`, pero usa tablas `corespon_*` (no se pisan).
- Si cambias una env var en Render, **hay que pulsar "Manual Deploy → Deploy latest commit"** para que surta efecto.

---

## 4. Quirks y gotchas (lo que un agente probablemente se perdería)

### Flujo de partida

- **Dos partidas a la vez**: el usuario puede cambiar de partida o volver a la lista **sin rendirse**. El botón `Partidas` regresa al listado; solo `Abandonar` cuenta como derrota.
- **`Abandonar` = rendición**; `Partidas` = volver a la lista sin rendirse; cerrar pestaña = guardar (sesión persistida).
- **Plazo de 2 días** empieza cuando **ambos** jugadores han entrado a la sala, no al crear la sala.
- **Etiquetas de estado**:
  - `joined:false` → `"<rival> aún no ha entrado"`
  - `joined:true && connected:false` → `"Rival sin conexión (la partida sigue)"`
  - En ambos casos el jugador **puede mover igual** (no se bloquea por desconexión).

### Botones y UI

- El botón que rinde debe llamarse **Abandonar**, no "Salir", para no confundir con cerrar pestaña.
- **Cambio de sala sin rendir**: `server.js` usa `resign:true` para rendir; `resign:false` solo desconecta el asiento.
- El aviso de turno ahora avisa al jugador que debe mover (no al que se movió). Fix commit `52ef2d4`.
- La lista de "Partidas abiertas" muestra el nombre de quien mueve con el badge `▶ Nombre` (`.turno-badge`). Se calcula en el cliente desde `turno` (`'white' | 'black'`) que ya devuelve `GET /api/partidas`; sin texto tipo "Le toca a".

### Clave personal (PIN) y alta cerrada

- **Cada jugador tiene una clave de 4–6 dígitos** para demostrar quién es; sin ella cualquiera con el código de sala puede escribir su nombre y mover por él.
- Se pide **una vez por dispositivo/navegador**: se guarda en `localStorage` (`corespon.pin.<Nombre>`) y se autorrellena. Recargar o reiniciar el servidor **no** la pide.
- **Reconectar con el token del asiento no pide clave** (es la prueba de identidad). El token va en el `snapshot` de la sala, así que sobrevive a los deploys.
- **El alta está cerrada por defecto**: una clave nueva solo se puede registrar si el admin abre la ventana (`POST /api/admin/enrollment { abrir: true, horas }`). Cerrada → error **`alta_cerrada`**. Así nadie reclama el nombre de otro.
- El admin puede **asignar** (`{ pin: "1234" }`) o **borrar** (`{ pin: null }`) la clave de un jugador, y ver `tieneClave` en el listado. Borrar la clave de alguien que está jugando no le expulsa.
- Se guarda `sha256(nombre + ':' + pin + PIN_PEPPER)`, nunca en claro. 5 fallos seguidos → bloqueo 10 min (`rate_limited`).
- `POST /api/admin/rotate-seats` cambia los tokens de las salas abiertas: deja fuera cualquier sesión antigua con un nombre ajeno **sin tocar** FEN, PGN, plazos ni turno. Es el paso obligatorio al activar las claves con partidas en curso.
- Orden de puesta en marcha: deploy → **abrir alta 2 h** → **cerrar sesiones abiertas** → avisar a los 6 → verificar "6 de 6 con clave" en el panel → **cerrar el alta**.
- Endpoints del alta: `GET /api/admin/enrollment` (estado + `sinClave`) y `POST /api/admin/enrollment` (`{ abrir: true, horas: 1..168 }` o `{ abrir: false }`). La hora de cierre se guarda en `corespon_ajustes` y sobrevive a los reinicios.

### Sesión y recarga

- `loadSession()` se llama al cargar la página; recargar **no pierde** la sesión.
- `session = loadSession()` en `online-core.js`. Auto-resume al reconectar.

### Telegram: avisos privados vs grupo

- Si existe `TELEGRAM_CHAT_<JUGADOR>`, los avisos de turno a ese jugador van a su chat privado.
- Si no existe, van al grupo `TELEGRAM_CHAT_ID`.
- **Para que abuelo tenga privado:** ejecutar `/start Abuelo` en Telegram con el bot `@ajecorespon_abuelo_bot`. Esto registra su `chat_id` privado.
- Los mensajes de sistema (invitar, recordatorio, fin de partida) **siguen yendo al grupo** mientras `TELEGRAM_CHAT_ID` esté configurado.

### Torneo (round-robin, 2 partidas por pareja)

- `GET /api/tournament` (alias `GET /api/tournament/start`) → resumen de solo lectura calculado con los jugadores activos: `totalPartidas = n × (n − 1)`. Con los 6 por defecto: 15 parejas × 2 = **30 partidas**. Devuelve además `partidasJugadas` / `partidasPendientes`.
- `POST /api/tournament/players` con `{ "nombre": "Nuria" }` → añade un jugador (400 nombre vacío, 409 duplicado). Exige `x-admin-token` **solo si `ADMIN_TOKEN` está definido**; en local sin `.env` funciona sin token.
- `GET /api/tournament/players` (admin) → lista completa con `activa` y `tieneClave`. `PATCH /api/tournament/players/:id` con `{ "activa": false }` → **baja sin borrar historial** (sale del torneo y de la clasificación, conserva sus partidas). Se bloquea si quedaran menos de 2 activos. Con `{ "pin": "1234" }` asigna clave y con `{ "pin": null }` la borra.
- El roster de 6 se sigue creando al arrancar, así que el torneo no necesita configuración previa.
- En el cliente, `loadClasificacion()` pinta el banner `.torneo-info` encima de la tabla; si el endpoint falla, la tabla se ve como siempre.
- El lobby tiene un panel **⚙️ Administración** (`#adminForm`) para añadir jugadores: pega el `ADMIN_TOKEN` una vez (se guarda en `localStorage`) y escribe el nombre. Los desplegables se rellenan desde `/api/players`, así que el jugador nuevo aparece sin recargar.

### Tests

- 119 tests en verde tras todos los fixes (5 del torneo, 7 de administración, 9 de claves y 6 del alta).
- Los tests usan `pg-mem` (Postgres en memoria) y un proveedor falso de notificaciones.
- Para testear contra Neon antes de fiar una migración, conviene tener `DATABASE_URL` puesta.
- Ejecutar: `cd corespon && node --test tests/*.test.js`.

---

## 5. Despliegue (Render)

- Servicio: `aje-corespon` — plan free, región `oregon`.
- `render.yaml`:
  - `buildCommand: npm ci --omit=dev`
  - `startCommand: node server.js`
  - `healthCheckPath: /healthz`
  - `TZ=Europe/Madrid` y `NOTIFY_PROVIDER=telegram`
- Variables de entorno en panel Render (ver README): `DATABASE_URL`, `ADMIN_TOKEN`, `BASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- **No tocar `ajedrez-online`** hasta que acabe el torneo en curso (usa tablas `torneo_*`, comparte Neon).

---

## 6. Decisiones clave (del PLAN.md / README)

- Ranking base 1500, victoria +25, derrota −25, tablas 0. Mostrar los 6.
- `Abandonar` = rendición; `Partidas` = volver a lista sin rendirse; cerrar pestaña = guardar.
- Servidor: `corespon:leave` con `resign:false` solo desconecta el asiento; solo `resign:true` rinde.
- Etiquetas: `"<rival> aún no ha entrado"` / `"Rival sin conexión (la partida sigue)"`.
- Bug del aviso de turno: ahora avisa al jugador que le toca, no al que se movió.
- 119 tests en verde tras fixes.

---