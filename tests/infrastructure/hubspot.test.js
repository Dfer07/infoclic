import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchPropertyCatalog,
  readContactsByIdProperty,
  createContacts,
  updateContacts,
} from '../../src/infrastructure/hubspot.js';

function fakeHubspotClient({ properties = [], readResults = [] }) {
  const calls = { read: [], create: [], update: [], propertiesGet: 0 };
  return {
    calls,
    crm: {
      properties: {
        coreApi: {
          getAll: async () => {
            calls.propertiesGet += 1;
            return { results: properties };
          },
        },
      },
      contacts: {
        batchApi: {
          read: async (input) => {
            calls.read.push(input);
            return { results: readResults };
          },
          create: async (input) => {
            calls.create.push(input);
            return { results: input.inputs.map((i, idx) => ({ id: `new-${idx}`, properties: i.properties })) };
          },
          update: async (input) => {
            calls.update.push(input);
            return { results: input.inputs.map((i) => ({ id: i.id, properties: i.properties })) };
          },
        },
      },
    },
  };
}

test('fetchPropertyCatalog devuelve un Set con nombres internos', async () => {
  const client = fakeHubspotClient({
    properties: [{ name: 'firstname' }, { name: 'lastname' }, { name: 'email' }],
  });
  const names = await fetchPropertyCatalog(client);
  assert.ok(names instanceof Set);
  assert.equal(names.size, 3);
  assert.ok(names.has('firstname'));
  assert.ok(names.has('email'));
});

test('readContactsByIdProperty pide al batchApi.read con idProperty', async () => {
  const client = fakeHubspotClient({
    readResults: [
      { id: 'h1', properties: { documento_de_identidad: '12345', firstname: 'Carlos' } },
    ],
  });
  const result = await readContactsByIdProperty(client, {
    idProperty: 'documento_de_identidad',
    ids: ['12345', '67890'],
    properties: ['firstname', 'lastname'],
  });
  assert.equal(client.calls.read.length, 1);
  assert.equal(client.calls.read[0].idProperty, 'documento_de_identidad');
  assert.equal(client.calls.read[0].inputs.length, 2);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'h1');
});

test('createContacts pasa el batch de propiedades sin id', async () => {
  const client = fakeHubspotClient({});
  const result = await createContacts(client, [
    { documento_de_identidad: '12345', firstname: 'Carlos' },
  ]);
  assert.equal(client.calls.create.length, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].properties.firstname, 'Carlos');
});

test('updateContacts incluye id interno de HubSpot', async () => {
  const client = fakeHubspotClient({});
  const result = await updateContacts(client, [
    { id: 'h1', properties: { firstname: 'Carlos' } },
  ]);
  assert.equal(client.calls.update.length, 1);
  assert.equal(client.calls.update[0].inputs[0].id, 'h1');
  assert.equal(result.length, 1);
});

test('createContacts no llama API si lista vacía', async () => {
  const client = fakeHubspotClient({});
  const result = await createContacts(client, []);
  assert.equal(client.calls.create.length, 0);
  assert.deepEqual(result, []);
});

test('updateContacts no llama API si lista vacía', async () => {
  const client = fakeHubspotClient({});
  const result = await updateContacts(client, []);
  assert.equal(client.calls.update.length, 0);
  assert.deepEqual(result, []);
});
