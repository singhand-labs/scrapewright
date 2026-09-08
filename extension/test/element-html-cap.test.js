// Forty-first log: whole-card `attr: 'outerHTML'` fields came back 82396-99278
// chars each (result.json: 332KB for 3 posts). The fix caps element-HTML
// property reads at 50000 with an in-value disclosure comment. This file pins
// the content-script.js side: the createInlineListExtractOps fallback copy
// (RC5/RC35 drift family — must behave identically to lib/list-extract-ops.js)
// and domExtract ($extract's read path).
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');

function sliceFn(name) {
  let start = SRC.indexOf('async function ' + name + '(');
  if (start === -1) start = SRC.indexOf('function ' + name + '(');
  assert.ok(start !== -1, 'function ' + name + ' exists in content-script.js');
  let i = SRC.indexOf('{', start);
  let depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') { depth -= 1; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces for ' + name);
}

function setupDom(html) {
  const dom = new JSDOM(html, { url: 'https://example.com/page' });
  global.document = dom.window.document;
  global.window = dom.window;
  global.Node = dom.window.Node;
  return dom;
}

// Build the real cap helper from source (it must be self-contained so both
// content-script call sites and this harness can use it without free refs).
function buildCapHelper() {
  return eval('(' + sliceFn('capElementHtmlRead') + ')');
}

function buildInlineOps() {
  const factory = eval('(function (capElementHtmlRead, resolveLabelledbyText, isVisibleForDiagnostics) { return (' + sliceFn('createInlineListExtractOps') + '); })');
  return factory(
    buildCapHelper(),
    (el, attr) => ({ text: '', attr, refCount: 0, missingIds: [] }),
    () => true
  )();
}

function buildDomExtract() {
  const factory = eval('(function (domQuerySelector, querySelectorDeep, sendDebugLog, getListExtractOps, capElementHtmlRead) { return (' + sliceFn('domExtract') + '); })');
  return factory(
    async () => {},
    (sel) => ({ element: document.querySelector(sel) }),
    () => {},
    () => null,
    buildCapHelper()
  );
}

const BIG = 'x'.repeat(60000);
const SUFFIX = /<!--TRUNCATED: element HTML capped at 50000 of \d+ chars-->$/;

describe('forty-first log: element-HTML read cap — content-script side', () => {
  beforeEach(() => {
    setupDom('<!DOCTYPE html><html><body></body></html>');
  });

  it('inline readField caps container outerHTML (empty-selector site)', () => {
    document.body.innerHTML = '<div class="post"><span class="filler">' + BIG + '</span></div>';
    const ops = buildInlineOps();
    const containers = Array.from(document.querySelectorAll('.post'));
    const records = ops.extractListRecords(containers, { html: { selector: '', attr: 'outerHTML' } });
    assert.match(records[0].html, SUFFIX);
    assert.ok(records[0].html.length <= 50200, 'capped near 50000, got ' + records[0].html.length);
  });

  it('inline readField caps sub-selector innerHTML', () => {
    document.body.innerHTML = '<div class="post"><p class="filler">' + BIG + '</p></div>';
    const ops = buildInlineOps();
    const containers = Array.from(document.querySelectorAll('.post'));
    const records = ops.extractListRecords(containers, { inner: { selector: '.filler', attr: 'innerHTML' } });
    assert.match(records[0].inner, SUFFIX);
  });

  it('inline readFieldAll caps every element-HTML value (both sites)', () => {
    document.body.innerHTML = '<div class="post"><p class="filler">' + BIG + '</p><p class="filler">' + BIG + '</p></div>';
    const ops = buildInlineOps();
    const containers = Array.from(document.querySelectorAll('.post'));
    const records = ops.extractListMultiRecords(containers, {
      inner: { selector: '.filler', attr: 'innerHTML' },
      own: { selector: '', attr: 'outerHTML' }
    });
    for (const v of records[0].inner) assert.match(v, SUFFIX);
    assert.match(records[0].own[0], SUFFIX);
  });

  it('inline small element-HTML reads stay untouched', () => {
    document.body.innerHTML = '<div class="post"><p>Hello</p></div>';
    const ops = buildInlineOps();
    const containers = Array.from(document.querySelectorAll('.post'));
    const records = ops.extractListRecords(containers, { html: { selector: '', attr: 'outerHTML' } });
    assert.ok(!/TRUNCATED/.test(records[0].html));
  });

  it('domExtract caps $extract(_, "outerHTML") results', async () => {
    document.body.innerHTML = '<div id="card"><span>' + BIG + '</span></div>';
    const domExtract = buildDomExtract();
    const out = await domExtract('#card', 'outerHTML');
    assert.match(out.result, SUFFIX);
    assert.ok(out.result.length <= 50200, 'capped near 50000, got ' + out.result.length);
  });

  it('domExtract leaves small outerHTML and plain attributes untouched', async () => {
    document.body.innerHTML = '<div id="card"><p>Hi</p></div><div id="wide" data-x="' + 'y'.repeat(60000) + '"></div>';
    const domExtract = buildDomExtract();
    const small = await domExtract('#card', 'outerHTML');
    assert.ok(!/TRUNCATED/.test(small.result));
    const attr = await domExtract('#wide', 'data-x');
    assert.equal(attr.result.length, 60000, 'plain attributes are not capped');
  });
});
