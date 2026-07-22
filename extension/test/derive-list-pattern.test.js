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

describe('deriveListPattern grouping + LCP', () => {
  it('groups annotations by outputField dotted prefix', () => {
    const annos = [
      { type: 'extract', outputField: 'posts.author', selector: 'div[role="article"]:nth-of-type(1) a.author' },
      { type: 'extract', outputField: 'posts.content', selector: 'div[role="article"]:nth-of-type(1) div.content' },
      { type: 'extract', outputField: 'comments.text', selector: 'div.comment:nth-of-type(1) span.text' },
    ];
    const r = deriveListPattern(annos);
    assert.equal(r.patterns.length, 2);
    const posts = r.patterns.find(p => p.outputArray === 'posts');
    const comments = r.patterns.find(p => p.outputArray === 'comments');
    assert.ok(posts);
    assert.ok(comments);
  });

  it('derives container as LCP with nth-of-type stripped', () => {
    const annos = [
      { type: 'extract', outputField: 'posts.author', selector: 'div[role="article"]:nth-of-type(1) a' },
      { type: 'extract', outputField: 'posts.author', selector: 'div[role="article"]:nth-of-type(2) a' },
    ];
    const r = deriveListPattern(annos);
    assert.equal(r.patterns[0].container, 'div[role="article"]');
  });

  it('drops annotations without dotted outputField into _flat (no pattern)', () => {
    const annos = [
      { type: 'extract', outputField: 'title', selector: 'h1' },
    ];
    const r = deriveListPattern(annos);
    assert.equal(r.patterns.length, 0);
    assert.equal(r.annotationCount, 1);
  });

  it('emits no pattern when LCP is ambiguous (different stable attrs)', () => {
    const annos = [
      { type: 'extract', outputField: 'posts.author', selector: 'div[role="article"][data-testid="A"] a' },
      { type: 'extract', outputField: 'posts.author', selector: 'div[role="article"][data-testid="B"] a' },
    ];
    const r = deriveListPattern(annos);
    // LCP includes div[role="article"] (stable across both); data-testid differs so stripped.
    // We still get a pattern, but the container is just div[role="article"].
    assert.equal(r.patterns.length, 1);
    assert.equal(r.patterns[0].container, 'div[role="article"]');
  });
});
