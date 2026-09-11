// Code-review regression tests (dual-mirror: the REQUIREABLE lib is executed
// directly — converts the grep-only mirror guard into dual-execution parity;
// the inline content-script mirror stays pinned by mechanical-semantic.test.js
// and the drift guards).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const ops = require('../lib/list-extract-ops.js');

function makeDom(html) {
  const dom = new JSDOM(html, { url: 'https://example.com/p' });
  return dom.window.document;
}

const HOVER_HTML = '<div>Shared · Friday, September 11, 2026 at 1:43 AM</div>';

describe('#1 applyMatch array envelope (lib)', () => {
  it('$extractListMulti with {multi:true, match} returns the FILTERED ARRAY of passing values', () => {
    const doc = makeDom('<div class="c"><a href="/1">link one</a><a href="/2">link two</a><a href="/x">plain</a></div>');
    const out = ops.extractListMultiRecords(
      [doc.querySelector('.c')],
      { hrefs: { selector: 'a', attr: 'href', multi: true, match: '^/\\d' } },
      {}
    );
    assert.deepEqual(out[0].hrefs, ['/1', '/2']);
  });
  it('no passing value → empty array (envelope preserved, not scalar \'\')', () => {
    const doc = makeDom('<div class="c"><a href="/1">a</a></div>');
    const out = ops.extractListMultiRecords(
      [doc.querySelector('.c')],
      { hrefs: { selector: 'a', attr: 'href', multi: true, match: 'zzz' } },
      {}
    );
    assert.deepEqual(out[0].hrefs, []);
  });
});

describe('#5 compileMatch hardening (lib)', () => {
  it('defensive lastIndex reset: repeated tests of the same regex do not alternate', () => {
    const re = /ab/g; // simulated flag-bearing predicate state
    const vals = ['ab', 'ab', 'ab', 'ab'];
    const out = vals.filter((v) => {
      re.lastIndex = 0;
      return re.test(v);
    });
    assert.equal(out.length, 4);
    // via the public path: array applyMatch with a sticky-state regex source
    const doc = makeDom('<div class="c"><a href="/a">ab1</a><a href="/b">ab2</a></div>');
    const rec = ops.extractListMultiRecords(
      [doc.querySelector('.c')],
      { t: { selector: 'a', multi: true, match: 'ab' } },
      {}
    );
    assert.deepEqual(rec[0].t, ['ab1', 'ab2']);
  });
  it('values > 2000 chars are skipped (no test, no hang)', () => {
    const doc = makeDom('<div class="c"><a href="/a">x</a></div>');
    const long = 'a'.repeat(3000);
    doc.querySelector('.c a').textContent = long;
    const rec = ops.extractListRecords(
      [doc.querySelector('.c')],
      { t: { selector: 'a', match: 'a' } },
      {}
    );
    assert.equal(rec[0].t, '');
  });
  it('invalid match throws BEFORE any hoverFn call (compile hoisted to the split)', async () => {
    const doc = makeDom('<div class="c"><a class="a" href="/x">anchor</a></div>');
    let calls = 0;
    await assert.rejects(
      () => ops.extractWithHoverRecords(
        [doc.querySelector('.c')],
        { t: { selector: '.a', read: 'hoverPopover', match: '(' } },
        { anchorSel: '.a' },
        async () => { calls++; return { hovered: true, htmlSnippet: HOVER_HTML }; },
        {}
      ),
      /match is not a valid regex/
    );
    assert.equal(calls, 0);
  });
});

describe('#2 hover-read budget (lib)', () => {
  function card(doc) { return doc.querySelector('.card'); }
  it('candidate hovers per field per container are capped at 3, with __capped disclosure', async () => {
    const doc = makeDom('<div class="card">' +
      '<a class="a">1</a><a class="a">2</a><a class="a">3</a><a class="a">4</a><a class="a">5</a></div>');
    let calls = 0;
    const out = await ops.extractWithHoverRecords(
      [card(doc)],
      { t: { selector: '.a', read: 'hoverPopover', multi: true } },
      { anchorSel: 'span.never' }, // no anchor-loop hovers
      async () => { calls++; return { hovered: true, htmlSnippet: HOVER_HTML }; },
      {}
    );
    assert.equal(calls, 3, 'field candidate hovers capped at 3');
    assert.equal(out[0].t.length, 3);
    assert.equal(out[0].t__capped, 2);
  });
  it('reuse: an element the anchor loop already hovered is NOT re-hovered', async () => {
    const doc = makeDom('<div class="card"><a class="a" href="/x">anchor</a></div>');
    const hoveredEls = [];
    const out = await ops.extractWithHoverRecords(
      [card(doc)],
      { t: { selector: '.a', read: 'hoverPopover' } },
      { anchorSel: '.a' },
      async (el) => {
        hoveredEls.push(el);
        return { hovered: true, htmlSnippet: HOVER_HTML };
      },
      {}
    );
    assert.equal(hoveredEls.length, 1, 'the anchor loop hovered it; the field loop reuses');
    assert.ok(out[0].t.includes('September 11, 2026'));
  });
  it('scalar fallback: empty field harvest falls back to hovercards[].popoverText', async () => {
    const doc = makeDom('<div class="card"><span class="lbl">label</span><a class="a" href="/x">anchor</a></div>');
    const out = await ops.extractWithHoverRecords(
      [card(doc)],
      { t: { selector: '.other', read: 'hoverPopover' } }, // matches nothing → field candidates empty
      { anchorSel: '.a' },
      async () => ({ hovered: true, htmlSnippet: HOVER_HTML }),
      {}
    );
    assert.ok(out[0].hovercards[0].popoverText.includes('September 11, 2026'));
    assert.ok(out[0].t.includes('September 11, 2026'), 'fallback filled from hovercards popoverText');
  });
  it('scalar early-stop: hoverFn stops after the first non-empty capture', async () => {
    const doc = makeDom('<div class="card"><a class="b">1</a><a class="b">2</a><a class="b">3</a></div>');
    let calls = 0;
    const out = await ops.extractWithHoverRecords(
      [card(doc)],
      { t: { selector: '.b', read: 'hoverPopover' } },
      { anchorSel: 'span.none' },
      async () => { calls++; return { hovered: true, htmlSnippet: HOVER_HTML }; },
      {}
    );
    assert.equal(calls, 1, 'scalar stops at first non-empty capture');
    assert.ok(out[0].t.includes('September 11, 2026'));
  });
});

describe('#8 lib-executed parity (mechanical-semantic fixtures against the requireable lib)', () => {
  it('popoverText strip output matches the inline fixture expectation', async () => {
    const doc = makeDom('<div id="card"><a class="a" href="/x">anchor</a></div>');
    const out = await ops.extractWithHoverRecords(
      [doc.getElementById('card')],
      { t: { selector: '.a' } },
      { anchorSel: '.a' },
      async () => ({
        hovered: true,
        htmlSnippet: '<div role="tooltip"><div>Shared with Public</div><div>Friday, September 11, 2026 at 1:43 AM</div></div>'
      }),
      {}
    );
    assert.equal(out[0].hovercards[0].popoverText, 'Shared with Public Friday, September 11, 2026 at 1:43 AM');
  });
  it('read:hoverPopover + match: hit takes the whole raw value, miss is \'\'', async () => {
    const doc = makeDom('<div id="card"><a class="a" href="/x">anchor</a></div>');
    const out = await ops.extractWithHoverRecords(
      [doc.getElementById('card')],
      { postTime: { selector: '.a', read: 'hoverPopover', match: '\\d{4} at .*?(AM|PM)' } },
      { anchorSel: '.a' },
      async () => ({ hovered: true, htmlSnippet: '<div>Shared · Friday, September 11, 2026 at 1:43 AM</div>' }),
      {}
    );
    assert.equal(out[0].postTime, 'Shared · Friday, September 11, 2026 at 1:43 AM');
    const out2 = await ops.extractWithHoverRecords(
      [doc.getElementById('card')],
      { postTime: { selector: '.a', read: 'hoverPopover', match: '^[0-9]+$' } },
      { anchorSel: '.a' },
      async () => ({ hovered: true, htmlSnippet: '<div>September 11, 2026</div>' }),
      {}
    );
    assert.strictEqual(out2[0].postTime, '');
  });
  it('invalid match throws with the rewrite teaching', () => {
    const doc = makeDom('<div class="c"><a class="a">x</a></div>');
    assert.throws(
      () => ops.extractListRecords([doc.querySelector('.c')], { v: { selector: '.a', match: '(' } }, {}),
      /match is not a valid regex/
    );
  });
  it('array ordering preserved through match filtering', () => {
    const doc = makeDom('<div class="c"><a href="/1">one</a><a href="/2">two</a><a href="/3">three</a></div>');
    const out = ops.extractListMultiRecords(
      [doc.querySelector('.c')],
      { t: { selector: 'a', multi: true, match: 't' } },
      {}
    );
    assert.deepEqual(out[0].t, ['two', 'three']);
  });
});
