// RC45: container-scoped $extractWithHover primitive.
//
// Thirteenth hover-family incident. The existing $hover(..., { index: i })
// manual loop pattern assumes 1 anchor per container globally. When
// containers hold variable numbers of anchors (the universal case for any
// list of items with N>=0 hoverable entity references), the global anchor
// array interleaves across containers and the i-th call lands on the wrong
// container's anchor. $extractWithHover makes per-container anchor
// iteration a framework concern, eliminating the alignment failure mode.
//
// This file covers:
//   - Source-text audit for the domHover element-input refactor (Task 1)
//   - Source-text audit for the pure helper in lib/list-extract-ops.js (Task 2)
//   - Source-text audit for the inline fallback mirror (Task 3)
//   - Source-text audit for domExtractWithHover wrapper (Task 4)
//   - Source-text audit for sandbox + DOM_REQUEST wiring (Task 5)
//   - Source-text audit for ARRAY_EXTRACTION_RE update (Task 6)
//   - Source-text audit for DSL guide section + HOVER ENRICHMENT pointer (Tasks 7-8)
//   - JSDOM behavioral tests for extractWithHoverRecords (covered in Task 2)
//
// See docs/superpowers/specs/2026-08-12-extract-with-hover-design.md for the
// full design (local-only).

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const { extractWithHoverRecords } = require('../lib/list-extract-ops');

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function setupDOM(html) {
  const dom = new JSDOM(html, { url: 'https://example.com/page' });
  global.document = dom.window.document;
  global.window = dom.window;
  global.Node = dom.window.Node;
  return dom;
}

describe('RC45 Task 1: domHover accepts element-or-selector', () => {
  it('branches on element vs string input (avoids global querySelector when an element is passed)', () => {
    // Without this branch, $extractWithHover cannot pass a resolved anchor
    // element; it would have to re-enumerate globally, reintroducing the
    // alignment bug.
    const src = readSrc('content-script.js');
    const fnStart = src.indexOf('async function domHover(');
    assert.ok(fnStart > -1, 'domHover function must exist');
    // Slice a reasonable window for the anchor-resolution block.
    const window = src.slice(fnStart, fnStart + 4000);
    // Must detect an element (DOM node) branch via nodeType or typeof object.
    assert.ok(/nodeType|typeof\s+\w+\s*===\s*['"]object['"]/.test(window),
      'domHover must branch on element vs string input (look for nodeType or typeof object check near the anchor-resolution block)');
  });

  it('keeps the existing string-selector path working (regression guard)', () => {
    // The refactor must be backward compatible: existing $hover callers
    // pass strings and use opts.index. The querySelectorAllDeep and
    // querySelectorDeep calls must still be present.
    const src = readSrc('content-script.js');
    const fnStart = src.indexOf('async function domHover(');
    const window = src.slice(fnStart, fnStart + 5000);
    assert.ok(/querySelectorAllDeep/.test(window),
      'domHover must still call querySelectorAllDeep for string input with opts.index');
    assert.ok(/querySelectorDeep/.test(window),
      'domHover must still call querySelectorDeep for string input without opts.index');
  });
});

describe('RC45 Task 2: extractWithHoverRecords pure helper', () => {
  beforeEach(() => {
    setupDOM('<!DOCTYPE html><html><body></body></html>');
  });

  it('returns records with hovercards aligned per container (variable anchor counts)', async () => {
    // THE CORE CONTRACT: variable anchors per container must not misalign.
    // 3 containers with 2, 0, 3 anchors respectively.
    document.body.innerHTML = `
      <div class="item">
        <h3 class="title">A</h3>
        <a class="link" id="a1">Link 1</a>
        <a class="link" id="a2">Link 2</a>
      </div>
      <div class="item">
        <h3 class="title">B</h3>
      </div>
      <div class="item">
        <h3 class="title">C</h3>
        <a class="link" id="c1">Link 1</a>
        <a class="link" id="c2">Link 2</a>
        <a class="link" id="c3">Link 3</a>
      </div>
    `;
    const containers = Array.from(document.querySelectorAll('.item'));
    const mockHoverFn = async (anchorEl, popoverSel) => ({
      hovered: true,
      htmlSnippet: '<div role="dialog">' + anchorEl.id + '</div>',
      popoverSelector: popoverSel,
      autoDiscovered: false
    });
    const records = await extractWithHoverRecords(
      containers,
      { title: '.title' },
      { anchorSel: '.link', popoverSel: 'div[role="dialog"]' },
      mockHoverFn,
      { allowEmpty: true }
    );
    assert.equal(records.length, 3);
    assert.equal(records[0].title, 'A');
    assert.equal(records[0].hovercards.length, 2);
    assert.equal(records[0].hovercards[0].htmlSnippet, '<div role="dialog">a1</div>');
    assert.equal(records[0].hovercards[0].anchorIndex, 0);
    assert.equal(records[0].hovercards[1].htmlSnippet, '<div role="dialog">a2</div>');
    assert.equal(records[0].hovercards[1].anchorIndex, 1);
    assert.equal(records[1].title, 'B');
    assert.equal(records[1].hovercards.length, 0);
    assert.equal(records[2].title, 'C');
    assert.equal(records[2].hovercards.length, 3);
    assert.equal(records[2].hovercards[2].anchorIndex, 2);
  });

  it('scoped query: anchors outside any container are never hovered', async () => {
    // Decoy anchor at document level (sibling of containers, not inside).
    // The global-index bug would pick this up; the container-scoped query
    // must not.
    document.body.innerHTML = `
      <div class="item">
        <h3 class="title">X</h3>
        <a class="link" id="x1">In container</a>
      </div>
      <a class="link" id="decoy">Outside any container</a>
    `;
    const containers = Array.from(document.querySelectorAll('.item'));
    const seen = [];
    const mockHoverFn = async (anchorEl) => {
      seen.push(anchorEl.id);
      return { hovered: true, htmlSnippet: '<div role="dialog">' + anchorEl.id + '</div>' };
    };
    const records = await extractWithHoverRecords(
      containers,
      { title: '.title' },
      { anchorSel: '.link' },
      mockHoverFn,
      { allowEmpty: true }
    );
    assert.deepEqual(seen, ['x1']);
    assert.equal(records[0].hovercards.length, 1);
    assert.equal(records[0].hovercards[0].htmlSnippet, '<div role="dialog">x1</div>');
  });

  it('hover failure on one anchor does not abort other anchors in the same container', async () => {
    document.body.innerHTML = `
      <div class="item">
        <a class="link" id="ok1">1</a>
        <a class="link" id="boom">2</a>
        <a class="link" id="ok2">3</a>
      </div>
    `;
    const containers = Array.from(document.querySelectorAll('.item'));
    const mockHoverFn = async (anchorEl) => {
      if (anchorEl.id === 'boom') throw new Error('CDP dispatch failed');
      return { hovered: true, htmlSnippet: '<div role="dialog">' + anchorEl.id + '</div>' };
    };
    const records = await extractWithHoverRecords(
      containers,
      { title: { selector: '', attr: 'textContent' } },
      { anchorSel: '.link' },
      mockHoverFn,
      { allowEmpty: true }
    );
    assert.equal(records[0].hovercards.length, 3);
    assert.equal(records[0].hovercards[0].hovered, true);
    assert.equal(records[0].hovercards[1].hovered, false);
    assert.ok(/hover_error/.test(records[0].hovercards[1].reason));
    assert.equal(records[0].hovercards[2].hovered, true);
  });

  it('throws when containers array is empty and allowEmpty is false', async () => {
    await assert.rejects(
      () => extractWithHoverRecords([], { title: '.title' }, { anchorSel: '.link' }, async () => ({})),
      /no containers matched/
    );
  });

  it('returns [] when containers array is empty and allowEmpty is true', async () => {
    const result = await extractWithHoverRecords(
      [], { title: '.title' }, { anchorSel: '.link' }, async () => ({}),
      { allowEmpty: true }
    );
    assert.deepEqual(result, []);
  });

  it('throws when hoverConfig is missing or anchorSel is empty', async () => {
    document.body.innerHTML = '<div class="item"><a class="link">x</a></div>';
    const containers = Array.from(document.querySelectorAll('.item'));
    await assert.rejects(
      () => extractWithHoverRecords(containers, { title: '.title' }, null, async () => ({})),
      /hoverConfig/
    );
    await assert.rejects(
      () => extractWithHoverRecords(containers, { title: '.title' }, { anchorSel: '' }, async () => ({})),
      /anchorSel/
    );
  });

  it('throws when fieldMap is missing or empty', async () => {
    document.body.innerHTML = '<div class="item"></div>';
    const containers = Array.from(document.querySelectorAll('.item'));
    await assert.rejects(
      () => extractWithHoverRecords(containers, null, { anchorSel: '.link' }, async () => ({}), { allowEmpty: true }),
      /fieldMap/
    );
    await assert.rejects(
      () => extractWithHoverRecords(containers, {}, { anchorSel: '.link' }, async () => ({}), { allowEmpty: true }),
      /fieldMap/
    );
  });

  it('hovercard entries carry the documented shape', async () => {
    document.body.innerHTML = `
      <div class="item"><a class="link" id="only">x</a></div>
    `;
    const containers = Array.from(document.querySelectorAll('.item'));
    const mockHoverFn = async () => ({
      hovered: true,
      htmlSnippet: '<div role="dialog">snip</div>',
      popoverSelector: 'div[role="dialog"]',
      autoDiscovered: false,
      reason: null
    });
    const records = await extractWithHoverRecords(
      containers, { title: { selector: '', attr: 'textContent' } },
      { anchorSel: '.link', popoverSel: 'div[role="dialog"]' },
      mockHoverFn, { allowEmpty: true }
    );
    const card = records[0].hovercards[0];
    assert.equal(typeof card.hovered, 'boolean');
    assert.equal(typeof card.htmlSnippet, 'string');
    assert.equal(card.popoverSelector, 'div[role="dialog"]');
    assert.equal(card.autoDiscovered, false);
    assert.equal(card.anchorIndex, 0);
  });
});

describe('RC45 Task 3: inline fallback mirrors extractWithHoverRecords', () => {
  it('createInlineListExtractOps exports extractWithHoverRecords', () => {
    // The drift-guard test enforces name parity; this test is a more
    // targeted check that specifically confirms the inline fallback has
    // the function (not just that the name sets match).
    const src = readSrc('content-script.js');
    const fnStart = src.indexOf('function createInlineListExtractOps');
    assert.ok(fnStart > -1, 'createInlineListExtractOps must exist');
    // Slice the function body using a reasonable window.
    const window = src.slice(fnStart, fnStart + 30000);
    assert.ok(/extractWithHoverRecords/.test(window),
      'inline fallback must define extractWithHoverRecords (drift guard will also enforce this)');
    // Must be returned from the inline api object.
    assert.ok(/extractWithHoverRecords\s*,/.test(window) ||
              /extractWithHoverRecords\s*:/.test(window),
      'inline fallback must export extractWithHoverRecords in its return object');
  });
});

describe('RC45 Task 4: domExtractWithHover wrapper', () => {
  it('exists and validates inputs', () => {
    const src = readSrc('content-script.js');
    assert.ok(/async\s+function\s+domExtractWithHover\s*\(/.test(src),
      'domExtractWithHover function must exist');
    // Must validate containerSel as non-empty string.
    assert.ok(/containerSel must be a non-empty string/.test(src),
      'domExtractWithHover must validate containerSel');
    // Must validate opts.hover existence.
    assert.ok(/opts\.hover must be an object/.test(src),
      'domExtractWithHover must validate opts.hover');
    // Must validate opts.hover.anchorSel.
    assert.ok(/anchorSel must be a non-empty string/.test(src),
      'domExtractWithHover must validate opts.hover.anchorSel');
  });

  it('resolves containers via querySelectorAllDeep and supports range opts', () => {
    const src = readSrc('content-script.js');
    const fnStart = src.indexOf('async function domExtractWithHover');
    const fnEnd = src.indexOf('}', src.indexOf('return { result', fnStart));
    const body = src.slice(fnStart, fnEnd > fnStart ? fnEnd + 1 : src.length);
    assert.ok(/querySelectorAllDeep/.test(body),
      'domExtractWithHover must resolve containers via querySelectorAllDeep');
    // Range opts must be honored.
    assert.ok(/containerIndex/.test(body), 'must support containerIndex');
    assert.ok(/containerRange/.test(body), 'must support containerRange');
    assert.ok(/maxContainers/.test(body), 'must support maxContainers');
    // Must enforce only-one-of constraint.
    assert.ok(/only one of/.test(body), 'must enforce only-one-of range opts');
  });

  it('delegates to ops.extractWithHoverRecords with domHover injected', () => {
    const src = readSrc('content-script.js');
    const fnStart = src.indexOf('async function domExtractWithHover');
    const body = src.slice(fnStart, fnStart + 8000);
    assert.ok(/extractWithHoverRecords/.test(body),
      'must call ops.extractWithHoverRecords');
    // Must pass domHover as the hoverFn argument.
    assert.ok(/\bdomHover\b/.test(body),
      'must inject domHover as the hoverFn parameter');
  });

  it('returns { result, _diagnostics } with hover summary in diagnostics', () => {
    const src = readSrc('content-script.js');
    const fnStart = src.indexOf('async function domExtractWithHover');
    const body = src.slice(fnStart, fnStart + 8000);
    assert.ok(/return\s*\{\s*result/.test(body),
      'must return { result, _diagnostics }');
    assert.ok(/hoverSummary|hovercardsCaptured|hoverFailures/.test(body),
      'diagnostics must include a hover summary (captured + failed counts)');
  });
});

describe('RC45 Task 5: DOM_REQUEST + sandbox wiring', () => {
  it('content-script.js has case "extractWithHover" in the DOM_REQUEST switch', () => {
    const src = readSrc('content-script.js');
    assert.ok(/case\s+['"]extractWithHover['"]\s*:/.test(src),
      'DOM_REQUEST switch must have a case for extractWithHover');
    // The case must call domExtractWithHover.
    const caseIdx = src.indexOf("case 'extractWithHover'");
    assert.ok(caseIdx > -1);
    const caseBody = src.slice(caseIdx, caseIdx + 500);
    assert.ok(/domExtractWithHover/.test(caseBody),
      'extractWithHover case must call domExtractWithHover');
  });

  it('sandbox.js exposes window.$extractWithHover', () => {
    const src = readSrc('sandbox.js');
    assert.ok(/window\.\$extractWithHover\s*=/.test(src),
      'sandbox.js must define window.$extractWithHover');
    // Must send a DOM_REQUEST with action 'extractWithHover'.
    const defIdx = src.indexOf('window.$extractWithHover');
    const def = src.slice(defIdx, defIdx + 300);
    assert.ok(/sendDomRequest\(\s*['"]extractWithHover['"]/.test(def),
      'window.$extractWithHover must call sendDomRequest with action "extractWithHover"');
    // Arity must be (containerSel, fieldMap, opts) — 3 args.
    assert.ok(/containerSel,\s*fieldMap,\s*opts/.test(def),
      'window.$extractWithHover signature must be (containerSel, fieldMap, opts) — 3 args, matching existing list primitives');
  });
});

describe('RC45 Task 6: ARRAY_EXTRACTION_RE recognizes extractWithHover', () => {
  it('ARRAY_EXTRACTION_RE matches $extractWithHover( calls', () => {
    const src = readSrc('lib/wizard-utils.js');
    const m = src.match(/const\s+ARRAY_EXTRACTION_RE\s*=\s*\/([^\/]+)\//);
    assert.ok(m, 'ARRAY_EXTRACTION_RE must exist');
    const re = new RegExp(m[1]);
    assert.ok(re.test('$extractWithHover('),
      'ARRAY_EXTRACTION_RE must match $extractWithHover( — autoFix uses this to identify array-producing steps');
    // Sanity: existing primitives still recognized.
    assert.ok(re.test('$extractListMulti('));
    assert.ok(re.test('$extractList('));
    assert.ok(re.test('$list('));
  });
});
