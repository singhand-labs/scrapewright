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

const { parseDomPathSegments } = require('../lib/annotation-cluster');

describe('parseDomPathSegments', () => {
  it('splits a simple child-combinator path', () => {
    assert.deepEqual(parseDomPathSegments('div > div > span'), ['div', 'div', 'span']);
  });

  it('does not split on spaces inside attribute brackets', () => {
    const p = "div > div[role='article'][aria-posinset='3'] > h3 > a";
    assert.deepEqual(parseDomPathSegments(p), [
      'div',
      "div[role='article'][aria-posinset='3']",
      'h3',
      'a',
    ]);
  });

  it('returns [] for non-string input', () => {
    assert.deepEqual(parseDomPathSegments(null), []);
    assert.deepEqual(parseDomPathSegments(undefined), []);
    assert.deepEqual(parseDomPathSegments(42), []);
  });

  it('trims whitespace around segments', () => {
    assert.deepEqual(parseDomPathSegments('  div  >  span  '), ['div', 'span']);
  });

  it('handles single-segment path (no combinator)', () => {
    assert.deepEqual(parseDomPathSegments('div'), ['div']);
  });
});
