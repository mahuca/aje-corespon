'use strict';

/*
 * Punto de entrada principal de Aje-Corespon.
 * Sirve la aplicación de ajedrez por correspondencia.
 */

const { createServer } = require('./corespon/server/server');

const instance = createServer({ quiet: false });

instance.start().catch((error) => {
  console.error('[corespon] No se pudo arrancar el servidor:', error.message);
  process.exit(1);
});

/*
 * Render (y cualquier PaaS) envía SIGTERM al desplegar o escalar. Cerramos
 * sockets, temporizadores y el pool de Postgres, con un límite de tiempo para
 * no quedarnos colgados.
 */
let cerrando = false;
async function apagar(signal) {
  if (cerrando) return;
  cerrando = true;
  console.log(`[corespon] ${signal}: cerrando servidor…`);

  const limite = setTimeout(() => {
    console.error('[corespon] El cierre tardó demasiado; salgo igualmente.');
    process.exit(1);
  }, 10000);
  limite.unref();

  try {
    await instance.close();
    clearTimeout(limite);
    console.log('[corespon] Servidor cerrado.');
    process.exit(0);
  } catch (error) {
    console.error('[corespon] Error cerrando:', error.message);
    process.exit(1);
  }
}

process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT', () => apagar('SIGINT'));
