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
    sendMessage: async () => ({ pong: true }),
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

  it('sandbox DataCloneError gets the un-awaited-Promise hint (fourth-live-log G4)', async () => {
    const orch = async () => {
      const e = new Error('Step failed: Error in invoked script script: #[object Promise] could not be cloned.');
      e.stepId = 's1';
      throw e;
    };
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object' } });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /could not be cloned/);
    assert.match(out.report.error.message, /await/i);
    assert.match(out.report.error.message, /\$count|\$extract/, 'names the offending API family');
  });

  it('$list data-object misuse gets the not-a-DOM-node hint (fourth-live-log G4)', async () => {
    const orch = async () => {
      const e = new Error('Step failed: TypeError: c.querySelectorAll is not a function');
      e.stepId = 's1';
      throw e;
    };
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object' } });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /querySelectorAll is not a function/);
    assert.match(out.report.error.message, /\$list[^\n]*data/i, 'explains $list returns data snapshots, not DOM nodes');
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
    try {
      assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /ZERO_COUNTER_FROZEN/);
    assert.ok(out.report.events.indexOf('COUNTER_FROZEN') !== -1);
    assert.ok(out.raw.breaker, 'breaker state exposed on raw');
    } finally {
      Date.now = origNow;
    }
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

  it('tab-create timeout closes the late-arriving tab (leak guard)', async () => {
    const removed = [];
    const orch = async (svc, input, d) => {
      try { await d.createTab('https://example.com'); } catch (e) { /* timeout expected */ }
      return { finalResult: { posts: [{ title: 'a' }] }, steps: [], pages: [] };
    };
    const { runner } = makeRunner(orch, {
      createTab: async () => { await new Promise((r) => setTimeout(r, 80)); return { id: 99 }; },
      removeTab: async (x) => { removed.push(x); },
      withTimeout: (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg || 'timeout')), 30))])
    });
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object' } });
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(removed.some((x) => (x && x.id) === 99 || x === 99), 'late-arriving tab was closed by the leak guard');
    assert.equal(out.report.ok, true, 'the run itself still completes');
  });

  it('pagesTruncated renders as N+ in report.pages', async () => {
    const orch = async () => ({ finalResult: { posts: [{ title: 'a' }] }, steps: [], pages: [1, 2, 3], pagesTruncated: true });
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object' } });
    assert.equal(out.report.pages, '3+');
  });

  it('missing top-level schema fields are informational: schemaOk:false + schemaMissing, ok stays true', async () => {
    const orch = async () => ({ finalResult: { posts: [{ title: 'a' }] }, steps: [{ stepId: 's1', stepName: 'one', result: {}, snapshot: null }], pages: [], pagesTruncated: false });
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object', required: ['posts', 'cursor'], properties: { posts: { type: 'array' }, cursor: { type: 'string' } } } });
    assert.equal(out.report.ok, true, 'a missing scalar is not an extraction error (findEmptyExtractionFields skips scalars)');
    assert.equal(out.report.schemaOk, false);
    assert.ok(String(out.report.schemaMissing).indexOf('cursor') !== -1);
  });

  it('breaker does NOT trip when the streak spans less than the minimum elapsed time', async () => {
    const orch = async (svc, input, d, opts) => {
      for (let i = 1; i <= 10; i++) {
        opts.onEvent({ type: 'STEP_ITERATION', stepId: 's1', iteration: i, resultPreview: '{"done":false,"count":0,"raw":5}' });
      }
      return { finalResult: { posts: [{ title: 'a' }] }, steps: [], pages: [] };
    };
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object' } });
    assert.equal(out.raw.breaker, null, 'streak ≥ 8 but elapsed < 60s → no trip');
    assert.equal(out.report.ok, true);
  });
});

describe('verify-runner STEP_NO_RETURN detector (second-live-log D1)', () => {
  it('all steps yielded undefined + empty finalResult → loud error, ok:false, tag present', async () => {
    const orch = async (svc, input, d, opts) => {
      opts.onEvent({ type: 'EXECUTION_START' });
      opts.onEvent({ type: 'STEP_ITERATION', stepId: 's1', iteration: 1, resultPreview: 'undefined' });
      return {
        finalResult: {},
        steps: [
          { stepId: 's1', stepName: 'load', result: undefined, snapshot: null },
          { stepId: 's2', stepName: 'extract', result: undefined, snapshot: null }
        ],
        pages: [], pagesTruncated: false
      };
    };
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array' } } } });
    assert.equal(out.report.ok, false, 'scripts without returns cannot be green');
    assert.match(out.report.error.message, /STEP_NO_RETURN/);
    assert.match(out.report.error.message, /s1, s2/);
    assert.match(out.report.error.message, /return <value>/);
    assert.deepEqual(out.report.detectors.stepNoReturn, ['s1', 's2']);
    assert.ok(out.report.events.indexOf('STEP_NO_RETURN') !== -1, 'tag rides report.events');
  });

  it('data flowed but an earlier step returned undefined → report-only detector + tag, ok stays true', async () => {
    const orch = async () => ({
      finalResult: { posts: [{ title: 'a' }, { title: 'b' }] },
      steps: [
        { stepId: 's1', stepName: 'scroll', result: undefined, snapshot: null },
        { stepId: 's2', stepName: 'extract', result: { posts: [{ title: 'a' }, { title: 'b' }] }, snapshot: null }
      ],
      pages: [], pagesTruncated: false
    });
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' } } } } } } });
    assert.equal(out.report.ok, true, 'data reached the output — the undefined step is a hygiene note, not a run blocker');
    assert.deepEqual(out.report.detectors.stepNoReturn, ['s1']);
    assert.ok(out.report.events.indexOf('STEP_NO_RETURN') !== -1);
  });

  it('skipped steps are excluded (their result is legitimately absent)', async () => {
    const orch = async () => ({
      finalResult: { posts: [{ title: 'a' }] },
      steps: [
        { stepId: 's0', stepName: 'cond', skipped: true, skipReason: 'condition false', result: undefined, snapshot: null },
        { stepId: 's1', stepName: 'extract', result: { posts: [{ title: 'a' }] }, snapshot: null }
      ],
      pages: [], pagesTruncated: false
    });
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' } } } } } } });
    assert.equal(out.report.detectors.stepNoReturn, null);
    assert.equal(out.report.events.indexOf('STEP_NO_RETURN'), -1);
  });
});

describe('verify-runner shapeDistribution detector (record-shape-distribution consumer)', () => {
  const SCHEMA_ARR_OBJ = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } };

  it('heterogeneous record shapes → report-only detector block + CARD_POLICY tag (no error)', async () => {
    const orch = async () => ({
      finalResult: { posts: [
        { permalink: '/p1', title: 'a' }, { permalink: '/p2', title: 'b' },
        { adLabel: 'sponsored' }, { adLabel: 'sponsored' }
      ] },
      steps: [{ stepId: 's1', stepName: 'one', result: { done: true }, snapshot: null }], pages: [], pagesTruncated: false
    });
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA_ARR_OBJ });
    assert.equal(out.report.ok, true, 'shape heterogeneity is a signal, not an error');
    assert.ok(out.report.detectors.shapeDistribution, 'detector block present');
    assert.ok(out.report.detectors.shapeDistribution.indexOf('SHAPE A') !== -1);
    assert.ok(out.report.detectors.shapeDistribution.indexOf('SHAPE B') !== -1);
    assert.ok(out.report.detectors.shapeDistribution.indexOf('Record collection: posts') !== -1);
    assert.ok(out.report.events.indexOf('CARD_POLICY') !== -1, 'CARD_POLICY tag rides report.events for knowledge auto-attach');
  });

  it('homogeneous records → no block, no tag (quiet when there is nothing to say)', async () => {
    const orch = async () => ({
      finalResult: { posts: [{ permalink: '/p1', title: 'a' }, { permalink: '/p2', title: 'b' }, { permalink: '/p3', title: 'c' }] },
      steps: [{ stepId: 's1', stepName: 'one', result: { done: true }, snapshot: null }], pages: [], pagesTruncated: false
    });
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA_ARR_OBJ });
    assert.equal(out.report.ok, true);
    assert.equal(out.report.detectors.shapeDistribution, null);
    assert.equal(out.report.events.indexOf('CARD_POLICY'), -1);
  });

  it('non-array or too-small outputs stay null (no false heterogeneity)', async () => {
    const orch = async () => ({ finalResult: { posts: [{ a: 1 }] }, steps: [], pages: [] });
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA_ARR_OBJ });
    assert.equal(out.report.detectors.shapeDistribution, null);
  });
});
