// Forty-fifth log (2026-09-09, 2 sessions / 52+42 turns, same target site,
// glm-5.1 via Anthropic lane). Two infrastructure bugs, both confirmed from
// the log timestamps:
//
// P1 — domHover burned the full observe pipeline AFTER a failed dispatch.
// Live evidence: probe.hover dispatch failed at 17:20:40 ("hover.mouseMoved
// timeout after 2000ms" — the 2s withTimeout wrapper in renderer-activation
// worked and the failure returned promptly; the hover_request diagnostic
// landed at 17:20:40.055) yet the probe result was not delivered until
// 17:21:05 (30s per-step budget kill). ZERO hover_auto_discover diagnostics
// in the 25s gap: the dwell loop never completed ONE scoring tick. On a
// giant streaming page (3.5M-char body) a single synchronous tick — full
// addedNodes rescan from index 0, RC49 descendant walks, elementsFromPoint
// sampling ×5 offsets, per-candidate outerHTML serialization + baseline
// Set hashing — takes tens of seconds; the while-loop deadline was only
// checked BETWEEN ticks. Then the dismiss added another activation + CDP
// roundtrip. 3× 30s budget kills taught the model to abandon hovercards
// ("treat popovers as unavailable in this environment") and session 1
// shipped without real hovercards.
//
// Fixes under test:
//   F1 — dispatch-failure early-out: skip the dwell loop AND the dismiss
//        (the mouse never moved — no popover can have mounted), keep the
//        anchor-label harvest (needs no dispatch), return the dispatch
//        reason + a budgetNote naming the failure environmental/retryable.
//   F2 — addedNodes incremental cursor + Set-based seenEls + a candidate
//        pool that persists across ticks (kills the per-tick O(n²) rescan;
//        RC43 two-tick stability preserved because pool members persist).
//   F3 — mid-tick deadline bail with a grace window, checked INSIDE the
//        per-candidate loops (bounds a single oversized tick on giant
//        DOMs instead of letting it eat the caller's whole step budget).
//
// P2 — waitForTabLoad (wizard.js + background.js copies) waited ONLY for
// chrome.tabs.onUpdated status 'complete' and hard-rejected after 60s.
// Streaming search pages stay readyState 'interactive' for minutes while
// fully rendered (the log's page carried 3.5M chars of body text). 4× 60s
// failures burned ~4 minutes + LLM retry churn. Fix: probe readyState +
// bodyChars via chrome.scripting at T-1.5s — early enough that a resolve
// still beats the outer withTimeout(60s) wrappers at wizard.js
// makeWizardRail and lib/verify-runner.js — resolving when the page is
// interactive/complete with meaningful content; the probe can only
// UPGRADE the outcome, everything else defers to the hard timeout, which
// rejects with the probe evidence embedded in the message.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

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

function sliceDomHover(src) {
  return sliceFn(src, 'async function domHover(', 'async function domOpenTab(');
}

// ---------------------------------------------------------------------------
// waitForTabLoad: load each file's copy into a vm with a fake chrome +
// manually-fired timers (probe scheduled at timeoutMs-1500, hard timeout at
// timeoutMs — firing them in schedule order with a microtask between lets
// the async probe settle first, mirroring the real 1.5s headroom).
// ---------------------------------------------------------------------------

const WTFL_SOURCES = [
  ['wizard.js', '\nasync function sendMessageWithRetry'],
  ['background.js', '\nasync function tryAutoFixStep']
];

function loadWaitForTabLoad(file, endMarker, opts) {
  const o = opts || {};
  const fnSrc = sliceFn(readSrc(file), 'function waitForTabLoad(', endMarker);
  let currentListener = null;
  const chrome = {
    tabs: {
      onUpdated: {
        addListener(l) { currentListener = l; },
        removeListener() { currentListener = null; }
      },
      get: (tabId, cb) => cb({ id: tabId, status: o.tabsGetStatus || 'loading' })
    },
    scripting: {
      executeScript: o.probeError
        ? async () => { throw new Error(o.probeError); }
        : async () => [{ result: o.probeResult }]
    }
  };
  const timers = [];
  const ctx = { chrome, setTimeout: (fn) => { timers.push(fn); return timers.length; } };
  vm.createContext(ctx);
  vm.runInContext(fnSrc + '\nthis.__fn = waitForTabLoad;', ctx);
  return {
    fn: ctx.__fn,
    get listener() { return currentListener; },
    async runTimers() {
      while (timers.length) {
        const t = timers.shift();
        t();
        await new Promise((r) => setImmediate(r));
      }
    }
  };
}

describe('forty-fifth log P2: waitForTabLoad interactive-page fallback', () => {
  it('both copies probe readyState + bodyChars via chrome.scripting before the hard timeout', () => {
    for (const [file, endMarker] of WTFL_SOURCES) {
      const fn = sliceFn(readSrc(file), 'function waitForTabLoad(', endMarker);
      assert.ok(/chrome\.scripting\.executeScript/.test(fn), file + ' probes the page via chrome.scripting');
      assert.ok(/readyState/.test(fn) && /bodyChars/.test(fn), file + ' probe reads readyState and bodyChars');
      assert.ok(/timeoutMs - 1500/.test(fn),
        file + ' schedules the probe ~1.5s before the hard timeout so a resolve beats the outer withTimeout(60s) wrappers');
    }
  });

  it('resolves when the probe finds an interactive page with real content (wizard.js)', async () => {
    const h = loadWaitForTabLoad('wizard.js', WTFL_SOURCES[0][1], {
      probeResult: { readyState: 'interactive', bodyChars: 3500000 }
    });
    const p = h.fn(7);
    await h.runTimers();
    await p; // resolves — not rejects
    assert.equal(h.listener, null, 'listener removed after settle');
  });

  it('resolves when the probe finds an interactive page with real content (background.js)', async () => {
    const h = loadWaitForTabLoad('background.js', WTFL_SOURCES[1][1], {
      probeResult: { readyState: 'interactive', bodyChars: 3500000 }
    });
    const p = h.fn(7);
    await h.runTimers();
    await p;
  });

  it('a reachable-but-loading page defers to the hard timeout and rejects with the probe evidence', async () => {
    const h = loadWaitForTabLoad('wizard.js', WTFL_SOURCES[0][1], {
      probeResult: { readyState: 'loading', bodyChars: 50 }
    });
    const p = h.fn(7);
    const assertion = assert.rejects(p, /Tab load timeout after 120s \(page reachable: readyState=loading, bodyChars=50/);
    await h.runTimers();
    await assertion;
  });

  it('a failing probe defers to the hard timeout and names the probe failure', async () => {
    const h = loadWaitForTabLoad('wizard.js', WTFL_SOURCES[0][1], { probeError: 'frame gone' });
    const p = h.fn(7);
    const assertion = assert.rejects(p, /Tab load timeout after 120s.*probe failed: frame gone/);
    await h.runTimers();
    await assertion;
  });

  it('an empty interactive page does NOT resolve via the fallback (no meaningful content yet)', async () => {
    const h = loadWaitForTabLoad('wizard.js', WTFL_SOURCES[0][1], {
      probeResult: { readyState: 'interactive', bodyChars: 120 }
    });
    const p = h.fn(7);
    const assertion = assert.rejects(p, /readyState=interactive, bodyChars=120/);
    await h.runTimers();
    await assertion;
  });

  it('the normal complete path still resolves via the onUpdated listener', async () => {
    const h = loadWaitForTabLoad('wizard.js', WTFL_SOURCES[0][1], {
      probeResult: { readyState: 'complete', bodyChars: 5000 }
    });
    const p = h.fn(7);
    h.listener(7, { status: 'loading' }); // ignored
    h.listener(7, { status: 'complete' }); // resolves (after the settle timer)
    await h.runTimers(); // fires the 500ms settle timer (+ never-fired probe/timeout timers)
    await p;
  });
});

// ---------------------------------------------------------------------------
// domHover eval-factory: slice the real function out of content-script.js
// and run it against a jsdom document with every chrome relay injected —
// the production topology (inner functions close over the page document).
// ---------------------------------------------------------------------------

const HARVEST_DEPS_SRC =
  sliceFnSource('function resolveLabelledbyText(', '\n  async function domLabelledby') +
  '\n' +
  sliceFnSource('function harvestAnchorLabel(', '\n  async function domHover(')
  // 138th log: domHover consults the outer-deadline guard and the page-state
  // reader (starve branch). These tests pass no deadline and never starve, so
  // inert stubs preserve the pre-138 behavior they pin.
  + '\nfunction outerDeadlineExceeded(){return null}\nfunction readPageFrameState(){return {visibilityState:"visible",hasFocus:true}}';

function sliceFnSource(startMarker, endMarker) {
  return sliceFn(readSrc('content-script.js'), startMarker, endMarker);
}

function makeAnchorDom() {
  const dom = new JSDOM(
    '<span id="vis">June 21</span>' +
    '<span id="tip" style="display:none">June 21, 2024 at 3:15 PM</span>' +
    '<a id="anchor" class="a" href="/x" aria-labelledby="vis tip">x</a>',
    { url: 'https://example.com/page' }
  );
  const anchor = dom.window.document.getElementById('anchor');
  anchor.scrollIntoView = function () {};
  // Sixty-third log: JSDOM has no layout engine — getBoundingClientRect is
  // ALL ZEROS for every element. In production these anchors have real
  // boxes, and a zero-box anchor now early-outs as anchor_not_hoverable
  // before any dispatch. Stub a real box so these tests keep exercising the
  // dispatch/dwell paths they were written for; the sixty-third-log tests
  // use the raw JSDOM zero rect to hit the gate.
  anchor.getBoundingClientRect = function () {
    return { left: 800, top: 400, width: 96, height: 24, right: 896, bottom: 424 };
  };
  return { dom, anchor };
}

function baseHoverContext(dom, anchor) {
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
            if (m.type === 'TRUSTED_HOVER_REQUEST') {
              return { dispatched: false, ok: false, reason: 'hover.mouseMoved timeout after 2000ms' };
            }
            return { ok: true };
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
      popoverIdentityOf: () => ({ tag: 'DIV' }),
      // 138th log: domHover consults these (no deadline → guard null).
      outerDeadlineExceeded: () => null,
      readPageFrameState: () => ({ visibilityState: 'visible', hasFocus: true })
    },
    sent,
    diags
  };
}

function loadDomHover(ctx, prependSrc) {
  const hoverSrc = sliceDomHover(readSrc('content-script.js'));
  vm.createContext(ctx);
  vm.runInContext((prependSrc || '') + '\n' + hoverSrc + '\nthis.__domHover = domHover;', ctx);
  return ctx.__domHover;
}

describe('forty-fifth log F1: domHover dispatch-failure early-out', () => {
  it('skips the dwell loop and dismiss, keeps the harvest, names the transient — full factory run', async () => {
    const { dom, anchor } = makeAnchorDom();
    const { ctx, sent, diags } = baseHoverContext(dom, anchor);
    // Real harvest slices (resolveLabelledbyText + harvestAnchorLabel) so the
    // test pins that the 42nd-log anchor-label contract survives on the new
    // dispatch-failure path.
    const hoverFn = loadDomHover(ctx, HARVEST_DEPS_SRC);

    const r = await hoverFn('.a', null, { timeoutMs: 5000 });

    assert.equal(r.hovered, false);
    assert.equal(r.hoverDispatched, false);
    assert.equal(r.reason, 'hover.mouseMoved timeout after 2000ms');
    assert.match(r.budgetNote, /environmental transient/);
    assert.match(r.budgetNote, /retry/);
    assert.ok(sent.includes('TRUSTED_HOVER_REQUEST'));
    assert.ok(!sent.includes('TRUSTED_HOVER_DISMISS'),
      'the mouse never moved — a dismiss CDP roundtrip (plus its activation) cannot unmount anything and only burns budget');
    assert.ok(!diags.some((d) => d.name === 'hover_auto_discover'),
      'the dwell loop must not run a single scoring tick after a failed dispatch (the 25s budget-kill of the 45th log)');
    assert.ok(!diags.some((d) => d.name === 'hover_dismiss'), 'no dismiss diagnostic on the early-out path');
    assert.equal(r.labelledbyText, 'June 21 June 21, 2024 at 3:15 PM',
      'harvestAnchorLabel still runs — the ARIA label needs no dispatch and no visible popover');
  });

  it('source audit: loop and dismiss are gated, reason branch precedes popover_timeout', () => {
    const body = sliceDomHover(readSrc('content-script.js'));
    assert.ok(/var dispatchFailed = !\(hoverResp && hoverResp\.dispatched\);/.test(body),
      'dispatchFailed derived from hoverResp.dispatched');
    assert.ok(/while \(!dispatchFailed && Date\.now\(\) < deadline\)/.test(body),
      'dwell loop gated on dispatch success');
    assert.ok(/if \(dismiss && !dispatchFailed\)/.test(body),
      'dismiss gated on dispatch success');
    const dfIdx = body.indexOf('} else if (dispatchFailed) {');
    const ptIdx = body.indexOf("result.reason = 'popover_timeout'");
    assert.ok(dfIdx > -1 && ptIdx > dfIdx,
      'dispatch-failure reason must win over popover_timeout (the dwell budget was never spent, so "absence is budget-bounded" would be a lie)');
    assert.ok(/'hover_dispatch_failed'/.test(body), 'synthetic reason when hoverResp carries none');
  });
});

describe('forty-fifth log F2: incremental addedNodes cursor + persistent candidate pool', () => {
  it('source audit: cursor-anchored loop, Set-based dedupe, pool declared before the polling loop', () => {
    const body = sliceDomHover(readSrc('content-script.js'));
    assert.ok(/var addedNodesCursor = 0;/.test(body), 'named cursor declared');
    assert.ok(/for \(var k = addedNodesCursor; k < addedNodes\.length; k\+\+\)/.test(body),
      'the added-nodes loop starts at the cursor — accumulated feed mounts are never re-walked from index 0');
    assert.ok(/var seenEls = new Set\(\);/.test(body), 'seenEls is a Set');
    assert.ok(!/seenEls\.push/.test(body), 'the O(n^2) linear-array dedupe scan is gone');
    const poolDeclIdx = body.indexOf('var candidatePool = [];');
    const loopIdx = body.indexOf('while (!dispatchFailed');
    assert.ok(poolDeclIdx > -1 && loopIdx > poolDeclIdx,
      'candidate pool persists ACROSS ticks — RC43 two-tick stability requires pool members to survive between ticks');
  });
});

describe('forty-fifth log F3: mid-tick deadline bail inside the per-candidate loops', () => {
  it('source audit: grace window, per-loop checks, break, and the result flag', () => {
    const body = sliceDomHover(readSrc('content-script.js'));
    assert.ok(/var TICK_DEADLINE_GRACE_MS = \d+;/.test(body), 'named grace constant');
    assert.ok(/function tickOverBudget\(\)/.test(body), 'tickOverBudget helper');
    const addedLoopIdx = body.indexOf('for (var k = addedNodesCursor');
    assert.ok(/tickOverBudget\(\)/.test(body.slice(addedLoopIdx, addedLoopIdx + 400)),
      'added-nodes loop checks the tick budget per node');
    const scoringIdx = body.indexOf('for (var ci = 0; ci < candidatePool.length');
    assert.ok(/tickOverBudget\(\)/.test(body.slice(scoringIdx, scoringIdx + 400)),
      'scoring loop checks the tick budget per candidate');
    assert.ok(/if \(deadlineBailed\) break;/.test(body), 'a bailed tick stops polling instead of sleeping into another one');
    assert.ok(/result\.deadlineBailed = true;/.test(body), 'the result discloses the mid-tick bail');
    assert.match(body, /deadlineBailed[\s\S]{0,400}too large to scan|too large to scan[\s\S]{0,400}deadlineBailed/,
      'budgetNote teaches that the DOM outran the budget');
  });

  it('bounds the work of a giant first tick — factory run with a controllable clock', async () => {
    const { dom, anchor } = makeAnchorDom();
    // 500 body-level mounts, as a streaming feed accumulates during baseline
    // sampling + the failed/slow dispatch roundtrip.
    const added = [];
    for (let i = 0; i < 500; i++) {
      const el = dom.window.document.createElement('div');
      el.textContent = 'feed mount ' + i;
      dom.window.document.body.appendChild(el);
      added.push(el);
    }
    let fakeNow = 1000;
    let visibilityCalls = 0;
    const { ctx } = (function () {
      const base = baseHoverContext(dom, anchor);
      // Successful dispatch: the dwell loop RUNS this time — the bail must
      // bound the tick from inside, not via the F1 early-out.
      base.ctx.chrome.runtime.sendMessage = async (m) => {
        if (m.type === 'TRUSTED_HOVER_REQUEST') return { dispatched: true, ok: true };
        return { ok: true };
      };
      // Controllable clock: sleeps advance 100ms, every visibility probe
      // costs 50 fake-ms — a giant-DOM tick in miniature.
      base.ctx.Date = { now: () => fakeNow };
      base.ctx.setTimeout = (fn) => { fakeNow += 100; fn(); };
      base.ctx.isElementVisible = () => { fakeNow += 50; visibilityCalls++; return true; };
      // Observer fires its whole buffer synchronously on observe().
      base.ctx.MutationObserver = class {
        constructor(cb) { this.cb = cb; }
        observe() { this.cb([{ addedNodes: added }]); }
        disconnect() {}
      };
      return base;
    })();

    const hoverFn = loadDomHover(ctx, HARVEST_DEPS_SRC);
    const r = await hoverFn('.a', null, { timeoutMs: 10000 });

    assert.equal(r.reason, 'popover_timeout');
    assert.equal(r.deadlineBailed, true, 'mid-tick bail fired and is disclosed');
    assert.match(r.budgetNote, /too large to scan/);
    assert.ok(visibilityCalls > 0, 'the pool build did run');
    assert.ok(visibilityCalls < 450,
      'a single oversized tick must not process all ' + 500 + ' mounts (got ' + visibilityCalls +
      ' visibility probes — without the mid-tick bail the first tick alone costs 500+)');
  });
});
