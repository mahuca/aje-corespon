'use strict';

/*
 * Inicializa la base de datos con los 6 jugadores invitados.
 * Ejecutar con: node init-db.js
 */

const { createStore } = require('./corespon/server/db');

const JUGADORES = ['Manuel', 'Fernan', 'Alberto', 'Alvaro', 'Alejandro'];

async function main() {
  const store = createStore();
  await store.init();

  await store.initRoster(JUGADORES);

  const jugadores = await store.getPlayers();
  console.log('Jugadores registrados:');
  for (const j of jugadores) {
    console.log(`  - ${j.nombre} (id: ${j.id}, whatsapp: ${j.whatsapp || 'no configurado'})`);
  }

  await store.close();
  console.log('\nBase de datos inicializada correctamente.');
}

main().catch((error) => {
  console.error('Error inicializando la base de datos:', error);
  process.exit(1);
});
