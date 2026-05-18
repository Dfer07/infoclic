function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  return false;
}

export function pickUpdatableFields(csvProperties, crmProperties) {
  const result = {};
  for (const [key, csvValue] of Object.entries(csvProperties)) {
    const crmValue = crmProperties?.[key];
    if (isEmpty(crmValue)) {
      result[key] = csvValue;
    }
  }
  return result;
}
