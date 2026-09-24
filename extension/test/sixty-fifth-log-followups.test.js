// Sixty-fifth log (2026-09-11 17:02-19:07, session rs-1789117334182-1,
// glm-5.3, FB search, wallClock death at turn 57 with LAST VERIFY FAILED —
// posts.postTime 9/10 empty). The user's report: "some turns visibly popped
// user/group hovercards AND the postTime tooltip on screen — why was time
// considered unextracted?"
//
// The four hypotheses, adjudicated from evidence:
//   - "didn't wait for rendering?" — secondary: labelledby reference chains
//     genuinely do not resolve on freshly-opened verify tabs (field
//     diagnostics show the selector MATCHING with the value still empty),
//     but the anchor's visible text and the popover were available.
//   - "info not returned in time?" — NO: the SW log shows 12+ tooltip-sized
//     popover captures (4553-5972 px²) during the v8 window; the framework
//     returned the htmlSnippet faithfully and the step script DISCARDED it
//     (`try { await $hover(...) } catch {}` — fire-and-forget).
//   - "wrong DOM fragment?" — NO: container/anchor selectors matched
//     (extractList diagnostics: "field timeTexts … 1 matches").
//   - "tools inadequate?" — THE ROOT CAUSE: the step DSL had no one-call
//     timestamp primitive (probe.timestamp exists research-side only). The
//     model hand-rolled EIGHT artifact versions of the candidate dance:
//     labelledby-only (empty cold), then anchor visible-text unions (junk
//     from media anchors — the TIME_FIELD_IMPLAUSIBLE tags at v5/v6 were
//     flagging "d͏r͏e͏o͏n͏p͏t͏" / "PHUpmG4r6.comC"), then junk-filtered to
//     emptiness at v7/v8 after the reliable sources were dropped.
//
// Fix under test: $timestamp(containerSel, {anchorSel?, timeoutMs?,
// index?}) — the twenty-first DSL primitive. Per card: labelledby +
// aria-label + VISIBLE TEXT (survives cold mount) + the hover-mounted
// popover's own text (up to 3 anchors, hovering stops once an absolute is
// found), date-shape filtered, ABSOLUTE preferred. Mirrors wizard-utils
// extractDateSubstrings (sixty-fourth log) via a CS copy pinned by a
// drift-guard.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { extractDateSubstrings } = require('../lib/wizard-utils');

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function sliceFn(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start > -1, 'marker not found: ' + startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, 'end marker not found after start: ' + endMarker);
  return source.slice(start, end);
}

const CS_SRC = readSrc('content-script.js');
const TS_SLICE = sliceFn(CS_SRC, 'var TS_MAX_HOVER_ANCHORS', '\n  async function domExists(');
const HARVEST_SLICE =
  sliceFn(CS_SRC, 'function resolveLabelledbyText(', '\n  async function domLabelledby') + '\n' +
  sliceFn(CS_SRC, 'function harvestAnchorLabel(', '\n  async function domHover(');

// ---------------------------------------------------------------------------
// Drift guard: the CS copy must behave identically to the wizard-utils
// original (the RC8/RC35 inline-mirror drift class).
// ---------------------------------------------------------------------------

describe('sixty-fifth log: extractDateSubstringsCS drift guard', () => {
  const CORPUS = [
    'Shared with Public · Friday, September 11, 2026 at 1:43 AM',
    'Posted 2024-03-05 14:30 via API',
    'due 3/9/2026 2:30 PM',
    '发布于 2026年6月25日 10:30',
    '发布于 2026年6月25日',
    '4 hours ago and 3天前',
    'Ng6cOb30.comCatThis week mathematicians used AI to solve the first Millennium Prize Problem in 20 years—the field’s gr',
    'solve the first Millennium Prize Problem in 20 years',
    'Like: 179 people · 12 comments · 3 shares',
    'August 23 at 5:30 PM',
    ''
  ];

  it('CS copy === wizard-utils original on the corpus', () => {
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(TS_SLICE + '\nthis.__fn = extractDateSubstringsCS;', ctx);
    for (const c of CORPUS) {
      const vmOut = JSON.parse(JSON.stringify(ctx.__fn(c)));
      assert.deepEqual(vmOut, extractDateSubstrings(c), 'drift on input: ' + JSON.stringify(c.slice(0, 50)));
    }
  });
});

// ---------------------------------------------------------------------------
// domTimestamp behavioral.
// ---------------------------------------------------------------------------

function makeCardDom(extraAnchor) {
  const dom = new JSDOM(
    '<div id="card">' +
    '<a class="ts" href="?__cft=x" aria-labelledby="tl"><span id="tl">3 days ago</span></a>' +
    (extraAnchor || '<a class="ts2" href="?y">2 hours ago</a>') +
    '</div>',
    { url: 'https://example.com/page' }
  );
  return dom;
}

function tsContext(dom, hoverImpl) {
  const diags = [];
  const card = dom.window.document.getElementById('card');
  const ctx = {
    document: dom.window.document,
    querySelectorAllDeep: (sel) => (sel === '#card' ? [card] : []),
    notifyBackgroundDiagnostic: (name, payload) => { diags.push({ name, payload }); },
    domHover: hoverImpl,
    sendDebugLog: () => {}
  };
  vm.createContext(ctx);
  vm.runInContext(HARVEST_SLICE + '\n' + TS_SLICE + '\nthis.__ts = domTimestamp;', ctx);
  return { ctx, diags };
}

describe('sixty-fifth log: $timestamp primitive', () => {
  it('popover text wins as the ABSOLUTE; visible text is the cold-tab fallback', async () => {
    const dom = makeCardDom();
    let hovers = 0;
    const { ctx } = tsContext(dom, async () => {
      hovers += 1;
      return {
        hovered: true,
        htmlSnippet: '<div role="tooltip"><div>Shared with Public</div><div>Friday, September 11, 2026 at 1:43 AM</div></div>'
      };
    });
    const r = await ctx.__ts('#card', { anchorSel: '.ts, .ts2' });
    assert.equal(r.result.absolute, 'September 11, 2026 at 1:43 AM');
    assert.equal(r.result.absoluteSource, 'popoverText');
    assert.equal(r.result.value, 'September 11, 2026 at 1:43 AM');
    assert.equal(r.result.relative, '3 days ago');
    assert.equal(hovers, 1, 'hovering STOPS once an absolute candidate exists — the second anchor costs nothing');
    assert.equal(r.result.hoversDispatched, 1);
  });

  it('cold tab (no popover mounts): the anchor VISIBLE TEXT carries the value', async () => {
    const dom = makeCardDom();
    const { ctx } = tsContext(dom, async () => ({ hovered: false, htmlSnippet: null, reason: 'no_hover_signal_early_exit' }));
    const r = await ctx.__ts('#card', { anchorSel: '.ts, .ts2', timeoutMs: 4500 });
    assert.equal(r.result.absolute, null);
    assert.equal(r.result.value, '3 days ago');
    assert.ok(r.result.candidates.some((c) => c.source === 'text' && c.value === '3 days ago'),
      'the visible-text source is what survives a cold tab');
  });

  it('duration-mentioning masquerade prose yields NOTHING (not even relative)', async () => {
    const dom = makeCardDom('<a class="ts2" href="?y">Ng6cOb30.comCatThis week mathematicians used AI to solve the first Millennium Prize Problem in 20 years—the field’s gr</a>');
    dom.window.document.querySelector('.ts').textContent = '';
    const { ctx } = tsContext(dom, async () => ({ hovered: false, htmlSnippet: null }));
    const r = await ctx.__ts('#card', { anchorSel: '.ts2' });
    assert.equal(r.result.value, '');
    assert.equal(r.result.candidates.length, 0);
    assert.match(r.result.note, /no date-shaped value/);
  });

  it('missing container returns the honest ELEMENT_NOT_FOUND error shape', async () => {
    const dom = makeCardDom();
    const { ctx } = tsContext(dom, async () => ({ hovered: false, htmlSnippet: null }));
    const r = await ctx.__ts('#nope', {});
    assert.match(r.result.error, /ELEMENT_NOT_FOUND/);
  });

  it('hover anchor budget caps at 3 even with many anchors and no absolute', async () => {
    const dom = new JSDOM(
      '<div id="card">' +
      Array.from({ length: 6 }, (_, i) => '<a class="t" href="?x' + i + '">' + (i + 1) + ' hours ago</a>').join('') +
      '</div>',
      { url: 'https://example.com/page' }
    );
    let hovers = 0;
    const { ctx } = tsContext(dom, async () => { hovers += 1; return { hovered: false, htmlSnippet: null }; });
    const r = await ctx.__ts('#card', { anchorSel: '.t' });
    assert.equal(r.result.anchorsProbed, 6);
    assert.equal(hovers, 3, 'TS_MAX_HOVER_ANCHORS bounds the dwell spend');
    assert.equal(r.result.value, '1 hours ago');
  });
});

// ---------------------------------------------------------------------------
// Wiring + universality.
// ---------------------------------------------------------------------------

describe('sixty-fifth log: wiring + universality', () => {
  it('sandbox exposes $timestamp; the DOM_REQUEST dispatch routes to domTimestamp', () => {
    const sandboxSrc = readSrc('sandbox.js');
    assert.match(sandboxSrc, /window\.\$timestamp = \(sel, opts\) => legacySend\('timestamp', sel, \[opts \|\| \{\}\]\)/); // 141st: window bag routes via legacySend
    assert.match(CS_SRC, /case 'timestamp':[\s\S]{0,200}domTimestamp\(data\.selector/);
  });

  it('SCRIPT_DSL_GUIDE documents $timestamp with the do-not-hand-roll teaching', () => {
    const src = readSrc('lib/wizard-utils.js');
    const idx = src.indexOf('$timestamp(containerSel, {anchorSel?, timeoutMs?, index?})');
    assert.ok(idx > -1);
    const block = src.slice(idx, idx + 1600);
    assert.match(block, /VISIBLE TEXT/);
    assert.match(block, /absolute preferred|ABSOLUTE preferred/i);
    assert.match(block, /do NOT hand-roll/i);
    assert.match(block, /600-1600ms/);
  });

  it('universality: the new primitive strings carry no site tokens', () => {
    const FORBIDDEN = /facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i;
    assert.ok(!FORBIDDEN.test(TS_SLICE));
    const guide = readSrc('lib/wizard-utils.js');
    const idx = guide.indexOf('$timestamp(containerSel, {anchorSel?, timeoutMs?, index?})');
    assert.ok(!FORBIDDEN.test(guide.slice(idx, idx + 1600)));
  });
});
