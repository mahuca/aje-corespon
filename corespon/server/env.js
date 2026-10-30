'use strict';

/*
 * Carga mínima de `.env` sin dependencias externas.
 *
 * Busca el archivo en la raíz del repositorio y en `corespon/`. Las variables
 * ya definidas en el entorno tienen prioridad (Render, docker, CI…).
 */

const fs = require('fs');
const path = require('path');

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const separator = trimmed.indexOf('=');
  if (separator <= 0) return null;

  const key = trimmed.slice(0, separator).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) return null;

  let value = trimmed.slice(separator + 1).trim();
  const quoted = (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"));
  if (quoted && value.length >= 2) value = value.slice(1, -1);

  return { key, value };
}

function applyFile(file) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return false;
  }

  for (const line of content.split(/\r?\n/)) {
    const entry = parseLine(line);
    if (!entry) continue;
    if (process.env[entry.key] === undefined) process.env[entry.key] = entry.value;
  }
  return true;
}

function loadEnv() {
  const candidates = [
    path.join(__dirname, '..', '..', '.env'),
    path.join(__dirname, '..', '.env')
  ];

  const loaded = [];
  for (const file of candidates) {
    if (applyFile(file)) loaded.push(file);
  }
  return loaded;
}

module.exports = { loadEnv, parseLine };
