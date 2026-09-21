// Hundred-third log: the hover debug panel (101c build) let the user compare
// the relayed capture against the screen — five repeated observations named
// the gap: "rejectedAddedTexts 里的恰是弹窗内容，应该将其对应 html dom 片段
// 作为扩展信息". The trusted hover DOES mount the popover (post-escalation the
// pick is the hovercard itself), but:
//   (a) the popover's text-bearing leaf nodes each clear the <50px size gate
//       never — one-line strips/categories/bio lines are too_small rejects,
//       their TEXT was collected (24th/90th logs) but their HTML discarded;
//   (b) result.rejectedAddedTexts only attached when NO popover was picked
//       (!htmlSnippet gate) — whenever the picker captured the big hovercard
//       the rejected evidence was dropped from the result AND hovercards,
//       while the content sat buried in the htmlSnippet's SVG noise;
//   (c) testMatchValue guards predicates at 2000 chars — content deeper than
//       2000 chars into the picked htmlSnippet can NEVER be match-bound, so
//       read:'hoverPopover' fields need small text-dense fragments to search.
// Fix: collect rejectedAddedHtml (≤4×2000, text-bearing only, subset-dedupe)
// in the dwell window; attach UNGATED; forward onto hovercards (both mirrors);
// the mechanical hover-read path searches [picked html → fragments → texts]
// until applyMatch actually hits.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { loadInline, readSrc } = require('./helpers/inline-ops-factory.js');

const SRC = readSrc('content-script.js');
const LEO = readSrc('lib/list-extract-ops.js');
const WU = readSrc('lib/wizard-utils.js');
const ST = readSrc('lib/session-tools.js');
const PT = readSrc('lib/probe-tools.js');

function sliceFnFrom(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start > -1, name + ' must be defined');
  let depth = 0, i = start;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i + 1);
}

function evalWithDom(fnSrc, document) {
  const factory = new Function('document', 'return (' + fnSrc + ')');
  return factory(document);
}

function sliceDomHover() {
  const start = SRC.indexOf('async function domHover(');
  const end = SRC.indexOf('async function domOpenTab(', start);
  assert.ok(start > -1 && end > start, 'domHover must be sliceable');
  return SRC.slice(start, end);
}

describe('hundred-third log: collectRejectedAddedHtml behavior', () => {
  function makeDom() {
    const dom = new JSDOM(
      '<div id="w1"><span>July 17, 2026 at 3:42 PM</span></div>' +
      '<div id="w2"><svg></svg></div>' +
      '<div id="w3"><span>July 17, 2026 at 3:42 PM</span></div>' +
      '<div id="w4"><span>Page · Tech · Education</span></div>' +
      '<div id="w5"><span>Shared with Public</span></div>' +
      '<div id="w6"><span>1.2K members</span></div>');
    return dom.window.document;
  }
  it('keeps only text-bearing fragments, skips exact-duplicate text, caps at 4', () => {
    const d = makeDom();
    const fn = evalWithDom(sliceFnFrom(SRC, 'collectRejectedAddedHtml'), d);
    const out = fn(['w1', 'w2', 'w3', 'w4', 'w5', 'w6'].map((id) => d.getElementById(id)));
    assert.ok(Array.isArray(out), 'returns an array');
    assert.equal(out.length, 4, 'w2 (no text) skipped, w3 (dup of w1) skipped, 4-cap — got ' + JSON.stringify(out.map((h) => h.slice(0, 60))));
    assert.match(out[0], /^<div id="w1"/, 'fragments are serialized HTML');
    assert.ok(out.some((h) => /1\.2K members/.test(h)), 'later distinct fragments kept within the cap');
  });
  it('keeps a superset fragment after its subset (lossless order rule), skips subsets', () => {
    const dom = new JSDOM(
      '<div id="leaf"><span>September 11, 2026</span></div>' +
      '<div id="wrap"><span>Shared · September 11, 2026 at 5:30 PM</span></div>' +
      '<div id="part"><span>September 11, 2026</span></div>');
    const d = dom.window.document;
    const fn = evalWithDom(sliceFnFrom(SRC, 'collectRejectedAddedHtml'), d);
    const out = fn([d.getElementById('leaf'), d.getElementById('wrap'), d.getElementById('part')]);
    assert.equal(out.length, 2, 'subset-after-superset (part) skipped; the superset wrapper is kept so no text is lost');
    assert.match(out[1], /at 5:30 PM/, 'the superset carries the fuller text');
  });
  it('caps each fragment at 2000 chars with a disclosed marker', () => {
    const dom = new JSDOM('<div id="big"><span>' + 'x'.repeat(4000) + '</span></div>');
    const fn = evalWithDom(sliceFnFrom(SRC, 'collectRejectedAddedHtml'), dom.window.document);
    const out = fn([dom.window.document.getElementById('big')]);
    assert.equal(out.length, 1);
    assert.ok(out[0].length <= 2100, 'capped near 2000, got ' + out[0].length);
    assert.match(out[0], /capped at 2000/);
  });
});

describe('hundred-third log: domHover attaches rejected evidence UNGATED (source audit)', () => {
  it('collects rejectedAddedHtml beside the texts collector, both BEFORE the dismiss', () => {
    const body = sliceDomHover();
    assert.match(body, /collectRejectedAddedHtml\(rejectedAddedNodes\)/, 'html collector wired');
    const htmlIdx = body.indexOf('collectRejectedAddedHtml(rejectedAddedNodes)');
    const dismissIdx = body.indexOf('TRUSTED_HOVER_DISMISS');
    assert.ok(htmlIdx > -1 && dismissIdx > htmlIdx, 'html sampled inside the dwell window (nodes unmount on mouseout)');
  });
  it('rejectedAddedTexts/rejectedAddedHtml attach whenever non-empty — the !htmlSnippet gate is GONE', () => {
    const body = sliceDomHover();
    assert.match(body, /if \(rejectedAddedTexts\.length\) \{\s*\n\s*result\.rejectedAddedTexts = rejectedAddedTexts;/,
      'the 102nd-live incident: the picked hovercard buried the content under SVG noise while the rejected evidence was dropped');
    assert.match(body, /result\.rejectedAddedHtml = rejectedAddedHtml;/, 'html fragments ride the result');
  });
  it('rejectedAddedNote keeps its no-popover-specific gate and teaching', () => {
    const body = sliceDomHover();
    assert.match(body, /if \(!htmlSnippet && rejectedAddedTexts\.length\) \{[\s\S]*?rejectedAddedNote/,
      'the note text is about the NO-POPOVER path; it stays there');
  });
  it('debug panel payload carries rejectedAddedHtml so the user can compare', () => {
    const body = sliceDomHover();
    assert.match(body, /rejectedAddedHtml: rejectedAddedHtml \|\| \[\]/, 'panel texts include the fragments');
  });
});

function noisePopoverHtml(len) {
  return '<div class="popover-noise">' + ('<svg class="x"><circle cx="1" cy="1" r="1"></circle></svg>'.repeat(Math.ceil(len / 52))) + '<span>Page</span></div>';
}

function hoverWithFragment() {
  return {
    hovered: true,
    htmlSnippet: noisePopoverHtml(2600),
    rejectedAddedHtml: [
      '<div role="tooltip"><span>Shared · September 11, 2026 at 5:30 PM</span></div>'
    ],
    rejectedAddedTexts: ['Shared · September 11, 2026 at 5:30 PM']
  };
}

describe('hundred-third log: mechanical hover-read path searches the fragments (lib)', () => {
  const { extractWithHoverRecords } = require('../lib/list-extract-ops.js');
  function makeCard(html) {
    const dom = new JSDOM(html || '<div class="card"><a class="a" href="/x">anchor</a></div>', { url: 'https://example.com/p' });
    const card = dom.window.document.querySelector('.card');
    const a = dom.window.document.querySelector('.a');
    a.getBoundingClientRect = () => ({ left: 10, top: 10, width: 50, height: 20, right: 60, bottom: 30 });
    return { dom, card };
  }
  it('hovercards forward rejectedAddedHtml (capped at 3×1200)', async () => {
    const { dom, card } = makeCard();
    const long = '<div role="tooltip">' + 'y'.repeat(1500) + '</div>';
    const out = await extractWithHoverRecords(
      [card],
      { t: { selector: '.a' } },
      { anchorSel: '.a' },
      async () => Object.assign(hoverWithFragment(), { rejectedAddedHtml: [long, '<div>second</div>'] }),
      {}
    );
    const hc = out[0].hovercards[0];
    assert.ok(Array.isArray(hc.rejectedAddedHtml) && hc.rejectedAddedHtml.length === 2, 'forwarded');
    assert.ok(hc.rejectedAddedHtml[0].length <= 1300 && /capped/.test(hc.rejectedAddedHtml[0]), 'per-fragment cap with marker');
  });
  it("read:'hoverPopover' + match binds the date from a fragment when the picked html misses (match guard hides >2000-char-deep content)", async () => {
    const { dom, card } = makeCard();
    const out = await extractWithHoverRecords(
      [card],
      { postTime: { selector: '.a', read: 'hoverPopover', match: 'September 11, 2026' } },
      { anchorSel: '.a' },
      hoverWithFragment,
      {}
    );
    assert.match(out[0].postTime, /September 11, 2026 at 5:30 PM/,
      'the picked htmlSnippet is noise >2000 chars — only the fragment can carry the date; got ' + JSON.stringify(out[0].postTime));
  });
  it("scalar fallback searches OTHER hovercards' fragments (and texts) until the match actually hits", async () => {
    const { dom, card } = makeCard('<div class="card"><a class="a" href="/x">anchor</a><abbr class="ts">3 days ago</abbr></div>');
    const out = await extractWithHoverRecords(
      [card],
      { postTime: { selector: '.ts', read: 'hoverPopover', match: 'September 11, 2026' } },
      { anchorSel: '.a' },
      async (el) => ((el && el.className === 'a') ? hoverWithFragment() : { hovered: false, htmlSnippet: null, reason: 'popover_timeout' }),
      {}
    );
    assert.match(out[0].postTime, /September 11, 2026/,
      "the .ts candidate's own hover timed out; the anchor-loop hovercard's fragment must rescue the field");
  });
});

describe('hundred-third log: inline mirror parity (content-script factory)', () => {
  it("read:'hoverPopover' binds from a fragment through the inline mirror too", async () => {
    const dom = new JSDOM('<div class="card"><a class="a" href="/x">anchor</a></div>', { url: 'https://example.com/p' });
    const card = dom.window.document.querySelector('.card');
    const a = dom.window.document.querySelector('.a');
    a.getBoundingClientRect = () => ({ left: 10, top: 10, width: 50, height: 20, right: 60, bottom: 30 });
    const ops = loadInline(dom);
    const out = await ops.extractWithHoverRecords(
      [card],
      { postTime: { selector: '.a', read: 'hoverPopover', match: 'September 11, 2026' } },
      { anchorSel: '.a' },
      hoverWithFragment,
      {}
    );
    assert.match(out[0].postTime, /September 11, 2026/);
    assert.ok(Array.isArray(out[0].hovercards[0].rejectedAddedHtml), 'inline hovercards forward the fragments');
  });
  it('source audit: lib + inline both carry rejectedAddedHtml (drift guard)', () => {
    assert.match(LEO, /rejectedAddedHtml/);
    assert.match(SRC, /rejectedAddedHtml/);
  });
});

describe('hundred-third log: receipts + docs name the fragment channel', () => {
  it('probe layer forwards rejectedAddedHtml from the hover result', () => {
    assert.match(PT, /rejectedAddedHtml/, 'probe.hover receipt carries the fragments');
  });
  it('DSL guide + probe.hover spec mention rejectedAddedHtml', () => {
    assert.match(WU, /rejectedAddedHtml/, 'SCRIPT_DSL_GUIDE $hover line names the field');
    assert.match(ST, /rejectedAddedHtml/, 'session-tools spec names the field');
  });
  it('no site tokens in the new channel (universality)', () => {
    const idx = SRC.indexOf('function collectRejectedAddedHtml');
    const block = SRC.slice(idx, SRC.indexOf('\n  function ', idx + 10));
    assert.ok(!/facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i.test(block), 'collector stays site-agnostic');
  });
});
