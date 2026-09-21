// Hundred-third-round C — the five user-adjudicated fixes from the parameter
// audit:
//
// A. pre_existed_unchanged reverse hole: the RC43 baseline rejects a
//    candidate only on EXACT outerHTML equality with its T0 sample — on
//    obfuscated pages attributes churn (ids, URLs), so pre-existing chrome
//    NEVER matches its baseline and stayed in the passing pool forever.
//    Fix: structural identity (tag + class + 8px-bucketed page-coordinate
//    rect) with a text-length guard so a pre-existing wrapper that FILLED
//    with hover content during the dwell (RC43's own portal incident) is
//    NOT wrongly rejected.
//
// B. offscreen-level DOM_REQUEST serialization: the background relay
//    forwards concurrent DOM_REQUESTs to the same tab interleaved (research
//    probe + verify / un-awaited scripts) — 103b serialized only the CDP
//    attach. Fix: per-tab queue at the relay.
//
// C. too_small exemption: a TEXT-BEARING added candidate is never too small
//    — one-line tooltip strips ARE the payload (the 103rd incident: every
//    text leaf of the picked hovercard died at the 50px gate).
//
// D. match guard head+tail: popover markup puts the payload AFTER the
//    avatar/SVG noise; a head-only 2000-char guard made deep content
//    permanently unmatchable. Fix: test BOTH ends.
//
// E. scoring runner-ups (passing top-3, added-source) enter the rejected
//    memory — a strip that passed every filter but lost the cascade still
//    carries its payload.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const CS = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
const BG = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const LEO = fs.readFileSync(path.join(__dirname, '..', 'lib', 'list-extract-ops.js'), 'utf8');

function sliceFnFrom(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start > -1, name + ' must be defined');
  let depth = 0, i = start;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

function evalFn(src, ctxExtra) {
  const ctx = Object.assign({ window: { scrollX: 0, scrollY: 0, innerWidth: 1280, innerHeight: 800 } }, ctxExtra || {});
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.__fn = ' + src.slice(src.indexOf('function'), src.indexOf('(')) + ';', ctx);
  return ctx.__fn;
}

function elWithRect(dom, id, rect, className) {
  const el = dom.window.document.getElementById(id);
  el.getBoundingClientRect = () => ({ left: rect[0], top: rect[1], width: rect[2], height: rect[3], right: rect[0] + rect[2], bottom: rect[1] + rect[3] });
  if (className) el.className = className;
  return el;
}

describe('103c-A: baselineStructKeyOf — churn-proof structural identity', () => {
  const FN_SRC = sliceFnFrom(CS, 'baselineStructKeyOf');
  it('same tag/class/rect (±4px jitter) → same key; attribute churn does not matter', () => {
    const dom = new JSDOM('<div id="a" class="x1n2onr6 chrome"><span>Chrome text</span></div><div id="b" class="x1n2onr6 chrome"><span>Chrome text</span></div>');
    const fnSrc = FN_SRC + '\nthis.__fn = baselineStructKeyOf;';
    const ctxA = { window: { scrollX: 0, scrollY: 0 } }; vm.createContext(ctxA);
    vm.runInContext(fnSrc, ctxA);
    const key = ctxA.__fn;
    const a = elWithRect(dom, 'a', [100, 200, 300, 40], 'x1n2onr6 chrome');
    const b = elWithRect(dom, 'b', [103, 202, 300, 40], 'x1n2onr6 chrome');
    assert.equal(key(a), key(b), '3px jitter falls inside the 8px bucket');
    const c = elWithRect(dom, 'a', [100, 200, 300, 40], 'x1n2onr6 DIFFERENT');
    assert.notEqual(key(a), c === a ? key(elWithRect(dom, 'b', [100, 200, 300, 40], 'x1n2onr6 chrome')) : key(c), 'different class → different key');
  });
  it('scroll-proof: page coordinates absorb scrollY shifts', () => {
    const dom = new JSDOM('<div id="a" class="k">t</div>');
    const el = dom.window.document.getElementById('a');
    el.getBoundingClientRect = () => ({ left: 100, top: 44, width: 300, height: 40, right: 400, bottom: 84 });
    Object.defineProperty(el, 'ownerDocument', { value: { defaultView: { scrollX: 0, scrollY: 256 } } });
    const dom2 = new JSDOM('<div id="a" class="k">t</div>');
    const el2 = dom2.window.document.getElementById('a');
    el2.getBoundingClientRect = () => ({ left: 100, top: 300, width: 300, height: 40, right: 400, bottom: 340 });
    Object.defineProperty(el2, 'ownerDocument', { value: { defaultView: { scrollX: 0, scrollY: 0 } } });
    const fnSrc = FN_SRC + '\nthis.__fn = baselineStructKeyOf;';
    const ctx = {}; vm.createContext(ctx); vm.runInContext(fnSrc, ctx);
    const ctx2 = {}; vm.createContext(ctx2); vm.runInContext(fnSrc, ctx2);
    assert.equal(ctx.__fn(el), ctx2.__fn(el2), 'rect.top+scrollY is page-stable across scrolling — got ' + ctx.__fn(el) + ' vs ' + ctx2.__fn(el2));
  });
  it('candidate check has the structural fallback WITH the text-length guard', () => {
    const i = CS.indexOf("baselineEfpSnippets.has(nhtml))");
    assert.ok(i > -1);
    const block = CS.slice(i, i + 2400);
    assert.match(block, /baselineEfpProfiles\.get/, 'structural profile lookup');
    assert.match(block, /nTextLen === nProfile/, 'content-length guard — a pre-existing wrapper that FILLED with hover content (RC43 portal incident) must NOT be rejected');
    assert.match(block, /pre_existed_unchanged_struct/, 'distinct reject reason for the SW log');
  });
});

describe('103c-B: background per-tab DOM_REQUEST queue', () => {
  function loadQueue() {
    const fnSrc = sliceFnFrom(BG, 'enqueueDomRequestRelay');
    const ctx = { domRelayQueues: new Map() };
    vm.createContext(ctx);
    vm.runInContext('const domRelayQueues = new Map();\n' + fnSrc + '\nthis.__fn = enqueueDomRequestRelay;', ctx);
    return ctx.__fn;
  }
  it('same-tab sends serialize; different tabs stay concurrent', async () => {
    const enqueue = loadQueue();
    const order = [];
    const send = (label, ms) => () => new Promise((r) => setTimeout(() => { order.push(label); r(label); }, ms));
    const p1 = enqueue(1, send('t1a', 30));
    const p2 = enqueue(1, send('t1b', 5));
    const p3 = enqueue(2, send('t2a', 10));
    await Promise.all([p1, p2, p3]);
    assert.ok(order.indexOf('t1b') > order.indexOf('t1a'), 'same-tab second waits for the first (t1a=' + order.indexOf('t1a') + ', t1b=' + order.indexOf('t1b') + ')');
    assert.ok(order.indexOf('t2a') < order.indexOf('t1b'), 'cross-tab stays concurrent');
  });
  it('the DOM_REQUEST relay routes through the queue', () => {
    const i = BG.indexOf("message.type === 'DOM_REQUEST' && message._fromOffscreen");
    const block = BG.slice(i, i + 1600);
    assert.match(block, /enqueueDomRequestRelay\(/, 'relay wrapped by the per-tab queue');
  });
});

describe('103c-C: too_small exempts text-bearing added candidates', () => {
  it('the size gate has the added+text bypass', () => {
    const i = CS.indexOf("nr.width < 50 || nr.height < 50");
    assert.ok(i > -1);
    const block = CS.slice(i, i + 900);
    assert.match(block, /nsource === 'added'/, 'exemption is for added-source candidates');
    assert.match(block, /textContent/, 'exemption tests for text content');
  });
});

describe('103c-D: match guard tests head AND tail (both mirrors)', () => {
  function loadGuard(src) {
    const fnSrc = sliceFnFrom(src, 'testMatchValue');
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext('const MATCH_GUARD_LIMIT = 2000;\nlet matchGuardSkips = 0;\n' + fnSrc + '\nthis.__fn = testMatchValue;', ctx);
    return ctx.__fn;
  }
  for (const [label, src] of [['lib', LEO], ['inline mirror', CS]]) {
    it(label + ': a date at the TAIL of a 5000-char popover matches', () => {
      const guard = loadGuard(src);
      const long = 'x'.repeat(4800) + 'September 11, 2026 at 5:30 PM';
      assert.equal(guard(long, /September 11, 2026/), true, 'tail window carries the payload after the SVG noise');
    });
    it(label + ': content only in the middle still misses (disclosed skip)', () => {
      const guard = loadGuard(src);
      const long = 'x'.repeat(2400) + 'September 11, 2026' + 'y'.repeat(2400);
      assert.equal(guard(long, /September 11, 2026/), false, 'guard stays a guard — the middle is still bounded, skips counted');
    });
  }
});

describe('103c-E: scoring runner-ups enter the rejected memory', () => {
  it('runner-up nodes are remembered and merged before the collectors run', () => {
    const domHoverStart = CS.indexOf('async function domHover(');
    const domHoverEnd = CS.indexOf('async function domOpenTab(', domHoverStart);
    const body = CS.slice(domHoverStart, domHoverEnd);
    assert.match(body, /runnerUpNodes/, 'runner-up accumulator declared');
    assert.match(body, /passingCandidates\.slice\(1, ?4\)|rui < 4/, 'top-3 non-winners remembered');
    const mergeIdx = body.indexOf('runnerUpNodes[rni]');
    const textsIdx = body.indexOf('collectRejectedAddedTexts(rejectedAddedNodes)');
    assert.ok(mergeIdx > -1 && textsIdx > mergeIdx, 'merged BEFORE the texts/html collectors sample');
  });
});

describe('104th log: transform-positioned portals are overlay-positioned (user panel "有弹窗，为何reject？")', () => {
  it('posOverlay = absolute/fixed OR computed transform placement; the cascade sorts on posOverlay', () => {
    const domHoverStart = CS.indexOf('async function domHover(');
    const body = CS.slice(domHoverStart, CS.indexOf('async function domOpenTab(', domHoverStart));
    assert.match(body, /var posOverlay = posAbsolute \|\|\s*\n?\s*\(nodeStyle\.transform && nodeStyle\.transform !== 'none'\)/,
      'transform-placed portals (the 104th incident: transform: translate(627px, 762px), position NOT absolute) count as overlay-positioned');
    assert.match(body, /if \(a\.posOverlay !== b\.posOverlay\) return a\.posOverlay \? -1 : 1;/,
      'the scoring cascade sorts on posOverlay — the transform-placed hovercard must beat nearer static in-card wrappers');
    assert.match(body, /posOverlay: c\.posOverlay/, 'the SW-log candidate summary discloses the overlay flag');
  });
});

describe('105th log: too_small exemption covers ARIA-bearing zero-height strips', () => {
  it('an added candidate carrying aria-label/aria-labelledby payload is exempt even with empty textContent', () => {
    const i = CS.indexOf("nr.width < 50 || nr.height < 50");
    const block = CS.slice(i, i + 1600);
    assert.match(block, /exemptTinyText/, 'exemption present');
    assert.match(block, /aria-label/, 'aria-label counts as payload');
    assert.match(block, /aria-labelledby|labelledby/, 'aria reference presence counts (the date lives in the referenced hidden spans — 105th incident: the 218x0 tooltip strip carries its date in ARIA, not textContent, so the 103c text-only exemption missed it)');
  });
});

describe('108th log: page-profile probe — virtualization blindness + static lock-in', () => {
  it('the probe counts ADDED NODES (not mutation records) and records its max height', () => {
    const i = CS.indexOf('function detectLazyLoadProfile');
    const block = CS.slice(i, i + 3000);
    assert.match(block, /addedNodes/, 'count added nodes — a virtualized feed swaps cards in as ADDED nodes; counting records under-senses churn');
    assert.match(block, /__scrapewrightProfiledMaxHeight/, 'the height the profile was decided on is stored for later contradiction');
  });
  it('demoteStaticProfileIfGrown — later growth on a static-profiled tab demotes to lazy (one-way)', () => {
    const fnSrc = sliceFnFrom(CS, 'demoteStaticProfileIfGrown') + '\nthis.__fn = demoteStaticProfileIfGrown;';
    const ctx = { window: { __scrapewrightPageProfile: 'static', __scrapewrightProfiledMaxHeight: 5000 }, notifyBackgroundDiagnostic: (n) => { ctx.__diag = n; } };
    vm.createContext(ctx);
    vm.runInContext(fnSrc, ctx);
    const fn = ctx.__fn;
    assert.equal(fn(5200), false, '4% growth — under the 5% contradiction bar');
    assert.equal(ctx.window.__scrapewrightPageProfile, 'static');
    assert.equal(fn(5600), true, '12% growth contradicts the static verdict');
    assert.equal(ctx.window.__scrapewrightPageProfile, 'lazy', 'one-way demotion — a page that grows IS lazy regardless of the first-second snapshot');
    assert.equal(ctx.__diag, 'page_profile_demoted');
    // idempotent + lazy stays lazy + missing baseline never demotes
    assert.equal(fn(9000), false);
    const ctx2 = { window: { __scrapewrightPageProfile: 'static' }, notifyBackgroundDiagnostic: () => {} };
    vm.createContext(ctx2); vm.runInContext(fnSrc, ctx2);
    assert.equal(ctx2.__fn(99999), false, 'no stored baseline (old tabs) — never demotes');
  });
  it('scroll ops consult the demotion hook', () => {
    const sb = CS.indexOf('async function domScrollBy');
    const block = CS.slice(sb, CS.indexOf('async function domScrollToBottom', sb));
    assert.match(block, /demoteStaticProfileIfGrown/, 'domScrollBy checks growth contradiction');
    const stb = CS.indexOf('async function domScrollToBottom');
    const block2 = CS.slice(stb, stb + 9000);
    assert.match(block2, /demoteStaticProfileIfGrown/, 'domScrollToBottom checks growth contradiction');
  });
});
