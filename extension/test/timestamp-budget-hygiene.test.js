// Code-review regressions: $timestamp cross-call shared hover budget (#6)
// and selector hygiene (#12) — vm-sliced domTimestamp with a controllable
// Date so budget exhaustion is testable in real time.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const CS = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
function sliceFn(src, a, b) {
  const s = src.indexOf(a); assert.ok(s > -1, 'marker ' + a);
  const e = src.indexOf(b, s); assert.ok(e > s, 'end ' + b);
  return src.slice(s, e);
}
const TS_SLICE = sliceFn(CS, 'var TS_MAX_HOVER_ANCHORS', '\n  async function domExists(');
const HARVEST = sliceFn(CS, 'function harvestAnchorLabel(', '\n  async function domHover(');

// 4 anchors, none date-shaped in label/text — only hovers could add more.
const CARD_HTML = '<div id="card">' +
  '<span aria-labelledby="i1">a</span><span aria-labelledby="i2">b</span>' +
  '<span aria-labelledby="i3">c</span><span aria-labelledby="i4">d</span></div>';

function makeTs(domHoverImpl, advanceMs) {
  const dom = new JSDOM(CARD_HTML, { url: 'https://e.com/p' });
  const card = dom.window.document.getElementById('card');
  let fakeNow = 0;
  const ctx = {
    document: dom.window.document,
    querySelectorAllDeep: (sel) => (sel === '#card' ? [card] : []),
    notifyBackgroundDiagnostic: () => {}, sendDebugLog: () => {},
    domHover: async (...a) => { const r = domHoverImpl(...a); fakeNow += advanceMs; return r; },
    Date: { now: () => fakeNow }
  };
  vm.createContext(ctx);
  vm.runInContext(HARVEST + '\n' + TS_SLICE + '\nthis.__ts = domTimestamp;', ctx);
  return ctx.__ts;
}

describe('#6 $timestamp shared hover budget', () => {
  it('budget survives across calls: first call draws it down, second call skips hovers + notes', async () => {
    const ts = makeTs(async () => ({ hovered: false, htmlSnippet: null }), 20000);
    const r1 = await ts('#card', {});
    assert.ok(r1.result.hoversDispatched >= 1 && r1.result.hoversDispatched <= 3);
    const r2 = await ts('#card', {});
    assert.ok(r2.result.hoversDispatched < r1.result.hoversDispatched,
      'second call hovers less (' + r2.result.hoversDispatched + ' < ' + r1.result.hoversDispatched + ')');
    assert.match(r2.result.note, /shared hover budget exhausted/);
    assert.match(r2.result.note, /narrow anchorSel|io\.confirm/);
  });
});

describe('#12 $timestamp selector hygiene', () => {
  it('invalid container selector throws the named error (not a 0-container false negative)', async () => {
    const ts = makeTs(async () => ({ hovered: false, htmlSnippet: null }), 1);
    await assert.rejects(() => ts('##bad', {}), /\$timestamp container selector invalid/);
  });
  it('invalid anchorSel throws the named error (not silently anchors=[])', async () => {
    const ts = makeTs(async () => ({ hovered: false, htmlSnippet: null }), 1);
    await assert.rejects(() => ts('#card', { anchorSel: ':bad:' }), /\$timestamp anchor selector invalid/);
  });
  it('zero containers carries the cold-tab note', async () => {
    const ts = makeTs(async () => ({ hovered: false, htmlSnippet: null }), 1);
    const r = await ts('.nope', {});
    assert.match(r.result.note, /no containers matched — cold tab\? await \$wait\(sel\) first/);
  });
});
