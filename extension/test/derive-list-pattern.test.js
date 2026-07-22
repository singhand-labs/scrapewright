const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseSelectorSegments, deriveListPattern } = require('../lib/list-pattern');

describe('parseSelectorSegments', () => {
  it('splits a simple compound selector into segments', () => {
    const segs = parseSelectorSegments('div[role="article"]:nth-of-type(1) > a[role="link"] span');
    assert.equal(segs.length, 3);
    assert.equal(segs[0], 'div[role="article"]:nth-of-type(1)');
    assert.equal(segs[1], 'a[role="link"]');
    assert.equal(segs[2], 'span');
  });

  it('preserves iframe prefix as a single segment marker', () => {
    const segs = parseSelectorSegments('iframe#f1::div[role="article"]:nth-of-type(1) a');
    // Per plan Step 1.12: the `::` is part of the first segment, so the iframe
    // prefix stays glued to the immediately-following compound. That yields
    // 2 segments: [iframe#f1::div[role="article"]:nth-of-type(1), a].
    assert.equal(segs.length, 2);
    assert.equal(segs[0], 'iframe#f1::div[role="article"]:nth-of-type(1)');
    assert.equal(segs[1], 'a');
  });
});
