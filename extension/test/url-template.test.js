const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractTemplateParams, resolveTargetUrl } = require('../lib/url-template');

describe('extractTemplateParams', () => {
  it('returns empty array for plain URL with no placeholders', () => {
    assert.deepEqual(extractTemplateParams('https://example.com/search?q=shoes'), []);
  });

  it('returns single param name for one placeholder', () => {
    assert.deepEqual(extractTemplateParams('https://example.com/search?q={{keyword}}'), ['keyword']);
  });

  it('returns multiple param names in first-appearance order', () => {
    assert.deepEqual(
      extractTemplateParams('https://example.com/search?q={{keyword}}&page={{pageNumber}}'),
      ['keyword', 'pageNumber']
    );
  });

  it('dedupes repeated placeholders, keeping first-appearance order', () => {
    assert.deepEqual(
      extractTemplateParams('https://example.com/?q={{k}}&ref={{k}}'),
      ['k']
    );
  });

  it('tolerates whitespace inside braces', () => {
    assert.deepEqual(extractTemplateParams('https://example.com/?q={{ keyword }}'), ['keyword']);
  });

  it('ignores non-identifier patterns like {{a-b}}', () => {
    assert.deepEqual(extractTemplateParams('https://example.com/?q={{a-b}}'), []);
  });
});

describe('resolveTargetUrl', () => {
  it('returns plain URL verbatim on fast path', () => {
    const template = 'https://example.com/search?q=shoes';
    assert.equal(resolveTargetUrl(template, { keyword: 'x' }), template);
  });

  it('substitutes a single string placeholder', () => {
    assert.equal(
      resolveTargetUrl('https://example.com/search?q={{keyword}}', { keyword: 'shoes' }),
      'https://example.com/search?q=shoes'
    );
  });

  it('URL-encodes spaces', () => {
    assert.equal(
      resolveTargetUrl('https://example.com/?q={{keyword}}', { keyword: 'hello world' }),
      'https://example.com/?q=hello%20world'
    );
  });

  it('URL-encodes special characters', () => {
    assert.equal(
      resolveTargetUrl('https://example.com/?q={{q}}', { q: 'a&b=c' }),
      'https://example.com/?q=a%26b%3Dc'
    );
  });

  it('substitutes multiple placeholders', () => {
    assert.equal(
      resolveTargetUrl(
        'https://example.com/search?q={{keyword}}&page={{pageNumber}}',
        { keyword: 'shoes', pageNumber: 3 }
      ),
      'https://example.com/search?q=shoes&page=3'
    );
  });

  it('substitutes repeated placeholders from a single lookup', () => {
    assert.equal(
      resolveTargetUrl('https://example.com/?q={{k}}&ref={{k}}', { k: 'abc' }),
      'https://example.com/?q=abc&ref=abc'
    );
  });

  it('joins array values with comma and encodes', () => {
    assert.equal(
      resolveTargetUrl('https://example.com/?ids={{ids}}', { ids: [1, 2, 3] }),
      'https://example.com/?ids=1%2C2%2C3'
    );
  });

  it('coerces numbers to encoded strings', () => {
    assert.equal(
      resolveTargetUrl('https://example.com/?n={{n}}', { n: 42 }),
      'https://example.com/?n=42'
    );
  });

  it('throws MISSING_URL_PARAM when value is missing', () => {
    assert.throws(
      () => resolveTargetUrl('https://example.com/?q={{missing}}', {}),
      (err) => err.code === 'MISSING_URL_PARAM' && err.paramName === 'missing'
    );
  });

  it('throws MISSING_URL_PARAM when value is null', () => {
    assert.throws(
      () => resolveTargetUrl('https://example.com/?q={{x}}', { x: null }),
      (err) => err.code === 'MISSING_URL_PARAM' && err.paramName === 'x'
    );
  });

  it('throws MISSING_URL_PARAM when value is undefined', () => {
    assert.throws(
      () => resolveTargetUrl('https://example.com/?q={{x}}', { x: undefined }),
      (err) => err.code === 'MISSING_URL_PARAM' && err.paramName === 'x'
    );
  });

  it('leaves invalid identifier patterns as literal text', () => {
    assert.equal(
      resolveTargetUrl('https://example.com/?q={{a-b}}', {}),
      'https://example.com/?q={{a-b}}'
    );
  });
});
