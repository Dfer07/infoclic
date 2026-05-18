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
