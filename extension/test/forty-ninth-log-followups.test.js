'use strict';
// Forty-ninth log (2026-09-09 13:41-13:43 verify + docs/result.json, 8/10
// posts, session COMPLETED at v7 with verify ok:true): the run completed but
// the feed count froze at 2 for 7 iterations, jumped to 8, then froze at 8
// for 10 more until maxIterations 18 exhausted — while the hover ops' tab
// activation kept answering "already active". The user observed the cause
// directly: scroll lazy-load only fires when the tab is ACTIVE, and the
// browser skips requests/rendering otherwise; they authorized execution
// priority over manual focus ("switch to the tab automatically whenever
// needed").
//
//   RC-A scroll-family activation gap: domScrollToBottom / hover /
//       hoverDismiss were wrapped in withTabActivation since RC20/RC50, but
//       domScrollBy / domScrollIntoView / domWaitForStable / domClickInList
//       were NOT — the exact ops the verify's scroll loop used, so a user
//       switching away froze the feed with no re-activation ever attempted.
//   RC-B window focus never re-asserted: requestActivation returned early on
//       "already active" and the crossWindow path deliberately never raised
//       the window (thirteenth-log design). A tab can be active-in-window
//       while its WINDOW lost OS focus — no compositor frames either way.
//       The forty-ninth-log user authorization supersedes the old design.
//   RC-C frozen-NONZERO count invisible + zero scroll evidence:
//       detectFrozenZeroCounter catches only all-zero counters (fourth log);
//       the frozen 2-then-8 class had no detector. The scroll ops also
//       emitted NO selectorDiagnostics at all — the only DOM ops with none —
//       so the model guessed 7 scroll-step shapes across v1-v7 with no
//       visibility/frame evidence to reason from.
//   RC-D anchorHref harvest never walked up: anchorSel routinely matches the
//       label span INSIDE the link; getAttribute('href') on the span is null
//       → hovercards[].url '' 23/23 → the downstream /groups\//-style
//       classification read an empty string every time.
//   RC-E id collision census absent: postId fell back to the shared
//       container-level owner id for 3 records (plus 2 empty) on a green
//       verify — no detector for repeated identity values across records.
//
// F1 scroll-family withTabActivation coverage + window-focus enforcement
//    (needsWindowFocus evidence from the isolated world — the MAIN-world
//    visibility-keepalive override cannot lie on that side)
// F2 scroll diagnostics (api/pageState/frameSample) + detectFrozenScrollCount
//    trailing-streak census (SCROLL_COUNT_FROZEN, report-only)
// F3 anchorHref closest('a[href]') walk-up (+ content-script mirror)
// F4 detectDuplicateIdValues census (DUPLICATE_ID_VALUES, report-only)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const OPS = require('../lib/list-extract-ops');
const WU = require('../lib/wizard-utils');
const { createVerifyRunner } = require('../lib/verify-runner');

const CS_PATH = path.join(__dirname, '..', 'content-script.js');
const BG_PATH = path.join(__dirname, '..', 'background.js');
const TA_PATH = path.join(__dirname, '..', 'lib', 'tab-activation.js');

function sliceFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, name + ' not found');
  let depth = 0, inString = null, bodyStart = -1, bodyEnd = -1;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (ch === '{') { if (bodyStart === -1) bodyStart = i; depth++; }
    else if (ch === '}') { depth--; if (depth === 0) { bodyEnd = i; break; } }
  }
  assert.ok(bodyStart !== -1 && bodyEnd !== -1, 'could not slice ' + name);
  return src.slice(start, bodyEnd + 1);
}

// ---------------------------------------------------------------------------
// F1: window-focus enforcement in lib/tab-activation.js
// Fresh module + chrome mock per test (rc56 pattern, extended with
// windows.get so the minimized-window branch is testable).
function loadTabActivation(opts) {
  opts = opts || {};
  const calls = { tabsGet: [], tabsUpdate: [], windowsGetLastFocused: [], windowsGet: [], windowsUpdate: [] };
  const tabsById = new Map();
  const windowsById = new Map();
  let focusedWindowId = 1;
  const chromeMock = {
    tabs: {
      get: (tabId) => {
        calls.tabsGet.push(tabId);
        const tab = tabsById.get(tabId);
        if (!tab) return Promise.reject(new Error('No tab with id ' + tabId));
        return Promise.resolve(tab);
      },
      update: (tabId, props) => {
        calls.tabsUpdate.push({ tabId, props });
        const tab = tabsById.get(tabId);
        if (!tab) return Promise.reject(new Error('No tab with id ' + tabId));
        if (props && props.active === true) {
          for (const t of tabsById.values()) {
            if (t.windowId === tab.windowId && t.active) t.active = false;
          }
          tab.active = true;
        }
        return Promise.resolve(tab);
      },
      onActivated: { addListener: () => {} },
      onRemoved: { addListener: () => {} }
    },
    windows: {
      getLastFocused: () => {
        calls.windowsGetLastFocused.push(focusedWindowId);
        return Promise.resolve({ id: focusedWindowId });
      },
      get: (windowId) => {
        calls.windowsGet.push(windowId);
        const w = windowsById.get(windowId);
        if (!w) return Promise.reject(new Error('No window ' + windowId));
        return Promise.resolve(w);
      },
      update: (windowId, props) => {
        calls.windowsUpdate.push({ windowId, props });
        return Promise.resolve({ id: windowId });
      }
    },
    runtime: {}
  };
  if (opts.noWindowsUpdate) delete chromeMock.windows.update;
  const sandbox = {
    chrome: chromeMock,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: () => 0, clearTimeout: () => {},
    module: { exports: {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(TA_PATH, 'utf8'), sandbox, { filename: 'tab-activation.js' });
  return {
    api: sandbox.module.exports, calls, tabsById, windowsById,
    setFocusedWindow: (id) => { focusedWindowId = id; }
  };
}

describe('F1: window-focus enforcement (requestActivation)', () => {
  it('tab already active but its WINDOW not the focused window → window focused, focusedWindow:true', async () => {
    const ctx = loadTabActivation();
    ctx.setFocusedWindow(2); // user is working in another window
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: true });
    ctx.windowsById.set(1, { id: 1, state: 'normal' });
    const r = await ctx.api.requestActivation(101);
    assert.equal(r.ok, true);
    assert.equal(r.activated, false, 'the tab never lost active-tab state — this is exactly the forty-ninth-log fingerprint (hover ops said "already active" while the feed froze)');
    assert.equal(r.focusedWindow, true, 'the missing half: re-assert window focus');
    assert.equal(ctx.calls.tabsUpdate.length, 0, 'no tab churn');
    assert.equal(ctx.calls.windowsUpdate.length, 1);
    assert.equal(ctx.calls.windowsUpdate[0].windowId, 1);
    assert.equal(ctx.calls.windowsUpdate[0].props.focused, true);
  });

  it('tab already active AND its window focused → plain already-active no-op', async () => {
    const ctx = loadTabActivation();
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: true });
    ctx.windowsById.set(1, { id: 1, state: 'normal' });
    const r = await ctx.api.requestActivation(101);
    assert.equal(r.ok, true);
    assert.equal(r.activated, false);
    assert.match(r.reason, /already active/);
    assert.equal(ctx.calls.tabsUpdate.length, 0);
    assert.equal(ctx.calls.windowsUpdate.length, 0);
  });

  it('cross-window scrape tab: tab activated AND window raised (user authorization supersedes the thirteenth-log within-window-only design)', async () => {
    const ctx = loadTabActivation();
    ctx.setFocusedWindow(2);
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: false });
    ctx.windowsById.set(1, { id: 1, state: 'normal' });
    const r = await ctx.api.requestActivation(101);
    assert.equal(r.ok, true);
    assert.equal(r.activated, true);
    assert.equal(r.crossWindow, true, 'marker keeps explaining focus movement in diagnostics');
    assert.equal(r.focusedWindow, true);
    assert.equal(ctx.calls.tabsUpdate.length, 1);
    assert.equal(ctx.calls.windowsUpdate.length, 1);
    assert.equal(ctx.calls.windowsUpdate[0].props.focused, true);
  });

  it('forceWindowFocus (content-script evidence of a hidden/unfocused page) focuses the window even when Chrome reports the scrape window as last-focused', async () => {
    // The occluded/other-app-holds-OS-focus case: Chrome's getLastFocused
    // still names the scrape window, but the page itself reports it is not
    // visible/focused. Only the content script can see that.
    const ctx = loadTabActivation();
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: true });
    ctx.windowsById.set(1, { id: 1, state: 'normal' });
    const r = await ctx.api.requestActivation(101, { forceWindowFocus: true });
    assert.equal(r.ok, true);
    assert.equal(r.focusedWindow, true);
    assert.equal(ctx.calls.windowsUpdate.length, 1);
  });

  it('minimized window → focused:true AND state:normal', async () => {
    const ctx = loadTabActivation();
    ctx.setFocusedWindow(2);
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: true });
    ctx.windowsById.set(1, { id: 1, state: 'minimized' });
    const r = await ctx.api.requestActivation(101);
    assert.equal(r.focusedWindow, true);
    assert.equal(ctx.calls.windowsUpdate[0].props.state, 'normal',
      'focus alone does not restore a minimized window');
  });

  it('windows.update unavailable → graceful: activation still succeeds', async () => {
    const ctx = loadTabActivation({ noWindowsUpdate: true });
    ctx.setFocusedWindow(2);
    ctx.tabsById.set(100, { id: 100, windowId: 1, active: true });
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: false });
    const r = await ctx.api.requestActivation(101);
    assert.equal(r.ok, true);
    assert.equal(r.activated, true);
    assert.equal(ctx.calls.tabsUpdate.length, 1);
  });
});

// ---------------------------------------------------------------------------
// F1: scroll-family activation coverage + evidence flag (source audits)
describe('F1: scroll-family withTabActivation coverage (source audit)', () => {
  const src = fs.readFileSync(CS_PATH, 'utf8');

  it('domScrollBy / domScrollIntoView / domWaitForStable / domClickInList wrap via withTabActivation', () => {
    for (const [fn, label] of [
      ['domScrollBy', 'scrollBy'],
      ['domScrollIntoView', 'scrollIntoView'],
      ['domWaitForStable', 'waitForStable'],
      ['domClickInList', 'clickInList']
    ]) {
      const body = sliceFunction(src, fn);
      assert.ok(body.includes("withTabActivation('" + label + "'"),
        fn + ' must wrap its work via withTabActivation(\'' + label + '\', ...) — RC20 covered only scrollToBottom/hover/hoverDismiss, and the forty-ninth-log scroll loop used exactly these unwrapped ops');
    }
  });

  it('withTabActivation reads real page focus evidence and sends needsWindowFocus', () => {
    const body = sliceFunction(src, 'withTabActivation');
    assert.ok(/visibilityState/.test(body), 'must read document.visibilityState (isolated-world real value)');
    assert.ok(/hasFocus/.test(body), 'must read document.hasFocus()');
    assert.ok(/needsWindowFocus/.test(body), 'must forward the evidence flag to background');
  });

  it('background passes the forceWindowFocus evidence flag through to requestActivation', () => {
    const bg = fs.readFileSync(BG_PATH, 'utf8');
    const start = bg.indexOf("message.type === 'TAB_ACTIVATION_REQUEST'");
    assert.ok(start !== -1);
    const end = bg.indexOf('return true;', start);
    const body = bg.slice(start, end);
    assert.ok(/forceWindowFocus/.test(body), 'handler must forward needsWindowFocus as forceWindowFocus');
    assert.ok(/needsWindowFocus/.test(body));
  });
});

// ---------------------------------------------------------------------------
// F2: scroll diagnostics + frozen-nonzero detector
describe('F2: scroll op diagnostics (source audit)', () => {
  const src = fs.readFileSync(CS_PATH, 'utf8');

  it('domScrollBy returns {result,_diagnostics} with api scrollBy; no-progress carries pageState (+frameSample when suspicious)', () => {
    const body = sliceFunction(src, 'domScrollBy');
    assert.ok(/api:\s*'scrollBy'/.test(body), 'scrollBy must emit a selectorDiagnostics entry — scroll was the ONLY DOM op family with none, so the model had zero scroll evidence');
    assert.ok(/attachScrollEvidence|readPageFrameState/.test(body), 'no-progress results must carry real page visibility/focus state');
    assert.ok(/sampleFrameProduction|frameSample/.test(body), 'suspicious state must sample rAF frame production');
  });

  it('domWaitForStable returns {result,_diagnostics} and its not-stable exit carries pageState', () => {
    const body = sliceFunction(src, 'domWaitForStable');
    assert.ok(/api:\s*'waitForStable'/.test(body));
    assert.ok(/readPageFrameState/.test(body));
  });

  it('dispatch cases consume _diagnostics for scrollBy / scrollIntoView / waitForStable', () => {
    for (const api of ['scrollBy', 'scrollIntoView', 'waitForStable']) {
      const start = src.indexOf("case '" + api + "':");
      assert.ok(start !== -1, 'case ' + api + ' missing');
      const end = src.indexOf('break;', start);
      const body = src.slice(start, end);
      assert.ok(/_diagnostics\s*=/.test(body), 'case ' + api + ' must relay _diagnostics');
    }
  });
});

function evtIter(stepId, resultPreview, diags) {
  return { type: 'STEP_ITERATION', stepId, selectorDiagnostics: diags || [], resultPreview };
}
const SCROLL_DIAG = [{ api: 'scrollBy', selector: 'div feed', moved: true, pageState: null, frameSample: null }];
const COUNT_DIAG = [{ api: 'count', selector: 'article', matchCount: 8 }];

describe('F2: detectFrozenScrollCount (trailing-streak census)', () => {
  it('frozen-nonzero trailing streak + scroll api → entry naming the frozen count', () => {
    const events = [];
    for (let i = 0; i < 7; i++) events.push(evtIter('scroll', '{"done":false,"count":2}', SCROLL_DIAG.concat(COUNT_DIAG)));
    const out = WU.detectFrozenScrollCount(events);
    assert.equal(out.length, 1);
    assert.equal(out[0].stepId, 'scroll');
    assert.equal(out[0].frozenCount, 2);
    assert.equal(out[0].streak, 7);
    assert.equal(out[0].field, 'count');
  });

  it('growth then freeze (the exact forty-ninth-log shape 2×7 → 8×10) → entry with grewFrom', () => {
    const events = [];
    for (let i = 0; i < 7; i++) events.push(evtIter('scroll', '{"done":false,"count":2}', SCROLL_DIAG));
    for (let i = 0; i < 10; i++) events.push(evtIter('scroll', '{"done":false,"count":8}', SCROLL_DIAG));
    const out = WU.detectFrozenScrollCount(events);
    assert.equal(out.length, 1);
    assert.equal(out[0].frozenCount, 8);
    assert.equal(out[0].grewFrom, 2, 'the page DID load more once — growth stopped, which distinguishes throttle-stall from never-worked');
  });

  it('still-growing counts → no entry', () => {
    const events = [
      evtIter('scroll', '{"done":false,"count":2}', SCROLL_DIAG),
      evtIter('scroll', '{"done":false,"count":8}', SCROLL_DIAG),
      evtIter('scroll', '{"done":false,"count":20}', SCROLL_DIAG),
      evtIter('scroll', '{"done":false,"count":44}', SCROLL_DIAG)
    ];
    assert.equal(WU.detectFrozenScrollCount(events).length, 0);
  });

  it('no scroll api anywhere → no entry (that is the POLL_EXHAUSTED class, not ours)', () => {
    const events = [];
    for (let i = 0; i < 9; i++) events.push(evtIter('poll', '{"done":false,"count":5}', COUNT_DIAG));
    assert.equal(WU.detectFrozenScrollCount(events).length, 0);
  });

  it('frozen ZERO counters stay the zero-trap class — no nonzero entry', () => {
    const events = [];
    for (let i = 0; i < 9; i++) events.push(evtIter('scroll', '{"done":false,"count":0}', SCROLL_DIAG));
    assert.equal(WU.detectFrozenScrollCount(events).length, 0);
  });
});

// ---------------------------------------------------------------------------
// F2+F4: verify-runner wiring (makeRunner pattern — events ride the 4th arg)
function makeRunner(eventsToEmit, finalResult) {
  const deps = {
    orchestrate: async (service, input, orchDeps, options) => {
      for (const e of eventsToEmit) options.onEvent(e);
      return {
        finalResult,
        steps: [{ stepId: 'extract', stepName: 'extract', result: { done: true } }],
        pages: []
      };
    },
    ensureLock: async () => {},
    getSignal: () => null,
    log: () => {},
    onEvent: () => {},
    createTab: async (url) => ({ id: 11, url }),
    removeTab: async () => {},
    waitForTabLoad: async () => {},
    sendMessage: async () => ({ pong: true }),
    executeScript: async () => ({ result: 'ok', selectorDiagnostics: [] }),
    captureSnapshot: async () => ({ html: '<html></html>' }),
    evaluateCondition: async () => true
  };
  return createVerifyRunner(deps);
}

const SERVICE = { targetUrl: 'https://example.com', steps: [
  { id: 'scroll', name: 'scroll', script: 'return 1', onSuccess: 'extract' },
  { id: 'extract', name: 'extract', script: 'return 1', onSuccess: 'TERMINATE' }
], config: {} };

const SCHEMA = {
  type: 'object', required: ['posts'],
  properties: { posts: { type: 'array', items: { type: 'object', required: ['postId'], properties: {
    postId: { type: 'string' }, content: { type: 'string' }
  } } } }
};

const HEALTHY_UNIQUE = { posts: [
  { postId: '111', content: 'a' }, { postId: '222', content: 'b' }, { postId: '333', content: 'c' }
] };

describe('F2+F4: verify-runner wiring', () => {
  it('a green run with a frozen scroll count still carries the SCROLL_COUNT_FROZEN census + tag', async () => {
    const events = [];
    for (let i = 0; i < 10; i++) events.push(evtIter('scroll', '{"done":false,"count":8}', SCROLL_DIAG));
    const runner = makeRunner(events, HEALTHY_UNIQUE);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA });
    assert.equal(out.report.ok, true, 'report-only: the census is evidence, not a verdict');
    assert.ok(Array.isArray(out.report.detectors.scrollCountFrozen) && out.report.detectors.scrollCountFrozen.length === 1);
    assert.ok(out.report.events.includes('SCROLL_COUNT_FROZEN'), 'tags: ' + JSON.stringify(out.report.events));
  });

  it('repeated postId values across records → DUPLICATE_ID_VALUES advisory, run stays green', async () => {
    const dup = { posts: [
      { postId: '61584838476257', content: 'a' },
      { postId: '61584838476257', content: 'b' },
      { postId: '61584838476257', content: 'c' }
    ] };
    const runner = makeRunner([], dup);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA });
    assert.equal(out.report.ok, true, 'report-only');
    const d = out.report.detectors.duplicateIdValues;
    assert.ok(Array.isArray(d) && d.length === 1);
    assert.equal(d[0].path, 'posts.postId');
    assert.equal(d[0].count, 3);
    assert.deepEqual(d[0].indices, [1, 2, 3]);
    assert.ok(out.report.events.includes('DUPLICATE_ID_VALUES'));
  });

  it('unique ids on a healthy run → no duplicate census', async () => {
    const runner = makeRunner([], HEALTHY_UNIQUE);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA });
    assert.equal(out.report.detectors.duplicateIdValues, null);
  });
});

describe('F4: detectDuplicateIdValues unit', () => {
  it('fingerprints the shared value with 1-based record ordinals', () => {
    const out = WU.detectDuplicateIdValues({ posts: [
      { postId: 'x1', kind: 'photo' },
      { postId: 'shared', kind: 'photo' },
      { postId: 'shared', kind: 'photo' },
      { postId: 'shared', kind: 'photo' }
    ] }, SCHEMA);
    assert.equal(out.length, 1);
    assert.equal(out[0].field, 'postId');
    assert.equal(out[0].value, 'shared');
    assert.deepEqual(out[0].indices, [2, 3, 4]);
  });

  it('non-id-named fields with repeated values are ignored (kind:photo ×3 is legitimate)', () => {
    const out = WU.detectDuplicateIdValues(HEALTHY_UNIQUE.posts ? HEALTHY_UNIQUE : { posts: [
      { postId: 'a', kind: 'photo' }, { postId: 'b', kind: 'photo' }
    ] }, SCHEMA);
    assert.equal(out.length, 0);
  });

  it('empty values are skipped (the empty-ratio census owns that class)', () => {
    const out = WU.detectDuplicateIdValues({ posts: [
      { postId: '', content: 'a' }, { postId: '', content: 'b' }
    ] }, SCHEMA);
    assert.equal(out.length, 0);
  });
});

// ---------------------------------------------------------------------------
// F3: anchorHref walk-up
function setupDOM(html) {
  const dom = new JSDOM(html, { url: 'https://example.com/page' });
  global.document = dom.window.document;
  global.window = dom.window;
  global.Node = dom.window.Node;
  return dom;
}

const NO_HOVER = async () => ({ hovered: false, htmlSnippet: null, reason: 'no_popover' });

describe('F3: anchorHref closest(a[href]) walk-up', () => {
  it('span anchor inside the link harvests the ENCLOSING link href', async () => {
    setupDOM(`<!DOCTYPE html><html><body>
      <div class="card"><a href="/groups/123/posts/456"><span class="anchor">label</span></a></div>
    </body></html>`);
    const containers = Array.from(document.querySelectorAll('.card'));
    const records = await OPS.extractWithHoverRecords(
      containers, { t: '.anchor' }, { anchorSel: '.anchor' }, NO_HOVER, {});
    assert.equal(records[0].hovercards.length, 1);
    assert.equal(records[0].hovercards[0].anchorHref, '/groups/123/posts/456',
      'the span has no own href — the value lives one ancestor up');
  });

  it('direct <a> anchor unchanged; bare span outside any link stays empty', async () => {
    setupDOM(`<!DOCTYPE html><html><body>
      <div class="card"><a class="a1" href="/p/1">one</a></div>
      <div class="card"><span class="a2">orphan</span></div>
    </body></html>`);
    const containers = Array.from(document.querySelectorAll('.card'));
    const records = await OPS.extractWithHoverRecords(
      containers, { label: '.a1, .a2' }, { anchorSel: '.a1, .a2' }, NO_HOVER, {});
    assert.equal(records[0].hovercards[0].anchorHref, '/p/1');
    assert.equal(records[1].hovercards[0].anchorHref, '', 'no enclosing link — honestly empty');
  });

  it('content-script inline mirror carries the same walk-up', () => {
    const src = fs.readFileSync(CS_PATH, 'utf8');
    const inline = src.slice(src.indexOf('function createInlineListExtractOps'), src.indexOf('function clickInListItems('));
    assert.ok(inline.indexOf('extractWithHoverRecords') !== -1, 'inline copy located');
    const harvest = inline.slice(inline.indexOf('anchorHref'), inline.indexOf('anchorText'));
    assert.ok(/closest\(['"]a\[href\]['"]\)/.test(harvest), 'mirror must walk up to the enclosing link');
  });
});

// ---------------------------------------------------------------------------
// F-knowledge: the two new units + vocabulary
describe('F-knowledge: units + vocabulary', () => {
  const { KNOWLEDGE_UNITS } = require('../lib/knowledge-units');

  it('scroll-count-frozen unit exists keyed to SCROLL_COUNT_FROZEN and teaches both exits', () => {
    const u = KNOWLEDGE_UNITS.find((x) => x.id === 'scroll-count-frozen');
    assert.ok(u, 'unit must exist');
    assert.ok(u.matchEvents.includes('SCROLL_COUNT_FROZEN'));
    assert.ok(/frame|throttl/i.test(u.body), 'must teach the frame/throttle branch');
    assert.ok(/exhaust|accept|renegotiat/i.test(u.body), 'must teach the genuinely-exhausted exit');
  });

  it('duplicate-id-fallback unit exists keyed to DUPLICATE_ID_VALUES', () => {
    const u = KNOWLEDGE_UNITS.find((x) => x.id === 'duplicate-id-fallback');
    assert.ok(u, 'unit must exist');
    assert.ok(u.matchEvents.includes('DUPLICATE_ID_VALUES'));
    assert.ok(/container-level|shared/i.test(u.body), 'must name the container-level fallback cause');
  });

  it('the knowledge-base VOCAB test lists both new tags (stay in sync)', () => {
    const vocabSrc = fs.readFileSync(path.join(__dirname, 'knowledge-base.test.js'), 'utf8');
    assert.ok(vocabSrc.includes("'SCROLL_COUNT_FROZEN'"));
    assert.ok(vocabSrc.includes("'DUPLICATE_ID_VALUES'"));
  });
});

// ---------------------------------------------------------------------------
// F-universality
describe('F-universality: no site-specific terms in the new surface', () => {
  const SITE_RE = /\b(facebook|twitter|linkedin|tiktok|reddit|instagram|weibo|zhihu|douyin)\b|\b(fb|ig)\b/i;

  it('this test file carries no site terms beyond the guard itself', () => {
    const self = fs.readFileSync(__filename, 'utf8').replace(/const SITE_RE[^\n]*;/, '');
    assert.deepEqual(self.match(SITE_RE) || [], []);
  });

  it('the new wizard-utils detectors and tab-activation additions stay generic', () => {
    const wu = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wizard-utils.js'), 'utf8');
    for (const fn of ['detectFrozenScrollCount', 'detectDuplicateIdValues']) {
      const start = wu.indexOf('function ' + fn);
      assert.ok(start > -1, fn + ' must exist');
      const body = wu.slice(start, wu.indexOf('\nfunction ', start + 1));
      assert.deepEqual(body.match(SITE_RE) || [], [], fn + ' contains a site token');
    }
    const ta = fs.readFileSync(TA_PATH, 'utf8');
    const focus = ta.slice(ta.indexOf('function focusScrapeWindow'), ta.indexOf('\nfunction ', ta.indexOf('function focusScrapeWindow') + 1));
    assert.deepEqual(focus.match(SITE_RE) || [], []);
  });
});
