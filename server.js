'use strict';

/*
 * Punto de entrada principal de Aje-Corespon.
 * Sirve la aplicación de ajedrez por correspondencia.
 */

const { createServer } = require('./corespon/server/server');

createServer({ quiet: false });
