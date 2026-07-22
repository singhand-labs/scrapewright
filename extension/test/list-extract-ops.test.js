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

  it('re-throws invalid sub-selector with the field name in the message', () => {
    document.body.innerHTML = `<div class="post"><span class="author">Alice</span></div>`;
    const containers = Array.from(document.querySelectorAll('.post'));
    assert.throws(
      () => extractListRecords(containers, { author: '<<<invalid>>>' }),
      /field "author"/
    );
  });
});

describe('clickInListItems', () => {
  beforeEach(() => {
    setupDOM('<!DOCTYPE html><html><body></body></html>');
  });

  it('returns {clicked:0, errors:[]} for empty containers (NOT a throw)', () => {
    const r = clickInListItems([], '.expand', () => {}, 0);
    assert.equal(r.clicked, 0);
    assert.deepEqual(r.errors, []);
    assert.equal(r.delayMs, 0);
  });

  it('clicks subSel in every container', () => {
    document.body.innerHTML = `
      <div class="post"><button class="expand">+</button></div>
      <div class="post"><button class="expand">+</button></div>
    `;
    const containers = Array.from(document.querySelectorAll('.post'));
    const clicked = [];
    const r = clickInListItems(containers, '.expand', (el) => clicked.push(el.textContent), 0);
    assert.equal(r.clicked, 2);
    assert.equal(r.errors.length, 0);
    assert.equal(clicked.length, 2);
  });

  it('returns partial errors when subSel missing in some containers', () => {
    document.body.innerHTML = `
      <div class="post"><button class="expand">+</button></div>
      <div class="post"></div>
    `;
    const containers = Array.from(document.querySelectorAll('.post'));
    const r = clickInListItems(containers, '.expand', () => {}, 0);
    assert.equal(r.clicked, 1);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].index, 1);
    assert.match(r.errors[0].reason, /not found/);
  });

  it('clamps delayMs to [0, 5000]', () => {
    document.body.innerHTML = `<div><button>x</button></div>`;
    const containers = [document.querySelector('div')];
    const r1 = clickInListItems(containers, 'button', () => {}, -100);
    const r2 = clickInListItems(containers, 'button', () => {}, 99999);
    assert.equal(r1.delayMs, 0);
    assert.equal(r2.delayMs, 5000);
  });

  it('defaults delayMs to 500 when not provided', () => {
    document.body.innerHTML = `<div><button>x</button></div>`;
    const containers = [document.querySelector('div')];
    const r = clickInListItems(containers, 'button', () => {});
    assert.equal(r.delayMs, 500);
  });

  it('records exception in clickFn as error, continues', () => {
    document.body.innerHTML = `
      <div><button>a</button></div>
      <div><button>b</button></div>
    `;
    const containers = Array.from(document.querySelectorAll('div'));
    const r = clickInListItems(containers, 'button', () => { throw new Error('boom'); }, 0);
    assert.equal(r.clicked, 0);
    assert.equal(r.errors.length, 2);
    assert.match(r.errors[0].reason, /boom/);
  });
});
