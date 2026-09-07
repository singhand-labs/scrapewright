// Thirty-third log D2: v2 shipped postingTime = "eporntosdS9u77m62gllh0i16i81a1l5gcf7hg2taf545h7tcu9c32mt5i9c"
// — the anti-scrape decoy textContent read raw. detectJunkValues only knew
// queryBlob/dataUri/markupDump, so the decoy counted as a VALID non-empty
// value: REQUIRED_FIELD_EMPTY reported "1/2 empty" (the junk record passed)
// and no junk flag pushed the model toward the ARIA-reference resolution.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectJunkValues } = require('../lib/verify-runner');

const DECOY = 'eporntosdS9u77m62gllh0i16i81a1l5gcf7hg2taf545h7tcu9c32mt5i9c';

describe('detectJunkValues opaqueToken kind (anti-scrape decoy textContent)', () => {
  it('flags the live-log decoy blob in a human-readable field', () => {
    const data = { posts: [
      { postingTime: DECOY, content: 'real text here' },
      { postingTime: DECOY, content: 'more text' }
    ] };
    const r = detectJunkValues(data, { type: 'object' });
    assert.ok(r, 'detector fires');
    const f = r.fields.find((x) => x.kind === 'opaqueToken');
    assert.ok(f, 'opaqueToken entry present: ' + JSON.stringify(r.fields));
    assert.equal(f.field, 'posts.postingTime');
    assert.equal(f.count, 2);
    assert.ok(/anti-scrape|decoy/i.test(r.note), 'note explains the decoy mechanism');
    assert.ok(/labelledby/i.test(r.note), 'note points at the ARIA-reference resolution');
  });

  it('does not flag short tokens, sentences, URLs, or spaced text', () => {
    const data = { posts: [
      { postingTime: 'June 25 at 3:42 PM', videoId: 'dQw4w9WgXcQ', serialNumber: '7',
        postHref: 'https://example.com/watch?v=abc_DEF-123', content: '2nd Amendment March 2026 Was A Great Day Overall' }
    ] };
    const r = detectJunkValues(data, { type: 'object' });
    const opaque = r ? r.fields.filter((x) => x.kind === 'opaqueToken') : [];
    assert.deepEqual(opaque, [], 'no opaqueToken false positives');
  });

  it('does not flag id/hash/token-named fields carrying legit opaque ids', () => {
    const data = { posts: [
      { checksum: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', trackingToken: 'AsDfGhJkLqWeRtYuIoPzXcVbNm1234567890', ref: 'iVy7UQ9sKzM2wLpQ4rNtE8bX1cD6fG0hJoA5' }
    ] };
    const r = detectJunkValues(data, { type: 'object' });
    const opaque = r ? r.fields.filter((x) => x.kind === 'opaqueToken') : [];
    assert.deepEqual(opaque, [], 'name guard keeps legit opaque ids unflagged');
  });

  it('mixed-case-and-digits English-like long words with normal vowel density are not flagged', () => {
    const data = { posts: [
      { title: 'MisunderstandingsAreCommonplaceThroughoutInternationalOrganizations' }
    ] };
    const r = detectJunkValues(data, { type: 'object' });
    const opaque = r ? r.fields.filter((x) => x.kind === 'opaqueToken') : [];
    assert.deepEqual(opaque, [], 'high vowel density → real word, not junk');
  });

  it('schema hints extend the name guard (url-ish fields stay unflagged)', () => {
    const data = { posts: [{ mediaUrl: DECOY }] };
    const schema = { type: 'object', properties: { posts: { type: 'array', items: { type: 'object', properties: { mediaUrl: { type: 'string' } } } } } };
    const r = detectJunkValues(data, schema);
    const opaque = r ? r.fields.filter((x) => x.kind === 'opaqueToken') : [];
    assert.deepEqual(opaque, [], 'url-named fields are not opaqueToken targets');
  });
});
