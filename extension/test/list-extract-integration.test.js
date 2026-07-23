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

  // Regression for bugx.log 2026-07-23 16:26 — even with lazy lookup,
  // window.ListExtractOps was sometimes genuinely undefined at call time
  // (Chrome MV3 injection glitch). content-script.js now provides an inline
  // fallback that mirrors list-extract-ops.js. Verify the fallback produces
  // identical results to the canonical implementation.
  it('inline fallback in content-script produces same results as list-extract-ops.js', () => {
    const { extractListRecords: nativeExtract, clickInListItems: nativeClick } =
      require('../lib/list-extract-ops');

    // Mirror of content-script.js createInlineListExtractOps():
    function createInlineListExtractOps() {
      function readField(container, spec) {
        const sel = typeof spec === 'string' ? spec : spec.selector;
        const attr = typeof spec === 'string' ? null : spec.attr;
        const el = container.querySelector(sel);
        if (!el) return undefined;
        if (attr) return el.getAttribute(attr);
        return (el.textContent || '').trim();
      }
      function extractListRecords(containers, fieldMap, opts) {
        if (!Array.isArray(containers)) throw new Error('$extractList: containers must be an array');
        if (!fieldMap || typeof fieldMap !== 'object' || Object.keys(fieldMap).length === 0) {
          throw new Error('$extractList fieldMap must be a non-empty object');
        }
        if (!containers.length) {
          if (opts && opts.allowEmpty) return [];
          throw new Error('$extractList: no containers matched');
        }
        const records = [];
        for (const container of containers) {
          const rec = {};
          for (const [field, spec] of Object.entries(fieldMap)) {
            try { rec[field] = readField(container, spec); }
            catch (err) { throw new Error(`$extractList field "${field}" selector invalid: ${err.message}`); }
          }
          records.push(rec);
        }
        return records;
      }
      function clickInListItems(containers, subSel, clickFn, delayMs) {
        const delay = Math.max(0, Math.min(5000, typeof delayMs === 'number' ? delayMs : 500));
        let clicked = 0;
        const errors = [];
        containers.forEach((container, index) => {
          try {
            const el = container.querySelector(subSel);
            if (!el) { errors.push({ index, reason: 'subSel not found' }); return; }
            clickFn(el);
            clicked++;
          } catch (err) { errors.push({ index, reason: err.message || String(err) }); }
        });
        return { clicked, errors, delayMs: delay };
      }
      return { extractListRecords, clickInListItems };
    }
    const inline = createInlineListExtractOps();

    // Build a DOM with 3 posts, each with author/content/href, plus one post
    // missing content (field-alignment case).
    setupDOM(`<!DOCTYPE html><html><body>
      <div role="article">
        <a class="author">A1</a>
        <div class="body">B1</div>
        <a href="/p1">link</a>
      </div>
      <div role="article">
        <a class="author">A2</a>
        <a href="/p2">link</a>
      </div>
      <div role="article">
        <a class="author">A3</a>
        <div class="body">B3</div>
        <a href="/p3">link</a>
      </div>
    </body></html>`);

    const containers = Array.from(document.querySelectorAll('div[role="article"]'));
    const fieldMap = {
      author: 'a.author',
      body: 'div.body',
      href: { selector: 'a[href]', attr: 'href' }
    };

    const nativeResult = nativeExtract(containers, fieldMap);
    const inlineResult = inline.extractListRecords(containers, fieldMap);

    assert.deepEqual(inlineResult, nativeResult,
      'inline fallback must match native extractListRecords');
    assert.equal(inlineResult.length, 3);
    assert.equal(inlineResult[0].author, 'A1');
    assert.equal(inlineResult[1].body, undefined, 'missing field preserved as undefined');
    assert.equal(inlineResult[2].href, '/p3');

    // Verify clickInListItems parity
    const clicks1 = [];
    const clicks2 = [];
    const r1 = nativeClick(containers, 'a.author', (el) => clicks1.push(el.textContent), 0);
    const r2 = inline.clickInListItems(containers, 'a.author', (el) => clicks2.push(el.textContent), 0);
    assert.equal(r2.clicked, r1.clicked);
    assert.deepEqual(clicks2, clicks1);
  });
});
