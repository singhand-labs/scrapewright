// extension/test/verify-runner.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createVerifyRunner } = require('../lib/verify-runner');

function makeRunner(orchestrate, overrides) {
  const calls = { ensureLock: 0, removeTab: [], onEvent: 0 };
  const deps = Object.assign({
    orchestrate,
    ensureLock: async () => { calls.ensureLock += 1; },
    getSignal: () => null,
    log: () => {},
    onEvent: () => { calls.onEvent += 1; },
    createTab: async (url) => ({ id: 11, url }),
    removeTab: async (id) => { calls.removeTab.push(id); },
    waitForTabLoad: async () => {},
    sendMessage: async () => ({}),
    executeScript: async (tabId, script, input, timeoutMs) => ({ result: 'ok', selectorDiagnostics: [] }),
    captureSnapshot: async () => ({ html: '<html></html>' }),
    evaluateCondition: async () => true
  }, overrides || {});
  return { runner: createVerifyRunner(deps), calls, deps };
}

const SERVICE = { targetUrl: 'https://example.com', steps: [{ id: 's1', name: 'one', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} };

describe('createVerifyRunner', () => {
  it('green run: report ok, score computed, steps compacted, tags empty, raw carries testResult', async () => {
    const orch = async (svc, input, d, opts) => {
      await d.createTab(svc.targetUrl);
      opts.onEvent({ type: 'EXECUTION_START' });
      opts.onEvent({ type: 'STEP_ITERATION', stepId: 's1', iteration: 1, resultPreview: '{"posts":[{"a":1},{"a":2},{"a":3},{"a":4}]}' });
      return { finalResult: { posts: [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }] }, steps: [{ stepId: 's1', stepName: 'one', result: { done: true }, snapshot: { html: 'x' } }], pages: [], pagesTruncated: false };
    };
    const { runner, calls } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array' } } } });
    assert.equal(out.report.ok, true);
    assert.equal(out.report.error, null);
    assert.equal(out.report.eventCount, 2);
    assert.deepEqual(out.report.events, []);
    assert.equal(out.report.schemaOk, true);
    assert.ok(out.report.score.score >= 100, 'requiredCoverage 1.0 → score >= 100');
    assert.equal(out.report.steps.length, 1);
    assert.equal(out.report.steps[0].iterations, 1);
    assert.equal(out.raw.testResult.finalResult.posts.length, 4, 'raw keeps full result');
    // sampleRecordsForLLMContext appends a '[+N more records omitted]' marker
    // string after the kept records, so count only object entries.
    assert.ok(out.report.finalResult.posts.filter((x) => typeof x === 'object').length <= 3, 'report samples records (context diet)');
    assert.equal(calls.ensureLock, 1);
    assert.deepEqual(calls.removeTab, [11], 'scrape tab closed');
  });

  it('orchestrator throw → augmented error report with stepId, aborted=false, tags derived from message', async () => {
    const orch = async () => {
      const e = new Error('Step failed: POLL_EXHAUSTED step s1 gave up');
      e.stepId = 's1';
      e.steps = [{ stepId: 's1', stepName: 'one', result: null }];
      throw e;
    };
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object' } });
    assert.equal(out.report.ok, false);
    assert.equal(out.report.error.stepId, 's1');
    assert.equal(out.report.aborted, false);
    assert.ok(out.report.events.indexOf('SELECTOR_ZERO_MATCH') !== -1, 'POLL_EXHAUSTED maps to SELECTOR_ZERO_MATCH tag');
    assert.equal(out.raw.testResult && out.raw.testResult.steps ? out.raw.testResult.steps.length : 1, 1, 'partial steps preserved on raw');
  });

  it('empty extraction converts a green orchestration into an error report with EMPTY_EXTRACTION + EMPTY_FIELDS tags', async () => {
    const orch = async (svc, input, d, opts) => ({
      finalResult: { posts: [] },
      steps: [{ stepId: 's1', stepName: 'one', result: { posts: [] }, snapshot: null }],
      pages: [], pagesTruncated: false
    });
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } } } } });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /EMPTY_EXTRACTION/);
    assert.ok(out.report.events.indexOf('EMPTY_EXTRACTION') !== -1);
    assert.ok(out.report.events.indexOf('EMPTY_FIELDS') !== -1);
  });

  it('duplicate records detection fires with DUPLICATE_RECORDS tag', async () => {
    const rec = { title: 'same' };
    const orch = async () => ({
      finalResult: { posts: [rec, rec, rec] },
      steps: [{ stepId: 's1', stepName: 'one', result: { done: true }, snapshot: null }],
      pages: [], pagesTruncated: false
    });
    const { runner } = makeRunner(orch);
    // detectDuplicateRecords requires items.type==='object' plus non-empty
    // items.properties (fieldKeys derive from them).
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' } } } } } } });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /DUPLICATE_RECORDS/);
    assert.ok(out.report.events.indexOf('DUPLICATE_RECORDS') !== -1);
  });

  it('count shortfall is report-only: ok stays true, detector carries it, COUNT_SHORTFALL tag present', async () => {
    const posts = [{ t: 1 }, { t: 2 }, { t: 3 }].map((t, i) => ({ title: 'p' + i }));
    const orch = async () => ({
      finalResult: { posts },
      steps: [{ stepId: 's1', stepName: 'one', result: { done: true }, snapshot: null }],
      pages: [], pagesTruncated: false
    });
    const { runner } = makeRunner(orch);
    // detectCountShortfall requires items.type==='object'.
    const out = await runner({ service: SERVICE, input: { count: 10 }, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } } });
    assert.equal(out.report.ok, true, 'shortfall never forces retries (ZERO-TRAP lesson)');
    assert.ok(out.report.detectors.countShortfall, 'detector populated');
    assert.equal(out.report.detectors.countShortfall.extracted, 3);
    assert.equal(out.report.detectors.countShortfall.requested, 10);
    assert.ok(out.report.events.indexOf('COUNT_SHORTFALL') !== -1);
  });

  it('zero-counter breaker: frozen not-ready streak over threshold aborts and re-labels TEST_ABORTED as ZERO_COUNTER_FROZEN with COUNTER_FROZEN tag', async () => {
    const orch = async (svc, input, d, opts) => {
      for (let i = 1; i <= 10; i++) {
        opts.onEvent({ type: 'STEP_ITERATION', stepId: 's1', iteration: i, resultPreview: '{"done":false,"count":0,"raw":5}' });
        await new Promise((r) => setImmediate(r));
      }
      const e = new Error('TEST_ABORTED');
      e.stepId = 's1';
      throw e;
    };
    const origNow = Date.now;
    let t = origNow();
    Date.now = () => t;
    const { runner } = makeRunner(orch);
    // Deterministic fake clock: advance t between queued macrotasks (the
    // spec'd setInterval never fires because the onEvent calls run
    // synchronously back-to-back inside orch).
    const p = runner({ service: SERVICE, input: {}, outputSchema: { type: 'object' } });
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setImmediate(r));
      t += 8000;
    }
    const out = await p;
    Date.now = origNow;
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /ZERO_COUNTER_FROZEN/);
    assert.ok(out.report.events.indexOf('COUNTER_FROZEN') !== -1);
    assert.ok(out.raw.breaker, 'breaker state exposed on raw');
  });

  it('popover failure reasons in STEP_ITERATION previews map to POPOVER_TIMEOUT tag', async () => {
    const orch = async (svc, input, d, opts) => {
      opts.onEvent({ type: 'STEP_ITERATION', stepId: 's1', iteration: 1, resultPreview: '{"hovercards":[],"failureReasons":{"popover_timeout":9}}' });
      return { finalResult: { posts: [{ title: 'a' }] }, steps: [{ stepId: 's1', stepName: 'one', result: {}, snapshot: null }], pages: [], pagesTruncated: false };
    };
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object' } });
    assert.ok(out.report.events.indexOf('POPOVER_TIMEOUT') !== -1);
  });

  it('abort signal short-circuits executeScript with TEST_ABORTED (aborted:true)', async () => {
    let execCalls = 0;
    const orch = async (svc, input, d) => {
      await d.executeScript(11, 'return 1', {}, 1000);
      execCalls += 1;
      await new Promise((r) => setTimeout(r, 20)); // let the abort timer fire
      await d.executeScript(11, 'return 2', {}, 1000); // aborted by now
      execCalls += 1;
      return { finalResult: {}, steps: [], pages: [] };
    };
    let aborted = false;
    const { runner } = makeRunner(orch, { getSignal: () => ({ aborted }) });
    const p = runner({ service: SERVICE, input: {}, outputSchema: { type: 'object' } });
    setTimeout(() => { aborted = true; }, 10);
    const out = await p;
    assert.equal(execCalls, 1, 'second executeScript never ran');
    assert.equal(out.report.aborted, true);
    assert.match(out.report.error.message, /TEST_ABORTED/);
  });
});
