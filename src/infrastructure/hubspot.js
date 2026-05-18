import { Client } from '@hubspot/api-client';

export function createHubspotClient({ accessToken }) {
  return new Client({ accessToken, numberOfApiCallRetries: 3 });
}

export async function fetchPropertyCatalog(client) {
  const res = await client.crm.properties.coreApi.getAll('contacts');
  return new Set((res.results ?? []).map((p) => p.name));
}

export async function readContactsByIdProperty(client, { idProperty, ids, properties }) {
  if (ids.length === 0) return [];
  const res = await client.crm.contacts.batchApi.read({
    idProperty,
    inputs: ids.map((id) => ({ id })),
    properties,
  });
  return res.results ?? [];
}

export async function createContacts(client, contacts) {
  if (contacts.length === 0) return [];
  const res = await client.crm.contacts.batchApi.create({
    inputs: contacts.map((properties) => ({ properties })),
  });
  return res.results ?? [];
}

export async function updateContacts(client, updates) {
  if (updates.length === 0) return [];
  const res = await client.crm.contacts.batchApi.update({
    inputs: updates.map((u) => ({ id: u.id, properties: u.properties })),
  });
  return res.results ?? [];
}
