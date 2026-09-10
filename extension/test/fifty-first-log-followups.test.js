// extension/test/fifty-first-log-followups.test.js
// Fifty-first log — the no-login-state session (28 turns visible, completed
// with an honest negative conclusion). The session's environment conclusion
// was right, but three evidence-chain gaps surfaced:
//  F1 the v2 container selector div[role='feed'] > div:has(a[href*='/posts/'],
//     a[href*='story_fbid'], a[href*='/permalink/']) has commas INSIDE the
//     :has() argument list — computeSelectorDifferential bails on ANY comma
//     (line guard for union lists), so the zero-match error shipped BARE
//     ("$extractWithHover: no containers matched") with no differential,
//     even though the stripped base div[role='feed'] > div matched 4 and the
//     :has clause removed every one of them.
//  F2 the zero-container THROW shape is invisible to the censuses: the
//     orchestrator emits STEP_FAILED (with selectorDiagnostics — the sandbox
//     B2 error path relays them) but detectContainerMatchZero scans only
//     STEP_ITERATION, and the verify-runner error branch (fiftieth log) runs
//     only the frozen-scroll census — the v2 red verify carried ZERO tags
//     (no INPUT_VALUE_SUSPECT, no SELECTOR_OVERFILTERED, no census lines).
//  F3 probe.scroll mode:'by' rejects negative `by` (scroll-up) while
//     $scrollBy(deltaY) takes a signed delta — the model's legitimate
//     "scroll back to re-examine the top" was blocked (envelope-parity class).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createVerifyRunner } = require('../lib/verify-runner');
const WU = require('../lib/wizard-utils');
const { createSessionTools } = require('../lib/session-tools');

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

function domWithCards() {
  return new JSDOM(
    '<div class="card"><a href="/posts/1"></a></div>' +
    '<div class="card"><a href="/posts/2"></a></div>' +
    '<div class="card"><a href="/photos/9"></a></div>'
  ).window.document;
}

function makeDifferential(document) {
  const deep = (sel) => Array.from(document.querySelectorAll(sel));
  const strip = new Function('return (' + sliceFn('stripTrailingFilterClause') + ')')();
  const factory = new Function('querySelectorAllDeep', 'stripTrailingFilterClause', 'return (' + sliceFn('computeSelectorDifferential') + ')');
  return factory(deep, strip);
}

// ---------------------------------------------------------------------------
// F1: commas inside functional pseudo-class arguments must not kill the
// differential (only TOP-LEVEL commas mean a union list)
describe('F1: selector differential survives comma lists inside :has() (fifty-first log)', () => {
  it('the fifty-first-log shape — :has(a[...], a[...], a[...]) — carries a full differential', () => {
    const doc = domWithCards();
    // posts-links clause: only 2 of 3 cards carry /posts/ hrefs under this
    // stricter union of TWO clause args — count what the page actually has.
    const diff = makeDifferential(doc)("div.card:has(a[href*='/posts/'], a[href*='/permalink/'])");
    assert.ok(Array.isArray(diff), 'differential computed despite inner commas');
    assert.equal(diff.length, 2, 'full + stripped-base stage');
    assert.equal(diff[0].count, 2, 'the :has clause keeps the 2 /posts/ cards');
    assert.equal(diff[1].sel, 'div.card', 'stripped base');
    assert.equal(diff[1].count, 3, 'base matches all 3 cards');
  });

  it('a killer :has comma-list on a zero-match selector exposes the collapse point', () => {
    const doc = domWithCards();
    const diff = makeDifferential(doc)("div.card:has(a[href*='/nothing/'], a[href*='/also-nothing/'])");
    assert.ok(Array.isArray(diff) && diff.length === 2);
    assert.equal(diff[0].count, 0, 'full selector matches 0');
    assert.equal(diff[1].count, 3, 'the base is populated — the clause removed EVERYTHING');
  });

  it('top-level comma lists (union selectors) still bail — they are not one strippable selector', () => {
    const doc = domWithCards();
    assert.equal(makeDifferential(doc)('div.card, div.missing'), null);
  });

  it('commas inside quoted attribute values do not read as list separators', () => {
    const doc = new JSDOM('<div class="card" data-tags="a,b"></div>').window.document;
    const diff = makeDifferential(doc)('div.card:has([data-tags="a,b"])');
    assert.ok(Array.isArray(diff), 'quoted-comma attribute value does not disable the differential');
  });
});

// ---------------------------------------------------------------------------
// F2: the zero-container THROW shape reaches the censuses
describe('F2: detectContainerMatchZero scans STEP_FAILED events (fifty-first log)', () => {
  const ZERO_THROW_DIAG = {
    api: 'extractWithHover',
    containerSelector: "div[role='feed'] > div:has(a[href*='/posts/'])",
    containerMatches: 0,
    processedContainers: 0,
    perField: [],
    selectorDifferential: [
      { sel: "div[role='feed'] > div:has(a[href*='/posts/'])", count: 0 },
      { sel: "div[role='feed'] > div", count: 4 }
    ],
    note: 'no containers matched'
  };

  it('a STEP_FAILED event carrying a zero-container diagnostic is a census hit', () => {
    const events = [
      { type: 'STEP_FAILED', stepId: 'extract', error: '$extractWithHover: no containers matched', selectorDiagnostics: [ZERO_THROW_DIAG] }
    ];
    const out = WU.detectContainerMatchZero(events);
    assert.ok(out && out.length === 1, 'census sees the throw shape: ' + JSON.stringify(out));
    assert.equal(out[0].stepId, 'extract');
    assert.equal(out[0].api, 'extractWithHover');
    assert.equal(out[0].zeroCalls, 1);
    assert.ok(Array.isArray(out[0].selectorDifferential) && out[0].selectorDifferential.length === 2,
      'the live differential rides the census');
  });

  it('non-list diagnostics on STEP_FAILED stay invisible (no container census noise)', () => {
    const events = [
      { type: 'STEP_FAILED', stepId: 's', error: 'ELEMENT_NOT_FOUND', selectorDiagnostics: [{ api: 'wait', matchCount: 0 }] }
    ];
    assert.equal(WU.detectContainerMatchZero(events), null);
  });
});

function makeRunner(eventsToEmit, orchestrateImpl) {
  const deps = {
    orchestrate: orchestrateImpl || (async (service, input, orchDeps, options) => {
      for (const e of eventsToEmit) options.onEvent(e);
      return {
        finalResult: { posts: [{ postId: '1', content: 'a' }] },
        steps: [{ stepId: 'extract', stepName: 'extract', result: { done: true } }],
        pages: []
      };
    }),
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
  { id: 'load', name: 'load', script: 'return 1', onSuccess: 'extract' },
  { id: 'extract', name: 'extract posts', script: 'return 1', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
], config: {} };
const SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', required: ['postId'], properties: {
  postId: { type: 'string' }, content: { type: 'string' }
} } } } };

describe('F2: verify error branch carries the zero-container census (fifty-first log)', () => {
  it('a throwing zero-container run gets census lines + SELECTOR_OVERFILTERED lead (base populated)', async () => {
    const events = [
      { type: 'STEP_FAILED', stepId: 'extract', error: "$extractWithHover: no containers matched", selectorDiagnostics: [{
        api: 'extractWithHover',
        containerSelector: "div[role='feed'] > div:has(a[href*='/posts/'])",
        containerMatches: 0,
        selectorDifferential: [
          { sel: "div[role='feed'] > div:has(a[href*='/posts/'])", count: 0 },
          { sel: "div[role='feed'] > div", count: 4 }
        ]
      }] }
    ];
    const runner = makeRunner(events, async (service, input, orchDeps, options) => {
      for (const e of events) options.onEvent(e);
      const err = new Error('$extractWithHover: no containers matched');
      err.stepId = 'extract';
      throw err;
    });
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA });
    assert.equal(out.report.ok, false);
    const msg = String((out.report.error && out.report.error.message) || '');
    assert.match(msg, /matched 0 items/, 'census line embedded in the error the model reads: ' + msg);
    assert.match(msg, /SELECTOR DIFFERENTIAL|differential/i, 'differential rides the message');
    assert.ok(out.report.detectors.containerZero, 'detectors.containerZero populated on an error run');
    assert.ok(out.report.events.includes('SELECTOR_OVERFILTERED') || /SELECTOR_OVERFILTERED/.test(msg),
      'the base-populated branch leads with over-filtering, not input-value advice');
  });

  it('no differential (or base also 0) → INPUT_VALUE_SUSPECT advice path', async () => {
    const events = [
      { type: 'STEP_FAILED', stepId: 'extract', error: '$extractWithHover: no containers matched', selectorDiagnostics: [{
        api: 'extractWithHover', containerSelector: 'div.card', containerMatches: 0, selectorDifferential: null
      }] }
    ];
    const runner = makeRunner(events, async (service, input, orchDeps, options) => {
      for (const e of events) options.onEvent(e);
      const err = new Error('$extractWithHover: no containers matched');
      err.stepId = 'extract';
      throw err;
    });
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA });
    assert.equal(out.report.ok, false);
    const msg = String((out.report.error && out.report.error.message) || '');
    assert.ok(out.report.detectors.containerZero, 'census populated');
    assert.ok(out.report.events.includes('INPUT_VALUE_SUSPECT'), 'input-value advice tags the run: ' + JSON.stringify(out.report.events));
    assert.ok(!/SELECTOR_OVERFILTERED/.test(msg) || out.report.events.includes('INPUT_VALUE_SUSPECT'), 'no overfiltered lead without a populated base');
  });
});

// ---------------------------------------------------------------------------
// F3: probe.scroll accepts negative by (scroll up) — envelope parity with $scrollBy
describe('F3: probe.scroll negative by (fifty-first log)', () => {
  function makeDepsProbe() {
    const snippets = [];
    const deps = {
      rail: {
        pageOpen: async () => ({ tabId: 1, url: 'https://example.com', ready: true }),
        pageState: async () => ({ open: true, tabId: 1, url: 'https://example.com' }),
        executeDsl: async (s) => { snippets.push(s); return { scrolled: true, prevY: 9000, newY: 0 }; },
        ensureLock: async () => {}, releaseLock: async () => {}, dispose: async () => {}, tabId: 1
      },
      runVerify: async () => ({ report: { ok: true, error: null, aborted: false, score: { score: 100, isData: true, breakdown: {} }, schemaOk: true, schemaMissing: [], detectors: { emptyFields: [], duplicateFields: [], countShortfall: null }, steps: [], finalResult: {}, pages: '1', eventCount: 1, events: [] }, events: [], raw: {} }),
      getDraftService: () => null,
      applyArtifact: () => {},
      getTestInput: () => null,
      getOutputSchema: () => null,
      getSteps: () => [],
      annotationBridge: null,
      ioConfirmBridge: { request: async () => ({ confirmed: true }) }
    };
    return { deps, snippets };
  }

  it('a negative by scrolls UP — composed as $scrollBy(-12000), not rejected', async () => {
    const { deps, snippets } = makeDepsProbe();
    const t = createSessionTools(deps);
    const r = await t.tools['probe.scroll']({ mode: 'by', by: -12000 });
    assert.ok(!r.error, 'negative by is legal: ' + JSON.stringify(r));
    assert.ok(snippets[0].includes('$scrollBy(-12000)'), 'snippet composed with the signed delta: ' + snippets[0]);
    assert.deepEqual(r, { scrolled: true, prevY: 9000, newY: 0 });
  });

  it('zero / non-numeric by still errors (a no-op scroll is a bug)', async () => {
    const { deps } = makeDepsProbe();
    const t = createSessionTools(deps);
    const r = await t.tools['probe.scroll']({ mode: 'by', by: 0 });
    assert.match(r.error, /by .*required/i);
  });
});

// ---------------------------------------------------------------------------
// universality guard
describe('universality: fifty-first-log additions carry no site tokens', () => {
  const FORBIDDEN = /facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i;
  it('the comma-depth walker + census additions stay generic', () => {
    const region = SRC.slice(SRC.indexOf('function computeSelectorDifferential') - 800, SRC.indexOf('function computeSelectorDifferential') + 900);
    assert.ok(!FORBIDDEN.test(region), 'differential region generic');
    const vr = fs.readFileSync(path.join(__dirname, '../lib/verify-runner.js'), 'utf8');
    const idx = vr.indexOf('STEP_FAILED');
    assert.ok(idx > -1, 'STEP_FAILED census wiring present in verify-runner');
  });
});
