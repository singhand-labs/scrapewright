// extension/test/tooltip-gate.test.js
//
// Eighty-first log / user directive 2026-09-18: postTime must come from the
// hover tooltip, not the page-visible label. The 81st session shipped
// visible-label values WITHOUT EVER CALLING probe.timestamp (census:
// probe.snippet 32, probe.hover 3, probe.timestamp 0) — the partial-absolute
// machinery correctly MARKED the values partial and the ladder allowed the
// disclosed ship, but nothing required the tooltip route to be EXERCISED.
// The popover route is now a GATE (TIME_SOURCE_UNEXERCISED, red only for
// REQUIRED time fields carrying relative/partial values with no
// popover-route evidence). No site tokens.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
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

// orchestrate that emits STEP_ITERATION events carrying diagnostics
// (the runner passes the orchestrator hooks as the FOURTH argument)
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
const OPT_TIME_SCHEMA = {
  type: 'object', required: ['posts'],
  properties: { posts: { type: 'array', items: { type: 'object', properties: { postTime: { type: 'string' } } } } }
};

describe('tooltip gate — required time field with partial/relative values', () => {
  it('partial values ("June 3") + NO popover evidence → red TIME_SOURCE_UNEXERCISED naming both routes', async () => {
    const runner = VR_HARNESS.makeRunner(orchWithEvents(
      { posts: [{ url: '/a', postTime: 'June 3' }, { url: '/b', postTime: 'June 3' }] }, []
    ));
    const out = await runner({ service: SERVICE, input: {}, outputSchema: REQ_TIME_SCHEMA });
    assert.equal(out.report.ok, false, 'the gate flips the run red');
    assert.match(out.report.error.message, /TIME_SOURCE_UNEXERCISED/);
    assert.match(out.report.error.message, /posts\.postTime/);
    assert.match(out.report.error.message, /probe\.timestamp/);
    assert.match(out.report.error.message, /hoverPopover/);
    assert.ok(out.report.events.indexOf('TIME_SOURCE_UNEXERCISED') !== -1, 'tag present for knowledge auto-attach');
    assert.ok(Array.isArray(out.report.detectors.timeSourceUnexercised) && out.report.detectors.timeSourceUnexercised.length === 1);
  });

  it('relative values ("4 days ago") + NO popover evidence → gated too', async () => {
    const runner = VR_HARNESS.makeRunner(orchWithEvents(
      { posts: [{ url: '/a', postTime: '4 days ago' }, { url: '/b', postTime: '3 days ago' }] }, []
    ));
    const out = await runner({ service: SERVICE, input: {}, outputSchema: REQ_TIME_SCHEMA });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /TIME_SOURCE_UNEXERCISED/);
  });

  it('same values + ONE capturedPopovers event with samples → no gate (disclosed-ship path intact)', async () => {
    const runner = VR_HARNESS.makeRunner(orchWithEvents(
      { posts: [{ url: '/a', postTime: 'June 3' }, { url: '/b', postTime: '4 days ago' }] },
      [{ type: 'STEP_ITERATION', stepId: 's1', resultPreview: '{"done":true}',
         selectorDiagnostics: [{ api: 'extractWithHover', containerSelector: 'div.card', capturedPopovers: { captured: 2, samples: ['June 3, 2024 at 1:43 PM'] } }] }]
    ));
    const out = await runner({ service: SERVICE, input: {}, outputSchema: REQ_TIME_SCHEMA });
    assert.equal(out.report.ok, true, 'tooltip receipt exempts the run from the gate');
    assert.equal(out.report.events.indexOf('TIME_SOURCE_UNEXERCISED'), -1);
    assert.equal(out.report.detectors.timeSourceUnexercised, null);
    assert.ok(out.report.events.indexOf('RELATIVE_TIMESTAMP') !== -1, 'the advisory census still discloses');
  });

  it('a probe.timestamp receipt marker in an event preview also counts as evidence', async () => {
    const runner = VR_HARNESS.makeRunner(orchWithEvents(
      { posts: [{ url: '/a', postTime: 'June 3' }, { url: '/b', postTime: 'June 3' }] },
      [{ type: 'STEP_ITERATION', stepId: 's1', resultPreview: 'probe.timestamp returned {anchorsProbed:4, hoversDispatched:2}', selectorDiagnostics: [] }]
    ));
    const out = await runner({ service: SERVICE, input: {}, outputSchema: REQ_TIME_SCHEMA });
    assert.equal(out.report.events.indexOf('TIME_SOURCE_UNEXERCISED'), -1);
  });

  it('non-required time field with partial values → advisory only, run stays green', async () => {
    const runner = VR_HARNESS.makeRunner(orchWithEvents(
      { posts: [{ url: '/a', postTime: 'June 3' }, { url: '/b', postTime: 'June 14' }] }, []
    ));
    const out = await runner({ service: SERVICE, input: {}, outputSchema: OPT_TIME_SCHEMA });
    assert.equal(out.report.ok, true);
    assert.equal(out.report.events.indexOf('TIME_SOURCE_UNEXERCISED'), -1);
    assert.ok(out.report.events.indexOf('RELATIVE_TIMESTAMP') !== -1, 'advisory census still fires');
  });

  it('full-absolute values ("June 3, 2024 at 1:43 PM") → no gate even with zero popovers', async () => {
    const runner = VR_HARNESS.makeRunner(orchWithEvents(
      { posts: [{ postTime: 'June 3, 2024 at 1:43 PM' }, { postTime: 'May 22, 2024 at 9:00 AM' }] }, []
    ));
    const out = await runner({ service: SERVICE, input: {}, outputSchema: REQ_TIME_SCHEMA });
    assert.equal(out.report.ok, true);
    assert.equal(out.report.events.indexOf('TIME_SOURCE_UNEXERCISED'), -1);
    assert.equal(out.report.detectors.relativeTimestamps, null, 'full absolutes never enter the census');
  });

  it('gate appends to an existing error instead of replacing it', async () => {
    // partial-empty REQUIRED postId (2/2 empty) + partial postTime, no popovers:
    // both gates fire; the message must carry both markers.
    const schema = {
      type: 'object', required: ['posts'],
      properties: { posts: { type: 'array', items: { type: 'object', required: ['postId', 'postTime'], properties: { postId: { type: 'string' }, postTime: { type: 'string' } } } } }
    };
    const runner = VR_HARNESS.makeRunner(orchWithEvents(
      { posts: [{ postId: '', url: '/a', postTime: 'June 3' }, { postId: '', url: '/b', postTime: 'June 14' }] }, []
    ));
    const out = await runner({ service: SERVICE, input: {}, outputSchema: schema });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /REQUIRED_FIELD_EMPTY/);
    assert.match(out.report.error.message, /TIME_SOURCE_UNEXERCISED/);
  });
});

describe('tooltip gate — universality guard on new strings', () => {
  it('no site tokens in the new verify-runner/knowledge-unit strings', () => {
    const vr = fs.readFileSync(path.join(__dirname, '../lib/verify-runner.js'), 'utf8');
    const ku = fs.readFileSync(path.join(__dirname, '../lib/knowledge-units.js'), 'utf8');
    const gateIdx = vr.indexOf('TIME_SOURCE_UNEXERCISED');
    assert.ok(gateIdx > -1, 'gate present in verify-runner');
    const kuIdx = ku.indexOf('TIME_SOURCE_UNEXERCISED');
    assert.ok(kuIdx > -1, 'knowledge unit references the tag');
    // scope the scan to the NEW strings only (verify-runner carries
    // pre-existing comment text from earlier logs)
    const newStrings = vr.slice(gateIdx - 200, gateIdx + 2400) + ku.slice(kuIdx - 2200, kuIdx + 1200);
    assert.ok(!/facebook|fb\.com|m\.me\/|instagram|xiaohongshu|weibo/i.test(newStrings), 'no site tokens');
  });
});

// ---------------------------------------------------------------------------
// Eighty-seventh log: the gate's evidence census was structurally blind —
// it scanned ONLY the verify run's own events, so (1) research-tab
// probe.timestamp receipts were INVISIBLE (branch (b) never fires in
// production), (2) raw-$hover captures (the artifact's own per-anchor hovers
// in the step script) were invisible, and (3) the "NO tooltip evidence
// exists this session" claim was a session-scope assertion backed by
// run-scope data. The 87th artifact dispatched trusted hovers (author
// anchors) in every verify and was still told no evidence existed — the
// model reasonably ignored the gate three times. The documented contract
// ("only after that receipt is partial/relative an honest disclosed ship")
// also had no implementation: a model that HAD called probe.timestamp could
// never unlock the disclosed-ship exit.
describe('tooltip gate — 87th log: session-scoped evidence + truthful tiers', () => {
  it('in-run popover captures with NO date shape stay RED but the message tells the truth: popovers were captured, the TIME anchor was never hovered', async () => {
    const runner = VR_HARNESS.makeRunner(orchWithEvents(
      { posts: [{ url: '/a', postTime: 'August 23 at 8:11 PM' }, { url: '/b', postTime: 'a day ago' }] },
      [{ type: 'STEP_ITERATION', stepId: 's1', resultPreview: '{"done":true}',
         selectorDiagnostics: [{ api: 'extractWithHover', containerSelector: 'div.card', capturedPopovers: { captured: 2, samples: ['CoderMind Lab · 18K Followers · Follow'] } }] }]
    ));
    const out = await runner({ service: SERVICE, input: {}, outputSchema: REQ_TIME_SCHEMA });
    assert.equal(out.report.ok, false, 'author popovers ≠ time-route evidence');
    assert.match(out.report.error.message, /TIME_SOURCE_UNEXERCISED/);
    assert.match(out.report.error.message, /popover/i);
    assert.match(out.report.error.message, /ANY date shape/i);
    assert.match(out.report.error.message, /probe\.timestamp/);
  });

  it('raw-$hover step captures (preview markers) count in the census — same truthful tier', async () => {
    const runner = VR_HARNESS.makeRunner(orchWithEvents(
      { posts: [{ postTime: 'August 2' }, { postTime: 'August 9' }] },
      [{ type: 'STEP_ITERATION', stepId: 's1', resultPreview: '{"hovered":true,"htmlSnippet":"<div>Like · Reply</div>","popoverSelector":null}', selectorDiagnostics: [] }]
    ));
    const out = await runner({ service: SERVICE, input: {}, outputSchema: REQ_TIME_SCHEMA });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /popover/i);
    assert.match(out.report.error.message, /ANY date shape/i);
  });

  it('session evidence: probe.timestamp CALLED but no full absolute → the documented disclosed-ship exit unlocks (no red, no tag)', async () => {
    const runner = VR_HARNESS.makeRunner(orchWithEvents(
      { posts: [{ postTime: 'August 2' }, { postTime: 'a day ago' }] }, []
    ));
    const out = await runner({
      service: SERVICE, input: {}, outputSchema: REQ_TIME_SCHEMA,
      sessionEvidence: { probeTimestampCalls: 1, lastFullAbsolute: false, popoverSamples: [] }
    });
    assert.equal(out.report.ok, true, 'route exercised + partial receipt = honest disclosed ship per the gate contract');
    assert.equal(out.report.events.indexOf('TIME_SOURCE_UNEXERCISED'), -1);
    assert.ok(out.report.events.indexOf('RELATIVE_TIMESTAMP') !== -1, 'the advisory census still teaches the ladder');
  });

  it('session evidence: a popover sample carrying a FULL absolute date exempts the run', async () => {
    const runner = VR_HARNESS.makeRunner(orchWithEvents(
      { posts: [{ postTime: 'August 2' }, { postTime: 'August 9' }] }, []
    ));
    const out = await runner({
      service: SERVICE, input: {}, outputSchema: REQ_TIME_SCHEMA,
      sessionEvidence: { probeTimestampCalls: 0, lastFullAbsolute: false, popoverSamples: ['Shared with Public · Friday, September 11, 2026 at 1:43 AM'] }
    });
    assert.equal(out.report.ok, true);
    assert.equal(out.report.events.indexOf('TIME_SOURCE_UNEXERCISED'), -1);
  });

  it('session evidence: popover samples with NO date shape and no probe calls → red names the session captures truthfully', async () => {
    const runner = VR_HARNESS.makeRunner(orchWithEvents(
      { posts: [{ postTime: 'August 2' }, { postTime: 'August 9' }] }, []
    ));
    const out = await runner({
      service: SERVICE, input: {}, outputSchema: REQ_TIME_SCHEMA,
      sessionEvidence: { probeTimestampCalls: 0, lastFullAbsolute: false, popoverSamples: ['G-Girls Page · Musician/band · 7.1K Followers'] }
    });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /popover/i);
    assert.match(out.report.error.message, /ANY date shape/i);
  });

  it('no session evidence wired (legacy harness) keeps the original unexercised red', async () => {
    const runner = VR_HARNESS.makeRunner(orchWithEvents(
      { posts: [{ postTime: 'June 3' }, { postTime: 'June 14' }] }, []
    ));
    const out = await runner({ service: SERVICE, input: {}, outputSchema: REQ_TIME_SCHEMA });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /TIME_SOURCE_UNEXERCISED/);
  });
});

// ---------------------------------------------------------------------------
// session-tools wiring: the closure tracks probe.timestamp calls and the
// popover LRU, and verifyRun passes them as sessionEvidence.
describe('tooltip gate — session-tools sessionEvidence wiring', () => {
  function makeDeps(runVerifyCapture) {
    return {
      rail: { executeDsl: async () => ({ result: [] }) },
      runVerify: async (args) => {
        if (runVerifyCapture) runVerifyCapture(args);
        return { events: [], report: { ok: true, detectors: {} }, raw: {} };
      },
      getDraftService: () => ({ targetUrl: 'https://example.com', steps: [{ id: 's1', name: 'one', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }),
      applyArtifact: async () => ({ ok: true }),
      getTestInput: () => ({}),
      getOutputSchema: () => null,
      getSteps: () => [],
      probeFactory: () => ({
        timestamp: async () => ({ anchorsProbed: 3, hoversDispatched: 2, absolute: 'August 2', relative: null, candidates: [] }),
        getLastSelectorDiagnostics: () => null
      })
    };
  }

  it('verify.run receives sessionEvidence: probe.timestamp call count + popover samples', async () => {
    const { createSessionTools } = require('../lib/session-tools');
    let captured = null;
    const t = createSessionTools(makeDeps((a) => { captured = a; }));
    await t.tools['probe.timestamp']({ containerSel: 'div.card' }, { session: {} });
    await t.tools['verify.run']({}, { session: {} });
    assert.ok(captured && captured.sessionEvidence, 'sessionEvidence rides the verify call');
    assert.equal(captured.sessionEvidence.probeTimestampCalls, 1, 'the probe call was counted');
    assert.ok(Array.isArray(captured.sessionEvidence.popoverSamples), 'popover samples ride along');
  });
});
