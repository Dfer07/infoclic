import { env } from './env.js';

export const IDENTITY_PROPERTY = env.hubspot.identityProperty;

export const COLUMN_OVERRIDES = {};

export function resolveHubspotProperty(csvColumn) {
  return COLUMN_OVERRIDES[csvColumn] ?? csvColumn;
}
