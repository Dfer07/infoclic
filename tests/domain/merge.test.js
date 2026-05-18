import test from 'node:test';
import assert from 'node:assert/strict';
import { pickUpdatableFields } from '../../src/domain/merge.js';

test('pickUpdatableFields incluye campos donde CRM está vacío', () => {
  const csvProperties = { firstname: 'Carlos', email: 'c@x.com' };
  const crmProperties = { firstname: '', email: '' };
  const result = pickUpdatableFields(csvProperties, crmProperties);
  assert.deepEqual(result, { firstname: 'Carlos', email: 'c@x.com' });
});

test('pickUpdatableFields excluye campos donde CRM tiene valor (CRM gana)', () => {
  const csvProperties = { firstname: 'Carlos', email: 'c@x.com' };
  const crmProperties = { firstname: 'CarlosOLD', email: '' };
  const result = pickUpdatableFields(csvProperties, crmProperties);
  assert.deepEqual(result, { email: 'c@x.com' });
});

test('pickUpdatableFields trata null y undefined del CRM como vacío', () => {
  const csvProperties = { firstname: 'Carlos', lastname: 'M' };
  const crmProperties = { firstname: null, lastname: undefined };
  const result = pickUpdatableFields(csvProperties, crmProperties);
  assert.deepEqual(result, { firstname: 'Carlos', lastname: 'M' });
});

test('pickUpdatableFields devuelve objeto vacío si CRM tiene todo lleno', () => {
  const csvProperties = { firstname: 'Carlos' };
  const crmProperties = { firstname: 'Andrés' };
  const result = pickUpdatableFields(csvProperties, crmProperties);
  assert.deepEqual(result, {});
});

test('pickUpdatableFields ignora propiedades del CRM que no vienen en el CSV', () => {
  const csvProperties = { firstname: 'Carlos' };
  const crmProperties = { firstname: '', lastname: 'M', email: 'old@x.com' };
  const result = pickUpdatableFields(csvProperties, crmProperties);
  assert.deepEqual(result, { firstname: 'Carlos' });
});
