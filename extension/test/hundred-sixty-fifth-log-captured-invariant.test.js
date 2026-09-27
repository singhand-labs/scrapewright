// extension/test/hundred-sixty-fifth-log-captured-invariant.test.js
//
// 165th round — consolidation of the 164th incident-shaped gates into ONE
// universal invariant, from the user's architectural challenge: "TIME_
// ABSOLUTE_CAPTURED_UNBOUND 这种门……整个系统的通用性堪忧……与我为每个
// 目标网站单独开发采集解析程序何异".
//
// The invariant (site-agnostic, channel-agnostic, field-agnostic):
//   THE ASSEMBLY MUST NOT DROP A CAPTURED VALUE THAT SATISFIES A DECLARED
//   FIELD'S SEMANTIC REQUIREMENT.
// A shopping site's price-in-tooltip, a stock count behind a click, an
// author name in an aria reference — the same rule applies. The hover
// channel is just one candidate source; the gate knows nothing about it.
//
// Three pieces under test:
//   A. inferFieldSemantics + semanticPredicatePasses (wizard-utils) —
//      the contract layer turns the user's requirement ("完整绝对时间")
//      into a machine-checkable predicate per field.
//   B. collectCapturedCandidateTexts (verify-runner) — per-record pools
//      from pipeline INTERMEDIATE steps (hovercards[].popoverText etc.),
//      aligned by ordinal when counts match, unioned otherwise.
//   C. ONE gate CAPTURED_VALUE_UNBOUND replaces the 164th G1/G2 special
//      cases: field semantic != text + shipped value fails predicate +
//      pool holds a passing text → RED. Empty pool → page genuinely
//      lacks it → disclosed ship stays legal.
const { test, describe, it } = require('node:test');
const assert = require('assert');

const WU = require('../lib/wizard-utils');
const VR = require('../lib/verify-runner');

const SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object',
  required: ['postId', 'postTime', 'content'],
  properties: {
    postId: { type: 'string' }, postTime: { type: 'string' }, content: { type: 'string' },
    likes: { type: 'string' },
    hovercards: { type: 'array', items: { type: 'object', properties: { link: { type: 'string' }, kv: { type: 'object' } } } }
  } } } } };

describe('165 A — field semantics inference + predicates', () => {
  it('infers the semantic table from names and types', () => {
    const sem = WU.inferFieldSemantics(SCHEMA);
    const byField = {};
    for (const row of sem) byField[row.field] = row.semantic;
    assert.equal(byField.postTime, 'absoluteTime');
    assert.equal(byField.postId, 'identifier');
    assert.equal(byField.likes, 'count');
    assert.equal(byField.hovercards, 'contentfulEntries');
    assert.ok(!('content' in byField), 'plain prose fields carry no predicate (absent from the table)');
  });
  it('predicates are generic (no channel, no site)', () => {
    assert.equal(WU.semanticPredicatePasses('absoluteTime', 'September 12, 2026 at 3:18 PM'), true);
    assert.equal(WU.semanticPredicatePasses('absoluteTime', '2 days ago'), false);
    assert.equal(WU.semanticPredicatePasses('absoluteTime', 'April 17'), false);
    assert.equal(WU.semanticPredicatePasses('identifier', '943842055397354'), true);
    assert.equal(WU.semanticPredicatePasses('identifier', 'card-9-日本美女小姐姐為了男服務生'), false);
    assert.equal(WU.semanticPredicatePasses('count', '1.3K'), true);
    assert.equal(WU.semanticPredicatePasses('count', 'Like'), false);
    assert.equal(WU.semanticPredicatePasses('contentfulEntries', [{ link: 'https://x.com/1', kv: { label: '美女' } }]), false, 'shell entry');
    assert.equal(WU.semanticPredicatePasses('contentfulEntries',
      [{ link: '/g/1/', kv: { label: '美女', bio: 'Verified account · Public figure with many followers living somewhere' } }]), true);
    assert.equal(WU.semanticPredicatePasses('text', 'anything'), true, 'text fields always pass');
  });
});

describe('165 B — per-record candidate pools from intermediates', () => {
  it('collects popoverText/labelledbyText/rejected texts per record, aligned by ordinal', () => {
    const rawSteps = [
      { stepId: 'extract', stepName: 'extract', result: { posts: [
        { content: 'c1', hovercards: [{ popoverText: 'September 12, 2026 at 3:18 PM', labelledbyText: null, anchorText: 'author' }] },
        { content: 'c2', hovercards: [{ popoverText: null, labelledbyText: '美女 Page', rejectedAddedTexts: ['May 4, 2026 at 9:00 AM'] }] }
      ] } }
    ];
    const pools = VR.__test.collectCapturedCandidateTexts(rawSteps);
    assert.equal(pools.mode, 'per-record');
    assert.ok(pools.records[0].some((t) => /September 12, 2026/.test(t)));
    assert.ok(pools.records[1].some((t) => /May 4, 2026/.test(t)), 'rejected-mount texts join the pool');
    assert.ok(pools.records[1].some((t) => /美女 Page/.test(t)), 'labelledby texts join the pool');
  });
  it('count mismatch → union pool (honest degradation)', () => {
    const rawSteps = [
      { stepId: 'extract', stepName: 'extract', result: { posts: [
        { content: 'c1', hovercards: [{ popoverText: 'September 12, 2026 at 3:18 PM' }] },
        { content: 'c2', hovercards: [{ popoverText: null }] }
      ] } }
    ];
    const pools = VR.__test.collectCapturedCandidateTexts(rawSteps, 3);
    assert.equal(pools.mode, 'union');
    assert.ok(pools.union.some((t) => /September 12, 2026/.test(t)));
  });
  it('no intermediates → empty pool (page may genuinely lack the value)', () => {
    const pools = VR.__test.collectCapturedCandidateTexts([]);
    assert.equal(pools.mode, 'empty');
  });
});

describe('165 C — one gate CAPTURED_VALUE_UNBOUND (all fields, all channels)', () => {
  function makeRunner(orch) {
    return VR.createVerifyRunner({
      ensureLock: async () => {}, releaseLock: async () => {},
      createTab: async () => ({ id: 1 }), removeTab: async () => {},
      waitForTabLoad: async () => {}, sendMessage: async () => ({ pong: true }),
      executeScript: async () => ({ result: 'ok', selectorDiagnostics: [] }),
      captureSnapshot: async () => ({ html: '<html></html>' }),
      evaluateCondition: async () => true, orchestrate: orch
    });
  }
  function runWith(finalData, rawSteps) {
    const orch = async (svc, input, d, opts) => {
      await d.createTab(svc.targetUrl);
      opts.onEvent({ type: 'EXECUTION_START' });
      return { finalResult: finalData, steps: rawSteps, pages: [], pagesTruncated: false };
    };
    return makeRunner(orch)({ service: { targetUrl: 'https://e.com', steps: [{ id: 's1', name: 'x', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }, input: { count: 2 }, outputSchema: SCHEMA });
  }

  it('time field failing while the pool holds a full absolute → RED via the ONE gate', async () => {
    const out = await runWith(
      { posts: [
        { postId: '943842055397354', postTime: 'September 12, 2026 at 3:18 PM', content: 'c1' },
        { postId: '1370476108534229', postTime: '2 days ago', content: 'c2' }
      ] },
      [{ stepId: 'extract', stepName: 'e', result: { posts: [
        { content: 'c1', hovercards: [{ popoverText: 'September 12, 2026 at 3:18 PM' }] },
        { content: 'c2', hovercards: [{ popoverText: 'September 13, 2026 at 8:00 AM' }] }
      ] } }]
    );
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /CAPTURED_VALUE_UNBOUND/);
    assert.match(out.report.error.message, /postTime/);
    assert.match(out.report.error.message, /absolute[-_ ]?time/i);
  });

  it('shell hovercards while intermediates carry popoverText → the SAME gate', async () => {
    const out = await runWith(
      { posts: [
        { postId: '943842055397354', postTime: 'September 12, 2026 at 3:18 PM', content: 'c1', likes: '12',
          hovercards: [{ link: 'https://www.facebook.com/profile.php?id=100063493312571', kv: { label: '美女' } }] }
      ] },
      [{ stepId: 'extract', stepName: 'e', result: { posts: [
        { content: 'c1', hovercards: [{ popoverText: '美女 Page · Public figure 9.3K Followers · Lives in Taipei, Taiwan · Message Verified account' }] }
      ] } }]
    );
    assert.equal(out.report.ok, false, 'shell hovercards hit the same universal gate');
    assert.match(out.report.error.message, /CAPTURED_VALUE_UNBOUND/);
    assert.match(out.report.error.message, /hovercards/);
  });

  it('empty pool → disclosed ship stays legal (page genuinely lacks the value)', async () => {
    // The 87th time gate legalizes this via its probed tier (route exercised,
    // nothing found); the universal gate pool is empty — no captured value
    // was dropped. Both gates must agree on legal.
    const orch = async (svc, input, d, opts) => {
      await d.createTab(svc.targetUrl);
      opts.onEvent({ type: 'EXECUTION_START' });
      opts.onEvent({ type: 'STEP_ITERATION', stepId: 'ts', iteration: 1, resultPreview: '{"anchorsProbed": 2, "hoversDispatched": 2, "candidates": []}' });
      return { finalResult: { posts: [
        { postId: '943842055397354', postTime: 'September 12, 2026 at 3:18 PM', content: 'c1' },
        { postId: '1370476108534229', postTime: '2 days ago', content: 'c2' }
      ] }, steps: [{ stepId: 'extract', stepName: 'e', result: { posts: [
        { content: 'c1', hovercards: [] }, { content: 'c2', hovercards: [] }
      ] } }], pages: [], pagesTruncated: false };
    };
    const out = await makeRunner(orch)({ service: { targetUrl: 'https://e.com', steps: [{ id: 's1', name: 'x', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }, input: { count: 2 }, outputSchema: SCHEMA, sessionEvidence: { popoverSamples: [], probeTimestampCalls: 1 } });
    assert.equal(out.report.ok, true, 'no captured pass in the pool and the route was exercised — the relative ship is honest');
  });

  it('all values satisfying → no gate regardless of pool', async () => {
    const out = await runWith(
      { posts: [{ postId: '943842055397354', postTime: 'September 12, 2026 at 3:18 PM', content: 'c1', likes: '12' }] },
      [{ stepId: 'extract', stepName: 'e', result: { posts: [{ content: 'c1', hovercards: [{ popoverText: 'x' }] }] } }]
    );
    assert.equal(out.report.ok, true);
  });
});

describe('165 A2 — io.confirm receipt shows the framework understanding', () => {
  it('the confirm note carries the field semantics table', async () => {
    const { createSessionTools } = require('../lib/session-tools');
    const deps = {
      rail: { pageOpen: async () => ({ tabId: 1, url: 'https://e.com', ready: true }), pageState: async () => ({ open: true, tabId: 1, url: 'https://e.com' }), executeDsl: async () => 1, ensureLock: async () => {}, releaseLock: async () => {}, dispose: async () => {}, tabId: 1 },
      runVerify: async () => ({ report: { ok: true, error: null, aborted: false, score: { score: 1, isData: true, breakdown: {} }, schemaOk: true, schemaMissing: [], detectors: {}, steps: [], finalResult: {}, pages: '1', eventCount: 1, events: [] }, events: [], raw: {} }),
      getDraftService: () => null, applyArtifact: () => {}, getTestInput: () => null, getOutputSchema: () => null, getSteps: () => [],
      annotationBridge: null, ioConfirmBridge: { request: async () => ({ confirmed: true }) }
    };
    const t = createSessionTools(deps);
    const r = await t.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: SCHEMA }, { session: { state: () => ({ session: { artifactVersions: [] } }) } });
    assert.match(r.note, /field semantics: /);
    assert.match(r.note, /posts\.postTime=absoluteTime/);
    assert.match(r.note, /posts\.hovercards=contentfulEntries/);
  });
});
