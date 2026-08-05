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

const { normalizeSegment } = require('../lib/annotation-cluster');

describe('normalizeSegment', () => {
  it('strips the value from [attr="N"] (double-quote form)', () => {
    assert.equal(normalizeSegment('div[aria-posinset="3"]'), 'div[aria-posinset]');
  });

  it('strips the value from [attr=\'N\'] (single-quote form)', () => {
    assert.equal(normalizeSegment("div[aria-posinset='3']"), 'div[aria-posinset]');
  });

  it('strips the value from [data-index="42"]', () => {
    assert.equal(normalizeSegment('div[data-index="42"]'), 'div[data-index]');
  });

  it('collapses numeric-suffix ids to a stable marker', () => {
    assert.equal(normalizeSegment('div#post-7'), 'div[id]');
    assert.equal(normalizeSegment('div#item-42'), 'div[id]');
  });

  it('strips class numeric suffixes to a prefix pattern', () => {
    assert.equal(normalizeSegment('div.item-3'), 'div.item-');
    assert.equal(normalizeSegment('div.card7'), 'div.card');
  });

  it('drops :nth-of-type(N) and :nth-child(N)', () => {
    assert.equal(normalizeSegment('div:nth-of-type(3)'), 'div');
    assert.equal(normalizeSegment('li:nth-child(2)'), 'li');
  });

  it('preserves semantic attributes like role', () => {
    assert.equal(normalizeSegment("div[role='article']"), 'div[role]');
  });

  it('returns empty string for falsy input', () => {
    assert.equal(normalizeSegment(''), '');
    assert.equal(normalizeSegment(null), '');
  });
});

const { isHighConfidence } = require('../lib/annotation-cluster');

describe('isHighConfidence', () => {
  it('returns true for [role="..."]', () => {
    assert.equal(isHighConfidence("div[role='article']"), true);
  });

  it('returns true for [aria-posinset] (value stripped or not)', () => {
    assert.equal(isHighConfidence("div[aria-posinset='3']"), true);
    assert.equal(isHighConfidence('div[aria-posinset]'), true);
  });

  it('returns true for [data-index], [data-item], [data-testid], [data-row], [data-cid], [data-id]', () => {
    assert.equal(isHighConfidence('div[data-index="42"]'), true);
    assert.equal(isHighConfidence('div[data-item="1"]'), true);
    assert.equal(isHighConfidence('div[data-testid="result"]'), true);
    assert.equal(isHighConfidence('div[data-row="7"]'), true);
    assert.equal(isHighConfidence('div[data-cid="abc"]'), true);
    assert.equal(isHighConfidence('div[data-id="x"]'), true);
  });

  it('returns true for li / tr / option tag', () => {
    assert.equal(isHighConfidence('li'), true);
    assert.equal(isHighConfidence('tr.item'), true);
    assert.equal(isHighConfidence('option[value="a"]'), true);
  });

  it('returns true for item-/post-/card-/row-/entry-/result-/product-N class patterns', () => {
    assert.equal(isHighConfidence('div.item-3'), true);
    assert.equal(isHighConfidence('div.post-7'), true);
    assert.equal(isHighConfidence("div.card-42[x='1']"), true);
    assert.equal(isHighConfidence('div.row7'), true);
    assert.equal(isHighConfidence('div.entry-1'), true);
    assert.equal(isHighConfidence('div.result-99'), true);
    assert.equal(isHighConfidence('div.product-5'), true);
  });

  it('returns false for a generic section without signals', () => {
    assert.equal(isHighConfidence('section'), false);
    assert.equal(isHighConfidence('div.wrapper'), false);
  });

  it('returns false for empty input', () => {
    assert.equal(isHighConfidence(''), false);
    assert.equal(isHighConfidence(null), false);
  });
});
