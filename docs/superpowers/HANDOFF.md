# InfoClick — Handoff / Estado del Proyecto

**Fecha de corte:** 2026-05-19
**Branch:** `feat/initial-implementation`
**Versión:** 0.1.0
**Último commit:** `6979a7f docs: simplify README to point at spec and plan`

Este documento es un **punto de entrada para cualquier nueva sesión de Claude** que retome el trabajo. Léelo primero, luego ve a los archivos referenciados según necesites profundidad.

---

## TL;DR — Qué es y dónde estamos parados

**InfoClick** es un servicio Node 22 de larga duración (cron interno con `node-cron`) que sincroniza CSVs de un bucket Cloudflare R2 (`infoclic`) hacia contactos de HubSpot. No expone HTTP.

**Estado:** Implementación **100% completa** (tasks 1–14 + 16). Listo para el **smoke test manual (Task 15)** que requiere credenciales reales. 39 tests automatizados pasando. Repo limpio salvo una modificación local de `.claude/settings.json` (no relevante al producto).

**Próximo paso inmediato:** ejecutar smoke test con credenciales reales que el usuario ya cargó en `.env`. Ver sección "Cómo continuar AHORA" más abajo.

---

## Documentación: dónde leer qué

Orden de lectura recomendado para una sesión nueva:

1. **Este archivo** (`docs/superpowers/HANDOFF.md`) — contexto y próximo paso
2. **[CLAUDE.md](../../CLAUDE.md)** — instrucciones permanentes del proyecto, stack, reglas de negocio críticas, convenciones
3. **[Spec técnico](specs/2026-05-17-infoclick-design.md)** — fuente de verdad del diseño (objetivos, flujo, error handling, configuración)
4. **[Plan de implementación](plans/2026-05-17-infoclick-implementation.md)** — desglose de las 16 tareas; útil si hay que retomar algo o entender por qué se decidió X
5. **[README.md](../../README.md)** — quick start mínimo (deliberadamente corto, apunta al spec)

**Jerarquía cuando hay conflicto:** spec > CLAUDE.md > plan > README. El spec es la fuente de verdad.

**Memoria persistente del usuario:** `~/.claude/projects/-home-dfer-smarteam-construtecho-smartflow-infoclick/memory/MEMORY.md`. Hay una entrada **crítica**: commits deben ser de **una sola línea** y **nunca** incluir `Co-Authored-By: Claude...`. Respetar siempre.

---

## Qué se hizo (resumen ejecutivo)

### Arquitectura entregada

```
src/
├── config/
│   ├── env.js              # Carga + valida env vars, falla loud en valores inválidos
│   └── properties.js       # Resolver CSV→HubSpot (identity + overrides)
├── domain/
│   ├── transform.js        # rowToContact(row) — descarta celdas vacías
│   └── merge.js            # pickUpdatableFields() — implementa "CRM gana"
├── infrastructure/
│   ├── csv.js              # parseCsvBuffer — recupera mojibake UTF-8/Latin-1
│   ├── r2.js               # list/download/upload/move sobre S3 client
│   ├── hubspot.js          # catalog + batch read/create/update
│   ├── report.js           # buildReportJson + buildErrorsCsv
│   └── logger.js           # pino instance
├── application/
│   └── process-files.js    # Orquestador completo (~200 líneas)
├── run-once.js             # Entry point one-shot (npm run process-once)
└── index.js                # Entry point cron (npm start)
```

### Reglas de negocio implementadas (críticas)

1. **No sobrescribir vacíos:** si una celda CSV está vacía, esa propiedad NO se envía a HubSpot.
2. **CRM gana:** si HubSpot ya tiene valor distinto, prevalece HubSpot (`pickUpdatableFields` filtra solo donde CRM está vacío). Esto fuerza el flujo `read-before-write`.
3. **Identidad:** `documento_de_identidad` (configurable vía `HUBSPOT_IDENTITY_PROPERTY`). El orden de columnas en el CSV no importa; lo que importa es que exista y tenga valor por fila.
4. **Schema manual:** el código **nunca** crea propiedades en HubSpot. Si una columna del CSV no existe en HubSpot → archivo a `files_error/` con `.errors.csv`.
5. **Deduplicación intra-CSV:** última fila gana (Map por `documento_de_identidad`).

### Manejo de errores (3 niveles)

| Tipo | Ejemplo | Acción |
|---|---|---|
| **Permanente** | Encoding ilegible, propiedad faltante, CSV malformado | Mover archivo a `files_error/` + escribir `.errors.csv`. **No se reintenta.** |
| **Transitorio** | Red, HubSpot 5xx, rate limit | Archivo permanece en `files_in/`. Reintento automático en próximo tick. |
| **Granular** | Fila individual inválida (sin identity) | Fila va a `.errors.csv`, el resto del archivo se procesa normal. |

### Tests

- **39 tests pasando**, runner: `node --test` con glob `tests/**/*.test.js`
- Cobertura: domain (transform, merge), infrastructure (csv, r2, hubspot, report), application (process-files con dependencias mockeadas)
- **Entry points (`run-once.js`, `index.js`) no tienen tests** — se validan vía smoke test
- Comando: `npm test`

### Deploy

- `Dockerfile` con `node:22-alpine`, usuario no-root
- `compose.yaml` con `restart: unless-stopped`, carga `.env`
- Target: VPS Hostinger con Docker

### Configuración (`.env`)

Variables que necesita (ver `.env.example`):

```
CRON_SCHEDULE=*/5 * * * *
RUN_ON_START=false
LOG_LEVEL=info

R2_ACCOUNT_ID=
R2_ENDPOINT=
R2_BUCKET_NAME=infoclic       # Sin "k" — es el bucket real
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=

HUBSPOT_ACCESS_TOKEN=
HUBSPOT_IDENTITY_PROPERTY=documento_de_identidad
HUBSPOT_BATCH_DELAY_MS=100
```

**El usuario ya rellenó su `.env` con credenciales reales (HubSpot testing + R2).**

---

## Cómo continuar AHORA — Smoke test (Task 15)

Esto es lo único pendiente. Es **manual** porque requiere credenciales reales y validación humana en HubSpot y R2.

### Pre-requisitos (ya hechos por el usuario)

- ✅ `.env` con credenciales reales
- ✅ Propiedad `documento_de_identidad` creada en HubSpot, marcada `unique`
- ✅ Bucket `infoclic` en Cloudflare R2 con carpetas (o creación implícita) `files_in/`, `files_out/`, `files_error/`
- ✅ Token de HubSpot con scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.schemas.contacts.read`

### Plan de validación

Ver detalle completo en el **plan, Task 15** (líneas 1802+). Resumen:

1. **Crear CSV de prueba** localmente con 3 filas (caso feliz):
   ```csv
   documento_de_identidad,firstname,lastname,email,phone
   ID-001,Juan,García,juan.garcia@example.com,+34 912 345 678
   ID-002,María,López,maria.lopez@example.com,+34 913 456 789
   ID-003,Carlos,Martínez,,+34 914 567 890
   ```

2. **Subir CSV a R2** en `files_in/` (vía consola web de Cloudflare, o `aws s3 cp` con `--endpoint-url`). **No es carpeta local — el servicio lee de R2 directamente.**

3. **Ejecutar one-shot:**
   ```bash
   npm run process-once
   ```

4. **Verificar:**
   - CSV se movió de `files_in/` a `files_out/` en R2
   - `files_out/<nombre>.report.json` creado con counts esperados
   - Contactos creados en HubSpot
   - Sin nada en `files_error/`

5. **Escenarios adicionales a probar** (uno por uno con CSVs distintos):
   - **CRM gana:** modificar manualmente un campo en HubSpot, subir CSV con valor distinto, verificar que HubSpot NO se sobrescribe
   - **No sobrescribir vacíos:** CSV con celda vacía, verificar que la propiedad existente en HubSpot se mantiene
   - **Deduplicación:** CSV con dos filas mismo `documento_de_identidad`, verificar que solo se crea uno (última fila gana, contador `duplicates_collapsed`)
   - **Error permanente:** CSV malformado o con columna que no existe en HubSpot → debe ir a `files_error/`
   - **Error granular:** CSV con una fila sin `documento_de_identidad` → esa fila al `.errors.csv`, las demás procesan
   - **Cron continuo:** `RUN_ON_START=true npm start`, verificar tick inicial + scheduling, `Ctrl+C` detiene limpio

### Resultado esperado del reporte (caso feliz, primer run)

```json
{
  "rows_total": 3,
  "duplicates_collapsed": 0,
  "rows_skipped": 0,
  "rows_processed": 3,
  "contacts_created": 3,
  "contacts_updated": 0,
  "contacts_unchanged": 0,
  "errors_file": null
}
```

### Si algo falla

- Revisar logs (pino, JSON estructurado, en stdout). En dev: `pino-pretty` para legibilidad
- Errores transitorios: archivo permanece en `files_in/`, reintenta en próximo tick (no hace falta intervención)
- Errores permanentes: revisar el `.errors.csv` que acompaña al archivo en `files_error/`

---

## Decisiones importantes ya tomadas (NO re-litigar)

Algunas se discutieron y cerraron — no reabrir sin razón nueva:

- **Sin DI containers, sin puertos/adaptadores formales.** Arquitectura por capas simple: `entry → application → domain | infrastructure`.
- **Sin Fastify, sin HTTP.** Es proceso de fondo puro.
- **ESM modules**, Node 22 LTS.
- **`@hubspot/api-client` v13.5+ y `node-cron` v4.2+** — versiones actualizadas durante el desarrollo. No downgradar.
- **`HUBSPOT_BATCH_DELAY_MS` se valida con `parseNonNegativeNumber`** que falla loud en valores inválidos (no usa `Number()` que produce NaN silenciosamente).
- **Recuperación de mojibake en `csv.js`** detecta marcadores conocidos y re-encodea Latin-1→UTF-8.
- **Batch size = 100** contactos por llamada HubSpot, con delay configurable entre batches (solo si no es el último).
- **Empty CSV también genera reporte** (issue encontrado en code review y arreglado en commit `6701f8e`).
- **Cuenta HubSpot actual es de TESTING.** Cuando se migre a prod: cambiar `HUBSPOT_ACCESS_TOKEN` y asegurar que `documento_de_identidad` esté marcada `unique` (mencionado en CLAUDE.md).

---

## Cosas que NO se hicieron (intencionalmente, fuera de scope)

- No hay HTTP / healthcheck endpoint (no es una API)
- No hay creación automática de propiedades en HubSpot (schema manual del cliente)
- No hay UI / dashboard (servicio headless)
- No hay tests de integración con HubSpot/R2 reales (solo unit tests con mocks)
- No hay observabilidad externa (Datadog, Sentry, etc.) — solo logs JSON en stdout, suficiente para `docker compose logs`

Si en el futuro se requiere alguno: actualizar primero el spec, luego planear.

---

## Cómo trabajar con el usuario

Convenciones aprendidas durante el desarrollo:

- **Idioma:** responde en **español** salvo que el código/docs ya estén en inglés
- **Commits:** **una sola línea**, formato convencional (`feat:`, `fix:`, `chore:`, `docs:`). **Nunca** añadir `Co-Authored-By: Claude` — esto está guardado como memoria persistente y es regla dura
- **Estilo:** conciso, directo, paso-a-paso cuando explicas procedimientos manuales; el usuario quiere claridad sin verbosidad
- **No asumir despliegue:** preguntar antes de pushear, hacer merge a main, o ejecutar acciones irreversibles
- **Cuando hay dudas de diseño:** ir al spec antes que improvisar

---

## Verificación rápida del estado al retomar

Comandos para confirmar que todo sigue verde:

```bash
git status                    # Solo .claude/settings.json modificado (no relevante)
git log --oneline -5          # Último commit: 6979a7f
npm test                      # 39/39 tests passing
node --check src/index.js     # Sintaxis OK
node --check src/run-once.js  # Sintaxis OK
```

Si algo de esto falla, **investigar antes de modificar** — puede ser un cambio en deps o entorno.

---

## Glosario rápido

- **R2:** Cloudflare R2, almacenamiento S3-compatible
- **CRM gana:** regla de negocio donde HubSpot prevalece sobre CSV en caso de discrepancia
- **Mojibake:** texto corrupto por mala interpretación de encoding (típicamente UTF-8 leído como Latin-1)
- **Identity property:** `documento_de_identidad`, el campo que identifica unívocamente al contacto
- **Tick:** una ejecución del cron (cada `CRON_SCHEDULE`)
