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
