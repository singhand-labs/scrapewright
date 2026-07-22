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
    // Spec-literal LCP: the first segment differs in a stable attr (data-testid
    // value), so LCP is empty and no pattern is emitted. Falls back to per-
    // annotation lines downstream.
    assert.equal(r.patterns.length, 0);
  });
});

describe('deriveListPattern edge cases', () => {
  it('returns empty patterns for no annotations', () => {
    const r = deriveListPattern([]);
    assert.deepEqual(r.patterns, []);
    assert.deepEqual(r.clickInList, []);
    assert.equal(r.annotationCount, 0);
  });

  it('derives pattern from single annotation per field (no cross-item comparison)', () => {
    const annos = [
      { type: 'extract', outputField: 'posts.title', selector: 'div.post h2' },
      { type: 'extract', outputField: 'posts.body', selector: 'div.post p.body' },
    ];
    const r = deriveListPattern(annos);
    assert.equal(r.patterns.length, 1);
    assert.equal(r.patterns[0].container, 'div.post');
    assert.equal(r.patterns[0].fieldMap.title, 'h2');
    assert.equal(r.patterns[0].fieldMap.body, 'p.body');
  });

  it('strips iframe prefix before LCP, re-attaches on emit', () => {
    const annos = [
      { type: 'extract', outputField: 'posts.x', selector: 'iframe#f1::div[role="article"]:nth-of-type(1) a' },
      { type: 'extract', outputField: 'posts.x', selector: 'iframe#f1::div[role="article"]:nth-of-type(2) a' },
    ];
    const r = deriveListPattern(annos);
    assert.equal(r.patterns.length, 1);
    assert.ok(r.patterns[0].container.startsWith('iframe#f1::'));
    assert.ok(r.patterns[0].container.includes('div[role="article"]'));
  });

  it('derives expand click from purpose:expand annotations', () => {
    const annos = [
      { type: 'extract', outputField: 'posts.x', selector: 'div[role="article"] a' },
      { type: 'click', purpose: 'expand', selector: 'div[role="article"]:nth-of-type(1) button.expand' },
    ];
    const r = deriveListPattern(annos);
    assert.equal(r.clickInList.length, 1);
    assert.equal(r.clickInList[0].container, 'div[role="article"]');
    assert.equal(r.clickInList[0].subSelector, 'button.expand');
    assert.equal(r.clickInList[0].delayMs, 500);
  });

  it('bugx.log fixture: derives shared #mount_0_0_QS container from real annotations', () => {
    const annos = [
      { type: 'extract', outputField: 'posts.author', selector: '#mount_0_0_QS > div > div > div > div > div > div.x9f619.xjp7ctv > a[role="link"].xjbqb8w.xstzfhl.xt0psk2' },
      { type: 'extract', outputField: 'posts.content', selector: '#mount_0_0_QS > div > div > div > div > div > div[data-visualcompletion-rendering-role="story_message"].xyri2b > div.xpdmqnj' },
      { type: 'extract', outputField: 'posts.likes', selector: '#mount_0_0_QS > div > div > div > div > div > div[aria-label="赞"].xjbqb8w.xjqpnuy.xqeqjp1:nth-of-type(1)' },
      { type: 'extract', outputField: 'posts.comments', selector: '#mount_0_0_QS > div > div > div > div > div > div[role="button"][aria-label="发表评论"].xjbqb8w.xjqpnuy.xqeqjp1' },
    ];
    const r = deriveListPattern(annos);
    assert.equal(r.patterns.length, 1, 'emits a pattern');
    assert.equal(r.patterns[0].outputArray, 'posts');
    // The container is the LCP of all 4 selectors — 6 bare divs after #mount_0_0_QS.
    // (The LCP stops at the 7th segment because the four diverge: x9f619 vs story-rendering vs aria-label variants.)
    assert.equal(
      r.patterns[0].container,
      '#mount_0_0_QS > div > div > div > div > div',
      'LCP is the longest shared prefix'
    );
    // Field map should include all 4 fields with their post-LCP suffixes
    assert.ok(r.patterns[0].fieldMap.author, 'author field present');
    assert.ok(r.patterns[0].fieldMap.content, 'content field present');
    assert.ok(r.patterns[0].fieldMap.likes, 'likes field present');
    assert.ok(r.patterns[0].fieldMap.comments, 'comments field present');
  });
});
