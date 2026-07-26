const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { extractListRecords, clickInListItems, extractListMultiRecords } = require('../lib/list-extract-ops');

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

  // Regression for console.log 2026-07-26 RC5: outerHTML/innerHTML are DOM
  // properties, not HTML attributes — getAttribute returns null. The single-
  // match path must read DOM properties when attr names one of them.
  it('reads outerHTML DOM property (not getAttribute) for raw HTML', () => {
    document.body.innerHTML = `<div class="post"><p class="body">Hi</p></div>`;
    const containers = Array.from(document.querySelectorAll('.post'));
    const records = extractListRecords(containers, {
      body: { selector: '.body', attr: 'outerHTML' }
    });
    assert.equal(records.length, 1);
    assert.match(records[0].body, /^<p class="body">Hi<\/p>$/);
  });

  it('reads innerHTML DOM property for raw inner HTML', () => {
    document.body.innerHTML = `<div class="post"><div class="wrap"><span>x</span></div></div>`;
    const containers = Array.from(document.querySelectorAll('.post'));
    const records = extractListRecords(containers, {
      inner: { selector: '.wrap', attr: 'innerHTML' }
    });
    assert.equal(records.length, 1);
    assert.match(records[0].inner, /^<span>x<\/span>$/);
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

// Regression for console.log 2026-07-26: $extractList's readField uses
// container.querySelector(sel) — returns FIRST match only. The LLM cannot
// express "the 2nd a[role=link] in this container" or "the a[role=link]
// whose aria-label matches a date pattern" — needed to disambiguate
// Facebook's author link (1st a[role=link]) from the timestamp link (2nd).
// Without this primitive, the LLM produced brittle sibling selectors that
// matched neither, leaving publishTime empty across every iteration.
describe('extractListMultiRecords', () => {
  beforeEach(() => {
    setupDOM('<!DOCTYPE html><html><body></body></html>');
  });

  it('returns ALL matches per field per container as arrays', () => {
    // Facebook-shaped DOM: each post has two a[role=link] elements — first is
    // the author, second is the timestamp. $extractList picks first only;
    // $extractListMulti must return both so the LLM can disambiguate in JS.
    document.body.innerHTML = `
      <div class="post">
        <a role="link" aria-label="Alice">Alice</a>
        <a role="link" aria-label="2026年7月7日">7月7日</a>
      </div>
      <div class="post">
        <a role="link" aria-label="Bob">Bob</a>
        <a role="link" aria-label="2天">2天</a>
      </div>
    `;
    const containers = Array.from(document.querySelectorAll('.post'));
    const records = extractListMultiRecords(containers, { links: 'a[role="link"]' });
    assert.equal(records.length, 2);
    assert.deepEqual(records[0].links, ['Alice', '7月7日']);
    assert.deepEqual(records[1].links, ['Bob', '2天']);
  });

  it('returns empty array for fields with no matches (not undefined)', () => {
    document.body.innerHTML = `<div class="post"><a>Alice</a></div>`;
    const containers = Array.from(document.querySelectorAll('.post'));
    const records = extractListMultiRecords(containers, {
      links: 'a',
      missing: '.nope'
    });
    assert.deepEqual(records[0].links, ['Alice']);
    assert.deepEqual(records[0].missing, []);
  });

  it('supports { selector, attr } spec form', () => {
    document.body.innerHTML = `
      <div class="post">
        <a href="/u/alice">Alice</a>
        <a href="/posts/123">7月7日</a>
      </div>
    `;
    const containers = Array.from(document.querySelectorAll('.post'));
    const records = extractListMultiRecords(containers, {
      hrefs: { selector: 'a', attr: 'href' }
    });
    assert.deepEqual(records[0].hrefs, ['/u/alice', '/posts/123']);
  });

  it('throws on empty containers without allowEmpty', () => {
    assert.throws(() => extractListMultiRecords([], { a: '.a' }), /no containers matched/);
  });

  it('returns [] when allowEmpty is true and containers empty', () => {
    assert.deepEqual(extractListMultiRecords([], { a: '.a' }, { allowEmpty: true }), []);
  });

  it('supports outerHTML property read for raw-HTML extraction', () => {
    document.body.innerHTML = `<div class="post"><p>Hello</p></div>`;
    const containers = Array.from(document.querySelectorAll('.post'));
    const records = extractListMultiRecords(containers, {
      html: { selector: 'p', attr: 'outerHTML' }
    });
    assert.equal(records.length, 1);
    assert.match(records[0].html[0], /^<p>Hello<\/p>$/);
  });

  it('empty selector returns the container itself (for per-container outerHTML)', () => {
    document.body.innerHTML = `<div class="post"><p>Hello</p></div><div class="post"><p>World</p></div>`;
    const containers = Array.from(document.querySelectorAll('.post'));
    const records = extractListMultiRecords(containers, {
      html: { selector: '', attr: 'outerHTML' }
    });
    assert.equal(records.length, 2);
    assert.match(records[0].html[0], /^<div class="post"><p>Hello<\/p><\/div>$/);
    assert.match(records[1].html[0], /^<div class="post"><p>World<\/p><\/div>$/);
  });
});
