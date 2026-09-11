// Sixty-second log (console.log 2026-09-10, session rs-1789099270828-1,
// glm-5-turbo via singhand gateway, 58/60 turns). The 61st-log context — a
// fresh Windows machine — is the key: Enhanced Scraping Mode was NEVER
// enabled there, so every trusted hover of the session failed the
// hasDebuggerPermission() gate (23× "debugger permission not granted" in the
// log). Three compounding defects, all confirmed from evidence:
//
// RC1 — THE RECEIPT LIED TWICE. (a) The reason token named a permission the
// manifest DOES grant ("debugger" is in required permissions) — the actual
// gate is the Enhanced Mode settings toggle. (b) The 45th-log budgetNote
// ("environmental transient … retry the same hover") was written for
// CDP-contention dispatch failures; the opt-out gate fails the SAME way
// (dispatched:false) but DETERMINISTICALLY. One session, 23 structurally
// doomed retries, and the model's honest conclusion — "cold page doesn't
// resolve" — was wrong in the direction that matters: no page state could
// ever have fixed it.
//
// RC2 — STAGNATION BLIND TO A FLAPPING PERIPHERY. v3/v4/v5 all failed the
// SAME REQUIRED_FIELD_EMPTY gate (postTime/commentCount/shareCount/location
// 4/4 empty) but the OPTIONAL hoverExtensions flapped across the empty-ratio
// threshold between runs (2/4 → 0/4 → 2/4), so no two 52nd-log
// exact-match signatures were byte-identical and the STAGNANT_DISCLOSURES
// streak never formed across the three reds.
//
// RC3 — NO USER-FACING CHANNEL. RC25 gave the trusted-WHEEL opt-out a
// background broadcast + wizard post-run tip; the hover lane had nothing —
// the user never learned a one-toggle remedy existed.
//
// Fixes under test:
//   F1 — honest deterministic receipt: renderer-activation gates renamed
//        'enhanced mode disabled' (wheel + hover + dismiss); domHover
//        budgetNote branches on the reason (deterministic → no-retry
//        teaching naming the Settings toggle / finish / io.confirm and the
//        still-working non-hover routes; anything else keeps the 45th-log
//        transient+retry text); SCRIPT_DSL_GUIDE hover line rewritten;
//        domExtractWithHover exposes hoverSummary.enhancedModeDisabled as an
//        aggregate capability fact.
//   F2 — stagnation fires on the INTERSECTION of the last three signatures,
//        naming the persistent entries (flapping periphery excluded;
//        monotone progress still escapes — a fixed field drops out of the
//        intersection; the 56th-log all-empty guard survives structurally:
//        empty signatures intersect to nothing).
//   F3 — RC25 parity: background forwards a hover_request diagnostic with
//        dispatched:false + reason 'enhanced mode disabled' as
//        HOVER_SKIPPED_ENHANCED_MODE; the wizard counts it and surfaces a
//        post-run tip with the one-toggle remedy.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { createSessionTools } = require('../lib/session-tools');

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

// ---------------------------------------------------------------------------
// F1 behavioral: domHover budgetNote branch — same dispatched:false envelope,
// two opposite teachings. Factory harness copied from the forty-fifth-log
// tests (real resolveLabelledbyText + harvestAnchorLabel slices, jsdom
// anchor, chrome relay stub).
// ---------------------------------------------------------------------------

const HARVEST_DEPS_SRC =
  sliceFnSource('function resolveLabelledbyText(', '\n  async function domLabelledby') +
  '\n' +
  sliceFnSource('function harvestAnchorLabel(', '\n  async function domHover(');

function sliceFnSource(startMarker, endMarker) {
  return sliceFn(readSrc('content-script.js'), startMarker, endMarker);
}

function sliceDomHover(src) {
  return sliceFn(src, 'async function domHover(', 'async function domExtractWithHover(');
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

function baseHoverContext(dom, anchor, hoverReply) {
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
            if (m.type === 'TRUSTED_HOVER_REQUEST') return hoverReply;
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
      harvestAnchorLabel: () => null,
      popoverIdentityOf: () => ({ tag: 'DIV' })
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

describe('sixty-second log F1: domHover budgetNote — deterministic gate vs transient', () => {
  it('enhanced mode disabled → deterministic teaching: Settings toggle, finish/io.confirm, non-hover routes; NO transient-retry lie', async () => {
    const { dom, anchor } = makeAnchorDom();
    const { ctx, sent } = baseHoverContext(dom, anchor,
      { dispatched: false, ok: false, reason: 'enhanced mode disabled' });
    const hoverFn = loadDomHover(ctx, HARVEST_DEPS_SRC);

    const r = await hoverFn('.a', null, { timeoutMs: 5000 });

    assert.equal(r.hovered, false);
    assert.equal(r.hoverDispatched, false);
    assert.equal(r.reason, 'enhanced mode disabled');
    assert.match(r.budgetNote, /Enhanced Scraping Mode is OFF|Enhanced Mode is off/i,
      'names the actual gate — a Settings toggle, not a page property');
    assert.match(r.budgetNote, /Settings/i);
    assert.match(r.budgetNote, /finish/i, 'teaches surfacing in the finish summary');
    assert.match(r.budgetNote, /io\.confirm/, 'teaches the renegotiation exit');
    assert.match(r.budgetNote, /labelledby/, 'teaches the still-working non-hover routes');
    assert.ok(!/environmental transient/.test(r.budgetNote),
      'the deterministic gate must NOT carry the 45th-log transient framing');
    assert.ok(!/retry the same hover/.test(r.budgetNote),
      'the deterministic gate must NOT teach a retry — 23 doomed retries was the incident');
    assert.ok(!sent.includes('TRUSTED_HOVER_DISMISS'), 'early-out preserved (45th-log F1)');
    assert.equal(r.labelledbyText, 'June 21 June 21, 2024 at 3:15 PM',
      'the anchor-label harvest still runs — it needs no dispatch, and the deterministic note leans on it');
  });

  it('any other dispatch failure keeps the 45th-log transient + retry teaching', async () => {
    const { dom, anchor } = makeAnchorDom();
    const { ctx } = baseHoverContext(dom, anchor,
      { dispatched: false, ok: false, reason: 'hover.mouseMoved timeout after 2000ms' });
    const hoverFn = loadDomHover(ctx, HARVEST_DEPS_SRC);

    const r = await hoverFn('.a', null, { timeoutMs: 5000 });

    assert.equal(r.reason, 'hover.mouseMoved timeout after 2000ms');
    assert.match(r.budgetNote, /environmental transient/);
    assert.match(r.budgetNote, /retry the same hover/);
  });

  it('renderer-activation gates: the misnomer is gone, all three dispatch sites carry the honest token', () => {
    const src = readSrc('lib/renderer-activation.js');
    const live = src.match(/reason:\s*'debugger permission not granted'/g) || [];
    assert.equal(live.length, 0,
      'the manifest DOES grant the debugger permission — no live reason may claim otherwise');
    const honest = src.match(/reason:\s*'enhanced mode disabled'/g) || [];
    assert.ok(honest.length >= 3,
      'wheel + hover + dismiss gate sites all renamed (got ' + honest.length + ')');
  });

  it('SCRIPT_DSL_GUIDE hover line teaches the deterministic gate, not the old token', () => {
    const guide = readSrc('lib/wizard-utils.js');
    const lineIdx = guide.indexOf('reason:\'enhanced mode disabled\'') >= 0
      ? guide.indexOf("reason:'enhanced mode disabled'")
      : guide.indexOf("reason:'enhanced mode disabled'");
    assert.ok(lineIdx > -1, 'guide references the new token');
    const line = guide.slice(lineIdx, lineIdx + 700);
    assert.match(line, /DETERMINISTIC/i);
    assert.match(line, /no retry will change it|not by retrying/i);
    assert.match(line, /renegotiat|io\.confirm/i);
    assert.match(line, /labelledby/i, 'non-hover routes named');
    assert.equal(guide.indexOf("reason:'debugger permission not granted'"), -1,
      'the old token no longer appears as a live reason anywhere in the guide');
  });

  it('domExtractWithHover: a gate failure in the tally is surfaced as an aggregate capability fact', () => {
    const body = sliceFn(readSrc('content-script.js'),
      'async function domExtractWithHover(', '\n  async function domOpenTab(');
    const flagIdx = body.indexOf("failureReasons['enhanced mode disabled']");
    assert.ok(flagIdx > -1, 'the tally branches on the gate token');
    const flagSrc = body.slice(flagIdx, flagIdx + 400);
    assert.match(flagSrc, /hoverSummary\.enhancedModeDisabled/,
      'the aggregate lives ON hoverSummary — a verify-time reader sees a capability fact, not N per-anchor failures');
    assert.match(flagSrc, /deterministic capability gate|Enhanced Scraping Mode is off/i,
      'the note names the toggle');
  });
});

// ---------------------------------------------------------------------------
// F2 behavioral: stagnation fires on the shared core across three verifies,
// ignoring a flapping periphery.
// ---------------------------------------------------------------------------

function makeVerifyDeps(peSequences, extras) {
  const e = extras || {};
  let i = 0;
  const deps = {
    rail: {
      pageOpen: async () => ({ tabId: 1, url: 'https://example.com', ready: true }),
      pageState: async () => ({ open: true, tabId: 1, url: 'https://example.com' }),
      executeDsl: async () => 5,
      ensureLock: async () => {}, releaseLock: async () => {}, dispose: async () => {}, tabId: 1
    },
    getDraftService: () => ({ name: 's', steps: [{ id: 'x', script: 'return 1', onSuccess: 'TERMINATE' }] }),
    applyArtifact: () => {},
    getTestInput: () => ({}),
    getOutputSchema: () => null,
    getSteps: () => [],
    annotationBridge: null,
    ioConfirmBridge: { request: async () => ({ confirmed: true }) },
    runVerify: async () => {
      const peList = (peSequences[i] || peSequences[peSequences.length - 1]).map((p) => {
        const [path, counts] = p.split(':');
        const [emptyCount, totalCount] = counts.split('/');
        return { field: path.split('.').pop(), path, emptyCount: +emptyCount, totalCount: +totalCount, emptyRatio: emptyCount / totalCount, sampleNonEmpty: null, emptyRecordSamples: [] };
      });
      i += 1;
      return {
        report: {
          ok: true, error: null, aborted: false,
          score: { score: 143, isData: true, breakdown: {} },
          schemaOk: false, schemaMissing: ['posts.postTime'],
          detectors: {
            emptyFields: [], duplicateFields: [], countShortfall: null,
            partialEmptyFields: peList,
            junkValues: e.junkFields ? { fields: e.junkFields.map((f) => ({ field: f })) } : undefined
          },
          steps: [], finalResult: { posts: [{ postId: '1' }] }, pages: '1', eventCount: 1, events: []
        },
        events: [], raw: {}
      };
    }
  };
  return deps;
}

describe('sixty-second log F2: stagnation fires on the persistent core (flapping periphery ignored)', () => {
  // The exact incident shape: four fields 4/4-empty across v3/v4/v5, the
  // OPTIONAL hoverExtensions flapping 2/4 → 0/4 → 2/4.
  const CORE = ['posts.postTime:4/4', 'posts.commentCount:4/4', 'posts.shareCount:4/4', 'posts.location:4/4'];
  const WITH_FLAP = CORE.concat(['posts.hoverExtensions:2/4']);

  it('flapping membership never breaks the streak — the advisory fires naming the four persistent entries', async () => {
    const deps = makeVerifyDeps([WITH_FLAP, CORE, WITH_FLAP]);
    const t = createSessionTools(deps);
    const r1 = await t.tools['verify.run']({});
    const r2 = await t.tools['verify.run']({});
    assert.ok(!r1.stagnationNote && !r2.stagnationNote, 'first two: no advisory');
    const r3 = await t.tools['verify.run']({});
    assert.ok(r3.stagnationNote,
      'third verify: the advisory MUST fire — exact-match semantics stayed silent through the whole incident');
    for (const p of CORE) {
      assert.ok(r3.stagnationNote.includes(p), 'names persistent entry ' + p);
    }
    assert.ok(!r3.stagnationNote.includes('hoverExtensions'),
      'the flapping periphery is excluded — it is not part of the stuck core');
    assert.match(r3.stagnationNote, /PERSISTENT/);
    assert.ok((r3.events || []).includes('STAGNANT_DISCLOSURES'));
  });

  it('rotating signatures (real progress) still never fire', async () => {
    const deps = makeVerifyDeps([
      ['posts.postTime:4/4', 'posts.commentCount:4/4'],
      ['posts.commentCount:4/4', 'posts.shareCount:2/4'],
      ['posts.shareCount:1/4', 'posts.location:1/4']
    ]);
    const t = createSessionTools(deps);
    const r3 = await (async () => {
      await t.tools['verify.run']({});
      await t.tools['verify.run']({});
      return t.tools['verify.run']({});
    })();
    assert.ok(!r3.stagnationNote,
      'no entry persists across all three — fields are moving, this is progress, not stagnation');
  });

  it('a junk-field intersection fires with the junk: prefix when no partial-empty core exists', async () => {
    const deps = makeVerifyDeps([
      ['posts.postTime:4/4'],
      ['posts.commentCount:2/4'],
      ['posts.shareCount:1/4']
    ], { junkFields: ['queryBlob'] });
    const t = createSessionTools(deps);
    await t.tools['verify.run']({});
    await t.tools['verify.run']({});
    const r3 = await t.tools['verify.run']({});
    assert.ok(r3.stagnationNote, 'the junk intersection is a stuck core too');
    assert.match(r3.stagnationNote, /junk: queryBlob/);
  });
});

// ---------------------------------------------------------------------------
// F3: RC25 parity — background broadcast + wizard surfacing.
// ---------------------------------------------------------------------------

function makeChromeStub() {
  const sentMessages = [];
  const messageListeners = [];
  const noop = function () {};
  class ServiceRegistry {
    constructor() { this._byName = new Map(); }
    async getByName() { return null; }
    async list() { return []; }
  }
  class LLMClient { constructor() {} chat() { return Promise.resolve(''); } }
  class OffscreenExecutor {
    constructor() { this.tabId = 0; this.timeoutMs = 1; }
    ensureOffscreenDocument() { return Promise.resolve(); }
    hasDocument() { return Promise.resolve(false); }
    closeDocument() { return Promise.resolve(); }
    wrapScript(code) { return code; }
    execute() { return Promise.resolve({ result: null, selectorDiagnostics: [] }); }
  }
  class UrlTemplate { static resolveTargetUrl(url) { return url; } }
  class StepOrchestrator { static async execute() { return { finalResult: null, steps: [] }; } }
  return {
    chrome: {
      runtime: {
        sendMessage: (msg) => { sentMessages.push(msg); return Promise.resolve(); },
        onMessage: {
          addListener: (fn) => messageListeners.push(fn),
          removeListener: (fn) => {
            const i = messageListeners.indexOf(fn);
            if (i >= 0) messageListeners.splice(i, 1);
          }
        },
        onInstalled: { addListener: noop },
        onStartup: { addListener: noop },
        openOptionsPage: noop,
        getLastError: () => null,
        getURL: (p) => 'chrome-extension://x/' + p
      },
      storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
      alarms: { create: noop, onAlarm: { addListener: noop } },
      action: { onClicked: { addListener: noop } },
      tabs: { remove: () => Promise.resolve() },
      offscreen: { createDocument: () => Promise.resolve() }
    },
    classes: { ServiceRegistry, LLMClient, OffscreenExecutor, UrlTemplate, StepOrchestrator },
    _sentMessages: sentMessages,
    _messageListeners: messageListeners,
    _emit(message, sender = { tab: { id: 1 } }) {
      for (const fn of messageListeners) fn(message, sender, noop);
    }
  };
}

function loadBackground(stub) {
  const noop = function () {};
  const sandbox = {
    chrome: stub.chrome,
    ServiceRegistry: stub.classes.ServiceRegistry,
    LLMClient: stub.classes.LLMClient,
    OffscreenExecutor: stub.classes.OffscreenExecutor,
    UrlTemplate: stub.classes.UrlTemplate,
    StepOrchestrator: stub.classes.StepOrchestrator,
    debugLogger: { log: noop },
    importScripts: noop,
    console: { log: noop, error: noop, warn: noop },
    Date, JSON, URL, Promise, Error, Object, Array, Math,
    String, Number, Boolean, Map, Set, Symbol, parseInt, parseFloat,
    setTimeout, clearTimeout,
    AbortSignal: { timeout: () => ({}) },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ type: 'HEARTBEAT' }) })
  };
  vm.createContext(sandbox);
  vm.runInContext(readSrc('background.js'), sandbox);
}

describe('sixty-second log F3: hover-capability broadcast + wizard tip (RC25 parity)', () => {
  it('background broadcasts HOVER_SKIPPED_ENHANCED_MODE for a gate-failed hover_request diagnostic', () => {
    const stub = makeChromeStub();
    loadBackground(stub);
    stub._emit({
      type: 'CONTENT_SCRIPT_DIAGNOSTIC',
      category: 'hover_request',
      payload: { dispatched: false, reason: 'enhanced mode disabled', anchor: '.a' }
    });
    const b = stub._sentMessages.find((m) => m.type === 'HOVER_SKIPPED_ENHANCED_MODE');
    assert.ok(b, 'the broadcast exists — wheel parity (RC25)');
    assert.equal(b.payload.reason, 'enhanced mode disabled');
  });

  it('transient dispatch failures do NOT broadcast (only the deterministic gate pages the user)', () => {
    const stub = makeChromeStub();
    loadBackground(stub);
    stub._emit({
      type: 'CONTENT_SCRIPT_DIAGNOSTIC',
      category: 'hover_request',
      payload: { dispatched: false, reason: 'hover.mouseMoved timeout after 2000ms' }
    });
    assert.equal(
      stub._sentMessages.find((m) => m.type === 'HOVER_SKIPPED_ENHANCED_MODE'), undefined,
      'a transient failure is per-anchor noise, not a session capability fact');
  });

  it('a successful hover dispatch never broadcasts', () => {
    const stub = makeChromeStub();
    loadBackground(stub);
    stub._emit({
      type: 'CONTENT_SCRIPT_DIAGNOSTIC',
      category: 'hover_request',
      payload: { dispatched: true, ok: true }
    });
    assert.equal(stub._sentMessages.find((m) => m.type === 'HOVER_SKIPPED_ENHANCED_MODE'), undefined);
  });

  it('wizard wiring: listener, tip copy with the one-toggle remedy, and resets at BOTH run sites', () => {
    const src = readSrc('wizard.js');
    assert.ok(/HOVER_SKIPPED_ENHANCED_MODE/.test(src), 'wizard listens for the broadcast');
    const listenIdx = src.indexOf("message.type === 'HOVER_SKIPPED_ENHANCED_MODE'");
    assert.ok(listenIdx > -1);
    assert.match(src.slice(listenIdx, listenIdx + 300), /hoverSkipCount/,
      'the listener increments the counter');
    const tipIdx = src.indexOf('Hover dispatches failed');
    assert.ok(tipIdx > -1, 'the post-run tip exists');
    assert.match(src.slice(tipIdx, tipIdx + 500), /Enhanced Mode is off/,
      'the tip names the toggle state');
    assert.match(src.slice(tipIdx, tipIdx + 500), /Enhanced scraping mode/i,
      'the tip carries the one-toggle remedy');
    const resets = src.match(/hoverSkipCount = 0/g) || [];
    assert.equal(resets.length, 2,
      'the counter resets at BOTH run sites — testScript and presentSessionCompletion (stale counts would phantom-tip later runs)');
  });
});

// ---------------------------------------------------------------------------
// Universality guard: the new telemetry and teaching strings carry no site
// tokens — the gate/budgetNote/stagnation/tip machinery is infrastructure.
// ---------------------------------------------------------------------------

describe('sixty-second log universality guard', () => {
  const FORBIDDEN = /facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i;

  it('no site tokens in the new receipts, teachings, or tips', () => {
    const strings = [
      sliceFn(readSrc('content-script.js'), 'async function domHover(', 'async function domExtractWithHover(')
        .match(/result\.budgetNote = '[^']+'/g) || [],
      readSrc('lib/renderer-activation.js').match(/reason:\s*'[^']+'/g) || [],
      sliceFn(readSrc('content-script.js'), 'async function domExtractWithHover(', '\n  async function domOpenTab(')
        .slice(-800),
      sliceFn(readSrc('lib/session-tools.js'), 'async function verifyRun(', '\n    // Contract-state analysis view'),
      readSrc('wizard.js').slice(readSrc('wizard.js').indexOf('HOVER_SKIPPED_ENHANCED_MODE') - 200,
        readSrc('wizard.js').indexOf('HOVER_SKIPPED_ENHANCED_MODE') + 1600)
    ].flat();
    for (const s of strings) {
      assert.ok(!FORBIDDEN.test(s), 'site token found in new code string: ' + String(s).slice(0, 120));
    }
  });
});
