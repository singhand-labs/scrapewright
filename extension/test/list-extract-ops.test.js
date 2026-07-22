const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { extractListRecords, clickInListItems } = require('../lib/list-extract-ops');

function setupDOM(html) {
  const dom = new JSDOM(html, { url: 'https://example.com/page' });
  global.document = dom.window.document;
  global.window = dom.window;
  global.Node = dom.window.Node;
  return dom;
}

describe('extractListRecords', () => {
  beforeEach(() => {
    setupDOM('<!DOCTYPE html><html><body></body></html>');
  });

  it('returns aligned records when all fields present', () => {
    document.body.innerHTML = `
      <div class="post"><span class="author">Alice</span><p class="body">Hi</p></div>
      <div class="post"><span class="author">Bob</span><p class="body">Yo</p></div>
    `;
    const containers = Array.from(document.querySelectorAll('.post'));
    const records = extractListRecords(containers, { author: '.author', body: '.body' });
    assert.equal(records.length, 2);
    assert.equal(records[0].author, 'Alice');
    assert.equal(records[0].body, 'Hi');
    assert.equal(records[1].author, 'Bob');
    assert.equal(records[1].body, 'Yo');
  });

  it('throws on empty container list by default', () => {
    assert.throws(() => extractListRecords([], { a: '.a' }), /no containers matched/);
  });

  it('returns [] when allowEmpty is true and containers empty', () => {
    assert.deepEqual(extractListRecords([], { a: '.a' }, { allowEmpty: true }), []);
  });

  it('keeps field alignment when a field is missing on one item', () => {
    document.body.innerHTML = `
      <div class="post"><span class="author">Alice</span><p class="body">Hi</p></div>
      <div class="post"><p class="body">Yo</p></div>
    `;
    const containers = Array.from(document.querySelectorAll('.post'));
    const records = extractListRecords(containers, { author: '.author', body: '.body' });
    assert.equal(records[0].author, 'Alice');
    assert.equal(records[0].body, 'Hi');
    assert.equal(records[1].author, undefined);
    assert.equal(records[1].body, 'Yo');
  });

  it('supports attr form for href extraction', () => {
    document.body.innerHTML = `<div class="post"><a href="/p/1">link</a></div>`;
    const containers = Array.from(document.querySelectorAll('.post'));
    const records = extractListRecords(containers, { url: { selector: 'a', attr: 'href' } });
    assert.equal(records[0].url, '/p/1');
  });

  it('throws when fieldMap is empty', () => {
    assert.throws(() => extractListRecords([{}], {}), /non-empty object/);
  });
});
