# InfoClick Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir un servicio Node de larga duración que cada cierto intervalo lee CSVs de un bucket Cloudflare R2, los procesa, y sincroniza contactos en HubSpot respetando la regla "no sobrescribir vacíos" y la regla interim "CRM gana".

**Architecture:** Capas con dependencias hacia adentro: `entry → application → domain | infrastructure`. Sin DI containers, sin frameworks HTTP (no es API). Inyección por argumentos. Tests con `node --test` (built-in).

**Tech Stack:** Node 22 · `@aws-sdk/client-s3` · `@hubspot/api-client` · `csv-parse` · `iconv-lite` · `node-cron` · `pino` · `dotenv` · Docker

**Spec de referencia:** [docs/superpowers/specs/2026-05-17-infoclick-design.md](../specs/2026-05-17-infoclick-design.md)

---

## Estructura final del proyecto

Lo que vamos a haber construido al terminar:

```
smartflow-infoclick/
├── src/
│   ├── config/
│   │   ├── env.js              # carga .env, expone objeto env
│   │   └── properties.js       # IDENTITY_PROPERTY + COLUMN_OVERRIDES + resolver
│   ├── domain/
│   │   ├── transform.js        # row CSV → objeto contact (drop vacíos)
│   │   └── merge.js            # decide qué campos enviar (regla "CRM gana")
│   ├── infrastructure/
│   │   ├── csv.js              # parse + detección/conversión de encoding
│   │   ├── r2.js               # list, get, copy, delete en R2
│   │   ├── hubspot.js          # batch read, create, update + catálogo de props
│   │   ├── report.js           # generar .report.json y .errors.csv
│   │   └── logger.js           # instancia pino
│   ├── application/
│   │   └── process-files.js    # orquesta el flujo completo de un tick
│   ├── index.js                # entry con cron (npm start)
│   └── run-once.js             # entry para ejecución única (npm run process-once)
├── tests/
│   ├── domain/
│   │   ├── transform.test.js
│   │   └── merge.test.js
│   ├── infrastructure/
│   │   ├── csv.test.js
│   │   ├── r2.test.js
│   │   ├── hubspot.test.js
│   │   └── report.test.js
│   ├── application/
│   │   └── process-files.test.js
│   ├── config/
│   │   └── properties.test.js
│   └── fixtures/
│       ├── csv-utf8.csv
│       ├── csv-latin1.csv
│       └── csv-malformed.csv
├── .env.example
├── .gitignore
├── .dockerignore
├── Dockerfile
├── compose.yaml
├── package.json
├── README.md
├── CLAUDE.md
└── docs/superpowers/...
```

---

## Convenciones del plan

- **TDD**: cada feature empieza por un test que falla, luego implementación mínima, luego refactor si hace falta.
- **Frequent commits**: cada task termina con commit. Mensaje con prefijo `feat:`, `chore:`, `test:` o `docs:`.
- **Inyección por argumentos**: módulos exportan funciones que reciben sus dependencias (clientes, logger) como parámetros. La composición se hace en `index.js` y `run-once.js`.
- **Sin emojis ni decoración** en el código.
- **Sin comentarios "qué hace"**, solo "por qué" cuando hay matiz no obvio.

---

## Task 1: Scaffolding del proyecto

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `.dockerignore`
- Create: `tests/fixtures/.gitkeep`

- [ ] **Step 1: Crear `package.json`**

```json
{
  "name": "smartflow-infoclick",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "start": "node src/index.js",
    "process-once": "node src/run-once.js",
    "dev": "node --watch src/index.js",
    "test": "node --test --test-reporter=spec tests/"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "^3.700.0",
    "@hubspot/api-client": "^12.0.0",
    "csv-parse": "^5.5.0",
    "csv-stringify": "^6.5.0",
    "dotenv": "^16.4.0",
    "iconv-lite": "^0.6.3",
    "node-cron": "^3.0.3",
    "pino": "^9.5.0"
  },
  "devDependencies": {
    "pino-pretty": "^11.2.0"
  }
}
```

- [ ] **Step 2: Crear `.gitignore`**

```
node_modules/
.env
.env.local
.env.*.local
*.log
.DS_Store
coverage/
```

- [ ] **Step 3: Crear `.env.example`** (matchear el spec, sección 6)

```env
CRON_SCHEDULE=*/5 * * * *
RUN_ON_START=false
LOG_LEVEL=info

R2_ACCOUNT_ID=
R2_ENDPOINT=
R2_BUCKET_NAME=infoclic
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=

HUBSPOT_ACCESS_TOKEN=
HUBSPOT_IDENTITY_PROPERTY=documento_de_identidad

HUBSPOT_BATCH_DELAY_MS=100
```

- [ ] **Step 4: Crear `.dockerignore`**

```
node_modules
npm-debug.log
.env
.env.*
.git
.gitignore
README.md
CLAUDE.md
docs/
tests/
*.test.js
.dockerignore
Dockerfile
compose.yaml
```

- [ ] **Step 5: Crear el placeholder de fixtures**

```bash
mkdir -p tests/fixtures
touch tests/fixtures/.gitkeep
```

- [ ] **Step 6: Instalar dependencias**

```bash
npm install
```

Expected: `node_modules/` creado, `package-lock.json` generado, sin errores.

- [ ] **Step 7: Verificar que el test runner funciona**

```bash
npm test
```

Expected: "no tests found" o equivalente — no error, simplemente no hay tests aún.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json .gitignore .env.example .dockerignore tests/
git commit -m "chore: scaffold project structure and dependencies"
```

---

## Task 2: Configuración de variables de entorno

**Files:**
- Create: `src/config/env.js`

- [ ] **Step 1: Crear `src/config/env.js`**

```js
import 'dotenv/config';

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
};

export const env = {
  cronSchedule: process.env.CRON_SCHEDULE ?? '*/5 * * * *',
  runOnStart: process.env.RUN_ON_START === 'true',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  r2: {
    accountId: process.env.R2_ACCOUNT_ID,
    endpoint:
      process.env.R2_ENDPOINT ??
      (process.env.R2_ACCOUNT_ID
        ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
        : undefined),
    bucketName: process.env.R2_BUCKET_NAME ?? 'infoclic',
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    incomingPrefix: 'files_in/',
    processedPrefix: 'files_out/',
    errorPrefix: 'files_error/',
  },
  hubspot: {
    accessToken: process.env.HUBSPOT_ACCESS_TOKEN,
    identityProperty: process.env.HUBSPOT_IDENTITY_PROPERTY ?? 'documento_de_identidad',
    batchDelayMs: Number(process.env.HUBSPOT_BATCH_DELAY_MS ?? 100),
  },
};

export function validateEnv() {
  required('R2_ACCESS_KEY_ID');
  required('R2_SECRET_ACCESS_KEY');
  required('HUBSPOT_ACCESS_TOKEN');
  if (!env.r2.endpoint) {
    throw new Error('Either R2_ENDPOINT or R2_ACCOUNT_ID must be set');
  }
}
```

- [ ] **Step 2: Verificación rápida**

```bash
node -e "import('./src/config/env.js').then(m => console.log(m.env))"
```

Expected: imprime un objeto con `cronSchedule: '*/5 * * * *'`, valores R2/HubSpot probablemente `undefined` (porque no hay `.env` real). Sin errores.

- [ ] **Step 3: Commit**

```bash
git add src/config/env.js
git commit -m "feat(config): load env vars with defaults and validator"
```

---

## Task 3: Logger con pino

**Files:**
- Create: `src/infrastructure/logger.js`

- [ ] **Step 1: Crear `src/infrastructure/logger.js`**

```js
import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.logLevel,
  base: { service: 'infoclick' },
  timestamp: pino.stdTimeFunctions.isoTime,
});
```

- [ ] **Step 2: Verificación rápida**

```bash
node -e "import('./src/infrastructure/logger.js').then(({logger}) => logger.info({foo:'bar'}, 'hello'))"
```

Expected: una línea JSON con `level`, `time`, `service:"infoclick"`, `foo:"bar"`, `msg:"hello"`.

- [ ] **Step 3: Commit**

```bash
git add src/infrastructure/logger.js
git commit -m "feat(infra): add pino logger instance"
```

---

## Task 4: Configuración de propiedades (mapping centralizado)

**Files:**
- Create: `src/config/properties.js`
- Create: `tests/config/properties.test.js`

- [ ] **Step 1: Escribir tests (RED)**

`tests/config/properties.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHubspotProperty, IDENTITY_PROPERTY } from '../../src/config/properties.js';

test('resolveHubspotProperty returns identity mapping by default', () => {
  assert.equal(resolveHubspotProperty('firstname'), 'firstname');
  assert.equal(resolveHubspotProperty('documento_de_identidad'), 'documento_de_identidad');
});

test('resolveHubspotProperty respects COLUMN_OVERRIDES if defined', async () => {
  // Test via override via mutación temporal del módulo.
  // En producción, los overrides se definen estáticamente.
  // Para validar, hacemos un import fresh y comprobamos el shape.
  const mod = await import('../../src/config/properties.js');
  assert.equal(typeof mod.COLUMN_OVERRIDES, 'object');
});

test('IDENTITY_PROPERTY defaults to documento_de_identidad', () => {
  assert.equal(IDENTITY_PROPERTY, 'documento_de_identidad');
});
```

- [ ] **Step 2: Run tests, expect failure**

```bash
npm test -- tests/config/properties.test.js
```

Expected: FAIL — módulo no existe todavía.

- [ ] **Step 3: Implementar `src/config/properties.js`**

```js
import { env } from './env.js';

export const IDENTITY_PROPERTY = env.hubspot.identityProperty;

export const COLUMN_OVERRIDES = {};

export function resolveHubspotProperty(csvColumn) {
  return COLUMN_OVERRIDES[csvColumn] ?? csvColumn;
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
npm test -- tests/config/properties.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/properties.js tests/config/properties.test.js
git commit -m "feat(config): add CSV→HubSpot property resolver with overrides"
```

---

## Task 5: Domain — transformación de fila a contacto (regla "no sobrescribir vacíos")

**Files:**
- Create: `src/domain/transform.js`
- Create: `tests/domain/transform.test.js`

Esta es la regla core del dominio: una fila del CSV se convierte en un objeto `properties` que se mandará a HubSpot, con los campos vacíos **omitidos** (no enviados con `""`).

- [ ] **Step 1: Escribir tests (RED)**

`tests/domain/transform.test.js`:

```js
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
  // Por default es identity, así que las claves no cambian.
  const row = { documento_de_identidad: '12345' };
  const result = rowToContact(row);
  assert.deepEqual(result, { documento_de_identidad: '12345' });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
npm test -- tests/domain/transform.test.js
```

Expected: FAIL.

- [ ] **Step 3: Implementar `src/domain/transform.js`**

```js
import { resolveHubspotProperty } from '../config/properties.js';

export function rowToContact(row) {
  const properties = {};
  for (const [csvColumn, rawValue] of Object.entries(row)) {
    if (rawValue === null || rawValue === undefined) continue;
    const value = String(rawValue).trim();
    if (value === '') continue;
    const hubspotProperty = resolveHubspotProperty(csvColumn);
    properties[hubspotProperty] = value;
  }
  return properties;
}
```

- [ ] **Step 4: Run, expect pass**

```bash
npm test -- tests/domain/transform.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/transform.js tests/domain/transform.test.js
git commit -m "feat(domain): transform CSV row to contact properties dropping empties"
```

---

## Task 6: Domain — merge "CRM gana" (decidir qué campos enviar al update)

**Files:**
- Create: `src/domain/merge.js`
- Create: `tests/domain/merge.test.js`

Para un contacto que YA existe en HubSpot, decidir qué campos del CSV efectivamente se envían en el update. Regla: solo los campos donde HubSpot tiene vacío.

- [ ] **Step 1: Escribir tests (RED)**

`tests/domain/merge.test.js`:

```js
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
```

- [ ] **Step 2: Run, expect fail**

```bash
npm test -- tests/domain/merge.test.js
```

Expected: FAIL.

- [ ] **Step 3: Implementar `src/domain/merge.js`**

```js
function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  return false;
}

export function pickUpdatableFields(csvProperties, crmProperties) {
  const result = {};
  for (const [key, csvValue] of Object.entries(csvProperties)) {
    const crmValue = crmProperties?.[key];
    if (isEmpty(crmValue)) {
      result[key] = csvValue;
    }
  }
  return result;
}
```

- [ ] **Step 4: Run, expect pass**

```bash
npm test -- tests/domain/merge.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/merge.js tests/domain/merge.test.js
git commit -m "feat(domain): pickUpdatableFields enforces CRM-wins rule"
```

---

## Task 7: Infraestructura — CSV parsing con detección de encoding

**Files:**
- Create: `src/infrastructure/csv.js`
- Create: `tests/infrastructure/csv.test.js`
- Create: `tests/fixtures/csv-utf8.csv`
- Create: `tests/fixtures/csv-mojibake.csv` (CSV mal codificado a propósito)

- [ ] **Step 1: Crear fixtures**

`tests/fixtures/csv-utf8.csv`:

```
firstname,lastname,documento_de_identidad,email
Carlos,Martínez,1023456789,carlos.martinez@ejemplo.com
Lucía,Gómez,987654321,lucia.gomez@ejemplo.com
```

`tests/fixtures/csv-mojibake.csv` (matchea exactamente el CSV de prueba que envió el usuario):

```
firstname,lastname,documento_de_identidad,email
Carlos,MartÃ­nez,1023456789,carlos.martinez@ejemplo.com
LucÃ­a,GÃ³mez,987654321,lucia.gomez@ejemplo.com
AndrÃ©s,RodrÃ­guez,1122334455,andres.rodriguez@ejemplo.com
```

- [ ] **Step 2: Escribir tests (RED)**

`tests/infrastructure/csv.test.js`:

```js
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
```

- [ ] **Step 3: Run, expect fail**

```bash
npm test -- tests/infrastructure/csv.test.js
```

Expected: FAIL.

- [ ] **Step 4: Implementar `src/infrastructure/csv.js`**

```js
import { parse } from 'csv-parse/sync';
import iconv from 'iconv-lite';

const MOJIBAKE_MARKERS = ['Ã­', 'Ã³', 'Ã©', 'Ã¡', 'Ãº', 'Ã±', 'Ã‘'];

function hasMojibake(text) {
  return MOJIBAKE_MARKERS.some((m) => text.includes(m));
}

function decodeBuffer(buffer) {
  const utf8 = buffer.toString('utf8');
  if (!hasMojibake(utf8)) return utf8;
  // Recuperación de mojibake: la cadena utf8 actual tiene chars en rango Latin-1.
  // Re-encodearla como Latin-1 (un byte por char) restaura los bytes UTF-8 originales,
  // que al decodificarse como UTF-8 dan el texto correcto.
  return iconv.encode(utf8, 'latin1').toString('utf8');
}

export function parseCsvBuffer(buffer) {
  const text = decodeBuffer(buffer);
  return parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
}
```

- [ ] **Step 5: Run, expect pass**

```bash
npm test -- tests/infrastructure/csv.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/infrastructure/csv.js tests/infrastructure/csv.test.js tests/fixtures/
git commit -m "feat(infra): csv parser with utf-8 mojibake recovery"
```

---

## Task 8: Infraestructura — Cliente R2 (list, get, copy, delete)

**Files:**
- Create: `src/infrastructure/r2.js`
- Create: `tests/infrastructure/r2.test.js`

El módulo expone funciones puras que reciben un `S3Client` por argumento. Para tests, pasamos un fake.

- [ ] **Step 1: Escribir tests (RED)**

`tests/infrastructure/r2.test.js`:

```js
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
```

- [ ] **Step 2: Run, expect fail**

```bash
npm test -- tests/infrastructure/r2.test.js
```

Expected: FAIL.

- [ ] **Step 3: Implementar `src/infrastructure/r2.js`**

```js
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

export function createR2Client({ endpoint, accessKeyId, secretAccessKey }) {
  return new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
}

export async function listIncomingCsv(client, { bucket, prefix }) {
  const res = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }),
  );
  return (res.Contents ?? [])
    .map((o) => o.Key)
    .filter((k) => k && k !== prefix && k.endsWith('.csv'));
}

export async function downloadCsv(client, { bucket, key }) {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = await res.Body.transformToByteArray();
  return Buffer.from(bytes);
}

export async function moveObject(client, { bucket, sourceKey, destKey }) {
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${encodeURIComponent(sourceKey)}`,
      Key: destKey,
    }),
  );
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: sourceKey }));
}

export async function uploadObject(client, { bucket, key, body, contentType }) {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}
```

- [ ] **Step 4: Run, expect pass**

```bash
npm test -- tests/infrastructure/r2.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/r2.js tests/infrastructure/r2.test.js
git commit -m "feat(infra): r2 client wrappers for list, get, copy, delete, put"
```

---

## Task 9: Infraestructura — Cliente HubSpot (catálogo, batch read, batch create, batch update)

**Files:**
- Create: `src/infrastructure/hubspot.js`
- Create: `tests/infrastructure/hubspot.test.js`

El módulo expone funciones que reciben un cliente HubSpot inyectado. Para tests usamos un fake con las propiedades necesarias.

- [ ] **Step 1: Escribir tests (RED)**

`tests/infrastructure/hubspot.test.js`:

```js
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
```

- [ ] **Step 2: Run, expect fail**

```bash
npm test -- tests/infrastructure/hubspot.test.js
```

Expected: FAIL.

- [ ] **Step 3: Implementar `src/infrastructure/hubspot.js`**

```js
import { Client } from '@hubspot/api-client';

export function createHubspotClient({ accessToken }) {
  return new Client({ accessToken, numberOfApiCallRetries: 3 });
}

export async function fetchPropertyCatalog(client) {
  const res = await client.crm.properties.coreApi.getAll('contacts');
  return new Set((res.results ?? []).map((p) => p.name));
}

export async function readContactsByIdProperty(client, { idProperty, ids, properties }) {
  if (ids.length === 0) return [];
  const res = await client.crm.contacts.batchApi.read({
    idProperty,
    inputs: ids.map((id) => ({ id })),
    properties,
  });
  return res.results ?? [];
}

export async function createContacts(client, contacts) {
  if (contacts.length === 0) return [];
  const res = await client.crm.contacts.batchApi.create({
    inputs: contacts.map((properties) => ({ properties })),
  });
  return res.results ?? [];
}

export async function updateContacts(client, updates) {
  if (updates.length === 0) return [];
  const res = await client.crm.contacts.batchApi.update({
    inputs: updates.map((u) => ({ id: u.id, properties: u.properties })),
  });
  return res.results ?? [];
}
```

- [ ] **Step 4: Run, expect pass**

```bash
npm test -- tests/infrastructure/hubspot.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/hubspot.js tests/infrastructure/hubspot.test.js
git commit -m "feat(infra): hubspot client with property catalog + batch read/create/update"
```

---

## Task 10: Infraestructura — Reportes (.report.json y .errors.csv)

**Files:**
- Create: `src/infrastructure/report.js`
- Create: `tests/infrastructure/report.test.js`

- [ ] **Step 1: Escribir tests (RED)**

`tests/infrastructure/report.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReportJson, buildErrorsCsv } from '../../src/infrastructure/report.js';

test('buildReportJson serializa los campos esperados', () => {
  const summary = {
    processed_at: '2026-05-20T10:00:00.000Z',
    input_file: 'files_in/x.csv',
    output_file: 'files_out/2026-05-20-x.csv',
    rows_total: 10,
    duplicates_collapsed: 0,
    rows_skipped: 1,
    rows_processed: 9,
    contacts_created: 3,
    contacts_updated: 5,
    contacts_unchanged: 1,
    errors_file: null,
  };
  const json = buildReportJson(summary);
  const parsed = JSON.parse(json);
  assert.equal(parsed.rows_total, 10);
  assert.equal(parsed.contacts_created, 3);
  assert.equal(parsed.errors_file, null);
});

test('buildErrorsCsv produce CSV con header + _error_reason por fila', () => {
  const headers = ['firstname', 'documento_de_identidad', 'email'];
  const rows = [
    { row: { firstname: 'Carlos', documento_de_identidad: '', email: 'c@x.com' }, reason: 'missing required field: documento_de_identidad' },
    { row: { firstname: '', documento_de_identidad: '12345', email: 'a@x.com' }, reason: 'missing required field: firstname' },
  ];
  const csv = buildErrorsCsv(headers, rows);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'firstname,documento_de_identidad,email,_error_reason');
  assert.ok(lines[1].includes('Carlos'));
  assert.ok(lines[1].includes('missing required field: documento_de_identidad'));
  assert.equal(lines.length, 3);
});

test('buildErrorsCsv maneja valores con comas escapándolos', () => {
  const headers = ['firstname'];
  const rows = [{ row: { firstname: 'García, Carlos' }, reason: 'test' }];
  const csv = buildErrorsCsv(headers, rows);
  assert.ok(csv.includes('"García, Carlos"'));
});
```

- [ ] **Step 2: Run, expect fail**

```bash
npm test -- tests/infrastructure/report.test.js
```

Expected: FAIL.

- [ ] **Step 3: Implementar `src/infrastructure/report.js`**

```js
import { stringify } from 'csv-stringify/sync';

export function buildReportJson(summary) {
  return JSON.stringify(summary, null, 2);
}

export function buildErrorsCsv(headers, rows) {
  const allHeaders = [...headers, '_error_reason'];
  const records = rows.map(({ row, reason }) => {
    const record = {};
    for (const h of headers) record[h] = row[h] ?? '';
    record._error_reason = reason;
    return record;
  });
  return stringify(records, { header: true, columns: allHeaders });
}
```

- [ ] **Step 4: Run, expect pass**

```bash
npm test -- tests/infrastructure/report.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/report.js tests/infrastructure/report.test.js
git commit -m "feat(infra): report.json and errors.csv builders"
```

---

## Task 11: Aplicación — orquestación de un archivo

**Files:**
- Create: `src/application/process-files.js`
- Create: `tests/application/process-files.test.js`

Este es el corazón del flujo. Recibe todos los clientes como dependencias e implementa la lógica del spec sección 5.

- [ ] **Step 1: Escribir tests (RED)** — primero el camino exitoso

`tests/application/process-files.test.js`:

```js
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
      return batch.map((b) => ({ id: b.id, properties: b.properties }));
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
```

- [ ] **Step 2: Run, expect fail**

```bash
npm test -- tests/application/process-files.test.js
```

Expected: FAIL.

- [ ] **Step 3: Implementar `src/application/process-files.js`**

```js
import { parseCsvBuffer } from '../infrastructure/csv.js';
import { rowToContact } from '../domain/transform.js';
import { pickUpdatableFields } from '../domain/merge.js';
import { resolveHubspotProperty } from '../config/properties.js';
import { buildReportJson, buildErrorsCsv } from '../infrastructure/report.js';
import { env } from '../config/env.js';

const BATCH_SIZE = 100;

function timestampPrefix(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function basename(key) {
  return key.split('/').pop();
}

export async function processIncomingFiles(deps) {
  const { r2, hubspot, logger, clock } = deps;
  const keys = await r2.list();
  if (keys.length === 0) {
    logger.debug({}, 'no files to process');
    return;
  }

  const propertyCatalog = await hubspot.fetchPropertyCatalog();

  for (const key of keys) {
    await processOneFile(key, propertyCatalog, deps);
  }
}

async function processOneFile(key, propertyCatalog, deps) {
  const { r2, hubspot, logger, clock } = deps;
  const start = Date.now();
  const now = clock();
  const ts = timestampPrefix(now);
  const baseName = basename(key);

  let buffer;
  try {
    buffer = await r2.download(key);
  } catch (err) {
    logger.error({ err, key }, 'transient: download failed, will retry');
    return;
  }

  let rows;
  try {
    rows = parseCsvBuffer(buffer);
  } catch (err) {
    logger.error({ err, key }, 'permanent: csv malformed');
    await failPermanently(key, ts, baseName, [{ reason: `CSV parse error: ${err.message}` }], [], deps);
    return;
  }

  if (rows.length === 0) {
    logger.warn({ key }, 'empty CSV');
    await r2.move({ sourceKey: key, destKey: `files_out/${ts}-${baseName}` });
    return;
  }

  const headers = Object.keys(rows[0]);
  const missingProperties = headers
    .map((h) => resolveHubspotProperty(h))
    .filter((p) => !propertyCatalog.has(p));

  if (missingProperties.length > 0) {
    logger.error({ key, missingProperties }, 'permanent: properties missing in HubSpot');
    const reason = `Missing HubSpot properties: ${missingProperties.join(', ')}`;
    await failPermanently(key, ts, baseName, [{ row: {}, reason }], headers, deps);
    return;
  }

  const identityProperty = env.hubspot.identityProperty;
  if (!headers.includes(identityProperty)) {
    logger.error({ key, identityProperty }, 'permanent: identity column missing');
    const reason = `Identity column "${identityProperty}" missing in CSV header`;
    await failPermanently(key, ts, baseName, [{ row: {}, reason }], headers, deps);
    return;
  }

  const invalidRows = [];
  const validRows = [];
  for (const row of rows) {
    const idValue = String(row[identityProperty] ?? '').trim();
    if (!idValue) {
      invalidRows.push({ row, reason: `missing required field: ${identityProperty}` });
      continue;
    }
    validRows.push(row);
  }

  const byId = new Map();
  let duplicatesCollapsed = 0;
  for (const row of validRows) {
    const id = String(row[identityProperty]).trim();
    if (byId.has(id)) {
      duplicatesCollapsed += 1;
      logger.warn({ key, identityValue: id }, 'duplicate row in CSV, last wins');
    }
    byId.set(id, row);
  }
  const dedupedRows = [...byId.values()];

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  try {
    for (let i = 0; i < dedupedRows.length; i += BATCH_SIZE) {
      const slice = dedupedRows.slice(i, i + BATCH_SIZE);
      const ids = slice.map((r) => String(r[identityProperty]).trim());
      const existing = await hubspot.readByIdentity({
        idProperty: identityProperty,
        ids,
        properties: headers.map((h) => resolveHubspotProperty(h)),
      });

      const existingById = new Map();
      for (const c of existing) {
        existingById.set(String(c.properties[identityProperty]).trim(), c);
      }

      const toCreate = [];
      const toUpdate = [];
      for (const row of slice) {
        const id = String(row[identityProperty]).trim();
        const csvProps = rowToContact(row);
        const existingContact = existingById.get(id);
        if (!existingContact) {
          toCreate.push(csvProps);
        } else {
          const fieldsToUpdate = pickUpdatableFields(csvProps, existingContact.properties);
          if (Object.keys(fieldsToUpdate).length === 0) {
            unchanged += 1;
          } else {
            toUpdate.push({ id: existingContact.id, properties: fieldsToUpdate });
          }
        }
      }

      const createdRes = await hubspot.create(toCreate);
      const updatedRes = await hubspot.update(toUpdate);
      created += createdRes.length;
      updated += updatedRes.length;

      if (env.hubspot.batchDelayMs > 0 && i + BATCH_SIZE < dedupedRows.length) {
        await new Promise((r) => setTimeout(r, env.hubspot.batchDelayMs));
      }
    }
  } catch (err) {
    logger.error({ err, key }, 'transient: hubspot operation failed, will retry');
    return;
  }

  const errorsKey = invalidRows.length > 0
    ? `files_error/${ts}-${baseName.replace(/\.csv$/, '')}.errors.csv`
    : null;
  if (errorsKey) {
    const csvOut = buildErrorsCsv(headers, invalidRows);
    await r2.upload({
      key: errorsKey,
      body: Buffer.from(csvOut, 'utf8'),
      contentType: 'text/csv',
    });
  }

  const destKey = `files_out/${ts}-${baseName}`;
  await r2.move({ sourceKey: key, destKey });

  const reportKey = `files_out/${ts}-${baseName.replace(/\.csv$/, '')}.report.json`;
  const report = {
    processed_at: now.toISOString(),
    input_file: key,
    output_file: destKey,
    rows_total: rows.length,
    duplicates_collapsed: duplicatesCollapsed,
    rows_skipped: invalidRows.length,
    rows_processed: dedupedRows.length,
    contacts_created: created,
    contacts_updated: updated,
    contacts_unchanged: unchanged,
    errors_file: errorsKey,
  };
  await r2.upload({
    key: reportKey,
    body: Buffer.from(buildReportJson(report), 'utf8'),
    contentType: 'application/json',
  });

  logger.info(
    { key, destKey, ...report, ms: Date.now() - start },
    'file processed',
  );
}

async function failPermanently(key, ts, baseName, errorRows, headers, deps) {
  const { r2, logger } = deps;
  const errorsKey = `files_error/${ts}-${baseName.replace(/\.csv$/, '')}.errors.csv`;
  const csvOut = buildErrorsCsv(headers ?? [], errorRows);
  await r2.upload({
    key: errorsKey,
    body: Buffer.from(csvOut, 'utf8'),
    contentType: 'text/csv',
  });
  await r2.move({ sourceKey: key, destKey: `files_error/${ts}-${baseName}` });
}
```

- [ ] **Step 4: Run, expect pass**

```bash
npm test -- tests/application/process-files.test.js
```

Expected: PASS.

- [ ] **Step 5: Correr toda la suite para verificar regresiones**

```bash
npm test
```

Expected: todos los tests pasan.

- [ ] **Step 6: Commit**

```bash
git add src/application/process-files.js tests/application/process-files.test.js
git commit -m "feat(app): orchestrate file processing with CRM-wins flow"
```

---

## Task 12: Entry point — ejecución única (`run-once.js`)

**Files:**
- Create: `src/run-once.js`

- [ ] **Step 1: Crear `src/run-once.js`**

```js
import { env, validateEnv } from './config/env.js';
import { logger } from './infrastructure/logger.js';
import { createR2Client, listIncomingCsv, downloadCsv, moveObject, uploadObject } from './infrastructure/r2.js';
import {
  createHubspotClient,
  fetchPropertyCatalog,
  readContactsByIdProperty,
  createContacts,
  updateContacts,
} from './infrastructure/hubspot.js';
import { processIncomingFiles } from './application/process-files.js';

function buildDeps() {
  const s3 = createR2Client({
    endpoint: env.r2.endpoint,
    accessKeyId: env.r2.accessKeyId,
    secretAccessKey: env.r2.secretAccessKey,
  });
  const hs = createHubspotClient({ accessToken: env.hubspot.accessToken });

  return {
    r2: {
      list: () => listIncomingCsv(s3, { bucket: env.r2.bucketName, prefix: env.r2.incomingPrefix }),
      download: (key) => downloadCsv(s3, { bucket: env.r2.bucketName, key }),
      move: ({ sourceKey, destKey }) =>
        moveObject(s3, { bucket: env.r2.bucketName, sourceKey, destKey }),
      upload: ({ key, body, contentType }) =>
        uploadObject(s3, { bucket: env.r2.bucketName, key, body, contentType }),
    },
    hubspot: {
      fetchPropertyCatalog: () => fetchPropertyCatalog(hs),
      readByIdentity: (args) => readContactsByIdProperty(hs, args),
      create: (batch) => createContacts(hs, batch),
      update: (batch) => updateContacts(hs, batch),
    },
    logger,
    clock: () => new Date(),
  };
}

async function main() {
  validateEnv();
  logger.info({}, 'run-once start');
  const deps = buildDeps();
  try {
    await processIncomingFiles(deps);
    logger.info({}, 'run-once done');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'run-once failed');
    process.exit(1);
  }
}

main();
```

- [ ] **Step 2: Verificación de carga (sin .env real, sin tocar red)**

```bash
HUBSPOT_ACCESS_TOKEN=fake R2_ACCESS_KEY_ID=fake R2_SECRET_ACCESS_KEY=fake R2_ACCOUNT_ID=fake node --check src/run-once.js
```

Expected: sin output (el archivo parsea correctamente como módulo).

- [ ] **Step 3: Commit**

```bash
git add src/run-once.js
git commit -m "feat(entry): add run-once entry point for one-shot execution"
```

---

## Task 13: Entry point — cron (`index.js`)

**Files:**
- Create: `src/index.js`

- [ ] **Step 1: Crear `src/index.js`**

```js
import cron from 'node-cron';
import { env, validateEnv } from './config/env.js';
import { logger } from './infrastructure/logger.js';
import { createR2Client, listIncomingCsv, downloadCsv, moveObject, uploadObject } from './infrastructure/r2.js';
import {
  createHubspotClient,
  fetchPropertyCatalog,
  readContactsByIdProperty,
  createContacts,
  updateContacts,
} from './infrastructure/hubspot.js';
import { processIncomingFiles } from './application/process-files.js';

function buildDeps() {
  const s3 = createR2Client({
    endpoint: env.r2.endpoint,
    accessKeyId: env.r2.accessKeyId,
    secretAccessKey: env.r2.secretAccessKey,
  });
  const hs = createHubspotClient({ accessToken: env.hubspot.accessToken });

  return {
    r2: {
      list: () => listIncomingCsv(s3, { bucket: env.r2.bucketName, prefix: env.r2.incomingPrefix }),
      download: (key) => downloadCsv(s3, { bucket: env.r2.bucketName, key }),
      move: ({ sourceKey, destKey }) =>
        moveObject(s3, { bucket: env.r2.bucketName, sourceKey, destKey }),
      upload: ({ key, body, contentType }) =>
        uploadObject(s3, { bucket: env.r2.bucketName, key, body, contentType }),
    },
    hubspot: {
      fetchPropertyCatalog: () => fetchPropertyCatalog(hs),
      readByIdentity: (args) => readContactsByIdProperty(hs, args),
      create: (batch) => createContacts(hs, batch),
      update: (batch) => updateContacts(hs, batch),
    },
    logger,
    clock: () => new Date(),
  };
}

async function main() {
  validateEnv();
  const deps = buildDeps();
  let running = false;

  async function tick() {
    if (running) {
      logger.warn({}, 'previous tick still running, skipping');
      return;
    }
    running = true;
    logger.info({}, 'tick_start');
    const start = Date.now();
    try {
      await processIncomingFiles(deps);
    } catch (err) {
      logger.error({ err }, 'tick failed');
    } finally {
      running = false;
      logger.info({ ms: Date.now() - start }, 'tick_end');
    }
  }

  if (env.runOnStart) {
    logger.info({}, 'RUN_ON_START=true, executing initial tick');
    await tick();
  }

  cron.schedule(env.cronSchedule, tick);
  logger.info({ schedule: env.cronSchedule }, 'infoclick scheduler started');
}

main().catch((err) => {
  logger.error({ err }, 'fatal');
  process.exit(1);
});
```

- [ ] **Step 2: Verificación**

```bash
HUBSPOT_ACCESS_TOKEN=fake R2_ACCESS_KEY_ID=fake R2_SECRET_ACCESS_KEY=fake R2_ACCOUNT_ID=fake node --check src/index.js
```

Expected: sin output.

- [ ] **Step 3: Commit**

```bash
git add src/index.js
git commit -m "feat(entry): cron entry with running flag and heartbeat logs"
```

---

## Task 14: Docker

**Files:**
- Create: `Dockerfile`
- Create: `compose.yaml`

- [ ] **Step 1: Crear `Dockerfile`**

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
USER node
CMD ["node", "src/index.js"]
```

- [ ] **Step 2: Crear `compose.yaml`**

```yaml
services:
  infoclick:
    build: .
    container_name: infoclick
    env_file: .env
    restart: unless-stopped
```

- [ ] **Step 3: Verificación de build local** (opcional, requiere Docker)

```bash
docker compose build
```

Expected: build exitoso. Si no tenés Docker localmente, salta este paso y lo verificamos en el smoke test.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile compose.yaml
git commit -m "chore(deploy): add Dockerfile and compose for VPS deployment"
```

---

## Task 15: Smoke test end-to-end manual

Este task **no se ejecuta vía código**, es un protocolo de validación manual con la cuenta real de testing.

**Pre-requisitos** que debe tener el usuario antes de arrancar:

- Cuenta de HubSpot testing.
- Cuenta de Cloudflare R2 con bucket `infoclic` y carpeta `files_in/` existente.
- CSV de prueba `contactos_prueba.csv` ya disponible.

- [ ] **Step 1: Crear app privada en HubSpot**

Login a HubSpot testing → "Settings" → "Integrations" → "Private Apps" → "Create a private app".

Scopes mínimos a habilitar:

- `crm.objects.contacts.read`
- `crm.objects.contacts.write`
- `crm.schemas.contacts.read`

Guardar el token generado (no se puede volver a ver).

- [ ] **Step 2: Crear propiedad `documento_de_identidad` en HubSpot**

En HubSpot → "Settings" → "Properties" → "Create property":

- Object type: Contact
- Group: cualquier grupo existente (ej. "Contact information")
- Label: "Documento de identidad"
- Internal name: `documento_de_identidad`
- Field type: Single-line text
- **Has unique values**: NO (acordamos no usar unique en testing)

- [ ] **Step 3: Obtener credenciales de R2**

Cloudflare dashboard → R2 → "Manage R2 API Tokens" → "Create API Token":

- Permissions: "Object Read & Write"
- Scope: solo el bucket `infoclic`

Guardar: Access Key ID, Secret Access Key, Account ID.

- [ ] **Step 4: Crear `.env` local**

```bash
cp .env.example .env
```

Editar `.env` con valores reales:

```env
CRON_SCHEDULE=*/2 * * * *
RUN_ON_START=true
LOG_LEVEL=debug
R2_ACCOUNT_ID=<tu account id>
R2_ACCESS_KEY_ID=<...>
R2_SECRET_ACCESS_KEY=<...>
HUBSPOT_ACCESS_TOKEN=<token>
```

- [ ] **Step 5: Subir el CSV de prueba a R2**

Vía dashboard de Cloudflare: arrastrar `contactos_prueba.csv` al prefijo `files_in/` del bucket `infoclic`.

- [ ] **Step 6: Ejecutar process-once**

```bash
npm run process-once 2>&1 | npx pino-pretty
```

Expected log output (en orden):

- `run-once start`
- `file processed` con `rows_total: 3`, `contacts_created: 3`

Verificar en HubSpot: aparecen 3 contactos nuevos (Carlos Martínez, Lucía Gómez, Andrés Rodríguez) con sus emails y cédulas correctos (sin mojibake).

Verificar en R2: el archivo se movió a `files_out/<timestamp>-contactos_prueba.csv`, y aparece un `<timestamp>-contactos_prueba.report.json` al lado.

- [ ] **Step 7: Re-ejecutar para validar idempotencia + regla CRM gana**

```bash
# subir el mismo CSV a files_in/ nuevamente
npm run process-once 2>&1 | npx pino-pretty
```

Expected: `contacts_created: 0`, `contacts_updated: 0`, `contacts_unchanged: 3` (porque CRM ya tiene los datos y CRM gana).

- [ ] **Step 8: Validar regla "no sobrescribir vacíos"**

En HubSpot, manualmente: tomar uno de los contactos creados, vaciar el campo `lastname`. Subir el CSV nuevamente y ejecutar.

Expected: `contacts_updated: 1` y el contacto ahora tiene `lastname` poblado (porque CRM estaba vacío en ese campo, CSV ganó). Los demás campos del contacto no se tocan.

- [ ] **Step 9: Validar fallo permanente por propiedad faltante**

Crear un CSV con una columna `_test_columna_inexistente` que no exista como propiedad en HubSpot. Subirlo y ejecutar.

Expected:

- Log de error `permanent: properties missing in HubSpot`.
- Archivo se mueve a `files_error/`.
- Aparece un `.errors.csv` en `files_error/` mencionando la propiedad faltante.

- [ ] **Step 10: Validar tick mode**

```bash
RUN_ON_START=false npm start 2>&1 | npx pino-pretty
```

Subir un CSV nuevo y esperar el siguiente tick (con `CRON_SCHEDULE=*/2 * * * *`, máximo 2 min). Verificar que aparece `tick_start` → `tick_end` con el procesamiento.

Detener con `Ctrl+C`.

- [ ] **Step 11: Commit (si hubo ajustes durante el smoke test)**

```bash
git add -A
git commit -m "chore: smoke test adjustments"
```

(Si no hubo cambios, saltarse este paso.)

---

## Task 16: Documentación final

**Files:**
- Modify: `README.md` (reducir a un puntero al spec)
- Modify: `CLAUDE.md` (actualizar con cualquier hallazgo del smoke test)

- [ ] **Step 1: Reescribir `README.md`**

El README original era el predecesor del spec. Lo reducimos a un puntero claro:

```markdown
# InfoClick

Servicio Node que sincroniza CSVs de Cloudflare R2 hacia contactos de HubSpot, con un cron interno.

## Documentación

- **Spec técnico (fuente de verdad)**: [docs/superpowers/specs/2026-05-17-infoclick-design.md](docs/superpowers/specs/2026-05-17-infoclick-design.md)
- **Plan de implementación**: [docs/superpowers/plans/2026-05-17-infoclick-implementation.md](docs/superpowers/plans/2026-05-17-infoclick-implementation.md)
- **CLAUDE.md**: [CLAUDE.md](CLAUDE.md) (índice rápido del proyecto)

## Quick start

```bash
cp .env.example .env
# Editar .env con credenciales reales
npm install
npm run process-once   # corrida puntual
npm start              # cron continuo
```

## Despliegue

```bash
docker compose up -d --build
docker compose logs -f infoclick
```
```

- [ ] **Step 2: Actualizar `CLAUDE.md`**

Revisar `CLAUDE.md` y agregar cualquier convención o gotcha descubierto durante la implementación. Solo si hubo descubrimientos relevantes.

- [ ] **Step 3: Commit final**

```bash
git add README.md CLAUDE.md
git commit -m "docs: simplify README to point at spec and plan"
```

- [ ] **Step 4: Tag de versión**

```bash
git tag -a v0.1.0 -m "MVP: CSV → HubSpot sync"
```

---

## Verificación final

Después de Task 16, ejecutar el chequeo completo:

- [ ] `npm test` — todos los tests pasan.
- [ ] `git status` — working tree clean.
- [ ] `git log --oneline` — historial limpio con un commit por task.
- [ ] El smoke test (Task 15) completó los 10 steps sin errores no documentados.

---

## Resumen de cobertura vs spec

| Sección del spec | Task que la cubre |
|---|---|
| 1. Contexto y problema | (contextual, sin código) |
| 2. Objetivos y no-objetivos | Tasks 1-11 (objetivos), Task 11 (no-create) |
| 3. Arquitectura | Tasks 5-13 (capas) |
| 4. Estructura de carpetas | Task 1 + Tasks subsiguientes |
| 5.1 Descubrimiento | Task 8, Task 11 |
| 5.2 Encoding | Task 7 |
| 5.3 Parseo | Task 7 |
| 5.4 Validación de headers | Task 11 |
| 5.5 Validación de filas | Task 11 |
| 5.6 Deduplicación intra-CSV | Task 11 |
| 5.7 Read before write (CRM gana) | Task 6, Task 9, Task 11 |
| 5.8 Reporte | Task 10, Task 11 |
| 5.9 Errores granulares | Task 10, Task 11 |
| 5.10 Movimiento del archivo | Task 11 |
| 6. .env.example | Task 1 |
| 7. Comandos | Task 1, Task 12, Task 13 |
| 8. Logging | Task 3 |
| 9. Manejo de errores | Task 11 |
| 10. Despliegue Docker | Task 14, Task 15 |
| 11. Stack | Task 1 |
| 12. Cuotas | Task 11 (throttle) |
| 13. Para producción | (anotado en spec, sin código MVP) |
| 14. Reglas de negocio | Tasks 5, 6, 11 |
| 15. Riesgos | (anotado en spec) |
| 16. Plan de prueba | Task 15 |
