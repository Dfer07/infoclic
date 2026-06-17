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
  logger.info({ schedule: env.cronSchedule }, 'infoclic scheduler started');
}

main().catch((err) => {
  logger.error({ err }, 'fatal');
  process.exit(1);
});
