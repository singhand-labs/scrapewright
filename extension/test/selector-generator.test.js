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

  it('skips base36 Facebook-style classes (xjp7ctv, xjbqb8w)', () => {
    // Real Facebook classes use base36 hashes, not hex — this was a regression that
    // caused selectors to bloat with auto-gen classes and break LCP-based pattern derivation.
    const el = document.createElement('a');
    el.className = 'xjp7ctv xjbqb8w xpdmqnj xyri2b';
    assert.equal(buildSegment(el), 'a');
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

const { generateSelector } = require('../lib/selector-generator');

describe('generateSelector', () => {
  it('returns "body" for null input', () => {
    assert.equal(generateSelector(null, document), 'body');
  });

  it('returns "body" for detached element with no ownerDoc', () => {
    setupDOM('<!DOCTYPE html><html><body><div id="x"></div></body></html>');
    const el = document.createElement('span');
    assert.equal(generateSelector(el, document), 'span');
  });

  it('returns "#id" when element has an id', () => {
    setupDOM('<!DOCTYPE html><html><body><div id="main"></div></body></html>');
    const el = document.getElementById('main');
    assert.equal(generateSelector(el, document), '#main');
  });

  it('returns short stable selector when role uniquely identifies', () => {
    setupDOM(
      '<!DOCTYPE html><html><body>' +
      '<main><div role="article"></div></main>' +
      '</body></html>'
    );
    const el = document.querySelector('div[role="article"]');
    assert.equal(generateSelector(el, document), 'div[role="article"]');
  });

  it('appends leaf :nth-of-type when siblings share stable attrs', () => {
    setupDOM(
      '<!DOCTYPE html><html><body>' +
      '<div role="article"></div>' +
      '<div role="article"></div>' +
      '<div role="article"></div>' +
      '</body></html>'
    );
    // Click on the 3rd article. Siblings share identical stable attrs
    // (role="article"), so the only way to disambiguate is positional
    // :nth-of-type on the leaf.
    const articles = document.querySelectorAll('div[role="article"]');
    const target = articles[2];
    const sel = generateSelector(target, document);
    assert.ok(sel.includes('nth-of-type(3)'), `expected nth-of-type(3) in "${sel}"`);
    assert.ok(sel.includes('role="article"'), `expected role attr in "${sel}"`);
    // Should NOT contain a long chain of nth-of-type segments.
    const nthCount = (sel.match(/:nth-of-type/g) || []).length;
    assert.equal(nthCount, 1, `expected exactly 1 nth-of-type, got ${nthCount} in "${sel}"`);
  });

  it('walks up to find uniqueness when leaf is ambiguous', () => {
    setupDOM(
      '<!DOCTYPE html><html><body>' +
      '<section id="posts"><div role="row"></div><div role="row"></div></section>' +
      '<section id="comments"><div role="row"></div></section>' +
      '</body></html>'
    );
    // First row in #posts — ambiguous at leaf, but section#posts disambiguates.
    const target = document.querySelectorAll('#posts div[role="row"]')[0];
    const sel = generateSelector(target, document);
    assert.ok(sel.includes('#posts'), `expected #posts in "${sel}"`);
    assert.ok(sel.includes('role="row"'), `expected role=row in "${sel}"`);
  });

  it('produces no chain for top-level unique element', () => {
    setupDOM(
      '<!DOCTYPE html><html><body>' +
      '<button aria-label="Like"></button>' +
      '</body></html>'
    );
    const el = document.querySelector('button[aria-label]');
    const sel = generateSelector(el, document);
    assert.equal(sel, 'button[aria-label="Like"]');
  });

  it('does not emit auto-generated className in the chain', () => {
    setupDOM(
      '<!DOCTYPE html><html><body>' +
      '<div class="x9f619 x1n2onr6"><span class="xeuugli">hi</span></div>' +
      '</body></html>'
    );
    const el = document.querySelector('span');
    const sel = generateSelector(el, document);
    assert.ok(!/\.x[0-9a-f]+/i.test(sel), `should not contain auto-gen class in "${sel}"`);
    assert.ok(sel.startsWith('span'), `should start with tag in "${sel}"`);
  });
});
