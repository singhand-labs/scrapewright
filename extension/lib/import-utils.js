function validateImportData(data) {
  if (!Array.isArray(data)) data = [data];
  const results = { imported: [], skipped: [] };
  for (const svc of data) {
    if (!svc.id || !svc.name || (!svc.scriptCode && (!svc.steps || svc.steps.length === 0))) {
      results.skipped.push({ reason: 'missing required fields', service: svc });
      continue;
    }
    results.imported.push(svc);
  }
  return results;
}

function filterDuplicates(services, existingNames) {
  const toImport = [];
  let skipped = 0;
  for (const svc of services) {
    if (existingNames.has(svc.name)) {
      skipped++;
      continue;
    }
    toImport.push(svc);
  }
  return { toImport, skipped };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { validateImportData, filterDuplicates };
}
