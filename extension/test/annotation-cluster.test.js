const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

require('../lib/annotation-cluster');
const { clusterAnnotationsByContainer } = require('../lib/annotation-cluster');

describe('annotation-cluster bootstrap', () => {
  it('returns empty samples and supplemental for empty input', () => {
    const r = clusterAnnotationsByContainer([]);
    assert.deepEqual(r.samples, []);
    assert.deepEqual(r.supplemental, []);
  });

  it('returns empty samples and supplemental for non-array input', () => {
    const r = clusterAnnotationsByContainer(null);
    assert.deepEqual(r.samples, []);
    assert.deepEqual(r.supplemental, []);
  });
});
