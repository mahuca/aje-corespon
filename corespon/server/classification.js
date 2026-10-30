'use strict';

/*
 * Clasificación por rating fijo.
 *
 * Todos los jugadores empiezan en 1500. Cada partida decisiva mueve +25 al
 * ganador y -25 al perdedor; las tablas no cambian el rating. El rating se
 * calcula siempre desde los resultados guardados, así que no hay una columna
 * que se pueda desincronizar.
 *
 * Desempates: rating, victorias y nombre.
 */

const RATING_INICIAL = 1500;
const RATING_VICTORIA = 25;

function computeClassification(resultados, jugadores = []) {
  const tabla = new Map();

  function casilla(nombre) {
    if (!nombre) return null;
    if (!tabla.has(nombre)) {
      tabla.set(nombre, {
        nombre,
        rating: RATING_INICIAL,
        partidas: 0,
        victorias: 0,
        empates: 0,
        derrotas: 0
      });
    }
    return tabla.get(nombre);
  }

  // El roster completo aparece aunque todavía no haya jugado nadie.
  for (const jugador of jugadores || []) {
    if (jugador && jugador.nombre) casilla(jugador.nombre);
  }

  for (const resultado of resultados || []) {
    if (!resultado || !resultado.blancas || !resultado.negras) continue;

    const blancas = casilla(resultado.blancas);
    const negras = casilla(resultado.negras);

    if (resultado.resultado === 'tablas') {
      blancas.partidas++;
      negras.partidas++;
      blancas.empates++;
      negras.empates++;
      // Las tablas cuentan como partida pero no mueven el rating.
    } else if (resultado.resultado === 'blancas') {
      blancas.partidas++;
      negras.partidas++;
      blancas.victorias++;
      negras.derrotas++;
      blancas.rating += RATING_VICTORIA;
      negras.rating -= RATING_VICTORIA;
    } else if (resultado.resultado === 'negras') {
      blancas.partidas++;
      negras.partidas++;
      negras.victorias++;
      blancas.derrotas++;
      negras.rating += RATING_VICTORIA;
      blancas.rating -= RATING_VICTORIA;
    }
  }

  return Array.from(tabla.values())
    .sort((a, b) => b.rating - a.rating
      || b.victorias - a.victorias
      || a.nombre.localeCompare(b.nombre, 'es'));
}

module.exports = { computeClassification, RATING_INICIAL, RATING_VICTORIA };
