# InfoClick — Sincronización CSV → HubSpot

Servicio en Node que cada cierto intervalo revisa un bucket de Cloudflare R2, procesa los archivos CSV que encuentre y carga o actualiza los contactos correspondientes en HubSpot. Una vez procesado, mueve el archivo de la carpeta de entrada a la de salida.

No es una API: no expone endpoints HTTP. Es un proceso de larga duración con un cron interno (`node-cron`) que dispara el trabajo según una expresión configurable por variable de entorno.

---

## 1. Alcance funcional

- Origen: bucket `infoclick` de Cloudflare R2.
- Carpeta de entrada: `files_in/` (prefijo).
- Carpeta de salida: `files_out/` (prefijo).
- Destino: objeto **Contactos** de HubSpot. No empresas, no negocios, no productos.
- Identificador de upsert: `email` por defecto, configurable por env var para poder cambiar a `cedula` u otra propiedad única.
- Campos fijos esperados en el CSV: `nombre`, `apellido`, `cedula`, `telefono`, `correo`.
- Campos variables: según campaña (ej. `postpago`, `prepago`). El mapping CSV → propiedad de HubSpot se mantiene en un archivo de configuración.

### Reglas de negocio

1. **No sobrescribir vacíos.** Si una celda llega vacía (`""`, `null`, espacios), esa propiedad **no debe enviarse** en el payload del upsert. HubSpot interpreta una propiedad ausente como "no tocar"; una propiedad con cadena vacía **sí borra** el valor existente. Esta es la regla operativa exacta.
2. **Inserción o actualización por upsert.** No se hace `search` previo; se delega a `batchApi.upsert` con `idProperty: email`.
3. **Mover sólo si el procesamiento termina sin error.** Si la subida a HubSpot falla, el archivo permanece en `files_in/` para reintentarse en el siguiente tick.

---

## 2. Stack

- Node 22 (LTS).
- `@aws-sdk/client-s3` — cliente para R2 (compatible S3).
- `@hubspot/api-client` — SDK oficial de HubSpot.
- `csv-parse` — parser de CSV.
- `node-cron` — planificador interno.
- `pino` — logging estructurado.
- Docker para despliegue en VPS Hostinger.

---

## 3. Arquitectura

Capas con dependencias **sólo hacia adentro**:

```
entry (cron)  →  application (use case)  →  domain (reglas puras)
                                          →  infrastructure (R2, HubSpot, CSV)
```

- `domain/` no importa nada externo. Contiene la transformación CSV→Contacto y la regla de "no sobrescribir vacíos". Es 100% testeable con datos en memoria.
- `application/` orquesta el flujo: listar → descargar → parsear → transformar → upsert → mover.
- `infrastructure/` encapsula los SDK (S3, HubSpot, parser CSV, logger). Si mañana cambia R2 por otro storage, se modifica sólo aquí.
- `entry/` arma dependencias y arranca el cron.

No se usan contenedores de DI ni puertos/adaptadores formales: la inyección se hace por imports y argumentos. Lo justo para ser testeable y profesional sin ceremonia.

---

## 4. Estructura de carpetas

```
infoclick/
├── src/
│   ├── config/
│   │   ├── env.js
│   │   └── mappings.js
│   ├── domain/
│   │   └── transform.js
│   ├── infrastructure/
│   │   ├── r2.js
│   │   ├── hubspot.js
│   │   ├── csv.js
│   │   └── logger.js
│   ├── application/
│   │   └── process-files.js
│   └── index.js
├── .env.example
├── .dockerignore
├── Dockerfile
├── compose.yaml
├── package.json
└── README.md
```

---

## 5. Variables de entorno

`.env.example`:

```env
CRON_SCHEDULE=*/5 * * * *
LOG_LEVEL=info

R2_ACCOUNT_ID=
R2_ENDPOINT=
R2_BUCKET_NAME=infoclick
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=

HUBSPOT_ACCESS_TOKEN=
HUBSPOT_ID_PROPERTY=email
```

`R2_ENDPOINT` puede omitirse si se define `R2_ACCOUNT_ID` (se compone solo).

En dev se suele usar `CRON_SCHEDULE=*/1 * * * *`; en prod `*/5 * * * *`. Cambiarlo no requiere redeploy si se hace `docker compose restart` tras editar `.env`.

---

## 6. Módulos — código recomendado

### 6.1 `src/config/env.js`

```js
import 'dotenv/config';

export const env = {
  cronSchedule: process.env.CRON_SCHEDULE ?? '*/5 * * * *',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  r2: {
    accountId: process.env.R2_ACCOUNT_ID,
    endpoint:
      process.env.R2_ENDPOINT ??
      `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    bucketName: process.env.R2_BUCKET_NAME ?? 'infoclick',
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    incomingPrefix: 'files_in/',
    processedPrefix: 'files_out/',
  },
  hubspot: {
    accessToken: process.env.HUBSPOT_ACCESS_TOKEN,
    idProperty: process.env.HUBSPOT_ID_PROPERTY ?? 'email',
  },
};
```

### 6.2 `src/config/mappings.js`

Mapping declarativo. La clave es el nombre de columna del CSV; el valor es el internal name de la propiedad en HubSpot.

```js
export const FIXED_MAPPING = {
  nombre: 'firstname',
  apellido: 'lastname',
  cedula: 'cedula',
  telefono: 'phone',
  correo: 'email',
};

export const CAMPAIGN_MAPPINGS = {
  postpago: {
    plan: 'plan_postpago',
    consumo_mensual: 'consumo_mensual',
  },
  prepago: {
    saldo: 'saldo_prepago',
  },
};
```

La detección de campaña puede inferirse del nombre del archivo (`postpago-2026-05.csv`) o de una columna del CSV. Decisión a coordinar con Felipe.

### 6.3 `src/infrastructure/logger.js`

```js
import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({ level: env.logLevel });
```

### 6.4 `src/infrastructure/r2.js`

```js
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { env } from '../config/env.js';

const client = new S3Client({
  region: 'auto',
  endpoint: env.r2.endpoint,
  credentials: {
    accessKeyId: env.r2.accessKeyId,
    secretAccessKey: env.r2.secretAccessKey,
  },
});

export async function listIncomingCsv() {
  const res = await client.send(
    new ListObjectsV2Command({
      Bucket: env.r2.bucketName,
      Prefix: env.r2.incomingPrefix,
    }),
  );
  return (res.Contents ?? [])
    .map((o) => o.Key)
    .filter((k) => k && k !== env.r2.incomingPrefix && k.endsWith('.csv'));
}

export async function downloadCsv(key) {
  const res = await client.send(
    new GetObjectCommand({ Bucket: env.r2.bucketName, Key: key }),
  );
  return res.Body.transformToString();
}

export async function moveToProcessed(key) {
  const destKey = key.replace(env.r2.incomingPrefix, env.r2.processedPrefix);
  await client.send(
    new CopyObjectCommand({
      Bucket: env.r2.bucketName,
      CopySource: `${env.r2.bucketName}/${encodeURIComponent(key)}`,
      Key: destKey,
    }),
  );
  await client.send(
    new DeleteObjectCommand({ Bucket: env.r2.bucketName, Key: key }),
  );
  return destKey;
}
```

R2 no tiene operación "mover" atómica: es `Copy + Delete`. Si el `Delete` falla tras un `Copy` exitoso queda duplicado; conviene loggear para auditoría.

### 6.5 `src/infrastructure/csv.js`

```js
import { parse } from 'csv-parse/sync';

export function parseCsv(content) {
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
}
```

`bom: true` evita problemas con CSV exportados desde Excel.

### 6.6 `src/domain/transform.js`

Núcleo de la regla "no sobrescribir vacíos".

```js
import { FIXED_MAPPING, CAMPAIGN_MAPPINGS } from '../config/mappings.js';

export function rowToContact(row, campaign) {
  const variable = CAMPAIGN_MAPPINGS[campaign] ?? {};
  const mapping = { ...FIXED_MAPPING, ...variable };
  const properties = {};

  for (const [csvColumn, hubspotProperty] of Object.entries(mapping)) {
    const raw = row[csvColumn];
    if (raw === undefined || raw === null) continue;
    const value = String(raw).trim();
    if (value === '') continue;
    properties[hubspotProperty] = value;
  }
  return properties;
}

export function detectCampaign(fileKey) {
  const name = fileKey.split('/').pop() ?? '';
  for (const campaign of Object.keys(CAMPAIGN_MAPPINGS)) {
    if (name.toLowerCase().includes(campaign)) return campaign;
  }
  return null;
}
```

### 6.7 `src/infrastructure/hubspot.js`

```js
import { Client } from '@hubspot/api-client';
import { env } from '../config/env.js';

const client = new Client({
  accessToken: env.hubspot.accessToken,
  numberOfApiCallRetries: 3,
});

const BATCH_SIZE = 100;

export async function upsertContacts(contacts) {
  const idProperty = env.hubspot.idProperty;
  const valid = contacts.filter((c) => c[idProperty]);

  let processed = 0;
  for (let i = 0; i < valid.length; i += BATCH_SIZE) {
    const slice = valid.slice(i, i + BATCH_SIZE);
    const inputs = slice.map((c) => ({
      idProperty,
      id: c[idProperty],
      properties: c,
    }));
    await client.crm.contacts.batchApi.upsert({ inputs });
    processed += slice.length;
  }
  return { sent: processed, skipped: contacts.length - valid.length };
}
```

Los contactos sin el identificador configurado se descartan (no se puede hacer upsert sin clave).

### 6.8 `src/application/process-files.js`

```js
import {
  listIncomingCsv,
  downloadCsv,
  moveToProcessed,
} from '../infrastructure/r2.js';
import { parseCsv } from '../infrastructure/csv.js';
import { upsertContacts } from '../infrastructure/hubspot.js';
import { rowToContact, detectCampaign } from '../domain/transform.js';
import { logger } from '../infrastructure/logger.js';

export async function processIncomingFiles() {
  const keys = await listIncomingCsv();
  if (keys.length === 0) {
    logger.debug('no files to process');
    return;
  }

  for (const key of keys) {
    const start = Date.now();
    try {
      const campaign = detectCampaign(key);
      const csv = await downloadCsv(key);
      const rows = parseCsv(csv);
      const contacts = rows.map((row) => rowToContact(row, campaign));
      const result = await upsertContacts(contacts);
      const destKey = await moveToProcessed(key);
      logger.info(
        { key, destKey, campaign, rows: rows.length, ...result, ms: Date.now() - start },
        'file processed',
      );
    } catch (err) {
      logger.error({ err, key }, 'file processing failed');
    }
  }
}
```

Si una iteración falla, el archivo no se mueve y se reintentará en el siguiente tick.

### 6.9 `src/index.js`

```js
import cron from 'node-cron';
import { env } from './config/env.js';
import { processIncomingFiles } from './application/process-files.js';
import { logger } from './infrastructure/logger.js';

let running = false;

cron.schedule(env.cronSchedule, async () => {
  if (running) {
    logger.warn('previous tick still running, skipping');
    return;
  }
  running = true;
  try {
    await processIncomingFiles();
  } catch (err) {
    logger.error({ err }, 'tick failed');
  } finally {
    running = false;
  }
});

logger.info({ schedule: env.cronSchedule }, 'infoclick scheduler started');
```

El flag `running` evita superposición si un tick tarda más que el intervalo (importante con archivos grandes).

---

## 7. `package.json`

```json
{
  "name": "infoclick",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "^3.700.0",
    "@hubspot/api-client": "^12.0.0",
    "csv-parse": "^5.5.0",
    "dotenv": "^16.4.0",
    "node-cron": "^3.0.3",
    "pino": "^9.5.0"
  }
}
```

Las versiones son referenciales; ajustar a las más recientes estables al iniciar.

---

## 8. Docker

### `Dockerfile`

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
USER node
CMD ["node", "src/index.js"]
```

### `compose.yaml`

```yaml
services:
  infoclick:
    build: .
    container_name: infoclick
    env_file: .env
    restart: unless-stopped
```

### `.dockerignore`

```
node_modules
npm-debug.log
.env
.env.*
.git
.gitignore
README.md
```

---

## 9. Despliegue en VPS Hostinger

1. Conectar por SSH al VPS.
2. Clonar el repo en `/opt/infoclick` (o donde se prefiera).
3. Crear `.env` a partir de `.env.example` con las credenciales reales.
4. Construir y levantar:
   ```bash
   docker compose up -d --build
   ```
5. Verificar logs:
   ```bash
   docker compose logs -f infoclick
   ```
6. Para cambiar el intervalo: editar `CRON_SCHEDULE` en `.env` y `docker compose restart infoclick`.

---

## 10. Operación

### Cuota de HubSpot
Private App: **100 requests / 10 s**, **250 000 / día**. Con `batchApi.upsert` (100 contactos por llamada) un archivo de 10 000 contactos consume ~100 requests. Polling cada 5 min sin archivos pendientes consume 0 requests a HubSpot (sólo se listan objetos en R2).

### Riesgo y mitigación
Si un tick procesa varios archivos grandes seguidos puede acercarse al burst de 100/10s. Mitigación: introducir un pequeño retraso entre lotes si se detectan 429 (el SDK ya hace 3 reintentos por defecto).

### Logs
Salen por `stdout` en JSON (pino). Para lectura humana en dev:
```bash
docker compose logs -f infoclick | npx pino-pretty
```

### Errores recuperables vs fatales
- Error procesando un archivo → se loggea, el archivo queda en `files_in/`, se reintenta en el siguiente tick.
- Error de configuración (credenciales inválidas, token de HubSpot expirado) → se loggea por cada tick hasta corregir.

---

## 11. Coordinación con Felipe

Antes de cerrar el diseño confirmar:

- Cómo determinar la campaña de cada archivo (nombre del archivo vs columna interna).
- Nombres exactos de las propiedades en HubSpot para los campos variables (deben crearse en HubSpot antes del primer upsert; si no existen, falla la llamada).
- Convención de naming de archivos.

---

## 12. Próximos pasos (no MVP)

- Migrar a R2 Event Notifications + Cloudflare Workers cuando el volumen lo justifique (procesamiento reactivo en lugar de polling).
- Persistir un registro de procesamiento (Mongo/SQLite) para deduplicar y auditar.
- Métricas (cantidad de contactos procesados, errores por campaña) expuestas para Grafana.
