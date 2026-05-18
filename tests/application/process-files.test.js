import test from 'node:test';
import assert from 'node:assert/strict';
import { processIncomingFiles } from '../../src/application/process-files.js';

function makeFakeDeps({
  files = [],
  fileBuffers = {},
  hubspotProperties = new Set(['firstname', 'lastname', 'documento_de_identidad', 'email']),
  existingContacts = [],
} = {}) {
  const movedTo = [];
  const uploaded = [];
  const created = [];
  const updated = [];

  const r2 = {
    list: async () => files,
    download: async (key) => fileBuffers[key],
    move: async ({ sourceKey, destKey }) => {
      movedTo.push({ sourceKey, destKey });
    },
    upload: async ({ key, body }) => {
      uploaded.push({ key, body: body.toString() });
    },
  };
  const hubspot = {
    fetchPropertyCatalog: async () => hubspotProperties,
    readByIdentity: async () => existingContacts,
    create: async (batch) => {
      created.push(...batch);
      return batch.map((b, i) => ({ id: `c-${i}`, properties: b }));
    },
    update: async (batch) => {
      updated.push(...batch);
      return batch.map((b) => ({ id: b.id, properties: b }));
    },
  };
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const clock = () => new Date('2026-05-20T10:00:00.000Z');

  return { r2, hubspot, logger, clock, calls: { movedTo, uploaded, created, updated } };
}

test('procesa un archivo con 2 contactos nuevos', async () => {
  const csv = 'firstname,lastname,documento_de_identidad,email\nCarlos,Martínez,12345,c@x.com\nLucía,Gómez,67890,l@x.com\n';
  const deps = makeFakeDeps({
    files: ['files_in/x.csv'],
    fileBuffers: { 'files_in/x.csv': Buffer.from(csv) },
    existingContacts: [],
  });

  await processIncomingFiles(deps);

  assert.equal(deps.calls.created.length, 2);
  assert.equal(deps.calls.updated.length, 0);
  assert.equal(deps.calls.movedTo.length, 1);
  assert.ok(deps.calls.movedTo[0].destKey.startsWith('files_out/'));
});

test('actualiza solo campos vacíos en CRM (CRM gana)', async () => {
  const csv = 'firstname,lastname,documento_de_identidad,email\nCarlos,Martínez,12345,c@x.com\n';
  const deps = makeFakeDeps({
    files: ['files_in/x.csv'],
    fileBuffers: { 'files_in/x.csv': Buffer.from(csv) },
    existingContacts: [
      { id: 'h1', properties: { documento_de_identidad: '12345', firstname: 'Andrés', lastname: '', email: '' } },
    ],
  });

  await processIncomingFiles(deps);

  assert.equal(deps.calls.created.length, 0);
  assert.equal(deps.calls.updated.length, 1);
  // firstname está lleno en CRM → no se actualiza. lastname y email sí.
  assert.deepEqual(Object.keys(deps.calls.updated[0].properties).sort(), ['email', 'lastname']);
});

test('aborta archivo si hay columna sin propiedad en HubSpot', async () => {
  const csv = 'firstname,documento_de_identidad,columna_desconocida\nCarlos,12345,foo\n';
  const deps = makeFakeDeps({
    files: ['files_in/x.csv'],
    fileBuffers: { 'files_in/x.csv': Buffer.from(csv) },
  });

  await processIncomingFiles(deps);

  // movido a files_error/, no a files_out/
  assert.equal(deps.calls.movedTo.length, 1);
  assert.ok(deps.calls.movedTo[0].destKey.startsWith('files_error/'));
  assert.equal(deps.calls.created.length, 0);
  // se sube un .errors.csv
  const errorsUpload = deps.calls.uploaded.find((u) => u.key.endsWith('.errors.csv'));
  assert.ok(errorsUpload);
});

test('manda filas sin documento_de_identidad a .errors.csv', async () => {
  const csv = 'firstname,lastname,documento_de_identidad,email\nCarlos,Martínez,,c@x.com\nLucía,Gómez,67890,l@x.com\n';
  const deps = makeFakeDeps({
    files: ['files_in/x.csv'],
    fileBuffers: { 'files_in/x.csv': Buffer.from(csv) },
  });

  await processIncomingFiles(deps);

  assert.equal(deps.calls.created.length, 1); // solo Lucía
  const errorsUpload = deps.calls.uploaded.find((u) => u.key.endsWith('.errors.csv'));
  assert.ok(errorsUpload);
  // archivo principal se mueve a files_out/ (procesamiento exitoso parcial)
  const mainMove = deps.calls.movedTo.find((m) => m.destKey.startsWith('files_out/'));
  assert.ok(mainMove);
});

test('deduplicación intra-CSV: última fila gana', async () => {
  const csv = 'firstname,documento_de_identidad\nCarlos,12345\nCarlosUpdated,12345\n';
  const deps = makeFakeDeps({
    files: ['files_in/x.csv'],
    fileBuffers: { 'files_in/x.csv': Buffer.from(csv) },
  });

  await processIncomingFiles(deps);

  assert.equal(deps.calls.created.length, 1);
  assert.equal(deps.calls.created[0].firstname, 'CarlosUpdated');
});

test('sube un .report.json al final del procesamiento exitoso', async () => {
  const csv = 'firstname,documento_de_identidad\nCarlos,12345\n';
  const deps = makeFakeDeps({
    files: ['files_in/x.csv'],
    fileBuffers: { 'files_in/x.csv': Buffer.from(csv) },
  });

  await processIncomingFiles(deps);

  const reportUpload = deps.calls.uploaded.find((u) => u.key.endsWith('.report.json'));
  assert.ok(reportUpload);
  const parsed = JSON.parse(reportUpload.body);
  assert.equal(parsed.rows_total, 1);
  assert.equal(parsed.contacts_created, 1);
});
