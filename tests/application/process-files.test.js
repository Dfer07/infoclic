import test from 'node:test';
import assert from 'node:assert/strict';
import { processIncomingFiles } from '../../src/application/process-files.js';
import { env } from '../../src/config/env.js';

const ID = env.hubspot.identityProperty;

function makeFakeDeps({
  files = [],
  fileBuffers = {},
  hubspotProperties = new Set(['firstname', 'lastname', ID, 'email']),
  existingContacts = [],
  createError = null,
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
      if (createError) throw createError;
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
  const csv = `firstname,lastname,${ID},email\nCarlos,Martínez,12345,c@x.com\nLucía,Gómez,67890,l@x.com\n`;
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
  const csv = `firstname,lastname,${ID},email\nCarlos,Martínez,12345,c@x.com\n`;
  const deps = makeFakeDeps({
    files: ['files_in/x.csv'],
    fileBuffers: { 'files_in/x.csv': Buffer.from(csv) },
    existingContacts: [
      { id: 'h1', properties: { [ID]: '12345', firstname: 'Andrés', lastname: '', email: '' } },
    ],
  });

  await processIncomingFiles(deps);

  assert.equal(deps.calls.created.length, 0);
  assert.equal(deps.calls.updated.length, 1);
  // firstname está lleno en CRM → no se actualiza. lastname y email sí.
  assert.deepEqual(Object.keys(deps.calls.updated[0].properties).sort(), ['email', 'lastname']);
});

test('aborta archivo si hay columna sin propiedad en HubSpot', async () => {
  const csv = `firstname,${ID},columna_desconocida\nCarlos,12345,foo\n`;
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

test('manda filas sin identity a .errors.csv', async () => {
  const csv = `firstname,lastname,${ID},email\nCarlos,Martínez,,c@x.com\nLucía,Gómez,67890,l@x.com\n`;
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
  const csv = `firstname,${ID}\nCarlos,12345\nCarlosUpdated,12345\n`;
  const deps = makeFakeDeps({
    files: ['files_in/x.csv'],
    fileBuffers: { 'files_in/x.csv': Buffer.from(csv) },
  });

  await processIncomingFiles(deps);

  assert.equal(deps.calls.created.length, 1);
  assert.equal(deps.calls.created[0].firstname, 'CarlosUpdated');
});

test('sube un .report.json al final del procesamiento exitoso', async () => {
  const csv = `firstname,${ID}\nCarlos,12345\n`;
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

test('empty CSV generates report and moves to files_out', async () => {
  const csv = `firstname,${ID}\n`; // Only header, no rows
  const deps = makeFakeDeps({
    files: ['files_in/empty.csv'],
    fileBuffers: { 'files_in/empty.csv': Buffer.from(csv) },
  });

  await processIncomingFiles(deps);

  // File moved to files_out
  const mainMove = deps.calls.movedTo.find((m) => m.destKey.startsWith('files_out/'));
  assert.ok(mainMove);

  // Report generated
  const reportUpload = deps.calls.uploaded.find((u) => u.key.endsWith('.report.json'));
  assert.ok(reportUpload);
  const parsed = JSON.parse(reportUpload.body);
  assert.equal(parsed.rows_total, 0);
  assert.equal(parsed.contacts_created, 0);
  assert.equal(parsed.contacts_updated, 0);
  assert.equal(parsed.contacts_unchanged, 0);
  assert.equal(parsed.errors_file, null);

  // No errors CSV
  const errorsUpload = deps.calls.uploaded.find((u) => u.key.endsWith('.errors.csv'));
  assert.equal(errorsUpload, undefined);
});

test('error permanente de HubSpot (409 CONFLICT) mueve archivo a files_error/', async () => {
  const csv = `firstname,${ID},email\nCarlos,12345,c@x.com\n`;
  const conflictErr = Object.assign(new Error('Contact already exists'), {
    code: 409,
    body: { message: 'Contact already exists. Existing ID: 222544457474' },
  });
  const deps = makeFakeDeps({
    files: ['files_in/x.csv'],
    fileBuffers: { 'files_in/x.csv': Buffer.from(csv) },
    createError: conflictErr,
  });

  await processIncomingFiles(deps);

  // archivo movido a files_error/, NO a files_in/
  assert.equal(deps.calls.movedTo.length, 1);
  assert.ok(deps.calls.movedTo[0].destKey.startsWith('files_error/'));

  // se subió un .errors.csv con la razón
  const errorsUpload = deps.calls.uploaded.find((u) => u.key.endsWith('.errors.csv'));
  assert.ok(errorsUpload);
  assert.ok(errorsUpload.body.includes('409'));
});

test('error transitorio de HubSpot (503) deja archivo en files_in/ para retry', async () => {
  const csv = `firstname,${ID},email\nCarlos,12345,c@x.com\n`;
  const serverErr = Object.assign(new Error('Service Unavailable'), { code: 503 });
  const deps = makeFakeDeps({
    files: ['files_in/x.csv'],
    fileBuffers: { 'files_in/x.csv': Buffer.from(csv) },
    createError: serverErr,
  });

  await processIncomingFiles(deps);

  // archivo NO movido (queda en files_in/ para próximo tick)
  assert.equal(deps.calls.movedTo.length, 0);

  // no se subió .errors.csv ni .report.json
  assert.equal(deps.calls.uploaded.length, 0);
});
