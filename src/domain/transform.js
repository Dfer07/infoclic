import { resolveHubspotProperty } from '../config/properties.js';

export function rowToContact(row) {
  const properties = {};
  for (const [csvColumn, rawValue] of Object.entries(row)) {
    if (rawValue === null || rawValue === undefined) continue;
    const value = String(rawValue).trim();
    if (value === '') continue;
    const hubspotProperty = resolveHubspotProperty(csvColumn);
    properties[hubspotProperty] = value;
  }
  return properties;
}
