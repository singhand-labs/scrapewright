// Twenty-third log: $exists is the ONLY $ primitive gated on visibility
// (isElementVisible in content-script.js) while every read ($extract, $list,
// $count, $extractList) resolves through querySelector(All)Deep with NO
// visibility filter. The model's natural guard idiom —
// `if (!(await $exists(sel))) return null` — read hidden-but-readable
// elements (aria-labelledby tooltip spans) as "absent", postedTime/location
// extracted as "" in 5/5 records across seven service.update iterations,
// and the bare `false` let the model construct a wrong race hypothesis.
// A false $exists whose selector DOES match must carry diagnostics.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');

function sliceFn(name) {
  const start = SRC.indexOf('function ' + name + '(');
  assert.ok(start !== -1, 'function ' + name + ' exists in content-script.js');
  let i = SRC.indexOf('{', start);
  let depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') { depth -= 1; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces for ' + name);
}

function buildHarness(dom) {
  const doc = dom.window.document;
  // Main-doc-only stand-ins for the deep query functions the real
  // content-script resolves via lib/iframe-selector.js.
  const querySelectorDeep = (sel) => {
    const el = doc.querySelector(sel);
    return el ? { element: el, doc } : null;
  };
  const querySelectorAllDeep = (sel) => Array.from(doc.querySelectorAll(sel));
  const sendDebugLog = () => {};
  const recordDomActivity = () => {};

  const existsDeps = eval('(function (querySelectorDeep, isElementVisible, sendDebugLog) { return (async ' + sliceFn('domExists') + '); })')(
    querySelectorDeep, eval('(' + sliceFn('isElementVisible') + ')'), sendDebugLog
  );
  const computeExistsDiagnostics = eval(
    '(function (querySelectorAllDeep, isElementVisible, invisibleElementReason, sendDebugLog) { return (' + sliceFn('computeExistsDiagnostics') + '); })'
  )(querySelectorAllDeep, eval('(' + sliceFn('isElementVisible') + ')'), eval('(' + sliceFn('invisibleElementReason') + ')'), sendDebugLog);

  const noopAsync = async () => ({ result: {} });
  const fns = {
    domQuerySelector: noopAsync, domClick: noopAsync, domType: noopAsync, domExtract: noopAsync,
    domWait: noopAsync, domCheck: noopAsync, domOpenTab: noopAsync, domExists: existsDeps,
    domCount: noopAsync, domList: noopAsync, domWaitForStable: noopAsync, domExtractList: noopAsync,
    domExtractListMulti: noopAsync, domClickInList: noopAsync, domExtractWithHover: noopAsync,
    domScrollBy: noopAsync, domScrollToBottom: noopAsync, domScrollIntoView: noopAsync,
    domHover: noopAsync, recordDomActivity
  };
  const names = Object.keys(fns).concat(['computeExistsDiagnostics', 'sendDebugLog']);
  const factory = eval('(function (' + names.join(', ') + ') { return (async ' + sliceFn('handleDomRequest') + '); })');
  const args = names.map((n) => fns[n] !== undefined ? fns[n] : (n === 'computeExistsDiagnostics' ? computeExistsDiagnostics : sendDebugLog));
  return factory(...args);
}

function visibleRect(dom, sel) {
  const el = dom.window.document.querySelector(sel);
  el.getBoundingClientRect = () => ({ width: 120, height: 20, top: 0, left: 0 });
}

describe('twenty-third log F1: $exists hidden-match diagnostics', () => {
  it('a false $exists over a selector that MATCHES reports the hidden match with readable sample text', async () => {
    const dom = new JSDOM('<div id="card">card body</div>' +
      '<span id="lbl" style="display:none">September 3 at 8:12 PM</span>');
    visibleRect(dom, '#card'); // jsdom rects are zero-size by default
    const handle = buildHarness(dom);

    const out = await handle({ action: 'exists', selector: '#lbl', args: [0] });
    assert.equal(out.result, false);
    assert.ok(Array.isArray(out._diagnostics) && out._diagnostics.length === 1,
      'exists dispatch attaches diagnostics for a matched-but-invisible selector');
    const d = out._diagnostics[0];
    assert.equal(d.api, 'exists');
    assert.equal(d.selector, '#lbl');
    assert.equal(d.exists, false);
    assert.equal(d.matchedButInvisible, true);
    assert.equal(d.matchCount, 1);
    assert.equal(d.visibleCount, 0);
    assert.equal(d.invisibleCount, 1);
    assert.ok(Array.isArray(d.invisibleReasons) && d.invisibleReasons.length >= 1);
    assert.match(d.invisibleReasons.join(','), /display:none|zero-size/);
    assert.deepEqual(d.sampleTexts, ['September 3 at 8:12 PM']);
    assert.match(d.note, /not visibility-gated|visibility-gated/i);
  });

  it('a genuinely absent selector stays a clean false with no diagnostics', async () => {
    const dom = new JSDOM('<div id="card">card</div>');
    visibleRect(dom, '#card');
    const handle = buildHarness(dom);
    const out = await handle({ action: 'exists', selector: '#no-such-thing', args: [0] });
    assert.equal(out.result, false);
    assert.equal(out._diagnostics, undefined);
  });

  it('a visible match returns true with no diagnostics', async () => {
    const dom = new JSDOM('<div id="card">card</div>');
    visibleRect(dom, '#card');
    const handle = buildHarness(dom);
    const out = await handle({ action: 'exists', selector: '#card', args: [0] });
    assert.equal(out.result, true);
    assert.equal(out._diagnostics, undefined);
  });

  it('the ungated read path still reads the hidden element (the divergence is real)', async () => {
    const dom = new JSDOM('<span id="lbl" style="display:none">September 3 at 8:12 PM</span>');
    const doc = dom.window.document;
    assert.equal(doc.querySelector('#lbl').textContent.trim(), 'September 3 at 8:12 PM',
      'the hidden span IS readable by plain DOM reads — what $extract/$list do');
  });
});
