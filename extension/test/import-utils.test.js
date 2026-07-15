const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateImportData, filterDuplicates } = require('../lib/import-utils');

describe('validateImportData', () => {
  it('accepts valid service array with scriptCode (legacy)', () => {
    const data = [{ id: '1', name: 'svc-1', scriptCode: 'code' }];
    const result = validateImportData(data);
    assert.equal(result.imported.length, 1);
    assert.equal(result.skipped.length, 0);
  });

  it('accepts valid service array with steps (new)', () => {
    const data = [{ id: '1', name: 'svc-1', steps: [{ id: 'main', name: 'Main', script: 'code', onSuccess: 'TERMINATE', onFailure: 'TERMINATE', maxIterations: 1 }] }];
    const result = validateImportData(data);
    assert.equal(result.imported.length, 1);
    assert.equal(result.skipped.length, 0);
  });

  it('normalizes single object to array', () => {
    const data = { id: '1', name: 'svc-1', scriptCode: 'code' };
    const result = validateImportData(data);
    assert.equal(result.imported.length, 1);
  });

  it('skips entries missing required fields', () => {
    const data = [
      { id: '1', name: 'svc-1', scriptCode: 'code' },
      { id: '2', name: 'svc-2' },
      { name: 'svc-3', scriptCode: 'code' },
      {}
    ];
    const result = validateImportData(data);
    assert.equal(result.imported.length, 1);
    assert.equal(result.skipped.length, 3);
  });

  it('skips entries missing both scriptCode and steps', () => {
    const data = [
      { id: '1', name: 'svc-1', steps: [] },
      { id: '2', name: 'svc-2', scriptCode: 'code' }
    ];
    const result = validateImportData(data);
    assert.equal(result.imported.length, 1);
    assert.equal(result.skipped.length, 1);
  });
});

describe('filterDuplicates', () => {
  it('filters services with existing names', () => {
    const services = [
      { id: '1', name: 'svc-a', scriptCode: 'code' },
      { id: '2', name: 'svc-b', scriptCode: 'code' }
    ];
    const existing = new Set(['svc-a']);
    const result = filterDuplicates(services, existing);
    assert.equal(result.toImport.length, 1);
    assert.equal(result.toImport[0].name, 'svc-b');
    assert.equal(result.skipped, 1);
  });

  it('imports all when no duplicates', () => {
    const services = [{ id: '1', name: 'svc-a', scriptCode: 'code' }];
    const result = filterDuplicates(services, new Set());
    assert.equal(result.toImport.length, 1);
    assert.equal(result.skipped, 0);
  });

  it('skips all when all duplicates', () => {
    const services = [{ id: '1', name: 'svc-a', scriptCode: 'code' }];
    const result = filterDuplicates(services, new Set(['svc-a']));
    assert.equal(result.toImport.length, 0);
    assert.equal(result.skipped, 1);
  });
});
