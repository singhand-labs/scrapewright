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

  it('report.finalResult caps long string fields (eighth-log K1: 3 kept records × 75K html = 226K-char transcript entry)', async () => {
    const bigHtml = 'z'.repeat(75000);
    const orch = async () => ({ finalResult: { posts: [{ id: 1, html: bigHtml }] }, steps: [], pages: [] });
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object' } });
    const p = out.report.finalResult.posts[0];
    assert.equal(p.id, 1);
    assert.ok(p.html.length <= 2040, 'string fields capped in the sampled report, got ' + p.html.length);
    assert.match(p.html, /\[truncated from 75000 chars\]/);
    assert.equal(out.raw.testResult.finalResult.posts[0].html.length, 75000, 'raw untouched');
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

  it('JS syntax paren-imbalance gets the balanced-brackets hint (seventh-log J2: first verify at turn 60 died on "missing ) after argument list")', async () => {
    const orch = async () => {
      const e = new Error('Step failed: missing ) after argument list');
      e.stepId = 'extract';
      throw e;
    };
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object' } });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /missing \) after argument list/);
    assert.match(out.report.error.message, /balanced/i);
    assert.match(out.report.error.message, /\}\)\)/, 'names the .map((r) => ({ ... })) double-closer shape');
  });

  it('missing } after property list gets the same balanced-brackets hint (seventh-log J2)', async () => {
    const orch = async () => {
      const e = new Error('Step failed: missing } after property list');
      e.stepId = 's1';
      throw e;
    };
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object' } });
    assert.match(out.report.error.message, /missing \} after property list/);
    assert.match(out.report.error.message, /balanced/i);
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

  it('FIELD_MATCH_ZERO: empty output + a field that matched 0 of N containers on every call re-labels EMPTY_EXTRACTION with the census (thirteenth log: q=cat cards had no /posts/ permalinks; the step JS filter dropped all 19 records)', async () => {
    const orch = async (svc, input, d, opts) => {
      opts.onEvent({
        type: 'STEP_ITERATION', stepId: 'collect', iteration: 1,
        selectorDiagnostics: [{
          api: 'extractList',
          containerSelector: 'div[role="feed"] > div:has(h3)',
          containerMatches: 19,
          perField: [
            { field: 'author', subSelector: 'h3', attr: null, matchCount: 19, sampleTexts: [], sampleHrefs: [], sampleValues: [] },
            { field: 'postId', subSelector: 'a[href*="/posts/"]', attr: 'href', matchCount: 0, sampleTexts: [], sampleHrefs: [], sampleValues: [] }
          ]
        }]
      });
      return { finalResult: { posts: [] }, steps: [{ stepId: 'collect', stepName: 'scroll and collect posts', result: { done: true, posts: [] }, snapshot: null }], pages: [], pagesTruncated: false };
    };
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', properties: { postId: { type: 'string' } }, required: ['postId'] } } } } });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /FIELD_MATCH_ZERO/);
    assert.match(out.report.error.message, /postId/);
    assert.match(out.report.error.message, /0 of 19/);
    assert.match(out.report.error.message, /containers themselves DID match/);
    assert.match(out.report.error.message, /filter/, 'names the own-JS record-dropping mechanism');
    assert.match(out.report.error.message, /SAME input values/i, 'names the verify-input-divergence mechanism');
    assert.ok(out.report.detectors.zeroMatchFields && out.report.detectors.zeroMatchFields.length === 1);
    assert.equal(out.report.detectors.zeroMatchFields[0].field, 'postId');
    assert.ok(out.report.events.indexOf('FIELD_MATCH_ZERO') !== -1);
    assert.ok(out.report.events.indexOf('EMPTY_EXTRACTION') !== -1, 'keeps the EMPTY_EXTRACTION tag for knowledge attach');
  });

  // Fourteenth-log follow-up (user request): an input VALUE can leave the
  // site with nothing to extract (obscure keyword, over-specific filter) —
  // containers match 0. The generic message says "field selectors are
  // wrong", steering the model into selector hardening. Name the input
  // suspect and teach re-verifying with a different, more common value.
  it('INPUT_VALUE_SUSPECT: empty output + zero containers on every list call teaches re-testing a DIFFERENT input value before touching selectors', async () => {
    const orch = async (svc, input, d, opts) => {
      opts.onEvent({
        type: 'STEP_ITERATION', stepId: 'search', iteration: 1,
        selectorDiagnostics: [{
          api: 'extractList',
          containerSelector: 'div[role="feed"] > div:has(h3)',
          containerMatches: 0,
          perField: [
            { field: 'author', subSelector: 'h3', attr: null, matchCount: 0, sampleTexts: [], sampleHrefs: [], sampleValues: [] }
          ]
        }]
      });
      return { finalResult: { posts: [] }, steps: [{ stepId: 'search', stepName: 'search and collect', result: { done: true, posts: [] }, snapshot: null }], pages: [], pagesTruncated: false };
    };
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', properties: { author: { type: 'string' } }, required: ['author'] } } } } });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /INPUT_VALUE_SUSPECT/);
    assert.match(out.report.error.message, /no content for it|no content/i, 'names the no-content mechanism');
    assert.match(out.report.error.message, /DIFFERENT, more common/i, 'teaches switching to a common input value');
    assert.match(out.report.error.message, /"input"/, 'shows the verify.run input override');
    assert.match(out.report.error.message, /testInput/, 'teaches adopting the working value');
    assert.ok(!/selectors are wrong/.test(out.report.error.message), 'does NOT steer into selector hardening');
    assert.ok(out.report.detectors.containerZero && out.report.detectors.containerZero.length === 1, 'detector attached');
    assert.equal(out.report.detectors.containerZero[0].stepId, 'search');
    assert.ok(out.report.events.indexOf('INPUT_VALUE_SUSPECT') !== -1);
    assert.ok(out.report.events.indexOf('EMPTY_EXTRACTION') !== -1, 'keeps the EMPTY_EXTRACTION tag for knowledge attach');
  });

  it('populated containers keep the FIELD_MATCH_ZERO branch — INPUT_VALUE_SUSPECT does not fire when the page had items', async () => {
    const orch = async (svc, input, d, opts) => {
      opts.onEvent({
        type: 'STEP_ITERATION', stepId: 'collect', iteration: 1,
        selectorDiagnostics: [{
          api: 'extractList', containerSelector: 'div.card', containerMatches: 9,
          perField: [{ field: 'title', subSelector: 'h3', attr: null, matchCount: 0, sampleTexts: [], sampleHrefs: [], sampleValues: [] }]
        }]
      });
      return { finalResult: { posts: [] }, steps: [{ stepId: 'collect', stepName: 'collect', result: { done: true, posts: [] }, snapshot: null }], pages: [], pagesTruncated: false };
    };
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } } } } });
    assert.match(out.report.error.message, /FIELD_MATCH_ZERO/);
    assert.ok(!out.report.events.includes('INPUT_VALUE_SUSPECT'), 'input-value suspect stays out when containers matched');
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

describe('verify-runner score-0 key-mismatch note (sixth-live-log I4)', () => {
  it('score 0 with real data names the result keys vs the schema keys', async () => {
    const orch = async (svc, input, d, opts) => {
      await d.createTab(svc.targetUrl);
      opts.onEvent({ type: 'EXECUTION_START' });
      return { finalResult: { items: [{ a: 1 }, { a: 2 }] }, steps: [{ stepId: 's1', stepName: 'one', result: { done: true }, snapshot: null }], pages: [], pagesTruncated: false };
    };
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array' } } } });
    assert.equal(out.report.ok, true);
    assert.equal(out.report.score.score, 0, 'schema wants posts, result carries items → all-zero breakdown');
    assert.ok(out.report.score.isData, 'data DID arrive');
    assert.ok(out.report.scoreNote, 'the zero score is explained');
    assert.match(out.report.scoreNote, /items/);
    assert.match(out.report.scoreNote, /posts/);
    assert.match(out.report.scoreNote, /top-level/i, 'teaches that scoring reads result top-level keys');
  });

  it('a matching score carries no note', async () => {
    const orch = async (svc, input, d, opts) => {
      await d.createTab(svc.targetUrl);
      opts.onEvent({ type: 'EXECUTION_START' });
      return { finalResult: { posts: [{ a: 1 }] }, steps: [{ stepId: 's1', stepName: 'one', result: { done: true }, snapshot: null }], pages: [], pagesTruncated: false };
    };
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array' } } } });
    assert.ok(out.report.score.score > 0);
    assert.equal(out.report.scoreNote, null);
  });
});

describe('createVerifyRunner STEP_NO_RETURN detector (second-live-log D1)', () => {
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

describe('verify-runner junkValues detector (tenth-log N2: structurally green, junk-valued)', () => {
  const SCHEMA = {
    type: 'object', required: ['posts'],
    properties: { posts: { type: 'array', items: { type: 'object', properties: {
      title: { type: 'string' }, postId: { type: 'string' },
      mediaUrls: { type: 'array', items: { type: 'string' } }
    } } } }
  };

  it('query-blob ids + data: URIs in url arrays → report-only detector + JUNK_VALUES tag, ok stays true', async () => {
    const posts = [
      { title: 'a', postId: '?__cft__[0]=AZge7token&a', mediaUrls: ['https://cdn.example.com/a.jpg', 'data:image/svg+xml,%3Csvg%20fill%3D%27none%27%3E'] },
      { title: 'b', postId: '?__cft__[0]=ZZZother&b', mediaUrls: ['https://cdn.example.com/b.jpg'] }
    ];
    const orch = async () => ({ finalResult: { posts }, steps: [{ stepId: 's1', stepName: 'one', result: { done: true }, snapshot: null }], pages: [], pagesTruncated: false });
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA });
    assert.equal(out.report.ok, true, 'junk values are surfaced, never blocking');
    const jv = out.report.detectors.junkValues;
    assert.ok(jv, 'detector block present');
    const kinds = {};
    for (const f of jv.fields) kinds[f.field] = f.kind;
    assert.equal(kinds['posts.postId'], 'queryBlob', 'bare ?a=b redirect fragment flagged');
    assert.equal(kinds['posts.mediaUrls'], 'dataUri', 'inline data: URI in a url-ish array flagged');
    assert.ok(jv.fields.some((f) => f.kind === 'dataUri' && f.junkCount === 1 && f.total === 3), 'counts carried');
    assert.ok(out.report.events.indexOf('JUNK_VALUES') !== -1, 'tag rides report.events');
    assert.match(jv.note, /io\.confirm/, 'teaches renegotiation of the contract');
  });

  it('markup dump in a data field flagged; a field explicitly named html is left alone', async () => {
    const dump = '<div class="a"><span>x</span><b>y</b><i>z</i></div>' + 'z'.repeat(200);
    const posts = [
      { title: 'a', caption: dump, html: dump },
      { title: 'b', caption: dump, html: dump }
    ];
    const orch = async () => ({ finalResult: { posts }, steps: [], pages: [] });
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, caption: { type: 'string' }, html: { type: 'string' } } } } } } });
    assert.equal(out.report.ok, true);
    const jv = out.report.detectors.junkValues;
    assert.ok(jv, 'detector fires');
    const kinds = {};
    for (const f of jv.fields) kinds[f.field] = f.kind;
    assert.equal(kinds['posts.caption'], 'markupDump');
    assert.ok(!('posts.html' in kinds), 'an explicit html-named field is a user choice, not junk');
  });

  it('clean values stay quiet (null detector, no tag)', async () => {
    const posts = [
      { title: 'a', postId: '12345', mediaUrls: ['https://cdn.example.com/a.jpg'] },
      { title: 'b', postId: '67890', mediaUrls: ['https://cdn.example.com/b.jpg'] }
    ];
    const orch = async () => ({ finalResult: { posts }, steps: [], pages: [] });
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA });
    assert.equal(out.report.ok, true);
    assert.equal(out.report.detectors.junkValues, null);
    assert.equal(out.report.events.indexOf('JUNK_VALUES'), -1);
  });
});

describe('verify-runner partialEmptyFields detector (sixteenth log: green verify, confirmed fields empty)', () => {
  const SCHEMA = {
    type: 'object', required: ['posts'],
    properties: { posts: { type: 'array', items: { type: 'object', properties: {
      content: { type: 'string' }, time: { type: 'string' }, location: { type: 'string' },
      likeCount: { type: 'string' }, mediaUrls: { type: 'array', items: { type: 'string' } },
      hoverCards: { type: 'array', items: { type: 'object' } }
    } } } }
  };

  it('fields empty in EVERY record beside populated ones → report-only census + PARTIAL_EMPTY_FIELDS tag, ok stays true', async () => {
    // Sixteenth log shape: score 133 green ship with time:"" and location:""
    // hardcoded empty next to a populated content field —
    // findEmptyExtractionFields is blind to it (only fires all-fields-empty).
    const posts = [
      { content: 'climate post one', time: '', location: '', likeCount: '173', mediaUrls: [], hoverCards: [] },
      { content: 'climate post two', time: '', location: '', likeCount: '42', mediaUrls: [], hoverCards: [] },
      { content: 'climate post three', time: '', location: '', likeCount: '7', mediaUrls: [], hoverCards: [] }
    ];
    const orch = async () => ({ finalResult: { posts }, steps: [{ stepId: 's1', stepName: 'one', result: { done: true }, snapshot: null }], pages: [], pagesTruncated: false });
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA });
    assert.equal(out.report.ok, true, 'partial empties are surfaced, never blocking');
    const pe = out.report.detectors.partialEmptyFields;
    assert.ok(pe, 'detector block present');
    const byPath = {};
    for (const f of pe) byPath[f.path] = f;
    assert.ok(byPath['posts.time'], 'time censused');
    assert.equal(byPath['posts.time'].emptyCount, 3);
    assert.equal(byPath['posts.time'].totalCount, 3);
    assert.equal(byPath['posts.time'].emptyRatio, 1);
    assert.ok(byPath['posts.location'], 'location censused');
    assert.ok(byPath['posts.hoverCards'], 'empty array-of-objects field censused');
    assert.ok(!('posts.content' in byPath), 'populated fields stay out of the census');
    assert.ok(!('posts.likeCount' in byPath), 'populated scalar stays out of the census');
    assert.ok(out.report.events.indexOf('PARTIAL_EMPTY_FIELDS') !== -1, 'tag rides report.events');
  });

  it('partially-empty fields (some records) carry their ratio; a one-off empty stays quiet', async () => {
    const posts = [
      { content: 'c1', time: '2h', location: '', likeCount: '1', mediaUrls: [], hoverCards: [] },
      { content: 'c2', time: '5h', location: '', likeCount: '2', mediaUrls: ['https://cdn.example.com/x.jpg'], hoverCards: [] },
      { content: 'c3', time: '', location: '', likeCount: '3', mediaUrls: [], hoverCards: [{ html: '<div>card</div>' }] }
    ];
    const orch = async () => ({ finalResult: { posts }, steps: [], pages: [] });
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA });
    assert.equal(out.report.ok, true);
    const pe = out.report.detectors.partialEmptyFields;
    assert.ok(pe, 'detector block present');
    const byPath = {};
    for (const f of pe) byPath[f.path] = f;
    assert.ok(byPath['posts.location'], 'location empty 3/3 flagged');
    assert.equal(byPath['posts.location'].emptyRatio, 1);
    assert.ok(byPath['posts.mediaUrls'], 'mediaUrls empty 2/3 crosses the 0.5 threshold');
    assert.ok(Math.abs(byPath['posts.mediaUrls'].emptyRatio - 2 / 3) < 1e-9);
    assert.ok(!('posts.time' in byPath), 'time empty 1/3 is below threshold — not a pattern');
    assert.ok(byPath['posts.hoverCards'], 'hoverCards empty 2/3 crosses the threshold');
  });

  it('fully populated output keeps the detector null and the tag absent', async () => {
    const posts = [
      { content: 'c1', time: '2h', location: 'Berlin', likeCount: '1', mediaUrls: ['https://cdn.example.com/a.jpg'], hoverCards: [{ html: 'x' }] },
      { content: 'c2', time: '5h', location: 'Oslo', likeCount: '2', mediaUrls: ['https://cdn.example.com/b.jpg'], hoverCards: [{ html: 'y' }] }
    ];
    const orch = async () => ({ finalResult: { posts }, steps: [], pages: [] });
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA });
    assert.equal(out.report.ok, true);
    assert.equal(out.report.detectors.partialEmptyFields, null);
    assert.equal(out.report.events.indexOf('PARTIAL_EMPTY_FIELDS'), -1);
  });
});

describe('audit batch: junk/depth/hints/degradation (C7/C9/C11/C19/C20/C26)', () => {
  const { detectJunkValues } = require('../lib/verify-runner');

  it('C9: markupDump only fires on values that START with "<"', () => {
    const data = { posts: [
      { caption: 'Use <b>bold</b> and <i>italic</i> and <u>underline</u> in your posts — this is a legitimate sentence containing tags mid-text and is long enough to pass the length gate so the prefix rule is what must reject it.' },
      { caption: '<div class="card"><span>item one</span><span>item two</span><span>item three</span> real markup dump at the start of the value, long enough to trip the detector when it leads with a tag.' }
    ] };
    const r = detectJunkValues(data, { type: 'object' });
    assert.ok(r, 'detector fires');
    const cap = r.fields.find((f) => f.kind === 'markupDump');
    assert.ok(cap, 'markupDump flagged');
    assert.equal(cap.count, 1, 'only the leading-tag value counts');
  });

  it('C7: junk detection recurses into nested containers (depth <= 3)', () => {
    const data = { result: { items: [ { id: '?ref=abc123' } ] } };
    const r = detectJunkValues(data, { type: 'object' });
    assert.ok(r, 'nested record array scanned');
    assert.ok(r.fields.some((f) => f.field === 'result.items.id' && f.kind === 'queryBlob'), 'field path names the nested location');
  });

  it('C20: schema description hints mark url-ish/raw-ish fields the regex misses', () => {
    const data = { anexos: [ { enlace: ['data:image/png;base64,AAAA', 'https://ok.example/a.png'] } ] };
    const schema = { type: 'object', properties: { anexos: { type: 'array', items: { type: 'object', properties: { enlace: { type: 'array', description: 'attachment links (URLs)' } } } } } };
    const r = detectJunkValues(data, schema);
    assert.ok(r, 'hinted field treated as url-ish');
    assert.ok(r.fields.some((f) => f.kind === 'dataUri'), 'data: entry counted');
  });

  it('C20: raw-ish hint exempts a field named in the schema description', () => {
    const data = { posts: [ { cuerpo: '<div class="x"><p>one</p><p>two</p><p>three</p><p>four</p> markup-ish body that the schema declares as embedded html content by description.' } ] };
    const schema = { type: 'object', properties: { posts: { type: 'array', items: { type: 'object', properties: { cuerpo: { type: 'string', description: 'embedded html body' } } } } } };
    const r = detectJunkValues(data, schema);
    assert.ok(!r || !r.fields.some((f) => f.kind === 'markupDump'), 'schema-declared html field exempt');
  });

  it('C11: a wizard-utils bag missing functions reports degradation in the verify report', async () => {
    const orch = async (svc, input, d, opts) => ({ finalResult: { posts: [{ a: 1 }] }, steps: [], pages: [] });
    const partialBag = { scoreAttemptResult: () => null };
    const { runner } = makeRunner(orch, { wizardUtils: partialBag });
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object' } });
    assert.equal(out.report.ok, true);
    assert.match(out.report.degraded, /unavailable/, 'degradation disclosed');
    assert.match(out.report.degraded, /findEmptyExtractionFields/);
  });

  it('C26: not-ready iterations with NO counter fields never build a zero-counter streak', async () => {
    const orch = async (svc, input, d, opts) => {
      for (let i = 0; i < 12; i++) {
        opts.onEvent({ type: 'STEP_ITERATION', stepId: 's1', iteration: i + 1, resultPreview: '{"done":false,"ready":false}' });
      }
      opts.onEvent({ type: 'STEP_ITERATION', stepId: 's1', iteration: 13, resultPreview: '{"done":true}' });
      return { finalResult: { posts: [{ a: 1 }] }, steps: [], pages: [] };
    };
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object' } });
    assert.equal(out.report.ok, true, 'no breaker without counter fields');
    assert.equal(out.raw.breaker, null);
  });
});

describe('audit C2 (pin): abort signal reaches mid-run script execution', () => {
  it('getSignal().aborted flips the next executeScript into TEST_ABORTED', async () => {
    let signal = { aborted: false };
    const orch = async (svc, input, d, opts) => {
      opts.onEvent({ type: 'EXECUTION_START' });
      const step = svc.steps[0];
      await d.executeScript(11, step.script, {}, 1000); // first pass ok
      signal.aborted = true; // user hits Abort here
      await d.executeScript(11, step.script, {}, 1000); // must abort
      return { finalResult: {}, steps: [], pages: [] };
    };
    const { runner } = makeRunner(orch, { getSignal: () => signal });
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object' } });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /TEST_ABORTED/);
    assert.equal(out.report.aborted, true);
  });
});
