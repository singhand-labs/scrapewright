// Twenty-fourth log: $hover returned {hovered:true, htmlSnippet:undefined,
// reason:'popover_timeout'} while the hover HAD mounted tooltip scaffolding —
// three ADDED divs rejected by the visual filter as `too_small` (1423x0 /
// 201x0). The full date text was very plausibly inside those zero-height
// wrappers, fully READABLE (textContent ignores layout), but the failure
// result carried no evidence — so the model spent 14 script variants and
// ~10 verify rounds blind, and the user watched the same author-anchor
// hovers repeat with nothing changing.
//
// Fix (same shape as the twenty-third log's $exists falsification): a
// no-popover hover result carries rejectedAddedTexts — text READ out of
// the hover-mounted nodes the visibility/size filter rejected — plus a
// note teaching that hidden/zero-height content is readable and the field
// can be bound directly from those strings.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');

function sliceFn(name) {
  const start = SRC.indexOf('function ' + name + '(');
  assert.ok(start > -1, name + ' must be defined in content-script.js');
  let depth = 0, i = start;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return SRC.slice(start, i + 1);
}

function evalWithDom(fnSrc, document) {
  const factory = new Function('document', 'return (' + fnSrc + ')');
  return factory(document);
}

function domWithTooltipWrappers() {
  const dom = new JSDOM('<div id="w1"><span>July 17, 2026 at 3:42 PM</span></div>' +
    '<div id="w2"><svg></svg></div>' +
    '<div id="w3"><span>   July   17, 2026    at 3:42   PM  </span></div>' +
    '<div id="w4"><span>September 2, 2026 at 8:00 AM</span></div>' +
    '<div id="w5"><span>October 5, 2026 at 9:15 AM</span></div>');
  const d = dom.window.document;
  // zero-height wrappers (the too_small rejects) — layout state is irrelevant
  // to textContent, but stub rects anyway for realism
  for (const id of ['w1', 'w2', 'w3', 'w4', 'w5']) {
    d.getElementById(id).getBoundingClientRect = () => ({ width: 201, height: 0, left: 0, top: 0, right: 201, bottom: 0 });
  }
  return d;
}

describe('twenty-fourth log: collectRejectedAddedTexts behavior', () => {
  it('reads text out of zero-height wrappers, dedupes, caps length and count', () => {
    const fn = evalWithDom(sliceFn('collectRejectedAddedTexts'), domWithTooltipWrappers());
    const d = domWithTooltipWrappers();
    const nodes = ['w1', 'w2', 'w3', 'w4', 'w5'].map((id) => d.getElementById(id));
    const out = fn(nodes);
    assert.ok(Array.isArray(out), 'returns an array');
    assert.equal(out.length, 3, 'max 3 samples (w2 svg has no text, w3 is a whitespace variant of w1) — got ' + JSON.stringify(out));
    assert.equal(out[0], 'July 17, 2026 at 3:42 PM', 'whitespace normalized');
    assert.ok(out.indexOf('July 17, 2026 at 3:42 PM') === 0, 'dedup keeps the first occurrence');
    assert.equal(out.filter((t) => /September|October/.test(t)).length, 2, 'later distinct texts kept within the 3-cap');
  });

  it('caps each sample at 120 chars with an ellipsis marker', () => {
    const dom = new JSDOM('<div id="big"><span>' + 'x'.repeat(400) + '</span></div>');
    const fn = evalWithDom(sliceFn('collectRejectedAddedTexts'), dom.window.document);
    const out = fn([dom.window.document.getElementById('big')]);
    assert.equal(out.length, 1);
    assert.ok(out[0].length <= 122, 'sample capped near 120 chars, got ' + out[0].length);
    assert.match(out[0], /…$/);
  });

  it('skips empty/whitespace-only and non-element inputs defensively', () => {
    const d = domWithTooltipWrappers();
    const fn = evalWithDom(sliceFn('collectRejectedAddedTexts'), d);
    assert.deepEqual(fn([]), []);
    assert.deepEqual(fn([null, undefined, d.createTextNode('nope')]), []);
    assert.deepEqual(fn([d.createElement('div')]), [], 'empty div yields no sample');
  });
});

describe('twenty-fourth log: domHover wires rejected-added text evidence (source audit)', () => {
  function sliceDomHover() {
    const start = SRC.indexOf('async function domHover(');
    const end = SRC.indexOf('async function domOpenTab(', start);
    assert.ok(start > -1 && end > start, 'domHover must be sliceable');
    return SRC.slice(start, end);
  }

  it('accumulates rejected ADDED node references across ticks', () => {
    const body = sliceDomHover();
    assert.ok(/var rejectedAddedNodes\s*=\s*\[\]/.test(body),
      'domHover must declare rejectedAddedNodes (accumulating DOM refs, not per-tick summaries)');
  });

  it('rememberRejectedAdded helper is called from the reject branches', () => {
    const body = sliceDomHover();
    assert.ok(/function rememberRejectedAdded\(/.test(body), 'helper defined inside domHover');
    const calls = body.split('rememberRejectedAdded(').length - 1;
    assert.ok(calls >= 5,
      'the reject branches (invisible / too_small / viewport_sized / no_computed_style / distance-cap) must each remember added-source rejects — found ' + (calls - 1) + ' call sites');
    assert.ok(/candidateSource\.get\(node\)\s*!==\s*'added'/.test(body),
      'the helper only remembers nodes whose candidate source is "added" (MutationObserver-caught mounts)');
  });

  it('result carries rejectedAddedTexts + readability note (hundred-third log: attach is UNGATED)', () => {
    const body = sliceDomHover();
    assert.ok(/result\.rejectedAddedTexts\s*=/.test(body), 'result gains rejectedAddedTexts');
    assert.ok(/collectRejectedAddedTexts\(rejectedAddedNodes\)/.test(body), 'texts computed from the accumulated node refs');
    assert.ok(/reads are not visibility-gated/.test(body),
      'the note must teach the asymmetry (hidden/zero-height content is READABLE)');
    assert.match(body, /if \(rejectedAddedTexts\.length\) \{\s*\n\s*result\.rejectedAddedTexts = rejectedAddedTexts;/,
      'hundred-third log: the attach no longer requires !htmlSnippet — the picked popover can bury the payload under markup noise while the rejects carry it');
    assert.ok(/if \(!htmlSnippet && rejectedAddedTexts\.length\) \{[\s\S]*?rejectedAddedNote/.test(body),
      'the no-popover NOTE keeps its own gate (its teaching is about the no-popover path)');
  });

  it('texts are sampled BEFORE the dismiss unmounts the scaffolding', () => {
    const body = sliceDomHover();
    const sampleIdx = body.indexOf('collectRejectedAddedTexts(rejectedAddedNodes)');
    const dismissIdx = body.indexOf("TRUSTED_HOVER_DISMISS");
    assert.ok(sampleIdx > -1 && dismissIdx > sampleIdx,
      'text sampling must precede the trusted dismiss (nodes may unmount on mouseout)');
  });
});

describe('twenty-fourth log: DSL guide + tool specs teach the evidence channel', () => {
  const WU = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wizard-utils.js'), 'utf8');
  const ST = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session-tools.js'), 'utf8');

  it('SCRIPT_DSL_GUIDE $hover line mentions rejectedAddedTexts', () => {
    assert.match(WU, /rejectedAddedTexts/, 'DSL guide names the field so the model reads it');
  });

  it('probe.hover spec + methodology rule 6 mention the readable-mount fallback', () => {
    assert.match(ST, /rejectedAddedTexts/, 'session-tools probe.hover surfaces the field');
    const rule6 = ST.split("'6. To observe a hover popover")[1] ? ST.split("'6. To observe a hover popover")[1].slice(0, 2600) : '';
    assert.match(rule6, /rejectedAddedTexts/, 'methodology rule 6 teaches it');
  });
});
