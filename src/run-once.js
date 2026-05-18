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
