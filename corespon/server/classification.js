'use strict';

/*
 * Clasificación de la liga a partir de los resultados guardados.
 *
 * Puntuación: victoria 1, tablas 0.5, derrota 0.
 * Desempates: puntos, victorias, nombre.
 */

function computeClassification(resultados) {
  const tabla = new Map();

  function casilla(nombre) {
    if (!nombre) return null;
    if (!tabla.has(nombre)) {
      tabla.set(nombre, {
        nombre,
        partidas: 0,
        puntos: 0,
        victorias: 0,
        empates: 0,
        derrotas: 0
      });
    }
    return tabla.get(nombre);
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
      blancas.puntos += 0.5;
      negras.puntos += 0.5;
    } else if (resultado.resultado === 'blancas') {
      blancas.partidas++;
      negras.partidas++;
      blancas.victorias++;
      negras.derrotas++;
      blancas.puntos += 1;
    } else if (resultado.resultado === 'negras') {
      blancas.partidas++;
      negras.partidas++;
      negras.victorias++;
      blancas.derrotas++;
      negras.puntos += 1;
    }
  }

  return Array.from(tabla.values())
    .filter(fila => fila.partidas > 0)
    .sort((a, b) => b.puntos - a.puntos
      || b.victorias - a.victorias
      || a.nombre.localeCompare(b.nombre, 'es'));
}

module.exports = { computeClassification };
