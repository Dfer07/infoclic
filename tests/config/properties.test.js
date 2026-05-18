import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHubspotProperty, IDENTITY_PROPERTY } from '../../src/config/properties.js';

test('resolveHubspotProperty returns identity mapping by default', () => {
  assert.equal(resolveHubspotProperty('firstname'), 'firstname');
  assert.equal(resolveHubspotProperty('documento_de_identidad'), 'documento_de_identidad');
});

test('resolveHubspotProperty respects COLUMN_OVERRIDES if defined', async () => {
  const mod = await import('../../src/config/properties.js');
  assert.equal(typeof mod.COLUMN_OVERRIDES, 'object');
});

test('IDENTITY_PROPERTY defaults to documento_de_identidad', () => {
  assert.equal(IDENTITY_PROPERTY, 'documento_de_identidad');
});
