# InfoClick — Diseño técnico

**Fecha**: 2026-05-17
**Estado**: Aprobado para implementación
**Deadline de entrega**: 2026-05-20

---

## 1. Contexto y problema

El cliente de InfoClick lanza campañas de marketing (~1 por mes) y necesita cargar/actualizar contactos en su CRM (HubSpot) a partir de un CSV generado por su equipo desde una herramienta interna de consulta de bases de datos.

Hoy el proceso es 100% manual: el equipo del cliente extrae datos, los filtra y los mapea uno a uno hacia el CRM. Esto genera retrasos en las campañas y datos inconsistentes.

Se quiere automatizar la etapa "CSV listo → contactos en HubSpot", sin tocar la generación del CSV (que sigue siendo responsabilidad del cliente).

## 2. Objetivos y no-objetivos

### Objetivos

- Procesar automáticamente CSVs estandarizados que aparecen en un bucket de Cloudflare R2.
- Crear o actualizar contactos en HubSpot usando `documento_de_identidad` como llave única.
- Respetar la regla **"no sobrescribir información existente"**: nunca borrar datos del CRM con valores vacíos del CSV ni con valores diferentes (regla interim).
- Ser robusto a fallos: archivos con problemas no se pierden ni bloquean los siguientes.
- Soportar mantenimiento mensual sin requerir intervención del dev para cada campaña nueva.

### No-objetivos (explícitamente fuera del alcance)

- Extraer datos de las fuentes internas del cliente (lo hace su equipo).
- Mapear datos al formato CSV estandarizado (lo hace su equipo).
- **Crear propiedades automáticamente en HubSpot.** Si el CSV trae una columna que no existe como propiedad, el archivo se rechaza con error claro (el equipo de marketing del cliente debe crearla manualmente con el tipo de dato correcto antes de subir el archivo).
- Empresas, negocios, productos. Solo el objeto Contacto.
- Multi-tenant. Una instancia = un cliente.
- UI web. La operación se hace por el dashboard de Cloudflare (R2) y por logs.

## 3. Arquitectura

Servicio Node de larga duración, sin endpoints HTTP, con un cron interno (`node-cron`). Cada tick:

```
listar files_in/  →  por cada CSV:
  detectar encoding y normalizar a UTF-8
  parsear
  validar headers contra HubSpot
  leer estado actual en HubSpot por documento_de_identidad
  decidir create vs update con regla "CRM gana"
  ejecutar batch create + batch update
  generar reporte y errores
  mover archivo a files_out/  (o dejar en files_in/ si falló todo)
```

**Capas con dependencias solo hacia adentro:**

```
entry (cron)  →  application (use case)  →  domain (reglas puras)
                                          →  infrastructure (R2, HubSpot, CSV, logger)
```

Sin contenedores de DI, sin puertos/adaptadores formales. Inyección por imports y argumentos.

## 4. Estructura de carpetas

```
smartflow-infoclick/
├── src/
│   ├── config/
│   │   ├── env.js              # vars de entorno
│   │   └── properties.js       # IDENTITY_PROPERTY + COLUMN_OVERRIDES
│   ├── domain/
│   │   ├── transform.js        # row → contact, regla "no sobrescribir vacíos"
│   │   └── merge.js            # regla "CRM gana": decidir qué campos enviar
│   ├── infrastructure/
│   │   ├── r2.js               # list, get, copy, delete
│   │   ├── hubspot.js          # batch read/create/update + properties catalog
│   │   ├── csv.js              # parse + encoding detection
│   │   ├── report.js           # generación de .report.json y .errors.csv
│   │   └── logger.js           # pino
│   ├── application/
│   │   └── process-files.js    # orquesta el flujo completo
│   ├── index.js                # entry con cron
│   └── run-once.js             # entry para ejecución única
├── .env.example
├── .dockerignore
├── Dockerfile
├── compose.yaml
├── package.json
└── README.md
```

## 5. Flujo detallado por archivo

### 5.1 Descubrimiento

`listObjectsV2` en `files_in/`, filtrando solo `.csv` (no subcarpetas, no otros formatos).

### 5.2 Encoding

El CSV puede venir en UTF-8 o Latin-1/Windows-1252 (Excel español suele exportar Latin-1). El código:

1. Descarga el archivo como buffer.
2. Intenta UTF-8.
3. Si detecta patrones de mojibake (presencia de `Ã­`, `Ã³`, `Ã©`, etc. en los datos), re-decodifica como Latin-1.
4. Si tiene BOM, lo strippea (el parser CSV ya lo soporta con `bom: true`).

Librería propuesta: `iconv-lite` para conversión + detección heurística simple (no necesitamos `chardet` para esto).

### 5.3 Parseo

`csv-parse/sync` con `columns: true`, `skip_empty_lines: true`, `trim: true`, `bom: true`.

### 5.4 Validación de headers

Para cada columna del CSV:

1. Resolver el nombre real de la propiedad en HubSpot vía `COLUMN_OVERRIDES` (identity por default).
2. Verificar que esa propiedad exista en HubSpot (consultando el catálogo `crm.properties.coreApi.getAll('contacts')`, **una vez por tick** y cacheado en memoria).
3. Si alguna columna no tiene propiedad correspondiente → **fallo permanente del archivo**: mover el CSV a `files_error/` junto con un `.errors.csv` que liste las propiedades faltantes. No se reintenta hasta que un humano corrija y vuelva a subir a `files_in/`.

### 5.5 Validación de filas

Por cada fila:

- Debe traer la columna de identidad (`IDENTITY_PROPERTY`).
- El valor de identidad no puede estar vacío ni ser puro espacio.

Filas inválidas → al `.errors.csv` con motivo, no entran al pipeline.

### 5.6 Deduplicación intra-CSV

Si dos filas tienen el mismo `documento_de_identidad`:

- **Última fila gana.**
- Log de warning con la cédula duplicada.

### 5.7 Read antes de write (regla "CRM gana")

Para cada batch de hasta 100 contactos:

1. `crm.contacts.batchApi.read` con `idProperty: documento_de_identidad` y la lista de cédulas.
2. HubSpot devuelve los que existen (con su ID interno y propiedades actuales).
3. Para cada fila del CSV:
   - **Si NO existe en CRM**: preparar para `batchCreate` con todos los campos no-vacíos del CSV.
   - **Si existe**: comparar campo por campo:
     - Campo vacío en CRM, valor en CSV → incluir en update.
     - Campo con valor en CRM (cualquiera) → **no incluir** (CRM gana, regla interim).
4. Ejecutar `batchApi.create` y `batchApi.update` en paralelo.
5. Throttling: sleep de 100ms entre batches para no chocar con burst de HubSpot (100 req / 10 seg).

### 5.8 Reporte

Tras procesar, generar `<timestamp>-<filename>.report.json` y subir junto al archivo a `files_out/`. Estructura:

```json
{
  "processed_at": "2026-05-20T10:05:23.412Z",
  "input_file": "files_in/contactos-mayo.csv",
  "output_file": "files_out/2026-05-20T10:05:23-contactos-mayo.csv",
  "rows_total": 51,
  "duplicates_collapsed": 1,
  "rows_skipped": 3,
  "rows_processed": 47,
  "contacts_created": 12,
  "contacts_updated": 35,
  "contacts_unchanged": 0,
  "errors_file": "files_error/2026-05-20T10:05:23-contactos-mayo.errors.csv"
}
```

Invariantes: `rows_total = duplicates_collapsed + rows_skipped + rows_processed` y `rows_processed = contacts_created + contacts_updated + contacts_unchanged`.

### 5.9 Errores granulares

`files_error/<timestamp>-<filename>.errors.csv` con las filas problemáticas + columna extra `_error_reason`. Solo se genera si hubo errores. El cliente puede abrirlo en Excel, corregir, y volver a subir el archivo (el upsert es idempotente).

### 5.10 Movimiento del archivo

El destino del archivo depende del resultado del procesamiento. Distinguimos **tres** desenlaces:

| Resultado | Destino del CSV original | `.errors.csv` |
|---|---|---|
| Procesamiento exitoso (incluso si hubo filas individuales descartadas) | `files_out/<timestamp>-<filename>.csv` | En `files_error/` solo si hubo filas descartadas |
| Fallo permanente: encoding ilegible, CSV malformado, propiedades faltantes en HubSpot | `files_error/<timestamp>-<filename>.csv` | Sí, en `files_error/` describiendo el problema |
| Fallo transitorio: red caída, HubSpot 5xx, rate limit (429), timeout | **Queda en `files_in/`** (reintento en próximo tick) | No se genera (el archivo aún puede tener éxito) |

**Por qué la distinción**: si tratáramos los fallos permanentes como transitorios, cada tick generaría un nuevo `.errors.csv` para el mismo archivo, llenando la carpeta de duplicados y enmascarando el problema. Los fallos permanentes requieren intervención humana, no más reintentos.

Move en R2 = `CopyObject` + `DeleteObject` (R2 no tiene operación atómica). Si el delete falla tras un copy exitoso, queda duplicado; se loggea para auditoría manual.

## 6. Configuración (`.env.example`)

```env
# Cron schedule. Default: cada 5 minutos.
# Para dev: */1 * * * *  (1 min) o */30 * * * * *  (30 seg, formato con segundos)
CRON_SCHEDULE=*/5 * * * *

# Si true, ejecuta una vez al arrancar antes de seguir con el cron normal.
RUN_ON_START=false

# Nivel de log: debug | info | warn | error
LOG_LEVEL=info

# Cloudflare R2
R2_ACCOUNT_ID=
R2_ENDPOINT=
R2_BUCKET_NAME=infoclic
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=

# HubSpot
HUBSPOT_ACCESS_TOKEN=
HUBSPOT_IDENTITY_PROPERTY=documento_de_identidad

# Throttling entre batches (ms). 100ms por defecto, 0 para dev.
HUBSPOT_BATCH_DELAY_MS=100
```

`R2_ENDPOINT` puede omitirse si se define `R2_ACCOUNT_ID`.

## 7. Comandos

| Comando | Comportamiento |
|---|---|
| `npm start` | Arranca el cron según `CRON_SCHEDULE` |
| `npm run process-once` | Ejecuta una iteración y sale (no levanta cron) |
| `RUN_ON_START=true npm start` | Ejecuta una iteración al arrancar + cron normal |
| `npm run dev` | `node --watch` para iteración rápida en local |

## 8. Logging y observabilidad

**Logger: `pino`** (JSON estructurado, rápido, estándar). En dev se vuelve legible con `pino-pretty`.

Niveles:

- `info`: arranque, tick start/end (heartbeat), archivo procesado OK, contactos creados/actualizados (bulk).
- `warn`: filas individuales descartadas, cédulas duplicadas en mismo CSV.
- `error`: archivo descartado, propiedades faltantes en HubSpot, fallo de red.
- `debug`: detalle interno (solo con `LOG_LEVEL=debug`).

**Heartbeat**: cada tick loggea `"tick_start"` y `"tick_end"` aunque no haya archivos. Sin endpoint HTTP de healthcheck (over-engineering para esto).

## 9. Manejo de errores

| Escenario | Tipo | Comportamiento |
|---|---|---|
| No hay archivos en `files_in/` | — | `debug` log, fin del tick |
| Archivo con encoding ilegible | **Permanente** | `error` log, mover a `files_error/` con `.errors.csv` |
| Archivo con header desconocido (propiedad no existe en HubSpot) | **Permanente** | `error` log, mover a `files_error/` con `.errors.csv` listando propiedades faltantes |
| CSV malformado (no parsea) | **Permanente** | `error` log, mover a `files_error/` con `.errors.csv` |
| Fila sin `documento_de_identidad` | Granular | Fila va al `.errors.csv` con motivo, sigue procesando las demás |
| Cédulas duplicadas en mismo CSV | Granular | Última gana, `warn` log con cédula afectada |
| Fallo de red contra R2 o HubSpot | **Transitorio** | `error` log, archivo queda en `files_in/`, se reintenta en próximo tick |
| HubSpot devuelve 5xx o 429 (rate limit) | **Transitorio** | `error` log, archivo queda en `files_in/`, se reintenta en próximo tick |
| Tick anterior aún corriendo | — | Nuevo tick se salta con `warn` (flag `running` en memoria) |

## 10. Despliegue

VPS Hostinger con Docker.

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
USER node
CMD ["node", "src/index.js"]
```

```yaml
# compose.yaml
services:
  infoclick:
    build: .
    container_name: infoclick
    env_file: .env
    restart: unless-stopped
```

Operación:

1. SSH al VPS, clonar repo en `/opt/infoclick`.
2. Crear `.env` con credenciales reales.
3. `docker compose up -d --build`.
4. `docker compose logs -f infoclick` para verificar.
5. Cambios de schedule: editar `.env` + `docker compose restart infoclick`.

## 11. Stack

| Paquete | Uso |
|---|---|
| `@aws-sdk/client-s3` | Cliente R2 (compatible S3) |
| `@hubspot/api-client` | SDK HubSpot |
| `csv-parse` | Parser CSV |
| `iconv-lite` | Conversión de encoding |
| `node-cron` | Scheduler |
| `pino` | Logger |
| `dotenv` | Variables de entorno |

## 12. Cuotas y volumen

### En testing (alcance del MVP)

- 10-50 contactos por archivo, ~1 archivo al mes.
- Llamadas a HubSpot por archivo: ~3 (1 read + 1 create + 1 update).
- Sin riesgo de cuota.

### En producción (proyectado)

- Hasta millones de contactos por archivo.
- Para 1M contactos: ~30,000 llamadas a HubSpot (10,000 read + 10,000 update + 10,000 create).
- Cuota Private App: 250,000/día. Margen ~8x.
- Burst: 100 req/10s. Mitigado con `HUBSPOT_BATCH_DELAY_MS` configurable.

## 13. Consideraciones para producción

Estas optimizaciones **no se implementan en MVP**, pero el código queda preparado para activarlas:

1. **Streaming del CSV** en lugar de carga completa en memoria. Necesario para archivos > 100MB. Migración: cambiar `csv-parse/sync` → `csv-parse` con stream.
2. **Propiedad `documento_de_identidad` como unique en HubSpot.** Habilita el uso de `batchApi.upsert` en vez del flujo manual read+create/update, ahorrando ~50% de llamadas. Cambio: 1 línea en código + activar el flag en HubSpot.
3. **Persistencia de auditoría**: hoy los reportes viven en R2. A futuro, podría haber una tabla en una base de datos para queries rápidos ("¿qué se procesó la semana pasada?").
4. **Notificaciones** (email/Slack) al cliente cuando un archivo se procesa o falla. No incluido en MVP.
5. **Métricas Prometheus** expuestas para Grafana. No incluido.

## 14. Reglas de negocio finalizadas vs pendientes

### Finalizadas

- **Llave de upsert**: `documento_de_identidad` (configurable).
- **No sobrescribir vacíos**: si una celda del CSV está vacía, la propiedad no se envía al CRM.
- **Una sola plantilla evolutiva**: el CSV solo necesita traer las columnas que use esa campaña. Las propiedades no incluidas en el CSV no se tocan.
- **Headers del CSV = nombres internos de HubSpot** (con `COLUMN_OVERRIDES` para excepciones).
- **Schema en HubSpot lo controla el equipo de marketing del cliente** manualmente. El código no crea propiedades.

### Pendientes (decisión del cliente, interim definido)

- **Regla de discrepancia (CSV vs CRM con valores distintos)**: interim → **CRM gana**. Esta decisión condiciona el diseño actual (read antes de write). Si la regla final pasa a "CSV gana", el código se simplifica significativamente (puede usar upsert directo).

## 15. Riesgos conocidos

| Riesgo | Mitigación |
|---|---|
| `documento_de_identidad` no es unique en HubSpot (testing) | Garantía manual de no duplicados en datos de prueba; en prod se activa unique antes de migrar |
| Cliente sube CSV con encoding malo | Conversión automática de Latin-1 → UTF-8 |
| Cliente olvida crear una propiedad en HubSpot | Validación al inicio del archivo, no se procesa, error claro en `.errors.csv` |
| Server cae a mitad de proceso | Idempotencia: archivo no se mueve hasta el final exitoso, se reprocesa al reiniciar |
| Tick tarda más que el intervalo | Flag `running` en memoria previene superposición |
| Cuota HubSpot en prod | Throttling configurable + arquitectura batch |

## 16. Plan de prueba

1. Subir el CSV de prueba (`contactos_prueba.csv` con 3 filas) a `files_in/` en R2.
2. Crear en HubSpot testing las propiedades: `firstname`, `lastname`, `email` (ya existen como standard), `documento_de_identidad` (custom, single-line text, **NO** unique en testing).
3. Ejecutar `npm run process-once`.
4. Verificar:
   - 3 contactos creados en HubSpot.
   - Archivo movido a `files_out/<timestamp>-contactos_prueba.csv`.
   - `.report.json` generado con `contacts_created: 3`.
   - No hay `.errors.csv`.
5. Re-ejecutar con el mismo archivo: 0 creados, 0 actualizados (porque CRM gana en discrepancia y los campos ya tienen valor).
6. Modificar un contacto en HubSpot manualmente (dejar un campo vacío), subir el CSV con ese campo lleno, ejecutar: ese campo específico debe actualizarse, los demás no.

## 17. Changelog

| Fecha | Cambio |
|---|---|
| 2026-05-17 | Versión inicial del spec, consolidando ~8 rondas de brainstorming. |
| 2026-05-17 | Corrección de inconsistencia en niveles de log (sección 8): eliminada referencia a "columnas ignoradas" — el diseño aborta cuando una columna no existe en HubSpot, nunca las ignora. |
| 2026-05-17 | Ajuste de ejemplo de reporte JSON (sección 5.8) para que las cifras sean internamente consistentes. Documentadas las invariantes. |
| 2026-05-17 | Distinción explícita entre fallos **permanentes** (mover a `files_error/`, sin retry) y **transitorios** (queda en `files_in/`, retry). Afecta secciones 5.4, 5.10 y 9. Motivo: evitar generar `.errors.csv` duplicados cada tick cuando un fallo requiere intervención humana. |

---

**Fin del documento.**
