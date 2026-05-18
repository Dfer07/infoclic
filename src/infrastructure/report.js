import { stringify } from 'csv-stringify/sync';

export function buildReportJson(summary) {
  return JSON.stringify(summary, null, 2);
}

export function buildErrorsCsv(headers, rows) {
  const allHeaders = [...headers, '_error_reason'];
  const records = rows.map(({ row, reason }) => {
    const record = {};
    for (const h of headers) record[h] = row[h] ?? '';
    record._error_reason = reason;
    return record;
  });
  return stringify(records, { header: true, columns: allHeaders });
}
