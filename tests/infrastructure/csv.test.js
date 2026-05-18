import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCsvBuffer } from '../../src/infrastructure/csv.js';

test('parseCsvBuffer parsea CSV UTF-8 limpio', () => {
  const buf = readFileSync('tests/fixtures/csv-utf8.csv');
  const rows = parseCsvBuffer(buf);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].firstname, 'Carlos');
  assert.equal(rows[0].lastname, 'Martínez');
  assert.equal(rows[1].lastname, 'Gómez');
});

test('parseCsvBuffer recupera CSV con mojibake (UTF-8 bytes interpretados como Latin-1)', () => {
  const buf = readFileSync('tests/fixtures/csv-mojibake.csv');
  const rows = parseCsvBuffer(buf);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].lastname, 'Martínez');
  assert.equal(rows[1].firstname, 'Lucía');
  assert.equal(rows[2].lastname, 'Rodríguez');
});

test('parseCsvBuffer respeta el header y produce objetos por fila', () => {
  const buf = readFileSync('tests/fixtures/csv-utf8.csv');
  const rows = parseCsvBuffer(buf);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['documento_de_identidad', 'email', 'firstname', 'lastname']);
});

test('parseCsvBuffer lanza error si el CSV no parsea', () => {
  const garbage = Buffer.from('"unterminated quote\n');
  assert.throws(() => parseCsvBuffer(garbage));
});
