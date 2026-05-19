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

function isTransientHubspotError(err) {
  const code = err?.code ?? err?.statusCode ?? err?.response?.status;
  if (typeof code !== 'number') return true;
  if (code === 429) return true;
  return code >= 500;
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
    logger.debug({ key }, 'empty CSV');
    const destKey = `files_out/${ts}-${baseName}`;
    await r2.move({ sourceKey: key, destKey });
    const reportKey = `files_out/${ts}-${baseName.replace(/\.csv$/, '')}.report.json`;
    const report = {
      processed_at: now.toISOString(),
      input_file: key,
      output_file: destKey,
      rows_total: 0,
      duplicates_collapsed: 0,
      rows_skipped: 0,
      rows_processed: 0,
      contacts_created: 0,
      contacts_updated: 0,
      contacts_unchanged: 0,
      errors_file: null,
    };
    await r2.upload({
      key: reportKey,
      body: Buffer.from(buildReportJson(report), 'utf8'),
      contentType: 'application/json',
    });
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
    if (isTransientHubspotError(err)) {
      logger.error({ err, key }, 'transient: hubspot operation failed, will retry');
      return;
    }
    logger.error({ err, key }, 'permanent: hubspot rejected request');
    const reason = `HubSpot ${err?.code ?? err?.statusCode ?? 'error'}: ${err?.body?.message ?? err?.message ?? 'unknown'}`;
    await failPermanently(key, ts, baseName, [{ row: {}, reason }], headers, deps);
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
