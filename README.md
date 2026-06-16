# InfoClick

Servicio **Node 22 de larga duración** que sincroniza CSVs desde un bucket de **Cloudflare R2** hacia contactos de **HubSpot**. Corre con un cron interno (`node-cron`); **no expone HTTP** ni tiene base de datos: es un proceso de fondo (headless).

---

## 1. Descripción general

El cliente lanza ~1 campaña de marketing al mes y sube un CSV estandarizado al bucket R2. InfoClick, en cada tick del cron:

```
lista files_in/ → por cada CSV:
  detecta encoding y normaliza a UTF-8
  parsea y valida headers contra el schema de HubSpot
  lee el estado actual en HubSpot por documento_de_identidad (read-before-write)
  decide create vs update con la regla "CRM gana"
  ejecuta batch create + batch update
  genera reporte (.report.json) y, si aplica, errores (.errors.csv)
  mueve el archivo a files_out/ (o lo deja en files_in/ si falló todo)
```

### Dependencias y servicios externos

| Servicio | Uso | Notas |
|---|---|---|
| **Cloudflare R2** | Almacenamiento S3-compatible de los CSVs | Bucket `infoclic` (sin "k"). Carpetas: `files_in/`, `files_out/`, `files_error/` |
| **HubSpot** | CRM destino (objeto Contacto) | Durante desarrollo se usa una cuenta de **testing** |

- **Base de datos:** ninguna. El estado vive en R2 (archivos + reportes) y en HubSpot.
- **WordPress u otro CMS:** no aplica.
- **Framework HTTP (Fastify/Express):** no se usa. Es un proceso de fondo puro.

---

## 2. Requisitos previos

- **Node.js >= 22** y npm.
- Credenciales de **Cloudflare R2** (Access Key ID + Secret) y `R2_ACCOUNT_ID` (o `R2_ENDPOINT`).
- **Token de HubSpot** (Private App) con scopes:
  `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.schemas.contacts.read`.
- La propiedad de identidad (`documento_de_identidad`) **ya creada manualmente** en HubSpot.
  El código **nunca crea propiedades**: si una columna del CSV no existe en HubSpot, el archivo se rechaza.
- (Opcional) Docker + Docker Compose para el despliegue.

---

## 3. Ejecución local

```bash
git clone <repo> && cd smartflow-infoclick
npm install
cp .env.example .env        # editar .env con credenciales reales (ver sección 4)
npm run process-once        # ejecuta una iteración y sale
```

> No hay carpeta de entrada local: el servicio lee los CSVs directamente de `files_in/` en R2.
> Para probar, sube un CSV a `files_in/` desde el dashboard de Cloudflare o con `aws s3 cp --endpoint-url`.

### Comandos

| Comando | Comportamiento |
|---|---|
| `npm run process-once` | Ejecuta una iteración y sale (no levanta cron). Ideal para probar. |
| `npm start` | Arranca el cron según `CRON_SCHEDULE` (proceso de larga duración). |
| `RUN_ON_START=true npm start` | Ejecuta una iteración al arrancar y luego sigue con el cron. |
| `npm run dev` | `node --watch` para iteración rápida en local. |
| `npm test` | Corre la suite (`node --test`, 39 tests). |

### Ambientes

No hay archivos de config por ambiente: todo se controla por variables de entorno.
- **Dev/testing:** apunta a la cuenta de HubSpot de testing y al bucket R2 de pruebas.
- **Producción:** cambiar `HUBSPOT_ACCESS_TOKEN` y asegurar que `documento_de_identidad` esté marcada **unique** en HubSpot (ver sección 7).

---

## 4. Variables de entorno

Documentadas en [.env.example](.env.example). **Nunca commitear `.env`** (está en `.gitignore`).

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `CRON_SCHEDULE` | no | `*/5 * * * *` | Frecuencia del cron. Dev: `*/1 * * * *` o `*/30 * * * * *`. |
| `RUN_ON_START` | no | `false` | Si `true`, ejecuta un tick al arrancar antes del cron. |
| `LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `R2_ACCOUNT_ID` | sí* | — | ID de cuenta Cloudflare. Deriva el endpoint si no se da `R2_ENDPOINT`. |
| `R2_ENDPOINT` | sí* | derivado | Endpoint S3 de R2. Opcional si se define `R2_ACCOUNT_ID`. |
| `R2_BUCKET_NAME` | no | `infoclic` | Nombre del bucket. |
| `R2_ACCESS_KEY_ID` | **sí** | — | Access key de R2. |
| `R2_SECRET_ACCESS_KEY` | **sí** | — | Secret key de R2. |
| `HUBSPOT_ACCESS_TOKEN` | **sí** | — | Token de la Private App de HubSpot. |
| `HUBSPOT_IDENTITY_PROPERTY` | no | `documento_de_identidad` | Propiedad llave para el upsert. |
| `HUBSPOT_BATCH_DELAY_MS` | no | `100` | Throttle entre batches (ms). `0` en dev. |

\* Se requiere **`R2_ENDPOINT` o `R2_ACCOUNT_ID`** (uno de los dos). El arranque falla loud si falta alguna variable obligatoria.

---

## 5. Arquitectura

Arquitectura **por capas** con dependencias solo hacia adentro. Sin DI containers, sin puertos/adaptadores formales: inyección por imports y argumentos.

```
entry (cron / one-shot)  →  application (caso de uso)  →  domain (reglas puras)
                                                        →  infrastructure (R2, HubSpot, CSV, logger)
```

```
src/
├── config/
│   ├── env.js              # Carga + valida env vars (falla loud en valores inválidos)
│   └── properties.js       # Mapping CSV→HubSpot (identity + COLUMN_OVERRIDES)
├── domain/
│   ├── transform.js        # rowToContact(): descarta celdas vacías
│   └── merge.js            # pickUpdatableFields(): regla "CRM gana"
├── infrastructure/
│   ├── csv.js              # parseCsvBuffer: parseo + recuperación de mojibake UTF-8/Latin-1
│   ├── r2.js               # list / download / upload / move sobre cliente S3
│   ├── hubspot.js          # catálogo de propiedades + batch read/create/update
│   ├── report.js           # buildReportJson + buildErrorsCsv
│   └── logger.js           # instancia pino
├── application/
│   └── process-files.js    # Orquestador del flujo completo
├── index.js                # Entry point: cron (npm start)
└── run-once.js             # Entry point: one-shot (npm run process-once)
```

**Componentes principales:**
- **`process-files.js`** — orquesta descubrimiento, parseo, validación, read-before-write y movimiento de archivos.
- **`domain/`** — reglas de negocio puras y testeables (sin I/O).
- **`infrastructure/`** — toda la interacción con servicios externos, aislada e inyectable (facilita el testing con mocks).

---

## 6. Reglas de negocio y manejo de errores

### Reglas clave
- **No sobrescribir vacíos:** si una celda del CSV está vacía, esa propiedad **no** se envía a HubSpot.
- **CRM gana** (regla interim): si HubSpot ya tiene un valor distinto, prevalece HubSpot. Por eso el flujo es read-before-write.
- **Identidad:** `documento_de_identidad` (configurable). Última fila gana en duplicados intra-CSV.
- **Schema manual:** el código no crea propiedades; columnas desconocidas → archivo a `files_error/`.

### Manejo de errores (3 niveles)

| Tipo | Ejemplo | Acción |
|---|---|---|
| **Permanente** | Encoding ilegible, propiedad faltante, CSV malformado | Mover a `files_error/` + `.errors.csv`. **No se reintenta.** |
| **Transitorio** | Red, HubSpot 5xx/429, timeout | Queda en `files_in/`. Reintento automático en el próximo tick. |
| **Granular** | Fila sin identidad | La fila va al `.errors.csv`; el resto del archivo se procesa normal. |

### Logging
`pino` (JSON estructurado) a stdout. En dev se puede leer con `pino-pretty`. Cada tick loggea `tick_start`/`tick_end` como heartbeat.

---

## 7. Despliegue

VPS Hostinger con Docker (`node:22-alpine`, usuario no-root, `restart: unless-stopped`).

```bash
# en el VPS, dentro del repo, con .env ya creado
docker compose up -d --build
docker compose logs -f infoclick
```

Cambios de schedule: editar `.env` + `docker compose restart infoclick`.

**Migración a producción:**
1. Cambiar `HUBSPOT_ACCESS_TOKEN` a la cuenta real.
2. Marcar `documento_de_identidad` como **unique** en HubSpot.
3. Verificar que todas las propiedades del CSV existan en el schema de producción.

---

## 8. Pendientes, riesgos y recomendaciones

### Pendientes
- **Smoke test con credenciales reales** (Task 15): única tarea abierta. Validar el flujo end-to-end contra R2 + HubSpot reales (caso feliz, "CRM gana", no sobrescribir vacíos, deduplicación, errores permanentes/granulares). Detalle en el [plan de implementación](docs/superpowers/plans/2026-05-17-infoclick-implementation.md).
- **Regla de discrepancia (CSV vs CRM):** interim → "CRM gana". Pendiente de cierre por el cliente. Si pasa a "CSV gana", el código se simplifica (upsert directo).

### Riesgos conocidos
- `documento_de_identidad` **no es unique** en la cuenta de testing → se garantiza manualmente la no-duplicación; activar unique antes de migrar a prod.
- CSVs con encoding Latin-1/Windows-1252 (Excel español) → mitigado con conversión automática a UTF-8.
- Cliente olvida crear una propiedad en HubSpot → validación al inicio, archivo a `files_error/` con error claro.
- Move en R2 = `CopyObject` + `DeleteObject` (no atómico): si falla el delete tras un copy exitoso, queda un duplicado; se loggea para auditoría.

### Mejoras sugeridas (fuera del MVP, ver spec §13)
- Streaming del CSV para archivos grandes (>100MB).
- Usar `batchApi.upsert` cuando `documento_de_identidad` sea unique (ahorra ~50% de llamadas).
- Notificaciones (email/Slack) al procesar o fallar un archivo.
- Persistencia de auditoría y métricas (Prometheus/Grafana).

---

## 9. Documentación de referencia

- **Spec técnico (fuente de verdad):** [docs/superpowers/specs/2026-05-17-infoclick-design.md](docs/superpowers/specs/2026-05-17-infoclick-design.md)
- **Plan de implementación:** [docs/superpowers/plans/2026-05-17-infoclick-implementation.md](docs/superpowers/plans/2026-05-17-infoclick-implementation.md)
- **Estado del proyecto (handoff):** [docs/superpowers/HANDOFF.md](docs/superpowers/HANDOFF.md)
- **Instrucciones del proyecto:** [CLAUDE.md](CLAUDE.md)

> Jerarquía ante conflicto: **spec > CLAUDE.md > plan > README**.
