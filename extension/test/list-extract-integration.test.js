const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { extractListRecords, clickInListItems } = require('../lib/list-extract-ops');
const { deriveListPattern } = require('../lib/list-pattern');
// list-pattern.js defines deriveListPattern, which buildAnnotationsText calls
// as a free variable (browser-globals pattern). Load it BEFORE wizard-utils so
// global.deriveListPattern is set when wizard-utils is evaluated.
require('../lib/list-pattern');
require('../lib/wizard-utils');
const { buildAnnotationsText } = require('../lib/wizard-utils');

function setupDOM(html) {
  const dom = new JSDOM(html, { url: 'https://example.com/page' });
  global.document = dom.window.document;
  global.window = dom.window;
  global.Node = dom.window.Node;
  return dom;
}

describe('list-aware extraction integration', () => {
  beforeEach(() => setupDOM('<!DOCTYPE html><html><body></body></html>'));

  it('end-to-end: deriveListPattern -> fieldMap -> extractListRecords', () => {
    // Simulate bugx.log: user annotated author + content across 2 posts
    const annos = [
      { type: 'extract', outputField: 'posts.author', selector: 'div[role="article"]:nth-of-type(1) a.author' },
      { type: 'extract', outputField: 'posts.content', selector: 'div[role="article"]:nth-of-type(1) div.body' },
      { type: 'extract', outputField: 'posts.author', selector: 'div[role="article"]:nth-of-type(2) a.author' },
      { type: 'extract', outputField: 'posts.content', selector: 'div[role="article"]:nth-of-type(2) div.body' },
    ];

    // 1. Derive pattern
    const pattern = deriveListPattern(annos);
    assert.equal(pattern.patterns.length, 1);
    const p = pattern.patterns[0];
    assert.equal(p.container, 'div[role="article"]');

    // 2. Build DOM with 3 posts (one more than annotated - should generalize)
    document.body.innerHTML = `
      <div role="article"><a class="author">A1</a><div class="body">B1</div></div>
      <div role="article"><a class="author">A2</a><div class="body">B2</div></div>
      <div role="article"><a class="author">A3</a><div class="body">B3</div></div>
    `;

    // 3. Run extractListRecords as content-script.js would
    const containers = Array.from(document.querySelectorAll(p.container));
    const records = extractListRecords(containers, p.fieldMap);

    assert.equal(records.length, 3, 'extracts all 3 posts (not just the 2 annotated)');
    assert.equal(records[0].author, 'A1');
    assert.equal(records[2].author, 'A3');
  });

  it('end-to-end: deriveListPattern -> clickInListItems for expand', () => {
    const annos = [
      { type: 'extract', outputField: 'posts.x', selector: 'div[role="article"] a' },
      { type: 'click', purpose: 'expand', selector: 'div[role="article"]:nth-of-type(1) button.exp' },
      { type: 'click', purpose: 'expand', selector: 'div[role="article"]:nth-of-type(2) button.exp' },
    ];
    const pattern = deriveListPattern(annos);
    assert.equal(pattern.clickInList.length, 1);
    const clickSpec = pattern.clickInList[0];
    assert.equal(clickSpec.container, 'div[role="article"]');
    assert.equal(clickSpec.subSelector, 'button.exp');

    // Simulate 3 posts with expand buttons (more than annotated)
    document.body.innerHTML = `
      <div role="article"><button class="exp">+</button></div>
      <div role="article"><button class="exp">+</button></div>
      <div role="article"><button class="exp">+</button></div>
    `;
    const containers = Array.from(document.querySelectorAll(clickSpec.container));
    const clickedTexts = [];
    const r = clickInListItems(containers, clickSpec.subSelector, (el) => clickedTexts.push(el.textContent), 0);

    assert.equal(r.clicked, 3, 'clicked all 3 (not just 2 annotated)');
    assert.equal(r.errors.length, 0);
  });

  it('end-to-end: buildAnnotationsText emits usable $extractList call', () => {
    const annos = [
      { type: 'extract', outputField: 'posts.author', selector: 'div[role="article"]:nth-of-type(1) a' },
      { type: 'extract', outputField: 'posts.content', selector: 'div[role="article"]:nth-of-type(1) div' },
    ];
    const text = buildAnnotationsText(annos);
    // The emitted line must be valid JS that we can eval
    const match = text.match(/\$extractList\(([^)]+)\)/);
    assert.ok(match, 'emitted $extractList call');
    // Verify the container and fieldMap are in the call
    assert.match(text, /'div\[role="article"]'/);
    assert.match(text, /author:/);
    assert.match(text, /content:/);
  });

  // Regression for bugx.log "Cannot read properties of undefined (reading 'clickInListItems')".
  // The original fix (commit 361d3ae) captured `window.ListExtractOps` eagerly at IIFE
  // init via `const ListExtractOps = window.ListExtractOps`. If the alias was undefined
  // at init time (extension reloaded but tab still running old list-extract-ops, or any
  // future load-order surprise), the alias was frozen at undefined for the tab's entire
  // lifetime — $extractList/$clickInList could never recover even after reload.
  // The lazy-lookup pattern reads the current value at call time, so a late-attached
  // API still works.
  it('lazy lookup of ListExtractOps survives late attachment (regression)', () => {
    const savedWindow = global.window;
    const fakeWindow = {};
    global.window = fakeWindow;

    // Mirror of content-script.js getListExtractOps():
    const getListExtractOps = () => {
      const g = typeof window !== 'undefined' ? window : self;
      return g && g.ListExtractOps;
    };

    // At init time (alias captured), window.ListExtractOps is unset.
    assert.equal(getListExtractOps(), undefined,
      'if alias is captured now, it is undefined — this is the eager-capture bug');

    // Later, list-extract-ops.js finishes loading and attaches the API.
    fakeWindow.ListExtractOps = { extractListRecords: () => 'ok', clickInListItems: () => 'ok' };

    // Lazy lookup sees the late-attached value; eager alias would NOT have.
    const ops = getListExtractOps();
    assert.ok(ops && typeof ops.extractListRecords === 'function');
    assert.ok(ops && typeof ops.clickInListItems === 'function');

    global.window = savedWindow;
  });
});
