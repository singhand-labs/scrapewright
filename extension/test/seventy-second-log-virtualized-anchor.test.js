// Seventy-second log (2026-09-15, virtualized-anchor incident): the
// timestamp anchor hover was refused as anchor_not_hoverable with rect 0×0 —
// a VIRTUALIZED feed reclaimed the off-screen card's boxes while the nodes
// stayed attached; the popover could never mount; probe.timestamp returned
// partial-only labelledby candidates and the model concluded "no year exists
// anywhere on the page" (tool blindness quoted as page fact). Three fixes:
//
// G1 — remount retry for attached zero-box anchors: one ancestor-targeted
//      scrollIntoView + re-read before the degenerate-rect early-out fires;
//      domTimestamp scrolls the CONTAINER into view before enumeration.
// G2 — the anchor_not_hoverable budgetNote branches on cause: attached-but-
//      box-less (virtualization) teaches scroll+re-resolve; classic
//      display:none keeps the deterministic no-retry note.
// G3 — zero-hover negative firewall: when no hover actually dispatched and
//      candidates came only from non-popover sources, the result note gains
//      a NOTICE forbidding absence conclusions about popover-borne values.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { createProbeTools } = require('../lib/probe-tools');
const { createObservationLog } = require('../lib/observation-log');

const CS = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
const WU = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wizard-utils.js'), 'utf8');

function sliceFn(src, a, b) {
  const s = src.indexOf(a); assert.ok(s > -1, 'marker ' + a);
  const e = src.indexOf(b, s); assert.ok(e > s, 'end ' + b);
  return src.slice(s, e);
}
const HARVEST_DEPS_SRC =
  sliceFn(CS, 'function resolveLabelledbyText(', '\n  async function domLabelledby') +
  '\n' +
  sliceFn(CS, 'function harvestAnchorLabel(', '\n  async function domHover(')
  // 138th log: domHover consults the outer-deadline guard and the page-state
  // reader (starve branch). These tests pass no deadline and never starve, so
  // inert stubs preserve the pre-138 behavior they pin.
  + '\nfunction outerDeadlineExceeded(){return null}\nfunction readPageFrameState(){return {visibilityState:"visible",hasFocus:true}}';
const HOVER_SLICE = sliceFn(CS, 'async function domHover(', 'async function domExtractWithHover(');
const TS_SLICE = sliceFn(CS, 'var TS_MAX_HOVER_ANCHORS', '\n  async function domExists(');

// ---------------------------------------------------------------------------
// G1/G2: domHover remount retry + cause-branched budgetNote.
// ---------------------------------------------------------------------------

// Virtualized-card shape: anchor attached, own box reclaimed (0×0), parent
// wrapper still laid out (nonzero rect). When `recover` is true, scrolling
// the wrapper flips the anchor's rect — the virtualizer remounted the card.
function makeVirtualizedDom(recover) {
  const dom = new JSDOM(
    '<div id="wrap"><a id="anchor" class="a" href="/x">ts</a></div>',
    { url: 'https://example.com/page' }
  );
  const doc = dom.window.document;
  const anchor = doc.getElementById('anchor');
  const wrap = doc.getElementById('wrap');
  let recovered = false;
  anchor.scrollIntoView = function () {}; // the anchor's own scroll is a no-op
  wrap.getBoundingClientRect = function () { return { width: 500, height: 500, left: 0, top: 0 }; };
  wrap.scrollIntoView = function () { if (recover) recovered = true; };
  anchor.getBoundingClientRect = function () {
    return recovered
      ? { width: 120, height: 30, left: 40, top: 60 }
      : { width: 0, height: 0, left: 0, top: 0 };
  };
  return { dom, anchor, wrap };
}

function gateHoverContext(dom, anchor) {
  const sent = [];
  const diags = [];
  return {
    ctx: {
      document: dom.window.document,
      window: dom.window,
      Node: dom.window.Node,
      MutationObserver: dom.window.MutationObserver,
      Date: Date,
      setTimeout: (fn) => { fn(); },
      chrome: {
        runtime: {
          sendMessage: async (m) => {
            sent.push(m.type);
            // dispatch-failure shape: skips dwell + dismiss, returns fast —
            // the point under test is that the pipeline was ENTERED at all.
            return { dispatched: false, ok: false, reason: 'test-dispatch-refused' };
          }
        }
      },
      withTabActivation: async (label, fn) => fn(),
      notifyBackgroundDiagnostic: (name, payload) => { diags.push({ name, payload }); },
      sendDebugLog: () => {},
      querySelectorDeep: (sel) => (sel === '.a' ? { element: anchor } : null),
      querySelectorAllDeep: () => [anchor],
      isElementVisible: () => true,
      collectRejectedAddedTexts: () => [],
      collectRejectedAddedHtml: () => [],
      harvestAnchorLabel: () => null,
      popoverIdentityOf: () => ({ tag: 'DIV' })
    },
    sent,
    diags
  };
}

function loadHover(ctx) {
  vm.createContext(ctx);
  vm.runInContext(HARVEST_DEPS_SRC + '\n' + HOVER_SLICE + '\nthis.__domHover = domHover;', ctx);
  return ctx.__domHover;
}

describe('seventy-second log G1: remount retry for attached zero-box anchors', () => {
  it('scroll-recovers: ancestor scrollIntoView brings the box back → hover pipeline proceeds', async () => {
    const { dom, anchor } = makeVirtualizedDom(true);
    const { ctx, sent, diags } = gateHoverContext(dom, anchor);
    const hoverFn = loadHover(ctx);
    const r = await hoverFn('.a', null, { timeoutMs: 200 });
    assert.ok(sent.includes('TRUSTED_HOVER_REQUEST'),
      'the trusted dispatch was reached (no anchor_not_hoverable early-out): ' + JSON.stringify(sent));
    assert.notEqual(r.reason, 'anchor_not_hoverable');
    const req = diags.find((d) => d.name === 'hover_request');
    assert.ok(req, 'a dispatch-shaped hover_request diagnostic was emitted');
    assert.equal(typeof req.payload.hoverX, 'number');
    assert.equal(typeof req.payload.hoverY, 'number');
  });

  it('retry fails (box never returns) → early-out WITH the attached reasonDetail', async () => {
    const { dom, anchor } = makeVirtualizedDom(false);
    const { ctx, sent } = gateHoverContext(dom, anchor);
    const hoverFn = loadHover(ctx);
    const r = await hoverFn('.a', null, { timeoutMs: 200 });
    assert.equal(r.reason, 'anchor_not_hoverable');
    assert.equal(r.reasonDetail, 'attached, box-less after scroll retry (virtualized or hidden subtree)');
    assert.equal(sent.length, 0, 'no CDP dispatch for a still-box-less anchor');
  });

  it('classic display:none shape (no ancestor with a box) → early-out as today, original note', async () => {
    // No wrapper rect stub → every ancestor is 0×0 (JSDOM is layout-free),
    // the walk finds no remount target, no scroll is attempted: the
    // deterministic display:none note must survive.
    const dom = new JSDOM(
      '<span id="vis">June 21</span><span id="tip" style="display:none">June 21, 2024</span>' +
      '<a id="anchor" class="a" href="/x" aria-labelledby="vis tip" style="display:none">x</a>',
      { url: 'https://example.com/page' }
    );
    const anchor = dom.window.document.getElementById('anchor');
    anchor.scrollIntoView = function () {};
    const { ctx, sent } = gateHoverContext(dom, anchor);
    const hoverFn = loadHover(ctx);
    const r = await hoverFn('.a', null, { timeoutMs: 200 });
    assert.equal(r.reason, 'anchor_not_hoverable');
    assert.equal(r.reasonDetail, null, 'no retry was attempted → no attached detail');
    assert.match(r.budgetNote, /display:none or zero size/i);
    assert.match(r.budgetNote, /do NOT retry/i);
    assert.equal(sent.length, 0);
  });
});

describe('seventy-second log G2: budgetNote branches on cause', () => {
  it('attached-but-box-less note teaches scroll + RE-RESOLVE (and contrasts display:none)', async () => {
    const { dom, anchor } = makeVirtualizedDom(false);
    const { ctx } = gateHoverContext(dom, anchor);
    const r = await loadHover(ctx)('.a', null, { timeoutMs: 200 });
    assert.match(r.budgetNote, /attached but rendered box-less/i);
    assert.match(r.budgetNote, /virtualized cards reclaim boxes/i);
    assert.match(r.budgetNote, /RE-RESOLVE the anchor/i);
    assert.match(r.budgetNote, /re-query after scroll/i);
    assert.match(r.budgetNote, /pick a different, visible anchor/i);
  });

  it('SCRIPT_DSL_GUIDE ANCHOR MUST HAVE A BOX rule carries the virtualization exception', () => {
    const idx = WU.indexOf('ANCHOR MUST HAVE A BOX');
    assert.ok(idx > -1);
    const line = WU.slice(idx, idx + 1200);
    assert.match(line, /attached-but-box-less/i);
    assert.match(line, /virtualized/i);
    assert.match(line, /RE-RESOLVE the anchor/i);
    assert.match(line, /automatic scroll-retry/i);
  });
});

// ---------------------------------------------------------------------------
// G1 (domTimestamp container scroll) + G3 (zero-hover negative firewall).
// ---------------------------------------------------------------------------

const TS_CARD_HTML = '<div id="card">' +
  '<span id="lb">2 August</span>' +
  '<a id="tsa" aria-labelledby="lb">ts</a></div>';

function makeTs(domHoverImpl, advanceMs) {
  const dom = new JSDOM(TS_CARD_HTML, { url: 'https://e.com/p' });
  const card = dom.window.document.getElementById('card');
  const scrolls = [];
  card.scrollIntoView = function () { scrolls.push(1); };
  let fakeNow = 0;
  const ctx = {
    document: dom.window.document,
    querySelectorAllDeep: (sel) => (sel === '#card' ? [card] : []),
    notifyBackgroundDiagnostic: () => {}, sendDebugLog: () => {},
    setTimeout: (fn) => { fn(); },
    domHover: async (...a) => { const r = domHoverImpl(...a); fakeNow += advanceMs; return r; },
    Date: { now: () => fakeNow }
  };
  vm.createContext(ctx);
  vm.runInContext(HARVEST_DEPS_SRC + '\n' + TS_SLICE + '\nthis.__ts = domTimestamp;', ctx);
  return { ts: ctx.__ts, scrolls };
}

describe('seventy-second log G1: domTimestamp scrolls the container first', () => {
  it('container.scrollIntoView is called before anchor enumeration', async () => {
    const { ts, scrolls } = makeTs(async () => ({ hovered: true, hoverDispatched: true, htmlSnippet: '<div>August 2, 2026</div>' }), 10);
    const r = await ts('#card', {});
    assert.ok(scrolls.length >= 1, 'container scrolled into view before enumeration');
    assert.ok(r.result);
  });
});

describe('seventy-second log G3: zero-hover negative firewall', () => {
  const REFUSED = () => ({ hovered: false, htmlSnippet: null, hoverDispatched: false, reason: 'anchor_not_hoverable' });

  it('domTimestamp: all hovers refused + labelledby-only candidates → NOTICE present', async () => {
    const { ts } = makeTs(REFUSED, 10);
    const r = await ts('#card', {});
    // The 72nd-log shape: hoversDispatched counts ATTEMPTS (>0) yet none
    // actually dispatched — the notice is the firewall.
    assert.ok(r.result.hoversDispatched >= 1);
    assert.ok(r.result.candidates.length >= 1, 'labelledby "2 August" candidate exists');
    assert.match(r.result.note, /NOTICE: zero anchors were actually hovered this call/);
    assert.match(r.result.note, /popover route is UNVERIFIED/);
    assert.match(r.result.note, /do NOT conclude the page lacks a popover-borne value/);
  });

  it('domTimestamp: one popover capture → NOTICE absent', async () => {
    const { ts } = makeTs(async () => ({ hovered: true, hoverDispatched: true, htmlSnippet: '<div>August 2, 2026</div>' }), 10);
    const r = await ts('#card', {});
    assert.ok(!/NOTICE: zero anchors/.test(r.result.note || ''), 'a real hover silences the firewall');
  });

  it('domTimestamp: no candidates at all → NOTICE absent (the no-date note owns that case)', async () => {
    const dom = new JSDOM('<div id="card"><a id="tsa">x</a></div>', { url: 'https://e.com/p' });
    const card = dom.window.document.getElementById('card');
    card.scrollIntoView = function () {};
    const ctx = {
      document: dom.window.document,
      querySelectorAllDeep: (sel) => (sel === '#card' ? [card] : []),
      notifyBackgroundDiagnostic: () => {}, sendDebugLog: () => {},
      setTimeout: (fn) => { fn(); },
      domHover: async () => REFUSED(),
      Date: { now: () => 0 }
    };
    vm.createContext(ctx);
    vm.runInContext(HARVEST_DEPS_SRC + '\n' + TS_SLICE + '\nthis.__ts = domTimestamp;', ctx);
    const r = await ctx.__ts('#card', {});
    assert.equal(r.result.candidates.length, 0);
    assert.ok(!/NOTICE: zero anchors/.test(r.result.note || ''));
  });

  it('probe.timestamp: all hovercards {hovered:false, anchor_not_hoverable} + labelledby candidate → NOTICE', async () => {
    const observationLog = createObservationLog();
    const tools = createProbeTools({
      executeDsl: async () => [{
        __t_label: '2 August',
        __t_aria: '',
        __t_text: 'ts',
        hovercards: [{ hovered: false, hoverDispatched: false, reason: 'anchor_not_hoverable', labelledbyText: '2 August' }]
      }],
      observationLog
    });
    const r = await tools.timestamp({ containerSel: '#card' });
    assert.ok(r.candidates.length >= 1, 'labelledby candidate present');
    assert.match(r.note, /NOTICE: zero anchors were actually hovered this call/);
    assert.match(r.note, /popover route is UNVERIFIED/);
    assert.match(r.note, /inspect manually with probe\.hover before claiming absence/);
  });

  it('probe.timestamp: one hovered entry with popoverText → NOTICE absent', async () => {
    const observationLog = createObservationLog();
    const tools = createProbeTools({
      executeDsl: async () => [{
        __t_label: '2 August',
        __t_aria: '',
        __t_text: 'ts',
        hovercards: [
          { hovered: false, hoverDispatched: false, reason: 'anchor_not_hoverable' },
          { hovered: true, hoverDispatched: true, htmlSnippet: '<div>August 2, 2026 at 3:15 PM</div>' }
        ]
      }],
      observationLog
    });
    const r = await tools.timestamp({ containerSel: '#card' });
    assert.match(r.absolute, /^August 2, 2026/);
    assert.ok(!/NOTICE: zero anchors/.test(r.note || ''), 'popover evidence silences the firewall');
  });
});

// ---------------------------------------------------------------------------
// Universality guard over the new strings.
// ---------------------------------------------------------------------------

describe('seventy-second log universality guard', () => {
  const FORBIDDEN = /facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i;
  const strings = () => {
    const g1 = HOVER_SLICE.indexOf('G1 (seventy-second log)');
    const tg1 = TS_SLICE.indexOf('G1 (seventy-second log)');
    const tg3 = TS_SLICE.indexOf('G3 (seventy-second log)');
    const wu = WU.indexOf('ANCHOR MUST HAVE A BOX');
    assert.ok(g1 > -1 && tg1 > -1 && tg3 > -1 && wu > -1, 'new markers present in sources');
    return [
      HOVER_SLICE.slice(g1, g1 + 3400),
      TS_SLICE.slice(tg1, tg1 + 2200),
      TS_SLICE.slice(tg3, tg3 + 1800),
      WU.slice(wu, wu + 1600)
    ];
  };
  it('the new gate/note strings carry no site tokens', () => {
    for (const s of strings()) {
      assert.ok(!FORBIDDEN.test(s), 'site token in new code string: ' + String(s).slice(0, 120));
    }
  });
});
