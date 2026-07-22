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
});
