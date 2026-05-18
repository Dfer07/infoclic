import test from 'node:test';
import assert from 'node:assert/strict';
import { rowToContact } from '../../src/domain/transform.js';

test('rowToContact incluye campos con valor', () => {
  const row = { firstname: 'Carlos', lastname: 'Martínez', email: 'c@x.com' };
  const result = rowToContact(row);
  assert.deepEqual(result, { firstname: 'Carlos', lastname: 'Martínez', email: 'c@x.com' });
});

test('rowToContact omite campos con valor vacío', () => {
  const row = { firstname: 'Carlos', lastname: '', email: 'c@x.com' };
  const result = rowToContact(row);
  assert.deepEqual(result, { firstname: 'Carlos', email: 'c@x.com' });
});

test('rowToContact omite campos con espacios solamente', () => {
  const row = { firstname: '  ', lastname: 'Martínez' };
  const result = rowToContact(row);
  assert.deepEqual(result, { lastname: 'Martínez' });
});

test('rowToContact omite null y undefined', () => {
  const row = { firstname: null, lastname: undefined, email: 'c@x.com' };
  const result = rowToContact(row);
  assert.deepEqual(result, { email: 'c@x.com' });
});

test('rowToContact trimea valores con espacios alrededor', () => {
  const row = { firstname: '  Carlos  ' };
  const result = rowToContact(row);
  assert.deepEqual(result, { firstname: 'Carlos' });
});

test('rowToContact aplica resolver de propiedades HubSpot a las claves', () => {
  const row = { documento_de_identidad: '12345' };
  const result = rowToContact(row);
  assert.deepEqual(result, { documento_de_identidad: '12345' });
});
