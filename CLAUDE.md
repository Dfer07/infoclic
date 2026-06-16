# CLAUDE.md — InfoClick

> **Si retomas el proyecto en una sesión nueva, lee primero [docs/superpowers/HANDOFF.md](docs/superpowers/HANDOFF.md)** — resume el estado actual, qué se hizo y cuál es el próximo paso.

Servicio Node de larga duración que sincroniza CSVs de Cloudflare R2 hacia contactos de HubSpot. No expone HTTP; corre con un cron interno (`node-cron`).

**Estado:** implementación completa (39 tests pasando). Único pendiente: smoke test manual con credenciales reales (Task 15). Ver el handoff para el detalle.

## Documentación de referencia

- **Handoff (estado actual)**: [docs/superpowers/HANDOFF.md](docs/superpowers/HANDOFF.md)
- **Spec técnico (fuente de verdad)**: [docs/superpowers/specs/2026-05-17-infoclick-design.md](docs/superpowers/specs/2026-05-17-infoclick-design.md)
- **Plan de implementación**: [docs/superpowers/plans/2026-05-17-infoclick-implementation.md](docs/superpowers/plans/2026-05-17-infoclick-implementation.md)
- **README**: onboarding para devs (instalación, ejecución local, arquitectura, env vars, pendientes). En caso de conflicto técnico, **gana el spec**.

Jerarquía ante conflicto: **spec > CLAUDE.md > plan > README**.

## Stack

Node 22 · `@aws-sdk/client-s3` · `@hubspot/api-client` · `csv-parse` · `csv-stringify` · `iconv-lite` · `node-cron` · `pino` · Docker

**No incluye Fastify ni ningún framework HTTP.** Es un proceso de fondo, no una API. Sin base de datos: el estado vive en R2 (archivos + reportes) y en HubSpot.

## Estructura del proyecto

```
src/
├── config/       env.js (vars + validación) · properties.js (mapping CSV→HubSpot)
├── domain/       transform.js (descarta vacíos) · merge.js (regla "CRM gana")
├── infrastructure/  csv.js · r2.js · hubspot.js · report.js · logger.js
├── application/  process-files.js (orquestador del flujo)
├── index.js      entry cron (npm start)
└── run-once.js   entry one-shot (npm run process-once)
```

Tests en `tests/**/*.test.js` (`npm test`, `node --test`). Los entry points se validan vía smoke test.

## Comandos

| Comando | Uso |
|---|---|
| `npm start` | Arranca el cron según `CRON_SCHEDULE` |
| `npm run process-once` | Ejecuta una iteración y sale (sin cron) |
| `RUN_ON_START=true npm start` | Ejecuta una vez al arrancar + sigue con el cron |
| `npm run dev` | `node --watch` para iteración rápida |

## Reglas de negocio críticas

- **No sobrescribir vacíos**: si una celda del CSV está vacía, esa propiedad NO se envía a HubSpot (la existente se mantiene).
- **CRM gana en discrepancias** (regla interim, pendiente de cierre): si CRM tiene valor distinto al del CSV, prevalece CRM. Esto fuerza el flujo `read-before-write`.
- **Identificador único**: `documento_de_identidad` (configurable vía `HUBSPOT_IDENTITY_PROPERTY`).
- **Schema lo gestiona manualmente** el equipo de marketing del cliente en HubSpot. **El código NO crea propiedades**. Si una columna del CSV no existe en HubSpot → archivo a `files_error/`.

## Manejo de errores (resumen)

- **Permanente** (encoding ilegible, propiedad faltante, CSV malformado): mover a `files_error/` con `.errors.csv`. **No se reintenta** hasta intervención humana.
- **Transitorio** (red, HubSpot 5xx, rate limit): queda en `files_in/`, se reintenta en el próximo tick.
- **Granular** (fila individual inválida): va al `.errors.csv`, las demás filas siguen procesando.

## Convenciones

- Arquitectura por capas: `entry → application → domain | infrastructure`.
- Modularidad sin sobre-ingeniería: **sin** DI containers, **sin** puertos/adaptadores formales.
- Mapping CSV→HubSpot centralizado en `src/config/properties.js` (identity por default, overrides para cambios en prod).
- Logger: `pino` (JSON). En dev: `pino-pretty` para legibilidad humana.
- Para producción: ver "Consideraciones para producción" en el spec.

## Recursos externos

- **Bucket R2**: `infoclic` (sin "k") en cuenta Cloudflare `Smarteamcr@gmail.com`. Carpetas: `files_in/`, `files_out/`, `files_error/`.
- **HubSpot**: cuenta de **testing** durante desarrollo. Cuando se migre a prod, cambiar `HUBSPOT_ACCESS_TOKEN` y revisar `HUBSPOT_IDENTITY_PROPERTY` (la propiedad debería estar marcada `unique` en prod).
- **Despliegue**: VPS Hostinger con Docker (`docker compose up -d --build`).

## Cómo documentamos cambios

- **Cambios al spec**: agregar fila a la sección "Changelog" del spec con fecha y descripción breve.
- **Cambios al código**: git commits descriptivos de **una sola línea**, formato convencional (`feat:`, `fix:`, `chore:`, `docs:`). **Nunca** añadir trailer `Co-Authored-By`.
- **Decisiones nuevas o cambios en reglas de negocio**: actualizar el spec **y** este CLAUDE.md si corresponde.
