// extension/test/hundred-thirtieth-log-pacing.test.js
//
// 130th live log (FB keyword-search service, 80-turn session, v6 shipped
// unverified with postTime empty and count 2/5). Two harness gaps let the
// model's finish summary carry provably wrong conclusions:
//
// (A) The scroll poll step exhausted 25 iterations in ~2s (avg ~70ms/attempt)
//     then fell through to its onFailure edge — the POLL_EXHAUSTED pacing
//     note only attaches on the TERMINATE path (step-orchestrator), so the
//     ONLY discriminator between "no settle" and "genuine exhaustion" never
//     reached the verify report. The frameSample teaching cannot make this
//     call: an active tab with normal frames and a stable count reads as
//     "genuinely exhausted" (exactly the finish's misdiagnosis). The frozen
//     census entry now carries pacing computed from STEP_ITERATION `at`
//     stamps, and the knowledge unit teaches the no-settle branch.
//
// (B) The finish claimed absolute timestamps in hover-mounted rejected text
//     were "unreachable from the DSL" while read:'hoverPopover' searches
//     rejectedAddedHtml/rejectedAddedTexts by design. The blindness was
//     structural: harvestDossierFeeds only ever pushed PICKED popover
//     captures, so rejected mounts never entered the popover-capture LRU —
//     the dossier [POPOVER CAPTURES] and the session-evidence TIME lanes
//     could not see values the model had already paid page-ops to capture.
//     Rejected mounts are now harvested, and a report-only advisory names
//     the read:'hoverPopover' route when the session's own captures carry a
//     full absolute while a required time field ships empty or relative.
//
// No site tokens.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createVerifyRunner } = require('../lib/verify-runner');

const VR_HARNESS = (function () {
  function makeRunner(orchestrate) {
    const deps = {
      orchestrate,
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
  return { makeRunner };
})();

function orchWithEvents(finalResult, eventsToEmit) {
  return async (service, input, d3, hooks) => {
    const emit = (hooks && typeof hooks.onEvent === 'function')
      ? hooks.onEvent
      : ((d3 && typeof d3.onEvent === 'function') ? d3.onEvent : () => {});
    for (const evt of (eventsToEmit || [])) {
      try { emit(evt); } catch (e) { /* harness */ }
    }
    return {
      finalResult,
      steps: [{ stepId: 's1', stepName: 'one', result: { done: true }, snapshot: null }],
      pages: [], pagesTruncated: false
    };
  };
}

const SERVICE = { targetUrl: 'https://example.com', steps: [{ id: 's1', name: 'one', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} };
const REQ_TIME_SCHEMA = {
  type: 'object', required: ['posts'],
  properties: { posts: { type: 'array', items: { type: 'object', required: ['postTime'], properties: { postTime: { type: 'string' } } } } }
};

// ---------------------------------------------------------------------------
// A: pacing on the frozen-scroll census
describe('130th log — frozen-scroll census carries iteration pacing', () => {
  const WU = require('../lib/wizard-utils');

  function scrollIters(n, frozenAt, spacingMs, t0) {
    const out = [];
    let t = t0 || 1700000000000;
    for (let i = 0; i < n; i++) {
      out.push({
        type: 'STEP_ITERATION', stepId: 's3', at: t,
        resultPreview: '{"done":false,"count":' + frozenAt + '}',
        selectorDiagnostics: [{ api: 'scrollBy' }]
      });
      t += spacingMs;
    }
    return out;
  }

  it('back-to-back iterations (avg <300ms) → entry carries noSettle + a pacing string', () => {
    const entries = WU.detectFrozenScrollCount(scrollIters(6, 2, 70));
    assert.equal(entries.length, 1, 'frozen count detected');
    const e = entries[0];
    assert.equal(e.frozenCount, 2);
    assert.equal(e.streak, 6);
    assert.equal(e.noSettle, true, 'the no-settle discriminator is present');
    assert.match(String(e.pacing), /6 attempt\(s\) over \d+ms \(avg 7\dms\/attempt\)/, 'pacing names attempts + avg');
  });

  it('settled iterations (avg ≥300ms) → pacing present, noSettle absent', () => {
    const entries = WU.detectFrozenScrollCount(scrollIters(6, 2, 1200));
    assert.equal(entries.length, 1);
    assert.ok(!entries[0].noSettle, 'a settled loop is not misflagged');
    assert.match(String(entries[0].pacing), /avg 1200ms\/attempt/);
  });

  it('two iterations only (below pacing threshold) → entry without pacing, no crash', () => {
    const entries = WU.detectFrozenScrollCount(scrollIters(5, 2, 70, 0).slice(0, 2));
    assert.equal(entries.length, 0, 'below FROZEN_NONZERO_STREAK_THRESHOLD anyway');
  });

  it('legacy events without `at` → detector still fires, no pacing key, no crash', () => {
    const evts = scrollIters(6, 2, 70).map((e) => { const c = Object.assign({}, e); delete c.at; return c; });
    const entries = WU.detectFrozenScrollCount(evts);
    assert.equal(entries.length, 1, 'the frozen detection itself is unchanged');
    assert.ok(!entries[0].noSettle);
    assert.ok(entries[0].pacing === undefined || entries[0].pacing === null);
  });

  it('per-step isolation: a fast step and a slow step keep their own pacing', () => {
    const fast = scrollIters(5, 2, 60, 1700000000000);
    const slow = scrollIters(5, 3, 1500, 1800000000000).map((e) => Object.assign({}, e, { stepId: 's9' }));
    const entries = WU.detectFrozenScrollCount(fast.concat(slow));
    assert.equal(entries.length, 2);
    const byStep = {};
    for (const e of entries) byStep[e.stepId] = e;
    assert.equal(byStep.s3.noSettle, true);
    assert.ok(!byStep.s9.noSettle);
  });
});

describe('130th log — STEP_ITERATION events carry a dispatch timestamp', () => {
  it('the orchestrator emit includes a numeric, monotonic `at`', async () => {
    const src = fs.readFileSync(path.join(__dirname, '../lib/step-orchestrator.js'), 'utf8');
    const i = src.indexOf("emit('STEP_ITERATION'");
    assert.ok(i > -1, 'STEP_ITERATION emit found');
    assert.match(src.slice(i, i + 900), /at:\s*Date\.now\(\)/, 'emit stamps at: Date.now()');
  });
});

describe('130th log — dossier census renders scroll-frozen rows', () => {
  const ED = require('../lib/evidence-dossier');

  it('noSettle entry renders the row with the NO-settle marker', () => {
    const txt = ED.renderVerifyCensus({
      ok: false,
      detectors: {
        scrollCountFrozen: [{
          stepId: 's3', field: 'count', frozenCount: 2, streak: 25, iterations: 25, grewFrom: null,
          pacing: '25 attempt(s) over 1180ms (avg 47ms/attempt)', noSettle: true
        }]
      }
    });
    assert.match(txt, /scroll-frozen s3\.count=2 streak 25\/25/);
    assert.match(txt, /avg 47ms\/attempt/);
    assert.match(txt, /NO settle/);
  });

  it('settled entry renders without the marker', () => {
    const txt = ED.renderVerifyCensus({
      ok: true,
      detectors: {
        scrollCountFrozen: [{
          stepId: 's3', field: 'count', frozenCount: 9, streak: 6, iterations: 8, grewFrom: 2,
          pacing: '8 attempt(s) over 9600ms (avg 1371ms/attempt)', noSettle: false
        }]
      }
    });
    assert.match(txt, /scroll-frozen s3\.count=9 streak 6\/8/);
    assert.ok(!/NO settle/.test(txt));
  });
});

describe('130th log — knowledge unit teaches the no-settle branch', () => {
  it('scroll-count-frozen body names the pacing discriminator', () => {
    const ku = fs.readFileSync(path.join(__dirname, '../lib/knowledge-units.js'), 'utf8');
    const i = ku.indexOf("id: 'scroll-count-frozen'");
    assert.ok(i > -1);
    const body = ku.slice(i, ku.indexOf("id: 'duplicate-id-fallback'", i));
    assert.match(body, /avg.*ms\/attempt|pacing/i, 'the unit names the pacing field');
    assert.match(body, /settle/i, 'the unit teaches the settle fix');
  });
});

// ---------------------------------------------------------------------------
// B: rejected-mount harvest + absolute-captured-unbound advisory
describe('130th log — rejected hover mounts feed the popover-capture LRU', () => {
  const { createSessionTools } = require('../lib/session-tools');

  function makeDeps(capture) {
    return {
      rail: { executeDsl: async () => ({ result: [] }) },
      runVerify: async (args) => {
        if (capture) capture(args);
        return { events: [], report: { ok: true, detectors: {} }, raw: {} };
      },
      getDraftService: () => ({ targetUrl: 'https://example.com', steps: [{ id: 's1', name: 'one', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }),
      applyArtifact: async () => ({ ok: true }),
      getTestInput: () => ({}),
      getOutputSchema: () => null,
      getSteps: () => [],
      probeFactory: () => ({
        hover: async () => ({
          hovered: true, htmlSnippet: '', popoverSelector: null, reason: 'popover_timeout',
          rejectedAddedTexts: ['Shared with Public · Tuesday, September 22, 2026 at 8:14 PM'],
          rejectedAddedHtml: ['<div class="strip">September 22, 2026 at 8:14 PM</div>']
        }),
        extract: async () => ({ total: 0, records: [], emptyFields: {} }),
        timestamp: async () => ({ anchorsProbed: 0, hoversDispatched: 0, absolute: null, relative: null, candidates: [] }),
        getLastSelectorDiagnostics: () => null
      })
    };
  }

  it('probe.hover rejectedAddedTexts/Html land in sessionEvidence.popoverSamples', async () => {
    let captured = null;
    const t = createSessionTools(makeDeps((a) => { captured = a; }));
    await t.tools['probe.hover']({ anchorSel: 'a.t' }, { session: {} });
    await t.tools['verify.run']({}, { session: {} });
    assert.ok(captured && Array.isArray(captured.sessionEvidence.popoverSamples));
    const joined = captured.sessionEvidence.popoverSamples.join('\n');
    assert.match(joined, /September 22, 2026 at 8:14 PM/, 'the rejected-mount date is visible to the session evidence lanes');
    assert.match(joined, /strip/, 'the rejected HTML fragment is captured too');
    assert.ok(captured.sessionEvidence.popoverSamples.every((s) => typeof s === 'string' && s));
  });

  it('diagnostics-carried rejected mounts (snippet extractWithHover) feed the LRU too', async () => {
    let captured = null;
    const deps = makeDeps((a) => { captured = a; });
    let diag = [{ api: 'extractWithHover', containerSelector: 'div.card', rejectedAddedTexts: ['Wednesday, September 23, 2026 at 9:02 AM'] }];
    deps.probeFactory = () => ({
      extract: async () => ({ total: 1, records: [], emptyFields: {} }),
      hover: async () => ({}),
      timestamp: async () => ({ anchorsProbed: 0, hoversDispatched: 0, absolute: null, relative: null, candidates: [] }),
      getLastSelectorDiagnostics: () => diag
    });
    const t = createSessionTools(deps);
    await t.tools['probe.extract']({ containerSel: 'div.card', fieldMap: {} }, { session: {} });
    await t.tools['verify.run']({}, { session: {} });
    assert.ok(captured && Array.isArray(captured.sessionEvidence.popoverSamples));
    assert.match(captured.sessionEvidence.popoverSamples.join('\n'), /September 23, 2026 at 9:02 AM/);
  });
});

describe('130th log — absolute captured but unbound advisory (report-only)', () => {
  const FULL_ABS = 'Shared with Public · Tuesday, September 22, 2026 at 8:14 PM';

  it('required time field EMPTY everywhere + full absolute in session captures → advisory names the read:hoverPopover route', async () => {
    const runner = VR_HARNESS.makeRunner(orchWithEvents(
      { posts: [{ content: 'a', postTime: '' }, { content: 'b', postTime: '' }] }, []
    ));
    const out = await runner({
      service: SERVICE, input: {}, outputSchema: REQ_TIME_SCHEMA,
      sessionEvidence: { probeTimestampCalls: 0, lastFullAbsolute: false, popoverSamples: [FULL_ABS] }
    });
    assert.equal(out.report.ok, false, 'the empty-required lane still vetoes');
    const lane = out.report.detectors.timeAbsoluteCapturedUnbound;
    assert.ok(Array.isArray(lane) && lane.length === 1, 'advisory present');
    assert.equal(lane[0].field, 'postTime');
    assert.match(String(lane[0].note), /hoverPopover/, 'names the DSL route');
    assert.match(String(lane[0].note), /rejectedAdded/i, 'names the rejected-mount channel');
  });

  it('relative values + full absolute in session captures → advisory present, run NOT vetoed by it', async () => {
    const runner = VR_HARNESS.makeRunner(orchWithEvents(
      { posts: [{ postTime: 'August 2' }, { postTime: 'a day ago' }] }, []
    ));
    const out = await runner({
      service: SERVICE, input: {}, outputSchema: REQ_TIME_SCHEMA,
      sessionEvidence: { probeTimestampCalls: 0, lastFullAbsolute: false, popoverSamples: [FULL_ABS] }
    });
    assert.equal(out.report.ok, true, 'report-only — disclosed relative ship stays legal');
    assert.ok(Array.isArray(out.report.detectors.timeAbsoluteCapturedUnbound) && out.report.detectors.timeAbsoluteCapturedUnbound.length === 1);
  });

  it('no full absolute in captures → no advisory', async () => {
    const runner = VR_HARNESS.makeRunner(orchWithEvents(
      { posts: [{ postTime: 'August 2' }, { postTime: '' }] }, []
    ));
    const out = await runner({
      service: SERVICE, input: {}, outputSchema: REQ_TIME_SCHEMA,
      sessionEvidence: { probeTimestampCalls: 1, lastFullAbsolute: false, popoverSamples: ['CoderMind Lab · 18K Followers'] }
    });
    assert.ok(!out.report.detectors.timeAbsoluteCapturedUnbound, 'no absolute → no route claim');
  });

  it('advisory ignores non-time empty fields even with absolute captures present', async () => {
    const schema = {
      type: 'object', required: ['posts'],
      properties: { posts: { type: 'array', items: { type: 'object', required: ['postId'], properties: { postId: { type: 'string' } } } } }
    };
    const runner = VR_HARNESS.makeRunner(orchWithEvents(
      { posts: [{ postId: '', postTime: 'September 22, 2026 at 8:14 PM' }, { postId: '', postTime: 'September 1, 2026 at 1:00 PM' }] }, []
    ));
    const out = await runner({
      service: SERVICE, input: {}, outputSchema: schema,
      sessionEvidence: { probeTimestampCalls: 0, lastFullAbsolute: false, popoverSamples: [FULL_ABS] }
    });
    assert.ok(!out.report.detectors.timeAbsoluteCapturedUnbound, 'postTime is bound; postId is not a time field');
  });

  it('dossier census renders the advisory row', () => {
    const ED = require('../lib/evidence-dossier');
    const txt = ED.renderVerifyCensus({
      ok: false,
      detectors: {
        partialEmptyFields: [{ field: 'postTime', path: 'posts.postTime', emptyCount: 2, totalCount: 2, emptyRatio: 1, emptyRecordSamples: [] }],
        timeAbsoluteCapturedUnbound: [{ field: 'postTime', path: 'posts.postTime', note: "bind via read:'hoverPopover' — it searches rejectedAddedHtml/rejectedAddedTexts automatically" }]
      }
    });
    assert.match(txt, /time-absolute-captured-unbound posts\.postTime/);
    assert.match(txt, /hoverPopover/);
  });
});

describe('130th log — universality guard on the new strings', () => {
  it('no site tokens in the new pacing/harvest/advisory strings', () => {
    const files = ['../lib/wizard-utils.js', '../lib/verify-runner.js', '../lib/session-tools.js', '../lib/evidence-dossier.js', '../lib/knowledge-units.js'];
    let scan = '';
    for (const f of files) scan += fs.readFileSync(path.join(__dirname, f), 'utf8');
    const a = scan.indexOf('noSettle');
    const b = scan.indexOf('timeAbsoluteCapturedUnbound');
    const c = scan.indexOf('rejected mount');
    assert.ok(a > -1 && b > -1 && c > -1, 'new strings present');
    const window = scan.slice(Math.max(0, a - 400), a + 800) + scan.slice(Math.max(0, b - 600), b + 1600) + scan.slice(Math.max(0, c - 400), c + 800);
    assert.ok(!/facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i.test(window), 'no site tokens in the new code strings');
  });
});
