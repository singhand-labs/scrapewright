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

  it('steps carry each step LAST resultPreview, re-capped for the 4000-char tool-result window (twenty-eighth log: postingTime died between extract and resolve and the model had to blind-guess which)', async () => {
    const longPreview = '{"spans":[{"id":"_r_aa_"},{"id":"_r_ab_"},{"id":"_r_ac_"},{"id":"_r_ad_"},{"id":"_r_ae_"},{"id":"_r_af_"},{"id":"_r_ag_"},{"id":"_r_ah_"},{"id":"_r_ai_"},{"id":"_r_aj_"},{"id":"_r_ak_"},{"id":"_r_al_"},{"id":"_r_am_"},{"id":"_r_an_"},{"id":"_r_ao_"},{"id":"_r_ap_"},{"id":"_r_aq_"},{"id":"_r_ar_"},{"id":"_r_as_"},{"id":"_r_at_"},{"id":"_r_au_"},{"id":"_r_av_"}]}';
    const orch = async (svc, input, d, opts) => {
      opts.onEvent({ type: 'STEP_ITERATION', stepId: 'extract', iteration: 1, resultPreview: '{"done":false}' });
      opts.onEvent({ type: 'STEP_ITERATION', stepId: 'extract', iteration: 2, resultPreview: '{"posts":[{"timeRef":"_r_4c_"},{"timeRef":"_r_5i_"}]}' });
      opts.onEvent({ type: 'STEP_ITERATION', stepId: 'resolve', iteration: 1, resultPreview: longPreview });
      return {
        finalResult: { posts: [{ postingTime: '' }, { postingTime: '' }] },
        steps: [
          { stepId: 'extract', stepName: 'extract cards', result: {}, snapshot: null },
          { stepId: 'resolve', stepName: 'resolve timeRefs', result: {}, snapshot: null }
        ],
        pages: [], pagesTruncated: false
      };
    };
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object' } });
    const byId = {};
    for (const s of out.report.steps) byId[s.stepId] = s;
    assert.equal(byId.extract.resultPreview, '{"posts":[{"timeRef":"_r_4c_"},{"timeRef":"_r_5i_"}]}', 'last iteration wins, not the first');
    assert.ok(byId.resolve.resultPreview.length <= 200, 'preview re-capped at 200 chars, got ' + byId.resolve.resultPreview.length);
    assert.match(byId.resolve.resultPreview, /…/, 'cut disclosed');
    assert.match(byId.resolve.resultPreview, /\]\}$/, 'tail of the preview survives the re-cap (twenty-ninth log: head+tail)');
    const serialized = JSON.stringify(out.report);
    assert.ok(serialized.indexOf('_r_4c_') !== -1, 'intermediate value visible in the serialized report');
  });

  it('the 200 re-cap keeps the TAIL (twenty-ninth log: a head-only re-cap destroyed the timeMapSize instrumentation the model placed at the END of its extract return — exactly the key that discriminates spans-absent from lookup-failed)', async () => {
    const src = '{"posts":[{"content":"' + 'x'.repeat(400) + '"}],"totalCards":15,"timeMapSize":0}';
    const orch = async (svc, input, d, opts) => {
      opts.onEvent({ type: 'STEP_ITERATION', stepId: 'extract', iteration: 1, resultPreview: src });
      return {
        finalResult: { posts: [{ postingTime: '' }] },
        steps: [{ stepId: 'extract', stepName: 'extract cards', result: {}, snapshot: null }],
        pages: [], pagesTruncated: false
      };
    };
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object' } });
    const p = out.report.steps[0].resultPreview;
    assert.ok(p.length <= 200, 're-capped at 200 chars, got ' + p.length);
    assert.match(p, /^{"posts":\[\{"content":"/, 'head shape survives both layers');
    assert.match(p, /"timeMapSize":0\}$/, 'instrumented tail key survives both layers');
    assert.ok(p.includes('…'), 'cut disclosed');
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
    assert.ok(out.report.events.indexOf('POLL_EXHAUSTED') !== -1, 'POLL_EXHAUSTED keeps its own tag (seventeenth log)');
    assert.equal(out.report.events.indexOf('SELECTOR_ZERO_MATCH'), -1,
      'budget exhaustion with non-zero counts is NOT a zero-match claim — the mis-tag sent the model selector-hunting');
    assert.equal(out.raw.testResult && out.raw.testResult.steps ? out.raw.testResult.steps.length : 1, 1, 'partial steps preserved on raw');
  });

  it('POLL_EXHAUSTED names UNAWAITED_ASYNC_CALL when the failing step calls $ APIs without await (thirtieth log)', async () => {
    const svc = {
      targetUrl: 'https://example.com',
      steps: [{ id: 's1', name: 'poll count', script: 'const n = $count("div.card"); if (n > 0) return { done: true, count: n }; return { done: false };', onSuccess: 'TERMINATE' }],
      config: {}
    };
    const orch = async () => {
      const e = new Error('Step failed: POLL_EXHAUSTED step s1 gave up');
      e.stepId = 's1';
      throw e;
    };
    const { runner } = makeRunner(orch);
    const out = await runner({ service: svc, input: {}, outputSchema: { type: 'object' } });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /UNAWAITED_ASYNC_CALL/);
    assert.match(out.report.error.message, /\$count/);
    assert.match(out.report.error.message, /await/);
    assert.match(out.report.error.message, /Original error:/);
    assert.equal(out.report.error.stepId, 's1');
  });

  it('awaited script keeps the generic POLL_EXHAUSTED message — no false UNAWAITED_ASYNC_CALL', async () => {
    const svc = {
      targetUrl: 'https://example.com',
      steps: [{ id: 's1', name: 'poll count', script: 'const n = await $count("div.card"); if (n > 0) return { done: true, count: n }; return { done: false };', onSuccess: 'TERMINATE' }],
      config: {}
    };
    const orch = async () => {
      const e = new Error('Step failed: POLL_EXHAUSTED step s1 gave up');
      e.stepId = 's1';
      throw e;
    };
    const { runner } = makeRunner(orch);
    const out = await runner({ service: svc, input: {}, outputSchema: { type: 'object' } });
    assert.equal(out.report.ok, false);
    assert.doesNotMatch(out.report.error.message, /UNAWAITED_ASYNC_CALL/);
    assert.match(out.report.error.message, /POLL_EXHAUSTED/);
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

  it('score 0 with MATCHING keys but empty values carries no key-mismatch note (seventeenth log E: renaming advice would misdirect)', async () => {
    const orch = async () => ({
      finalResult: { posts: [{ serialNumber: 1, postId: '', content: '' }] },
      steps: [{ stepId: 's1', stepName: 'one', result: { done: true }, snapshot: null }],
      pages: [], pagesTruncated: false
    });
    const { runner } = makeRunner(orch);
    const out = await runner({
      service: SERVICE, input: {},
      outputSchema: {
        type: 'object', required: ['posts'],
        properties: { posts: { type: 'array', items: { type: 'object', properties: { postId: { type: 'string' }, content: { type: 'string' } } } } }
      }
    });
    assert.equal(out.report.scoreNote, null, 'keys align — the zeros come from empty values, and the empty-fields detector owns that case');
    assert.deepEqual(out.report.detectors.emptyFields, ['posts'],
      'records whose SCHEMA fields are all empty are flagged even with a non-empty synthetic key (seventeenth log: serialNumber 1 defeated Object.values)');
  });
});

describe('AD_MARKER_SELECTOR detector (eighteenth log: sponsored cards relabeled as posts)', () => {
  const FIELDED = { type: 'object', required: ['posts'], properties: { posts: { type: 'array' } } };
  const orch = async () => ({
    finalResult: { posts: [{ postId: 'p1', content: 'x' }] },
    steps: [{ stepId: 's1', stepName: 'extract', result: { done: true }, snapshot: null }],
    pages: [], pagesTruncated: false
  });

  it('a container built ON an ad marker carries the tag + polarity note', async () => {
    const svc = {
      targetUrl: 'https://example.com',
      steps: [{ id: 's1', name: 'extract', onSuccess: 'TERMINATE',
        script: "return $extractList(\"div[role='feed'] div[role='article']:has(div[data-ad-comet-preview])\", { postId: { selector: 'a', attr: 'href' } });" }],
      config: {}
    };
    const { runner } = makeRunner(orch);
    const out = await runner({ service: svc, input: {}, outputSchema: FIELDED });
    assert.equal(out.report.ok, true);
    assert.ok(out.report.events.indexOf('AD_MARKER_SELECTOR') !== -1, 'tag rides report.events');
    assert.ok(Array.isArray(out.report.detectors.adMarkerSelectors) && out.report.detectors.adMarkerSelectors.length === 1);
    assert.deepEqual(out.report.detectors.adMarkerSelectors[0].markers, ['data-ad-comet-preview']);
    assert.match(out.report.scoreNote, /polarity/i, 'note demands the polarity check');
    assert.match(out.report.scoreNote, /thin content/i, 'note names the thin-content alternative');
  });

  it('ad markers inside :not() exclusion also tag — the note teaches BOTH directions', async () => {
    const svc = {
      targetUrl: 'https://example.com',
      steps: [{ id: 's1', name: 'extract', onSuccess: 'TERMINATE',
        script: "return $extractList(\"div[role='feed'] div[role='article']:not(:has([data-ad-rendering-role]))\", { postId: { selector: 'a', attr: 'href' } });" }],
      config: {}
    };
    const { runner } = makeRunner(orch);
    const out = await runner({ service: svc, input: {}, outputSchema: FIELDED });
    assert.ok(out.report.events.indexOf('AD_MARKER_SELECTOR') !== -1, 'report-only: exclusion usage still surfaces for review');
    assert.match(out.report.scoreNote, /:not/i, 'note names the exclusion form as the correct direction');
  });

  it('clean scripts carry no tag and no note', async () => {
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: FIELDED });
    assert.equal(out.report.events.indexOf('AD_MARKER_SELECTOR'), -1);
    assert.equal(out.report.scoreNote, null);
    assert.equal(out.report.detectors.adMarkerSelectors, null);
  });
});

describe('SCHEMA_BLIND defense (seventeenth log: fieldless outputSchema → green score-0 garbage)', () => {
  it('green run under a fieldless schema carries the SCHEMA_BLIND tag and an io.confirm scoreNote', async () => {
    const orch = async (svc, input, d, opts) => {
      await d.createTab(svc.targetUrl);
      opts.onEvent({ type: 'EXECUTION_START' });
      return { finalResult: { posts: [{ postId: '', content: '', html: '' }] }, steps: [{ stepId: 's1', stepName: 'one', result: { done: true }, snapshot: null }], pages: [], pagesTruncated: false };
    };
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object' } });
    assert.equal(out.report.ok, true);
    assert.equal(out.report.score.score, 0);
    assert.ok(out.report.score.isData, 'data arrived — the zero is blindness, not absence');
    assert.ok(out.report.events.indexOf('SCHEMA_BLIND') !== -1, 'tag rides report.events');
    assert.match(out.report.scoreNote, /declares no fields/i);
    assert.match(out.report.scoreNote, /io\.confirm/, 'names the renegotiation path');
  });

  it('fielded schema stays silent — no SCHEMA_BLIND tag', async () => {
    const orch = async () => ({ finalResult: { posts: [{ a: 1 }] }, steps: [], pages: [] });
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array' } } } });
    assert.equal(out.report.events.indexOf('SCHEMA_BLIND'), -1);
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

// Fortieth log: posts.comments shipped "Leave a comment" (the comment
// BUTTON's aria-label) in 4/4 records through a GREEN verify — the
// controlLabel junk detection existed but was advisory-only, so the
// artifact published with the user's reported problem unfixed. A
// schema-declared field whose EVERY value is a bare UI control label
// carries zero data — the same lie-class as REQUIRED_FIELD_EMPTY.
describe('verify-runner junk-dominated field gate (fortieth log: "Leave a comment" shipped green)', () => {
  const SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', required: ['postId'], properties: {
    postId: { type: 'string' }, content: { type: 'string' }, comments: { type: 'string' }, likes: { type: 'string' }
  } } } } };

  it('100% controlLabel on a declared field flips the run red with both exits taught', async () => {
    const posts = [
      { postId: '1', content: 'hello world one', comments: 'Leave a comment', likes: '19' },
      { postId: '2', content: 'hello world two', comments: 'Leave a comment', likes: '' }
    ];
    const orch = async () => ({ finalResult: { posts }, steps: [{ stepId: 's1', stepName: 'extract', result: { done: true } }], pages: [] });
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA });
    assert.equal(out.report.ok, false, 'a field that is 100% button label is not data');
    assert.match(out.report.error.message, /JUNK_DOMINATED_FIELD: posts\.comments/);
    assert.match(out.report.error.message, /Leave a comment/);
    assert.match(out.report.error.message, /digit/, 'teaches the digit-bearing-source signal');
    assert.match(out.report.error.message, /io\.confirm/, 'names the renegotiation exit');
    assert.ok(out.report.events.indexOf('JUNK_DOMINATED') !== -1, 'tag rides report.events');
    assert.ok(out.report.detectors.junkValues, 'underlying census still present');
  });

  it('partial label junk (some records carry a real count) stays green and advisory', async () => {
    const posts = [
      { postId: '1', content: 'one', comments: '4 comments', likes: '1' },
      { postId: '2', content: 'two', comments: 'Leave a comment', likes: '2' }
    ];
    const orch = async () => ({ finalResult: { posts }, steps: [], pages: [] });
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA });
    assert.equal(out.report.ok, true, '1/2 junk is variation, not domination');
    const jv = out.report.detectors.junkValues;
    assert.ok(jv && jv.fields.some((f) => f.kind === 'controlLabel' && f.field === 'posts.comments' && f.count === 1 && f.total === 2), 'census carries count + total');
    assert.equal(out.report.events.indexOf('JUNK_DOMINATED'), -1);
  });

  it('label junk in an UNdeclared field stays advisory (the schema is the gate)', async () => {
    const posts = [
      { postId: '1', content: 'one', comments: 'Leave a comment' },
      { postId: '2', content: 'two', comments: 'Leave a comment' }
    ];
    const thin = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', required: ['postId'], properties: {
      postId: { type: 'string' }, content: { type: 'string' }
    } } } } };
    const orch = async () => ({ finalResult: { posts }, steps: [], pages: [] });
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: thin });
    assert.equal(out.report.ok, true, 'undeclared extras are the census\'s business, not the gate\'s');
    assert.ok(out.report.detectors.junkValues);
  });
});

// 129th-round review fix (P0 dead code): the 127th-round JUNK_VALUES_REQUIRED
// veto gated on Array.isArray(detectors.junkValues) — detectJunkValues
// returns {fields, note}, so the veto could NEVER fire and its only test
// grepped the source. These cases drive the real runner end-to-end: junk in
// a REQUIRED field flips the run red; the same junk in a non-required field
// stays advisory; controlLabel junk keeps routing to the older, more
// specific JUNK_DOMINATED_FIELD gate (precedence pinned).
describe('verify-runner JUNK_VALUES_REQUIRED veto (129th-round review: the dead gate wired to the real detector shape)', () => {
  const REQ_SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', required: ['postId', 'permalink'], properties: {
    postId: { type: 'string' }, permalink: { type: 'string' }, content: { type: 'string' }, comments: { type: 'string' }
  } } } } };

  it('query-blob junk in a REQUIRED field vetoes the run (dotted path resolved, last segment tested)', async () => {
    const posts = [
      { postId: '1', permalink: '?__cft__[0]=AZge7token&a', content: 'hello one' },
      { postId: '2', permalink: '?__cft__[0]=ZZZother&b', content: 'hello two' }
    ];
    const orch = async () => ({ finalResult: { posts }, steps: [{ stepId: 's1', stepName: 'extract', result: { done: true } }], pages: [] });
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: REQ_SCHEMA });
    assert.equal(out.report.ok, false, 'junk in a required field is a broken binding, not an advisory');
    assert.match(out.report.error.message, /JUNK_VALUES_REQUIRED: posts\.permalink/);
    assert.match(out.report.error.message, /queryBlob/, 'names the junk kind');
    assert.match(out.report.error.message, /io\.confirm/, 'names the renegotiation exit');
    assert.ok(out.report.detectors.junkValues, 'underlying census still present under the veto');
  });

  it('the SAME junk in a NON-required field stays green with the advisory census', async () => {
    const posts = [
      { postId: '1', permalink: 'https://example.com/p/1', content: 'hello one', ref: '?__cft__[0]=AZge7token&a' },
      { postId: '2', permalink: 'https://example.com/p/2', content: 'hello two', ref: '?__cft__[0]=ZZZother&b' }
    ];
    const lenient = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', required: ['postId', 'permalink'], properties: {
      postId: { type: 'string' }, permalink: { type: 'string' }, content: { type: 'string' }, ref: { type: 'string' }
    } } } } };
    const orch = async () => ({ finalResult: { posts }, steps: [{ stepId: 's1', stepName: 'extract', result: { done: true } }], pages: [] });
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: lenient });
    assert.equal(out.report.ok, true, 'non-required junk is surfaced, never blocking');
    const jv = out.report.detectors.junkValues;
    assert.ok(jv && jv.fields.some((f) => f.field === 'posts.ref' && f.kind === 'queryBlob'), 'advisory census entry present');
  });

  it('controlLabel junk in a required field still routes to JUNK_DOMINATED_FIELD (the two gates coexist)', async () => {
    const posts = [
      { postId: '1', permalink: 'https://example.com/p/1', content: 'one', comments: 'Leave a comment' },
      { postId: '2', permalink: 'https://example.com/p/2', content: 'two', comments: 'Leave a comment' }
    ];
    const withComments = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', required: ['postId', 'permalink', 'comments'], properties: {
      postId: { type: 'string' }, permalink: { type: 'string' }, content: { type: 'string' }, comments: { type: 'string' }
    } } } } };
    const orch = async () => ({ finalResult: { posts }, steps: [{ stepId: 's1', stepName: 'extract', result: { done: true } }], pages: [] });
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: withComments });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /JUNK_DOMINATED_FIELD: posts\.comments/, 'the 40th-log gate keeps the controlLabel lane');
    assert.doesNotMatch(out.report.error.message, /JUNK_VALUES_REQUIRED/, 'the new veto does not steal the controlLabel case');
  });
});

// Fortieth log: the container selector matched the same card at two DOM
// nesting levels (a :has() selector matches EVERY qualifying ancestor), so
// 4 records shipped for 2 posts — identical data fields, differing wrapper
// htmlSnippet — through a green verify (item count 4 scored as success).
describe('verify-runner duplicateEntities gate (fortieth log: 4 records = 2 posts shipped green)', () => {
  const SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', required: ['postId', 'content'], properties: {
    index: { type: 'integer' }, postId: { type: 'string' }, postTime: { type: 'string' }, content: { type: 'string' }, htmlSnippet: { type: 'string' }
  } } } } };

  it('nested double-match flips red with the nesting + dedup teaching', async () => {
    const posts = [
      { index: 1, postId: '1312691617719487', postTime: 'June 11', content: 'first post body', htmlSnippet: '<div class="outer">A</div>' },
      { index: 2, postId: '1312691617719487', postTime: 'June 11', content: 'first post body', htmlSnippet: '<div class="inner">A</div>' },
      { index: 3, postId: '10239314043541358', postTime: 'August 6', content: 'second post body', htmlSnippet: '<div class="outer">B</div>' },
      { index: 4, postId: '10239314043541358', postTime: 'August 6', content: 'second post body', htmlSnippet: '<div class="inner">B</div>' }
    ];
    const orch = async () => ({ finalResult: { posts }, steps: [{ stepId: 's1', stepName: 'extract', result: { done: true } }], pages: [] });
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA });
    assert.equal(out.report.ok, false, 'double-counted entities must not verify green');
    assert.match(out.report.error.message, /DUPLICATE_ENTITIES: posts/);
    assert.match(out.report.error.message, /2 of 4|4 records/, 'counts named');
    assert.match(out.report.error.message, /NESTED/i);
    assert.match(out.report.error.message, /:has\(\)/, 'names the ancestor-matching :has() hazard');
    assert.match(out.report.error.message, /dedup/i, 'assembly-dedup exit taught');
    assert.match(out.report.error.message, /probe\.count/, 'live cross-check taught');
    assert.ok(out.report.events.indexOf('DUPLICATE_ENTITIES') !== -1, 'tag rides report.events');
    assert.ok(out.report.detectors.duplicateEntities, 'detector block present');
  });

  it('distinct entities stay green (no false fire on real diversity)', async () => {
    const posts = [
      { index: 1, postId: 'a', postTime: 't1', content: 'x', htmlSnippet: '<div>1</div>' },
      { index: 2, postId: 'b', postTime: 't2', content: 'y', htmlSnippet: '<div>2</div>' },
      { index: 3, postId: 'c', postTime: 't3', content: 'z', htmlSnippet: '<div>3</div>' }
    ];
    const orch = async () => ({ finalResult: { posts }, steps: [], pages: [] });
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA });
    assert.equal(out.report.ok, true);
    assert.equal(out.report.detectors.duplicateEntities, null);
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

  it('typeless items (items:{properties} with no type tag) still census empties — nineteenth log', async () => {
    // 2026-09-04 production shape: outputSchema posts items declared
    // properties WITHOUT items.type:'object'. scoreAttemptResult read the
    // fields (avgFieldsPerItem 1/11) while the ratio detector gated on
    // items.type and returned [] — verify went GREEN at score 140 over 4
    // records whose every data field was empty (only a synthetic index
    // populated). The census must see the same fields the scorer sees.
    const schema = {
      type: 'object', required: ['posts'],
      properties: { posts: { type: 'array', items: { properties: {
        index: { type: 'number' }, postId: { type: 'string' }, time: { type: 'string' },
        content: { type: 'string' }, likes: { type: 'string' }
      } } } }
    };
    const posts = [
      { index: 1, postId: '', time: '', content: '', likes: '' },
      { index: 2, postId: '', time: '', content: '', likes: '' },
      { index: 3, postId: '', time: '', content: '', likes: '' },
      { index: 4, postId: '', time: '', content: '', likes: '' }
    ];
    const orch = async () => ({ finalResult: { posts }, steps: [{ stepId: 's1', stepName: 'one', result: { done: true }, snapshot: null }], pages: [], pagesTruncated: false });
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: schema });
    assert.equal(out.report.ok, true);
    const pe = out.report.detectors.partialEmptyFields;
    assert.ok(pe, 'detector block present for typeless items');
    const paths = pe.map(f => f.path).sort();
    assert.deepEqual(paths, ['posts.content', 'posts.likes', 'posts.postId', 'posts.time'],
      'every data field except the synthetic index censused; got: ' + JSON.stringify(paths));
    assert.ok(out.report.events.indexOf('PARTIAL_EMPTY_FIELDS') !== -1, 'tag rides report.events');
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

describe('verify-runner emptyFieldDiagnostics (thirty-first log: green verify, time 5/5 empty, labelledby falsification already in STEP_ITERATION events)', () => {
  const SCHEMA = {
    type: 'object', required: ['posts'],
    properties: { posts: { type: 'array', items: { type: 'object', properties: {
      content: { type: 'string' }, time: { type: 'string' }
    }, required: ['content'] } } }
  };
  const SERVICE2 = {
    targetUrl: 'https://example.com',
    steps: [
      {
        id: 'extract', name: 'extract posts', onSuccess: 'TERMINATE',
        script: "const t = await $labelledby('div[aria-labelledby]'); return $extractList('div.post', { time: { selector: 'abbr' }, content: { selector: 'span' } });"
      }
    ],
    config: {}
  };

  it('lifts the owning step\'s last-iteration falsification notes into detectors.emptyFieldDiagnostics beside the census', async () => {
    const posts = [
      { content: 'post one', time: '' },
      { content: 'post two', time: '' }
    ];
    const orch = async (svc, input, d, opts) => {
      // Earlier iteration: stale falsification that the final run outgrew
      // must NOT be lifted — only the LAST iteration's diagnostics count.
      opts.onEvent({
        type: 'STEP_ITERATION', stepId: 'extract', iteration: 1, resultPreview: 'x',
        selectorDiagnostics: [
          { api: 'labelledby', selector: 'div[aria-labelledby]', refCount: 0, missingIds: ['stale_id'], textLength: 0, note: 'references id(s) that resolve to nothing: stale_id' }
        ]
      });
      opts.onEvent({
        type: 'STEP_ITERATION', stepId: 'extract', iteration: 2, resultPreview: 'y',
        selectorDiagnostics: [
          {
            api: 'extractList', containerSelector: 'div.post', containerMatches: 2,
            perField: [{ field: 'time', subSelector: 'abbr', attr: null, matchCount: 0, sampleTexts: [], sampleHrefs: [], sampleValues: [] }]
          }
        ]
      });
      return {
        finalResult: { posts },
        steps: [{ stepId: 'extract', stepName: 'extract posts', result: { done: true }, snapshot: null }],
        pages: [], pagesTruncated: false
      };
    };
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE2, input: {}, outputSchema: SCHEMA });
    assert.equal(out.report.ok, true, 'report-only — never blocking');
    assert.ok(out.report.detectors.partialEmptyFields, 'census fired');
    const efd = out.report.detectors.emptyFieldDiagnostics;
    assert.ok(efd, 'diagnostics digest present');
    assert.equal(efd.length, 1);
    assert.equal(efd[0].field, 'time');
    assert.equal(efd[0].path, 'posts.time');
    assert.equal(efd[0].emptyCount, 2);
    const blob = JSON.stringify(efd[0].crumbs);
    assert.ok(/abbr/.test(blob), 'zero-match sub-selector named');
    assert.ok(/matched 0/.test(blob), 'matchCount-0 falsification phrased');
    assert.ok(/stale_id/.test(blob) === false, 'earlier-iteration notes are stale and dropped');
    // the serialized report alone lets the model see WHY time is empty
    assert.ok(JSON.stringify(out.report).indexOf('matched 0') !== -1);
  });

  it('healthy last-iteration diagnostics keep the digest null even when the census fires (emptiness lives downstream of extraction)', async () => {
    const posts = [
      { content: 'post one', time: '' },
      { content: 'post two', time: '' }
    ];
    const orch = async (svc, input, d, opts) => {
      opts.onEvent({
        type: 'STEP_ITERATION', stepId: 'extract', iteration: 1, resultPreview: 'y',
        selectorDiagnostics: [
          {
            api: 'extractList', containerSelector: 'div.post', containerMatches: 2,
            perField: [{ field: 'time', subSelector: 'abbr', attr: null, matchCount: 2, sampleTexts: ['2h', '5h'], sampleHrefs: [], sampleValues: ['2h', '5h'] }]
          }
        ]
      });
      return {
        finalResult: { posts },
        steps: [{ stepId: 'extract', stepName: 'extract posts', result: { done: true }, snapshot: null }],
        pages: [], pagesTruncated: false
      };
    };
    const { runner } = makeRunner(orch);
    const out = await runner({ service: SERVICE2, input: {}, outputSchema: SCHEMA });
    assert.ok(out.report.detectors.partialEmptyFields, 'census still names the empty field');
    assert.equal(out.report.detectors.emptyFieldDiagnostics, null, 'no falsification at the extraction layer — digest stays quiet instead of guessing');
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

// Twentieth log: the page-context resolveWU bag is a FIXED literal of
// wizard-utils function names. Three detectors (detectFieldMatchZero 13th
// log, detectContainerMatchZero 14th log, detectEmptyOutputFieldsByRatio
// 16th log) were wired at their call sites and exported from
// module.exports — so Node tests (which resolve via require) always saw
// them — but nobody extended the bag, so in the BROWSER every production
// verify silently skipped them (typeof guard) and PARTIAL_EMPTY_FIELDS /
// FIELD_MATCH_ZERO / INPUT_VALUE_SUSPECT tags were unreachable. A green
// v1 with time:"" in 100% of records verified with partialEmpty:[].
describe('twentieth log: page-context bag parity (RC35/B5 drift family)', () => {
  it('bag path resolves the three detectors — v1 scenario (time empty in every record) fires PARTIAL_EMPTY_FIELDS', async () => {
    const WUmod = require('../lib/wizard-utils');
    const pageWindow = {};
    for (const k of Object.keys(WUmod)) pageWindow[k] = WUmod[k]; // mirrors the wizard-utils self-export block (window.<fn> per function)
    const orch = async () => ({
      finalResult: { posts: [
        { index: 0, postId: 'a1', time: '', content: 'first post' },
        { index: 1, postId: 'a2', time: '', content: 'second post' }
      ] },
      steps: [{ stepId: 's1', stepName: 'one', result: { done: true } }], pages: []
    });
    const { runner } = makeRunner(orch, { wizardUtils: pageWindow });
    const out = await runner({
      service: SERVICE, input: {},
      outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', required: ['postId', 'time', 'content'], properties: { index: { type: 'number' }, postId: { type: 'string' }, time: { type: 'string' }, content: { type: 'string' } } } } } }
    });
    // Twenty-sixth log: `time` sits in items.required and is empty in 2/2
    // records — the REQUIRED_FIELD_EMPTY gate now flips the run red (the
    // old ok:true here was exactly the false green this log shipped with).
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /REQUIRED_FIELD_EMPTY: posts\.time/);
    assert.ok(out.report.detectors.partialEmptyFields, 'ratio detector ran via the page-context bag');
    assert.deepEqual(out.report.detectors.partialEmptyFields.map((f) => f.path), ['posts.time']);
    assert.ok(out.report.events.indexOf('PARTIAL_EMPTY_FIELDS') !== -1, 'tag reachable in browser context');
  });

  it('source-audit drift guard: every WU.<name> used in verify-runner is a key of the bag literal', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../lib/verify-runner.js'), 'utf8');
    const bagMatch = src.match(/const bag = \{([\s\S]*?)\};/);
    assert.ok(bagMatch, 'resolveWU bag literal found');
    const bagKeys = new Set(Array.from(bagMatch[1].matchAll(/(?:^|\n)\s*([A-Za-z_][A-Za-z0-9_]*):/g), (m) => m[1]));
    const mentions = new Set(Array.from(src.matchAll(/WU\.([A-Za-z_][A-Za-z0-9_]*)/g), (m) => m[1]));
    assert.ok(mentions.size >= 15, 'found the WU call sites');
    for (const name of mentions) {
      if (name === '__missing') continue;
      assert.ok(bagKeys.has(name), 'WU.' + name + ' is used by verify-runner but missing from the page-context bag literal — browser verifies silently skip it (twentieth log)');
    }
  });
});

describe('twenty-seventh log: ELEMENT_NOT_FOUND on a $wait-using step teaches the throw semantics', () => {
  // v3 burned a red verify + a broken-update turn on this: the model put
  // `$wait(cnt, 4000)` INSIDE a count-check poll loop — but $wait THROWS when
  // its selector never appears, and absence was the loop's whole waiting
  // condition (content not hydrated yet). The bare ELEMENT_NOT_FOUND message
  // carried no teaching, so the model guessed at href shapes instead.
  function serviceWith(script) {
    return { targetUrl: 'https://example.com', steps: [{ id: 's1', name: 'Poll', script, onSuccess: 'TERMINATE' }], config: {} };
  }
  function orchElemNotFound() {
    return async () => {
      const e = new Error("ELEMENT_NOT_FOUND: div[role='article']:has(a[href*='story.php'])");
      e.stepId = 's1';
      throw e;
    };
  }

  it('appends the $wait-as-poll-condition note when the failing step script uses $wait(', async () => {
    const { runner } = makeRunner(orchElemNotFound());
    const out = await runner({
      service: serviceWith("const n = await $count(cnt);\nif (n >= 5) return { done: true };\nawait $wait(cnt, 4000);\nreturn { done: false };"),
      input: {},
      outputSchema: { type: 'object' }
    });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /ELEMENT_NOT_FOUND/);
    assert.match(out.report.error.message, /\$wait\(sel\) THROWS/i);
    assert.match(out.report.error.message, /\{ done: false \}/);
    assert.match(out.report.error.message, /maxIterations/i);
  });

  it('no note when the step script has no $wait call (other ELEMENT_NOT_FOUND causes stay clean)', async () => {
    const { runner } = makeRunner(orchElemNotFound());
    const out = await runner({
      service: serviceWith("return $extract('div[role=\"article\"]');"),
      input: {},
      outputSchema: { type: 'object' }
    });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /ELEMENT_NOT_FOUND/);
    assert.doesNotMatch(out.report.error.message, /THROWS/i);
  });

  it('DSL guide teaches the $wait throw semantics at the $wait entry', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../lib/wizard-utils.js'), 'utf8');
    const line = src.split('\n').find((l) => l.indexOf('- $wait(selector, delayMs?)') !== -1);
    assert.ok(line, '$wait DSL entry found');
    assert.match(line, /THROWS/i, 'entry must state the throw-on-absent behavior');
    assert.match(line, /done: false/, 'entry must point at the poll-condition alternative');
  });
});

// Forty-first log: htmlSnippet fields (whole-card attr:'outerHTML') came back
// 82396-99278 chars each — result.json hit 332KB for 3 posts. The size census
// is REPORT-ONLY (a big field can be the confirmed contract's honest shape);
// it teaches tighter anchoring instead of blocking.
describe('OUTPUT_FIELD_SIZE — oversized output field census (forty-first log)', () => {
  it('oversized fields → report-only detector + OUTPUT_FIELD_SIZE tag, ok stays true', async () => {
    const big = 'x'.repeat(60000);
    const orch = async () => ({
      finalResult: { posts: [{ a: 1, html: big }, { a: 2, html: big }] },
      steps: [], pages: []
    });
    const { runner } = makeRunner(orch);
    const out = await runner({
      service: SERVICE, input: {},
      outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array' } } }
    });
    assert.equal(out.report.ok, true, 'advisory never blocks');
    const of = out.report.detectors.oversizedFields;
    assert.ok(Array.isArray(of) && of.length === 1, 'census surfaced on report.detectors');
    assert.equal(of[0].field, 'posts.html');
    assert.equal(of[0].count, 2);
    assert.equal(of[0].maxLen, 60000);
    assert.ok(out.report.events.indexOf('OUTPUT_FIELD_SIZE') !== -1, 'tag rides report.events');
  });

  it('normal-sized output → no detector, no tag', async () => {
    const orch = async () => ({
      finalResult: { posts: [{ a: 'small' }, { a: 'tiny' }] },
      steps: [], pages: []
    });
    const { runner } = makeRunner(orch);
    const out = await runner({
      service: SERVICE, input: {},
      outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array' } } }
    });
    assert.equal(out.report.ok, true);
    assert.equal(out.report.detectors.oversizedFields, null);
    assert.equal(out.report.events.indexOf('OUTPUT_FIELD_SIZE'), -1);
  });
});
