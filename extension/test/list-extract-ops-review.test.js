// Code-review regression tests (dual-execution parity: every behavioral case
// runs against BOTH the requireable lib AND the inline content-script vm
// mirror — sixty-ninth review F6; the inline harness is shared via
// test/helpers/inline-ops-factory.js).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const libOps = require('../lib/list-extract-ops.js');
const { loadInline } = require('./helpers/inline-ops-factory.js');

// Cross-realm values (vm arrays) are not reference-equal to Node arrays —
// normalize before deepStrictEqual.
function norm(v) { return JSON.parse(JSON.stringify(v)); }

function makeDom(html) {
  const dom = new JSDOM(html, { url: 'https://example.com/p' });
  return { dom, doc: dom.window.document };
}

const HOVER_HTML = '<div>Shared · Friday, September 11, 2026 at 1:43 AM</div>';

// Run a suite body twice: once against the lib, once against the inline
// mirror. body(mk) receives mk(dom) → an ops surface for that DOM.
function dual(label, body) {
  describe(label + ' (lib)', () => body({ make: () => libOps }));
  describe(label + ' (inline mirror)', () => body({ make: (dom) => loadInline(dom) }));
}

dual('#1 applyMatch array envelope', ({ make }) => {
  it('{multi:true, match} returns the FILTERED ARRAY of passing values', () => {
    const { dom, doc } = makeDom('<div class="c"><a href="/1">link one</a><a href="/2">link two</a><a href="/x">plain</a></div>');
    const out = make(dom).extractListMultiRecords(
      [doc.querySelector('.c')],
      { hrefs: { selector: 'a', attr: 'href', multi: true, match: '^/\\d' } },
      {}
    );
    assert.deepEqual(norm(out[0].hrefs), ['/1', '/2']);
  });
  it('no passing value → empty array (envelope preserved, not scalar \'\')', () => {
    const { dom, doc } = makeDom('<div class="c"><a href="/1">a</a></div>');
    const out = make(dom).extractListMultiRecords(
      [doc.querySelector('.c')],
      { hrefs: { selector: 'a', attr: 'href', multi: true, match: 'zzz' } },
      {}
    );
    assert.deepEqual(norm(out[0].hrefs), []);
  });
});

dual('#5 compileMatch hardening', ({ make }) => {
  it('defensive lastIndex reset: repeated tests of the same regex do not alternate', () => {
    const { dom, doc } = makeDom('<div class="c"><a href="/a">ab1</a><a href="/b">ab2</a></div>');
    const rec = make(dom).extractListMultiRecords(
      [doc.querySelector('.c')],
      { t: { selector: 'a', multi: true, match: 'ab' } },
      {}
    );
    assert.deepEqual(norm(rec[0].t), ['ab1', 'ab2']);
  });
  it('values > 2000 chars: head AND tail windows tested (103c user directive), skipped guard counted (F8)', () => {
    const { dom, doc } = makeDom('<div class="c"><a href="/a">x</a></div>');
    const long = 'a'.repeat(2500) + 'TAIL';
    doc.querySelector('.c a').textContent = long;
    const ops = make(dom);
    if (typeof ops.resetMatchGuardSkips === 'function') ops.resetMatchGuardSkips();
    const rec = ops.extractListRecords(
      [doc.querySelector('.c')],
      { t: { selector: 'a', match: 'a' } },
      {}
    );
    // the prefix matches → the whole raw value is taken, never a silent false
    assert.equal(rec[0].t, long);
    if (typeof ops.getMatchGuardSkips === 'function') {
      assert.ok(ops.getMatchGuardSkips() >= 1, 'skipped guard disclosed via counter');
    }
    // a match living in the TAIL window (past the SVG/noise head — the 103rd
    // incident shape) is now VISIBLE: head+tail windows both tested.
    doc.querySelector('.c a').textContent = 'x'.repeat(2500) + 'NEEDLE';
    if (typeof ops.resetMatchGuardSkips === 'function') ops.resetMatchGuardSkips();
    const rec2 = ops.extractListRecords(
      [doc.querySelector('.c')],
      { t: { selector: 'a', match: 'NEEDLE' } },
      {}
    );
    assert.equal(rec2[0].t, 'x'.repeat(2500) + 'NEEDLE', 'tail-window match takes the whole raw value');
    if (typeof ops.getMatchGuardSkips === 'function') {
      assert.ok(ops.getMatchGuardSkips() >= 1);
    }
    // the MIDDLE stays bounded (catastrophic-backtracking protection, F8):
    // a needle between the two windows is still invisible, counter disclosed.
    doc.querySelector('.c a').textContent = 'x'.repeat(2100) + 'MIDDLE-NEEDLE' + 'y'.repeat(2100);
    if (typeof ops.resetMatchGuardSkips === 'function') ops.resetMatchGuardSkips();
    const rec3 = ops.extractListRecords(
      [doc.querySelector('.c')],
      { t: { selector: 'a', match: 'MIDDLE-NEEDLE' } },
      {}
    );
    assert.equal(rec3[0].t, '');
    if (typeof ops.getMatchGuardSkips === 'function') {
      assert.ok(ops.getMatchGuardSkips() >= 1);
    }
  });
  it('invalid match throws BEFORE any hoverFn call (compile hoisted to the split)', async () => {
    const { dom, doc } = makeDom('<div class="c"><a class="a" href="/x">anchor</a></div>');
    let calls = 0;
    await assert.rejects(
      // the inline mirror's fn is not declared async — validation throws
      // synchronously; hop through a promise so rejects() sees it either way.
      () => Promise.resolve().then(() => make(dom).extractWithHoverRecords(
        [doc.querySelector('.c')],
        { t: { selector: '.a', read: 'hoverPopover', match: '(' } },
        { anchorSel: '.a' },
        async () => { calls++; return { hovered: true, htmlSnippet: HOVER_HTML }; },
        {}
      )),
      (e) => /match is not a valid regex/.test(String(e && e.message || e))
    );
    assert.equal(calls, 0);
  });
});

dual('#2 hover-read budget', ({ make }) => {
  const card = (doc) => doc.querySelector('.card');
  it('candidate hovers per field per container are capped at 3; caps land in diagnostics, NOT record keys (F9)', async () => {
    const { dom, doc } = makeDom('<div class="card">' +
      '<a class="a">1</a><a class="a">2</a><a class="a">3</a><a class="a">4</a><a class="a">5</a></div>');
    let calls = 0;
    const ops = make(dom);
    const out = await ops.extractWithHoverRecords(
      [card(doc)],
      { t: { selector: '.a', read: 'hoverPopover', multi: true } },
      { anchorSel: 'span.never' }, // no anchor-loop hovers
      async () => { calls++; return { hovered: true, htmlSnippet: HOVER_HTML }; },
      {}
    );
    assert.equal(calls, 3, 'field candidate hovers capped at 3');
    assert.equal(norm(out[0].t).length, 3);
    assert.ok(!('t__capped' in out[0]), 'no field__capped record key (schema pollution)');
    if (typeof ops.getHoverReadCapped === 'function') {
      assert.deepEqual(norm(ops.getHoverReadCapped()), { t: 2 });
    }
  });
  it('reuse: an element the anchor loop already hovered is NOT re-hovered', async () => {
    const { dom, doc } = makeDom('<div class="card"><a class="a" href="/x">anchor</a></div>');
    const hoveredEls = [];
    const out = await make(dom).extractWithHoverRecords(
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
    const { dom, doc } = makeDom('<div class="card"><span class="lbl">label</span><a class="a" href="/x">anchor</a></div>');
    const out = await make(dom).extractWithHoverRecords(
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
    const { dom, doc } = makeDom('<div class="card"><a class="b">1</a><a class="b">2</a><a class="b">3</a></div>');
    let calls = 0;
    const out = await make(dom).extractWithHoverRecords(
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

dual('#8 parity fixtures (mechanical-semantic shapes)', ({ make }) => {
  it('popoverText strip output matches the inline fixture expectation', async () => {
    const { dom, doc } = makeDom('<div id="card"><a class="a" href="/x">anchor</a></div>');
    const out = await make(dom).extractWithHoverRecords(
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
    const { dom, doc } = makeDom('<div id="card"><a class="a" href="/x">anchor</a></div>');
    const out = await make(dom).extractWithHoverRecords(
      [doc.getElementById('card')],
      { postTime: { selector: '.a', read: 'hoverPopover', match: '\\d{4} at .*?(AM|PM)' } },
      { anchorSel: '.a' },
      async () => ({ hovered: true, htmlSnippet: '<div>Shared · Friday, September 11, 2026 at 1:43 AM</div>' }),
      {}
    );
    assert.equal(out[0].postTime, 'Shared · Friday, September 11, 2026 at 1:43 AM');
    const out2 = await make(dom).extractWithHoverRecords(
      [doc.getElementById('card')],
      { postTime: { selector: '.a', read: 'hoverPopover', match: '^[0-9]+$' } },
      { anchorSel: '.a' },
      async () => ({ hovered: true, htmlSnippet: '<div>September 11, 2026</div>' }),
      {}
    );
    assert.strictEqual(out2[0].postTime, '');
  });
  it('invalid match throws with the rewrite teaching', () => {
    const { dom, doc } = makeDom('<div class="c"><a class="a">x</a></div>');
    assert.throws(
      () => make(dom).extractListRecords([doc.querySelector('.c')], { v: { selector: '.a', match: '(' } }, {}),
      /match is not a valid regex/
    );
  });
  it('array ordering preserved through match filtering', () => {
    const { dom, doc } = makeDom('<div class="c"><a href="/1">one</a><a href="/2">two</a><a href="/3">three</a></div>');
    const out = make(dom).extractListMultiRecords(
      [doc.querySelector('.c')],
      { t: { selector: 'a', multi: true, match: 't' } },
      {}
    );
    assert.deepEqual(norm(out[0].t), ['two', 'three']);
  });
});
