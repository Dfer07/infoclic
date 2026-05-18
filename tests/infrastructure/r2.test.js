import test from 'node:test';
import assert from 'node:assert/strict';
import { listIncomingCsv, downloadCsv, moveObject, uploadObject } from '../../src/infrastructure/r2.js';

function fakeClient(responses) {
  const calls = [];
  const client = {
    async send(command) {
      calls.push({ name: command.constructor.name, input: command.input });
      const handler = responses[command.constructor.name];
      if (!handler) throw new Error(`No mock for ${command.constructor.name}`);
      return handler(command.input);
    },
  };
  return { client, calls };
}

test('listIncomingCsv devuelve solo .csv del prefijo files_in/', async () => {
  const { client } = fakeClient({
    ListObjectsV2Command: () => ({
      Contents: [
        { Key: 'files_in/clientes.csv' },
        { Key: 'files_in/' },
        { Key: 'files_in/notas.txt' },
        { Key: 'files_in/otro.csv' },
      ],
    }),
  });
  const keys = await listIncomingCsv(client, { bucket: 'infoclic', prefix: 'files_in/' });
  assert.deepEqual(keys.sort(), ['files_in/clientes.csv', 'files_in/otro.csv']);
});

test('listIncomingCsv devuelve [] cuando no hay contenido', async () => {
  const { client } = fakeClient({
    ListObjectsV2Command: () => ({}),
  });
  const keys = await listIncomingCsv(client, { bucket: 'infoclic', prefix: 'files_in/' });
  assert.deepEqual(keys, []);
});

test('downloadCsv devuelve un Buffer', async () => {
  const expected = Buffer.from('firstname,lastname\nCarlos,M\n');
  const { client } = fakeClient({
    GetObjectCommand: () => ({
      Body: {
        transformToByteArray: async () => new Uint8Array(expected),
      },
    }),
  });
  const buf = await downloadCsv(client, { bucket: 'infoclic', key: 'files_in/x.csv' });
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString(), expected.toString());
});

test('moveObject hace copy seguido de delete', async () => {
  const { client, calls } = fakeClient({
    CopyObjectCommand: () => ({}),
    DeleteObjectCommand: () => ({}),
  });
  await moveObject(client, {
    bucket: 'infoclic',
    sourceKey: 'files_in/x.csv',
    destKey: 'files_out/2026-01-01-x.csv',
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, 'CopyObjectCommand');
  assert.equal(calls[1].name, 'DeleteObjectCommand');
});

test('uploadObject sube body con la key indicada', async () => {
  const { client, calls } = fakeClient({
    PutObjectCommand: () => ({}),
  });
  await uploadObject(client, {
    bucket: 'infoclic',
    key: 'files_out/report.json',
    body: Buffer.from('{}'),
    contentType: 'application/json',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'PutObjectCommand');
  assert.equal(calls[0].input.Key, 'files_out/report.json');
});
