const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// dom-cleaner.js uses DOMParser (browser-only). In Node tests we require jsdom.
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.DOMParser = dom.window.DOMParser;
global.NodeFilter = dom.window.NodeFilter;
global.document = dom.window.document;
global.window = dom.window;

const DomCleaner = require('../lib/dom-cleaner.js');

describe('truncateLongTextInNodes (via cleanPageHtml)', () => {
  it('truncates long prose but preserves the enclosing element', () => {
    const longText = 'A'.repeat(500);
    const html = `<div><p>${longText}</p></div>`;
    const cleaned = DomCleaner.cleanPageHtml(html);
    // The <p> element must survive (structure preserved)
    assert.match(cleaned, /<p>/);
    // The text must be shortened — not the full 500 chars
    assert.ok(!cleaned.includes(longText), 'long prose must be truncated');
    // And end with the truncation marker
    assert.match(cleaned, /\.\.\.<\/p>/);
  });

  it('preserves short text verbatim (titles, labels)', () => {
    const html = `<div><h2>Short Title</h2><button>Click me</button></div>`;
    const cleaned = DomCleaner.cleanPageHtml(html);
    assert.match(cleaned, /Short Title/);
    assert.match(cleaned, /Click me/);
    assert.ok(!cleaned.includes('...'));
  });

  it('preserves date-like text regardless of length', () => {
    const html = `<div><span>2026-08-03T12:34:56.789Z</span></div>`;
    const cleaned = DomCleaner.cleanPageHtml(html);
    assert.match(cleaned, /2026-08-03T12:34:56\.789Z/);
  });

  it('preserves price-like text regardless of length', () => {
    const html = `<div><span>USD 1,234,567.89</span></div>`;
    const cleaned = DomCleaner.cleanPageHtml(html);
    assert.match(cleaned, /USD 1,234,567\.89/);
  });

  it('preserves relative-time text (English)', () => {
    const html = `<div><time>3 days ago</time></div>`;
    const cleaned = DomCleaner.cleanPageHtml(html);
    assert.match(cleaned, /3 days ago/);
    assert.ok(!cleaned.includes('...'));
  });
});
