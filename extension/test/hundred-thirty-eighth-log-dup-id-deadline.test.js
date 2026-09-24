// extension/test/hundred-thirty-eighth-log-dup-id-deadline.test.js
//
// 138th log — two production defects from one session (stopped maxTurns
// 80/80, last verify red, v9 unverified):
//
// A. DUPLICATE-ID STEP GRAPH. The model sent abortChunk WITH the full
//    4-step graph (buffered as "new chunk 1"), then resent all 4 steps as
//    the final chunk. Assembly concatenated buffer+final = 8 steps with 4
//    duplicate ids, and validateChain passed it — its pointer and
//    reachability checks are both id-keyed (a Set collapses duplicates;
//    steps.find resolves the first occurrence), so a shadow copy is
//    invisible. v8 AND v9 shipped corrupted graphs (patch:true then
//    replaced only the FIRST copy of the patched id, leaving the stale
//    second copy resident).
//
// B. ZOMBIE HOVER BATCHES + SCROLL TIMER STARVATION. On the research tab,
//    hover pre-dispatch scrollMs escalated 24s → 82s → 176s → 132s → 203s
//    → 355s → 488s → 590s: the 50ms/250ms settle sleeps inside domHover
//    were stretched to minutes by occluded-window renderer timer
//    throttling (completions clustered on activation thaw bursts), the
//    batch's own maxWallMs budget is checked BETWEEN anchors so one
//    starved anchor burned 10 minutes inside a single call, and the outer
//    SCRIPT_TIMEOUT rejected without the content side ever learning —
//    hovers kept dispatching (and re-stealing window focus via dispatch
//    escalation) for 5+ minutes AFTER the session had stopped.
//
// Fixes under test:
//   A1. validateChain rejects duplicate ids (positions named).
//   A2. chunk assembly/REPLACES dedupes by id (LAST definition wins) and
//       the receipt discloses the dropped duplicates.
//   B1. OffscreenExecutor stamps deadlineAt = now + timeoutMs on the
//       dispatch; offscreen/sandbox/background relay it onto every
//       DOM_REQUEST; the background relay answers EXPIRED requests itself
//       (never relays them — no activation side effects for dead work).
//   B2. content-script: outerDeadlineExceeded guard; domHover entry bail
//       (before any activation) + pre-dispatch starvation cap (15s);
//       domExtractWithHover entry guard + per-anchor-bailing injected
//       hover fn + maxWallMs clamped to the remaining deadline;
//       domCollectUntil per-round abandonment with disclosure.
//
// No site tokens.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const WU = require('../lib/wizard-utils');
const ST = require('../lib/session-tools');

const CS = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
const BG = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const OFFSCREEN_SRC = fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8');
const SANDBOX_SRC = fs.readFileSync(path.join(__dirname, '..', 'sandbox.js'), 'utf8');

function sliceFn(src, marker) {
  const i = src.indexOf(marker);
  assert.ok(i > -1, marker + ' found');
  let depth = 0, j = i;
  for (j = i; j < src.length; j++) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) break; }
  }
  return src.slice(i, j + 1);
}

const mk = (id, next) => ({ id, name: id, onSuccess: next, script: 'return 1;' });

// ---------------------------------------------------------------------------
// A1: validateChain duplicate-id rejection
// ---------------------------------------------------------------------------

describe('138th log A1 — validateChain rejects duplicate step ids', () => {
  it('the exact incident shape (full graph duplicated) is rejected with both positions named', () => {
    const r = WU.validateChain([mk('open', 'wait_feed'), mk('wait_feed', 'collect'), mk('collect', 'extract'), mk('extract', 'TERMINATE'),
      mk('open', 'wait_feed'), mk('wait_feed', 'collect'), mk('collect', 'extract'), mk('extract', 'TERMINATE')]);
    assert.equal(r.valid, false);
    assert.match(r.error, /Duplicate step id "open"/);
    assert.match(r.error, /positions 1 and 5/);
  });

  it('a single duplicated id anywhere is rejected; unique graphs still pass', () => {
    assert.equal(WU.validateChain([mk('a', 'TERMINATE'), mk('a', 'TERMINATE')]).valid, false);
    assert.equal(WU.validateChain([mk('a', 'b'), mk('b', 'TERMINATE')]).valid, true);
  });
});

// ---------------------------------------------------------------------------
// A2: chunk assembly dedupes by id (last wins) + receipt disclosure
// ---------------------------------------------------------------------------

describe('138th log A2 — assembly dedupe-by-id', () => {
  function makeBag(applied) {
    return ST.createSessionTools({
      rail: { executeDsl: async () => ({}), pageState: async () => ({}), epoch: 0 },
      runVerify: async () => ({ events: [], report: { ok: true, detectors: {} }, raw: {} }),
      probeFactory: () => ({ snippet: async () => ({ ok: true }) }),
      getDraftService: () => null,
      applyArtifact: (a) => applied.push(a),
      getTestInput: () => ({}),
      getOutputSchema: () => ({ type: 'object', properties: {} }),
      getSteps: () => [],
      ioConfirmBridge: { request: async (p) => ({ confirmed: true, testInput: p && p.testInput }) }
    }).tools;
  }
  const SCHEMAS = {
    inputSchema: { type: 'object', properties: { k: { type: 'string' } } },
    outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } }
  };

  it('the exact incident sequence lands a CLEAN 4-step artifact (not 8) with the dedupe disclosed', async () => {
    const applied = [];
    const tools = makeBag(applied);
    await tools['io.confirm']({ testInput: { keyword: 'ml', count: 3 }, ...SCHEMAS });
    // abortChunk WITH the full graph (the incident's "new chunk 1")
    const ab = await tools['service.update']({ abortChunk: true, steps: [mk('open', 'wait_feed'), mk('wait_feed', 'collect'), mk('collect', 'TERMINATE')] });
    assert.equal(ab.aborted, true);
    assert.match(ab.note, /already buffered: \[open, wait_feed, collect\]/, 'the abort receipt names the buffered ids so a full resend is unnecessary');
    // final chunk resends ALL of them plus extract
    const r = await tools['service.update']({ steps: [mk('open', 'wait_feed'), mk('wait_feed', 'collect'), mk('collect', 'extract'), mk('extract', 'TERMINATE')] });
    assert.ok(r.updated === true || r.version, 'applied — got ' + JSON.stringify(r).slice(0, 160));
    assert.match(String(r.note || ''), /DEDUPED 3 duplicate-id step definition\(s\) \[open, wait_feed, collect\]/);
    const landed = applied[applied.length - 1].steps;
    assert.deepEqual(landed.map((s) => s.id), ['open', 'wait_feed', 'collect', 'extract'], 'exactly the 4 unique steps');
  });

  it('a single send carrying duplicate ids also dedupes (last definition wins)', async () => {
    const applied = [];
    const tools = makeBag(applied);
    await tools['io.confirm']({ testInput: { keyword: 'ml', count: 3 }, ...SCHEMAS });
    const r = await tools['service.update']({ steps: [
      Object.assign(mk('open', 'wait_feed'), { script: 'return 1;' }),
      Object.assign(mk('wait_feed', 'TERMINATE'), { script: 'return 2;' }),
      Object.assign(mk('open', 'wait_feed'), { script: 'return 3;' }),
      Object.assign(mk('wait_feed', 'TERMINATE'), { script: 'return 4;' })
    ] });
    assert.ok(r.updated === true || r.version, 'applied — got ' + JSON.stringify(r).slice(0, 160));
    const landed = applied[applied.length - 1].steps;
    assert.deepEqual(landed.map((s) => s.id), ['open', 'wait_feed']);
    assert.equal(landed[0].script, 'return 3;', 'the LAST definition of the duplicated id wins');
    assert.equal(landed[1].script, 'return 4;');
  });
});

// ---------------------------------------------------------------------------
// B1: deadline plumbing (offscreen-executor, offscreen.js, sandbox.js, background.js)
// ---------------------------------------------------------------------------

describe('138th log B1 — deadlineAt rides the execution pipeline', () => {
  it('OffscreenExecutor stamps deadlineAt = now + timeoutMs on EXECUTE_SCRIPT_OFFSCREEN', async () => {
    const SENT = [];
    let LISTENERS = [];
    global.chrome = {
      runtime: {
        sendMessage: async (msg) => { SENT.push(msg); },
        getURL: (p) => 'chrome-extension://fake/' + p,
        getContexts: async () => [],
        onMessage: {
          addListener: (fn) => { LISTENERS.push(fn); },
          removeListener: (fn) => { LISTENERS = LISTENERS.filter((f) => f !== fn); }
        }
      },
      offscreen: { createDocument: async () => {} }
    };
    delete require.cache[require.resolve('../lib/offscreen-executor')];
    const { OffscreenExecutor } = require('../lib/offscreen-executor');
    const ex = new OffscreenExecutor(7);
    ex.timeoutMs = 30000;
    const before = Date.now();
    const p = ex.execute('return 1;', {});
    p.catch(() => {});
    for (let i = 0; i < 100 && !SENT.find((m) => m.type === 'EXECUTE_SCRIPT_OFFSCREEN'); i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    const sent = SENT.find((m) => m.type === 'EXECUTE_SCRIPT_OFFSCREEN');
    assert.ok(sent, 'dispatched');
    const after = Date.now();
    assert.equal(typeof sent.deadlineAt, 'number');
    assert.ok(sent.deadlineAt >= before + 30000 && sent.deadlineAt <= after + 30000,
      'deadlineAt is now+timeoutMs — got ' + sent.deadlineAt + ' in [' + (before + 30000) + ', ' + (after + 30000) + ']');
    // resolve the execution so its wall timer is cleared before teardown
    for (const l of [...LISTENERS]) l({ type: 'SCRIPT_RESULT', _fromOffscreen: true, execId: sent.execId, tabId: 7, result: 1 });
    await p;
    global.chrome = undefined;
    delete require.cache[require.resolve('../lib/offscreen-executor')];
  });

  it('offscreen.js forwards deadlineAt on EXECUTE and on DOM_REQUEST (source audit)', () => {
    assert.match(OFFSCREEN_SRC, /forwardExecute\(message\.script, message\.input, message\.execId, message\.deadlineAt\)/);
    assert.match(OFFSCREEN_SRC, /deadlineAt:\s*e\.data\.deadlineAt/, 'DOM_REQUEST forward carries the sandbox-stamped deadline');
  });

  it('sandbox.js stores the EXECUTE deadline and stamps every DOM_REQUEST with it (functional)', async () => {
    // Run the sandbox IIFE in a vm with a postMessage spy and a capturable
    // window message listener; feed it an EXECUTE then observe a $hover
    // DOM_REQUEST pick the deadline up.
    const posted = [];
    let windowListener = null;
    const sandboxWindow = {
      addEventListener: (kind, fn) => { if (kind === 'message') windowListener = fn; }
    };
    const ctx = {
      console: { log: () => {}, warn: () => {}, error: () => {} },
      setTimeout: (fn) => { fn(); return 0; },
      Date: Date,
      JSON: JSON,
      Promise: Promise,
      Map: Map,
      Set: Set,
      parent: { postMessage: (m) => { posted.push(m); } },
      addEventListener: () => {},
      window: sandboxWindow,
      globalThis: {}
    };
    sandboxWindow.window = sandboxWindow;
    sandboxWindow.parent = ctx.parent;
    ctx.globalThis = sandboxWindow;
    vm.createContext(ctx);
    vm.runInContext(SANDBOX_SRC, ctx);
    assert.equal(typeof sandboxWindow.$hover, 'function', 'sandbox $ API attached');
    const p = sandboxWindow.$hover('.a');
    let req = posted.find((m) => m.type === 'DOM_REQUEST');
    assert.ok(req, 'DOM_REQUEST posted');
    assert.equal(req.deadlineAt, null, 'no EXECUTE yet — deadline null (legacy shape)');
    // deliver EXECUTE with a deadline; the next DOM_REQUEST must carry it
    const deadline = Date.now() + 30000;
    windowListener({ data: { type: 'EXECUTE', script: 'return 7;', input: {}, execId: 'e1', deadlineAt: deadline } });
    const p2 = sandboxWindow.$hover('.b');
    req = posted.filter((m) => m.type === 'DOM_REQUEST').pop();
    assert.equal(req.deadlineAt, deadline, 'the stored EXECUTE deadline rides the DOM_REQUEST');
    // source pins for the storage/restatement link
    assert.match(SANDBOX_SRC, /execDeadlineAt = \(typeof e\.data\.deadlineAt === 'number'/);
    assert.match(SANDBOX_SRC, /deadlineAt: execDeadlineAt/);
    void p; void p2;
  });

  it('background.js answers EXPIRED DOM_REQUESTs itself and never relays them (source audit)', () => {
    const i = BG.indexOf("message.type === 'DOM_REQUEST' && message._fromOffscreen");
    const block = BG.slice(i, i + 4000);
    assert.match(block, /deadlineAt: message\.deadlineAt/, 'relay payload carries the deadline through');
    assert.match(block, /Date\.now\(\) > message\.deadlineAt/, 'expiry pre-check before relaying');
    assert.match(block, /OUTER_DEADLINE_EXCEEDED/, 'expired request answered with the diagnostic');
    // the pre-check must run BEFORE the enqueue (a queued zombie would
    // otherwise still reach the tab when the queue drains)
    assert.ok(block.indexOf('Date.now() > message.deadlineAt') < block.indexOf('enqueueDomRequestRelay('),
      'expiry check precedes the enqueue');
  });
});

// ---------------------------------------------------------------------------
// B2: content-script guards
// ---------------------------------------------------------------------------

describe('138th log B2 — domHover deadline + starvation guards', () => {
  function loadHover(deadlineBehavior) {
    const hoverSrc = sliceFn(CS, 'async function domHover(');
    const ctx = {
      console: { log: () => {} },
      Date: Date,
      setTimeout: (fn) => { fn(); return 0; },
      chrome: { storage: { local: { get: (_, cb) => cb({}) }, onChanged: { addListener: () => {} } } },
      querySelectorDeep: () => ({ element: { scrollIntoView: () => {}, getBoundingClientRect: () => ({ width: 10, height: 10, left: 0, top: 0 }) } }),
      querySelectorAllDeep: () => [],
      outerDeadlineExceeded: deadlineBehavior || (() => null),
      readPageFrameState: () => ({ visibilityState: 'visible', hasFocus: true }),
      harvestAnchorLabel: () => null,
      notifyBackgroundDiagnostic: () => {},
      sendDebugLog: () => {},
      withTabActivation: async (l, fn) => fn(),
      collectRejectedAddedTexts: () => [],
      collectRejectedAddedHtml: () => [],
      popoverIdentityOf: () => ({ tag: 'DIV' }),
      isElementVisible: () => true,
      MutationObserver: class { observe() {} disconnect() {} },
      chrome2: null
    };
    vm.createContext(ctx);
    vm.runInContext(hoverSrc + '\nthis.__domHover = domHover;', ctx);
    return ctx.__domHover;
  }

  it('an expired deadline abandons the hover BEFORE any work, with the diagnostic reason', async () => {
    let activations = 0;
    const hoverSrc = sliceFn(CS, 'async function domHover(');
    const ctx = {
      console: { log: () => {} },
      Date: Date,
      setTimeout: (fn) => { fn(); return 0; },
      chrome: { storage: { local: { get: (_, cb) => cb({}) }, onChanged: { addListener: () => {} } } },
      querySelectorDeep: () => { throw new Error('must not resolve the anchor — the entry guard fires first'); },
      querySelectorAllDeep: () => [],
      outerDeadlineExceeded: () => 'OUTER_DEADLINE_EXCEEDED: budget ended',
      readPageFrameState: () => ({ visibilityState: 'visible', hasFocus: true }),
      harvestAnchorLabel: () => null,
      notifyBackgroundDiagnostic: () => {},
      sendDebugLog: () => {},
      withTabActivation: async () => { activations += 1; }
    };
    vm.createContext(ctx);
    vm.runInContext(hoverSrc + '\nthis.__domHover = domHover;', ctx);
    const r = await ctx.__domHover('.anchor', null, {}, Date.now() - 1);
    assert.equal(r.hovered, false);
    assert.equal(r.hoverDispatched, false);
    assert.equal(r.reason, 'outer_deadline_exceeded');
    assert.match(r.reasonDetail, /OUTER_DEADLINE_EXCEEDED/);
    assert.equal(activations, 0, 'no tab activation for a dead execution');
  });

  it('the pre-dispatch starvation cap exists (source audit): scrollDoneAt - hoverT0 > 15000 bails with pre_dispatch_starved', () => {
    const hoverSrc = sliceFn(CS, 'async function domHover(');
    assert.match(hoverSrc, /scrollDoneAt - hoverT0 > 15000/, '15s starve cap present');
    assert.match(hoverSrc, /pre_dispatch_starved/, 'diagnosable reason');
    assert.match(hoverSrc, /Do not read this as a popover-negative/, 'the note blocks the false-negative reading');
  });

  it('outerDeadlineExceeded: null while the budget lives, diagnostic after it passes', () => {
    const ctx = { Date: Date };
    vm.createContext(ctx);
    vm.runInContext(sliceFn(CS, 'function outerDeadlineExceeded(') + '\nthis.__f = outerDeadlineExceeded;', ctx);
    assert.equal(ctx.__f(null), null, 'no deadline (legacy senders) — never blocks');
    assert.equal(ctx.__f(Date.now() + 60000), null, 'budget alive');
    const late = ctx.__f(Date.now() - 1, 'hover');
    assert.match(late, /OUTER_DEADLINE_EXCEEDED/);
    assert.match(late, /hover/);
  });
});

describe('138th log B2 — domExtractWithHover + domCollectUntil deadline guards', () => {
  it('domExtractWithHover: entry guard + per-anchor bail wrapper + clamped wall budget (source audit)', () => {
    const src = sliceFn(CS, 'async function domExtractWithHover(');
    assert.match(src, /outerDeadlineExceeded\(deadlineAt, 'extractWithHover batch'\)/, 'entry guard');
    assert.match(src, /hoverFnForBatch/, 'hover fn wrapper for per-anchor bails');
    assert.match(src, /outerDeadlineExceeded\(deadlineAt, 'anchor hover'\)/, 'per-anchor guard inside the wrapper');
    assert.match(src, /Math\.min\(.*batchWallMs.*Math\.max\(0, remaining\)\)/, 'wall budget clamped to the remaining deadline');
    assert.match(src, /domHover\(anchorEl, popoverSelArg, hopts, deadlineAt\)/, 'deadline threaded into each anchor hover');
  });

  it('domExtractWithHover entry guard throws with diagnostics when the deadline passed (functional)', async () => {
    const src = sliceFn(CS, 'async function domExtractWithHover(');
    const ctx = {
      console: { log: () => {} },
      Date: Date,
      outerDeadlineExceeded: () => 'OUTER_DEADLINE_EXCEEDED: budget ended',
      querySelectorAllDeep: () => { throw new Error('must not resolve containers — entry guard fires first'); },
      sendDebugLog: () => {},
      notifyBackgroundDiagnostic: () => {}
    };
    vm.createContext(ctx);
    vm.runInContext(src + '\nthis.__f = domExtractWithHover;', ctx);
    await assert.rejects(
      ctx.__f('.card', { t: { selector: '.t' } }, { hover: { anchorSel: '.a' } }, Date.now() - 1),
      (err) => {
        assert.match(err.message, /OUTER_DEADLINE_EXCEEDED/);
        assert.equal(err._diagnostics.outerDeadlineExceeded, true);
        return true;
      }
    );
  });

  it('the injected per-anchor hover fn bails without touching domHover once the deadline passed (functional)', async () => {
    // Extract the wrapper construction by calling domExtractWithHover with
    // fake ops that capture the injected hover fn and opts. The deadline
    // guard is made stateful: the ENTRY check passes (call 1 → null), the
    // per-anchor check then trips (call 2+ → error).
    const captured = {};
    let guardCalls = 0;
    const src = sliceFn(CS, 'async function domExtractWithHover(');
    const el = (id) => ({ tag: 'DIV', id });
    const ctx = {
      console: { log: () => {} },
      Date: Date,
      outerDeadlineExceeded: () => { guardCalls += 1; return guardCalls === 1 ? null : 'OUTER_DEADLINE_EXCEEDED: budget ended'; },
      querySelectorAllDeep: () => [el('c1'), el('c2')],
      sendDebugLog: () => {},
      notifyBackgroundDiagnostic: () => {},
      getListExtractOps: () => ({
        resetMatchGuardSkips: () => {},
        extractWithHoverRecords: async (processed, fieldMap, hoverConfig, hoverFn, o) => {
          captured.hoverFn = hoverFn;
          captured.opts = o;
          return [];
        }
      }),
      computeSelectorDifferential: () => null,
      formatSelectorDifferentialNote: () => '',
      attachClauseCostCensus: () => null,
      computeAnchorCensus: () => null,
      domHover: async () => { throw new Error('real domHover must not run once the deadline passed'); }
    };
    vm.createContext(ctx);
    vm.runInContext(src + '\nthis.__f = domExtractWithHover;', ctx);
    await ctx.__f('.card', { t: { selector: '.t' } }, { hover: { anchorSel: '.a' }, maxWallMs: 25000 }, Date.now() + 60000);
    assert.equal(typeof captured.hoverFn, 'function', 'wrapper injected');
    const r = await captured.hoverFn({ tag: 'A' }, null, {});
    assert.equal(r.reason, 'outer_deadline_exceeded');
    assert.equal(r.hoverDispatched, false);
    assert.equal(captured.opts.maxWallMs, 25000, 'wall budget present (clamped to remaining deadline when shorter)');
  });

  it('domCollectUntil abandons at the round boundary once the deadline passes and discloses it (functional)', async () => {
    const src = sliceFn(CS, 'async function domCollectUntil(');
    let scrollCalls = 0;
    const ctx = {
      console: { log: () => {} },
      Date: Date,
      setTimeout: (fn) => { fn(); return 0; },
      querySelectorAllDeep: () => [{ element: { getAttribute: () => '/p1' } }, { element: { getAttribute: () => '/p2' } }],
      getScrollOps: () => ({ scrollToBottomIncremental: async () => { scrollCalls += 1; return { stalled: false, newScrollHeight: 1000, attempts: 1 }; } }),
      resolveScrollTarget: () => null,
      sendDebugLog: () => {},
      notifyBackgroundDiagnostic: () => {},
      withTabActivation: async (l, fn) => fn(),
      outerDeadlineExceeded: (dl) => (scrollCalls >= 1 && typeof dl === 'number') ? 'OUTER_DEADLINE_EXCEEDED: budget ended' : null
    };
    vm.createContext(ctx);
    vm.runInContext(src + '\nthis.__f = domCollectUntil;', ctx);
    const r = await ctx.__f('.card', { targetCount: 99, idAttr: 'href', settleMs: 1, maxRounds: 10 }, Date.now() + 100000);
    assert.equal(scrollCalls, 1, 'loop abandoned at the SECOND round boundary (one scroll ran before the deadline tripped)');
    assert.match(String(r.outerDeadline), /OUTER_DEADLINE_EXCEEDED/, 'receipt discloses the abandonment');
  });

  it('the dispatch switch threads data.deadlineAt into the long ops (source audit)', () => {
    assert.match(CS, /domExtractWithHover\(data\.selector, data\.args && data\.args\[0\], data\.args && data\.args\[1\], data\.deadlineAt\)/);
    assert.match(CS, /domCollectUntil\(data\.selector, \(data\.args && data\.args\[0\] && typeof data\.args\[0\] === 'object'\) \? data\.args\[0\] : \{\}, data\.deadlineAt\)/);
    assert.match(CS, /domHover\(data\.selector, data\.args && data\.args\[0\], data\.args && data\.args\[1\], data\.deadlineAt\)/);
  });
});

// ---------------------------------------------------------------------------
// 138th log — prompt segmentation budget guard (user directive: after 138
// rounds of accretion the base prompt exploded to 21.8K + 9.3K spec chars of
// undifferentiated narrative; the rewrite is operative-only and SECTIONED.
// This guard pins the budget so a future round cannot silently regrow it:
// add a rule → cut a stale one, or move depth into a knowledge unit.
// ---------------------------------------------------------------------------

describe('138th log — prompt budget guard (segmentation)', () => {
  const base = ST.buildDslContractPrompt();
  const specs = ST.createSessionTools({
    rail: { executeDsl: async () => ({}), pageState: async () => ({}), epoch: 0 },
    runVerify: async () => ({ events: [], report: { ok: true, detectors: {} }, raw: {} }),
    probeFactory: () => ({ snippet: async () => ({ ok: true }) }),
    getDraftService: () => null, applyArtifact: () => {},
    getTestInput: () => ({}), getOutputSchema: () => ({ type: 'object', properties: {} }),
    getSteps: () => [],
    ioConfirmBridge: { request: async () => ({ confirmed: true }) }
  }).toolSpecs;
  const specTotal = specs.reduce((s, t) => s + t.args.length + t.returns.length, 0);

  it('the base contract stays within the post-rewrite budget (and above a sanity floor)', () => {
    assert.ok(base.length <= 17500, 'base prompt ' + base.length + ' chars exceeds the 17500 budget — cut a stale rule or move depth to a knowledge unit');
    assert.ok(base.length >= 9000, 'base prompt ' + base.length + ' chars fell below the 9000 floor — operative rules were LOST, not compressed');
  });

  it('the base contract is SECTIONED with a quick index (navigability is the point)', () => {
    assert.match(base, /# Contract quick index/);
    for (const h of ['# 1 Service model', '# 2 \$ API', '## 2.1 Reads', '## 2.2 Lists \\+ hover', '## 2.3 Scroll \\+ collect', '## 2.4 Interaction \\+ waits', '## 2.5 Tabs', '## 2.6 Selector \\+ return rules', '# 3 Methodology \\(10 rules\\)', '# 4 Skeleton view']) {
      assert.ok(base.indexOf(h.replace(/\\\+/g, '+').replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\$/g, '$')) !== -1, 'section present: ' + h);
    }
  });

  it('toolSpecs stay within the budget, per-spec and total', () => {
    assert.ok(specTotal <= 6500, 'toolSpecs total ' + specTotal + ' exceeds 6500 — trim to operative content or move teaching to a knowledge unit');
    for (const t of specs) {
      const n = t.args.length + t.returns.length;
      assert.ok(n <= 900, t.name + ' spec is ' + n + ' chars (max 900) — the spec carries args/shape/call-time rules only');
    }
  });

  it('operative anchors survived the rewrite (spot-check load-bearing clauses)', () => {
    const anchors = [
      /STEP_NO_RETURN/,
      /VISIBILITY-gated/,
      /multi:true collects ALL matches/,
      /read:\'hoverPopover\'/,
      /\$collectUntil\(containerSel/,
      /THROWS ELEMENT_NOT_FOUND/,
      /:has-text\/:contains\/:text= are NOT/,
      /GROUND every selector/,
      /CHEAPEST probe/,
      /diag\.read BEFORE changing/,
      /CHOOSE THE ANCHOR BY REQUIREMENT SEMANTICS/,
      /REQUIREMENT-BOUNDED/,
      /INPUT_VALUE_SUSPECT/,
      /EARLY contract confirmation/,
      /Ship real values only/,
      /NUMBERED SKELETON/
    ];
    for (const re of anchors) assert.ok(re.test(base), 'operative clause survives: ' + re);
  });
});
