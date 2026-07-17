const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  filterClasses,
  truncateText,
  shouldRemoveTag,
  buildIframePrefix,
} = require('../lib/dom-cleaner');

function setupJSDOM(html) {
  const dom = new JSDOM(html, { url: 'https://example.com/page' });
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  global.window = dom.window;
  global.DOMParser = dom.window.DOMParser;
  global.NodeFilter = dom.window.NodeFilter;
  global.CSS = dom.window.CSS;
  return dom;
}

describe('filterClasses', () => {
  it('drops Angular and Vue scoped markers', () => {
    assert.equal(filterClasses('_ngcontent-abc foo bar'), 'foo bar');
    assert.equal(filterClasses('_nghost-xyz main-content'), 'main-content');
    assert.equal(filterClasses('data-v-abc123 btn'), 'btn');
  });

  it('drops emotion and styled-components hashes', () => {
    assert.equal(filterClasses('css-1abc23 ant-btn'), 'ant-btn');
    assert.equal(filterClasses('sc-abc123 primary'), 'primary');
    assert.equal(filterClasses('styled-xyz hover-state'), 'hover-state');
  });

  it('drops pure hash tokens', () => {
    assert.equal(filterClasses('abc123 def455 button'), 'button');
    assert.equal(filterClasses('_9a3b2c'), '');
  });

  it('preserves semantic classes including Tailwind utilities', () => {
    assert.equal(filterClasses('btn btn-primary'), 'btn btn-primary');
    assert.equal(filterClasses('flex p-4 text-sm'), 'flex p-4 text-sm');
    assert.equal(filterClasses('ant-btn ant-input'), 'ant-btn ant-input');
    assert.equal(filterClasses('chakra-stack product-card'), 'chakra-stack product-card');
  });

  it('returns empty string for empty input', () => {
    assert.equal(filterClasses(''), '');
    assert.equal(filterClasses(null), '');
    assert.equal(filterClasses(undefined), '');
  });
});

describe('truncateText', () => {
  const { truncateText } = require('../lib/dom-cleaner');

  it('preserves text under 60 chars unchanged', () => {
    assert.equal(truncateText('short text'), 'short text');
    assert.equal(truncateText('a'.repeat(60)), 'a'.repeat(60));
  });

  it('preserves prices and numbers regardless of length', () => {
    assert.equal(truncateText('¥1,234.56'), '¥1,234.56');
    assert.equal(truncateText('$9,999,999.99'), '$9,999,999.99');
  });

  it('preserves ISO and slash dates', () => {
    assert.equal(truncateText('2026-07-17'), '2026-07-17');
    assert.equal(truncateText('07/17/2026'), '07/17/2026');
  });

  it('preserves ALL-CAPS codes and identifier-like tokens', () => {
    assert.equal(truncateText('INV-2024-001'), 'INV-2024-001');
    assert.equal(truncateText('ORDER_12345'), 'ORDER_12345');
  });

  it('truncates long prose to 60 chars with ellipsis', () => {
    const prose = 'This is a paragraph of marketing copy that goes on for many words and exceeds the threshold';
    const out = truncateText(prose);
    assert.equal(out.length, 63); // 60 + '...'
    assert.ok(out.endsWith('...'));
    assert.equal(out.startsWith(prose.slice(0, 60)), true);
  });
});

describe('shouldRemoveTag', () => {
  const { shouldRemoveTag } = require('../lib/dom-cleaner');

  it('returns true for script/style/media tags', () => {
    ['script', 'style', 'link', 'img', 'video', 'audio', 'canvas', 'svg',
     'noscript', 'template', 'meta', 'path', 'g', 'defs', 'use'
    ].forEach(tag => assert.equal(shouldRemoveTag(tag), true, tag));
  });

  it('returns false for content tags', () => {
    ['div', 'span', 'p', 'a', 'button', 'input', 'table', 'ul', 'iframe']
      .forEach(tag => assert.equal(shouldRemoveTag(tag), false, tag));
  });
});

describe('buildIframePrefix', () => {
  const { buildIframePrefix } = require('../lib/dom-cleaner');

  it('prefers id selector', () => {
    setupJSDOM(`<html><body><iframe id="zbggframe1"></iframe></body></html>`);
    const iframe = document.getElementById('zbggframe1');
    assert.equal(buildIframePrefix(iframe), 'iframe#zbggframe1::');
  });

  it('falls back to name when id is absent', () => {
    setupJSDOM(`<html><body><iframe name="content"></iframe></body></html>`);
    const iframe = document.querySelector('iframe[name="content"]');
    assert.equal(buildIframePrefix(iframe), 'iframe[name="content"]::');
  });

  it('falls back to nth-of-type when neither id nor name', () => {
    setupJSDOM(`<html><body><iframe></iframe><iframe></iframe></body></html>`);
    const iframes = document.querySelectorAll('iframe');
    assert.equal(buildIframePrefix(iframes[0]), 'iframe:nth-of-type(1)::');
    assert.equal(buildIframePrefix(iframes[1]), 'iframe:nth-of-type(2)::');
  });
});
