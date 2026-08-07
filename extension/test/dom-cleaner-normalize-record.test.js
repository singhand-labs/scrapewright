const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.DOMParser = dom.window.DOMParser;
global.NodeFilter = dom.window.NodeFilter;
global.Node = dom.window.Node;

const { normalizeRecordStructure } = require('../lib/dom-cleaner');

test('collapses chain of single-child no-attribute wrapper divs', () => {
  const input = '<div><div><div><span>X</span></div></div></div>';
  const out = normalizeRecordStructure(input);
  assert.strictEqual(out, '<span>X</span>');
});

test('preserves multi-child container', () => {
  const input = '<div><span>A</span><span>B</span></div>';
  const out = normalizeRecordStructure(input);
  assert.strictEqual(out, input);
});

test('preserves element with class attribute', () => {
  const input = '<div class="keep"><span>A</span></div>';
  const out = normalizeRecordStructure(input);
  assert.strictEqual(out, input);
});

test('preserves element with id attribute', () => {
  const input = '<div id="main"><span>A</span></div>';
  const out = normalizeRecordStructure(input);
  assert.strictEqual(out, input);
});

test('preserves element with role attribute', () => {
  const input = '<div role="row"><span>A</span></div>';
  const out = normalizeRecordStructure(input);
  assert.strictEqual(out, input);
});

test('preserves element with data-* attribute', () => {
  const input = '<div data-id="42"><span>A</span></div>';
  const out = normalizeRecordStructure(input);
  assert.strictEqual(out, input);
});

test('mixed: outer collapses, inner with class preserves', () => {
  const input = '<div><div class="keep"><span>A</span></div></div>';
  const out = normalizeRecordStructure(input);
  assert.strictEqual(out, '<div class="keep"><span>A</span></div>');
});

test('idempotent: running twice equals running once', () => {
  const input = '<div><div><span>A</span><span>B</span></div></div>';
  // outer div has 1 child (inner div), inner div has 2 spans → inner preserved.
  // Outer collapses to inner div. Running again: inner div has 2 children, no collapse.
  const once = normalizeRecordStructure(input);
  const twice = normalizeRecordStructure(once);
  assert.strictEqual(once, twice);
});

test('does not collapse into script/style/template', () => {
  const input = '<div><script>var x;</script></div>';
  const out = normalizeRecordStructure(input);
  // Script is opaque — outer div stays.
  assert.ok(out.includes('<script>'));
  assert.ok(out.startsWith('<div>'));
});
