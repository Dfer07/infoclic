import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReportJson, buildErrorsCsv } from '../../src/infrastructure/report.js';

test('buildReportJson serializa los campos esperados', () => {
  const summary = {
    processed_at: '2026-05-20T10:00:00.000Z',
    input_file: 'files_in/x.csv',
    output_file: 'files_out/2026-05-20-x.csv',
    rows_total: 10,
    duplicates_collapsed: 0,
    rows_skipped: 1,
    rows_processed: 9,
    contacts_created: 3,
    contacts_updated: 5,
    contacts_unchanged: 1,
    errors_file: null,
  };
  const json = buildReportJson(summary);
  const parsed = JSON.parse(json);
  assert.equal(parsed.rows_total, 10);
  assert.equal(parsed.contacts_created, 3);
  assert.equal(parsed.errors_file, null);
});

test('buildErrorsCsv produce CSV con header + _error_reason por fila', () => {
  const headers = ['firstname', 'documento_de_identidad', 'email'];
  const rows = [
    { row: { firstname: 'Carlos', documento_de_identidad: '', email: 'c@x.com' }, reason: 'missing required field: documento_de_identidad' },
    { row: { firstname: '', documento_de_identidad: '12345', email: 'a@x.com' }, reason: 'missing required field: firstname' },
  ];
  const csv = buildErrorsCsv(headers, rows);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'firstname,documento_de_identidad,email,_error_reason');
  assert.ok(lines[1].includes('Carlos'));
  assert.ok(lines[1].includes('missing required field: documento_de_identidad'));
  assert.equal(lines.length, 3);
});

test('buildErrorsCsv maneja valores con comas escapándolos', () => {
  const headers = ['firstname'];
  const rows = [{ row: { firstname: 'García, Carlos' }, reason: 'test' }];
  const csv = buildErrorsCsv(headers, rows);
  assert.ok(csv.includes('"García, Carlos"'));
});
