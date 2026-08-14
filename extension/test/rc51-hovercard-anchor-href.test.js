// RC51 audit: hovercard entries must carry anchorHref + anchorText so
// downstream step scripts can classify hovercards by their source anchor.
//
// FOLLOWUP to RC50 (post-RC49). console.log 2026-08-14 08:16-11:55 showed
// the hover layer FULLY WORKING for the first time: 18/18 iterations picked
// a candidate (100%), 68/68 dismisses ok:true (100% — RC50 fix verified).
// htmlSnippet was captured on every iteration via popoverSel path (a).
//
// Yet the final result still had hovercards:[] for every record. The step-4
// script classified each entry via:
//   if (/\/groups\//.test(h.anchorHref || '')) type = 'group';
//   else if (/facebook\.com\//.test(h.anchorHref || '')) type = 'account';
//   if (type === 'unknown') return null;
//
// h.anchorHref was ALWAYS undefined — the framework never returned it. The
// hovercard entry shape was { hovered, htmlSnippet, popoverSelector,
// autoDiscovered, reason, anchorIndex }. The anchor element is in hand when
// the entry is built; its href is the single most useful classification
// signal, and it was dropped on the floor.
//
// The DSL guide documented the same incomplete shape, so the step script
// invented a field that did not exist. Framework gap, not LLM error.
//
// Fix: extractWithHoverRecords entries gain anchorHref (raw href attribute,
// empty string when absent) and anchorText (trimmed textContent, capped at
// 120 chars). Both copies (lib + content-script inline fallback) and the
// DSL guide shape are updated together — drift discipline per RC35.

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

describe('RC51: hovercard entries carry anchorHref + anchorText', () => {
  beforeEach(() => {
    setupDOM('<!DOCTYPE html><html><body></body></html>');
  });

  it('returns anchorHref from the anchor element and anchorText from its text', async () => {
    document.body.innerHTML = `
      <div class="item">
        <h3 class="title">One</h3>
        <a class="link" href="/records/alpha">Alpha Entity</a>
        <a class="link" href="/collections/beta">Beta Collection</a>
      </div>
    `;
    const containers = Array.from(document.querySelectorAll('.item'));
    const mockHoverFn = async () => ({
      hovered: true, htmlSnippet: '<div role="dialog">card</div>'
    });
    const records = await extractWithHoverRecords(
      containers,
      { title: '.title' },
      { anchorSel: '.link' },
      mockHoverFn,
      { allowEmpty: true }
    );
    assert.equal(records[0].hovercards.length, 2);
    assert.equal(records[0].hovercards[0].anchorHref, '/records/alpha');
    assert.equal(records[0].hovercards[0].anchorText, 'Alpha Entity');
    assert.equal(records[0].hovercards[1].anchorHref, '/collections/beta');
    assert.equal(records[0].hovercards[1].anchorText, 'Beta Collection');
  });

  it('anchorHref is empty string (not null/undefined) when the anchor has no href attribute', async () => {
    // Downstream classification does regex tests on anchorHref; null/undefined
    // forces callers to defensively coerce. Empty string is the stable contract.
    document.body.innerHTML = `
      <div class="item">
        <a class="link">No href anchor</a>
      </div>
    `;
    const containers = Array.from(document.querySelectorAll('.item'));
    const mockHoverFn = async () => ({ hovered: false, htmlSnippet: null });
    const records = await extractWithHoverRecords(
      containers,
      { title: '.title' },
      { anchorSel: '.link' },
      mockHoverFn,
      { allowEmpty: true }
    );
    assert.equal(records[0].hovercards[0].anchorHref, '');
    assert.equal(records[0].hovercards[0].anchorText, 'No href anchor');
  });

  it('anchorText is trimmed and capped at 120 chars', async () => {
    document.body.innerHTML = `
      <div class="item">
        <a class="link" href="/x">${'t'.repeat(200)}</a>
      </div>
    `;
    const containers = Array.from(document.querySelectorAll('.item'));
    const mockHoverFn = async () => ({ hovered: false, htmlSnippet: null });
    const records = await extractWithHoverRecords(
      containers,
      { title: '.title' },
      { anchorSel: '.link' },
      mockHoverFn,
      { allowEmpty: true }
    );
    const text = records[0].hovercards[0].anchorText;
    assert.equal(text.length, 120);
    assert.ok(text.startsWith('ttt'));
  });

  it('error-path entries (hoverFn throws) still carry anchorHref + anchorText', async () => {
    // The catch branch must mirror the success branch — otherwise one thrown
    // hover loses the classification signal for that anchor.
    document.body.innerHTML = `
      <div class="item">
        <a class="link" href="/records/alpha">Alpha Entity</a>
      </div>
    `;
    const containers = Array.from(document.querySelectorAll('.item'));
    const throwingHoverFn = async () => { throw new Error('dispatch failed'); };
    const records = await extractWithHoverRecords(
      containers,
      { title: '.title' },
      { anchorSel: '.link' },
      throwingHoverFn,
      { allowEmpty: true }
    );
    assert.equal(records[0].hovercards.length, 1);
    assert.equal(records[0].hovercards[0].anchorHref, '/records/alpha');
    assert.equal(records[0].hovercards[0].anchorText, 'Alpha Entity');
    assert.ok(String(records[0].hovercards[0].reason).indexOf('hover_error') === 0);
  });
});

describe('RC51: inline fallback parity (drift guard per RC35)', () => {
  it('content-script.js inline copy pushes anchorHref + anchorText on the success branch', () => {
    const src = readSrc('content-script.js');
    // The inline copy lives inside createInlineListExtractOps.
    const inlineStart = src.indexOf('function createInlineListExtractOps()');
    const inlineEnd = src.indexOf('extractWithHoverRecords,', inlineStart);
    assert.ok(inlineStart > -1 && inlineEnd > inlineStart, 'inline fallback must exist');
    const inline = src.slice(inlineStart, inlineEnd);
    const hoverStart = inline.indexOf('function extractWithHoverRecords(');
    assert.ok(hoverStart > -1, 'inline extractWithHoverRecords must exist');
    const body = inline.slice(hoverStart, inline.indexOf('function ', hoverStart + 10) > -1
      ? inline.indexOf('clickInListItems', hoverStart)
      : hoverStart + 4000);
    assert.ok(/anchorHref\s*:/.test(body),
      'inline fallback success branch must push anchorHref');
    assert.ok(/anchorText\s*:/.test(body),
      'inline fallback success branch must push anchorText');
  });

  it('content-script.js inline copy pushes anchorHref + anchorText on the error branch', () => {
    const src = readSrc('content-script.js');
    const inlineStart = src.indexOf('function createInlineListExtractOps()');
    const inlineEnd = src.indexOf('extractWithHoverRecords,', inlineStart);
    const inline = src.slice(inlineStart, inlineEnd);
    const hoverStart = inline.indexOf('function extractWithHoverRecords(');
    const bodyEnd = inline.indexOf('clickInListItems', hoverStart);
    const body = inline.slice(hoverStart, bodyEnd);
    const errIdx = body.indexOf('hover_error');
    assert.ok(errIdx > -1, 'inline error branch must exist');
    const errBranch = body.slice(errIdx - 400, errIdx);
    assert.ok(/anchorHref\s*:/.test(errBranch),
      'inline fallback error branch must push anchorHref');
    assert.ok(/anchorText\s*:/.test(errBranch),
      'inline fallback error branch must push anchorText');
  });
});

describe('RC51: DSL guide documents the new fields', () => {
  it('EXTRACT-WITH-HOVER return shape includes anchorHref + anchorText', () => {
    const src = readSrc('lib/wizard-utils.js');
    const secStart = src.indexOf('EXTRACT-WITH-HOVER');
    assert.ok(secStart > -1, 'EXTRACT-WITH-HOVER section must exist');
    const shapeIdx = src.indexOf('hovercards: [', secStart);
    assert.ok(shapeIdx > -1, 'return shape block must exist');
    const shape = src.slice(shapeIdx, shapeIdx + 400);
    assert.ok(/anchorHref/.test(shape),
      'return shape must document anchorHref');
    assert.ok(/anchorText/.test(shape),
      'return shape must document anchorText');
  });
});
