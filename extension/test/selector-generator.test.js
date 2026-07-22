const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { buildSegment } = require('../lib/selector-generator');

function setupDOM(html) {
  const dom = new JSDOM(html, { url: 'https://example.com/page' });
  global.document = dom.window.document;
  global.window = dom.window;
  global.Node = dom.window.Node;
  global.CSS = dom.window.CSS;
  return dom;
}

describe('buildSegment', () => {
  beforeEach(() => {
    setupDOM('<!DOCTYPE html><html><body></body></html>');
  });

  it('returns "#id" when element has an id', () => {
    const el = document.createElement('div');
    el.id = 'main';
    assert.equal(buildSegment(el), '#main');
  });

  it('returns tag + [role] when no id but role present', () => {
    const el = document.createElement('div');
    el.setAttribute('role', 'article');
    assert.equal(buildSegment(el), 'div[role="article"]');
  });

  it('returns tag + [aria-posinset="N"] when present', () => {
    const el = document.createElement('div');
    el.setAttribute('aria-posinset', '2');
    assert.equal(buildSegment(el), 'div[aria-posinset="2"]');
  });

  it('skips auto-generated React className (x-prefix hash)', () => {
    const el = document.createElement('div');
    el.className = 'x9f619 x1n2onr6';
    assert.equal(buildSegment(el), 'div');
  });

  it('skips html-* and _-prefix classes', () => {
    const el = document.createElement('h3');
    el.className = 'html-h3 _a58j';
    assert.equal(buildSegment(el), 'h3');
  });

  it('keeps semantic className (no auto-gen pattern)', () => {
    const el = document.createElement('div');
    el.className = 'post-card featured';
    assert.equal(buildSegment(el), 'div.post-card.featured');
  });

  it('returns bare tag when nothing else available', () => {
    const el = document.createElement('span');
    assert.equal(buildSegment(el), 'span');
  });

  it('stacks multiple stable attributes', () => {
    const el = document.createElement('div');
    el.setAttribute('role', 'article');
    el.setAttribute('aria-posinset', '3');
    el.setAttribute('data-testid', 'post');
    assert.equal(
      buildSegment(el),
      'div[role="article"][aria-posinset="3"][data-testid="post"]'
    );
  });

  it('escapes quotes in attribute values', () => {
    const el = document.createElement('div');
    el.setAttribute('aria-label', 'she said "hi"');
    // CSS.escape wraps in quotes and escapes inner quotes
    const result = buildSegment(el);
    assert.ok(result.startsWith('div[aria-label='), 'should start with attr name');
    assert.ok(result.includes('she said'), 'should contain the value');
  });
});
