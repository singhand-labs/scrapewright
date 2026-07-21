const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
global.debugLogger = { log: () => {} };
const { StepOrchestrator } = require('../lib/step-orchestrator');
// In the Service Worker, url-template.js is loaded via importScripts and its
// top-level functions become globals. In Node tests, require() scopes them to
// the module, so attach them to global to mirror the runtime.
const urlTemplate = require('../lib/url-template');
global.UrlTemplate = urlTemplate;

function makeMockDeps(overrides = {}) {
  return {
    createTab: async (url) => ({ id: 1, url }),
    waitForTabLoad: async () => {},
    executeScript: async (tabId, script, input) => ({ script, input }),
    captureSnapshot: async () => ({ html: '<html></html>' }),
    removeTab: async () => {},
    evaluateCondition: async () => true,
    ...overrides
  };
}

describe('StepOrchestrator', () => {
  it('executes single step and terminates', async () => {
    const service = {
      targetUrl: 'http://example.com',
      steps: [
        { id: 'a', name: 'Step A', script: 'return 1;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
      ],
      config: {}
    };
    const deps = makeMockDeps();
    const result = await StepOrchestrator.execute(service, {}, deps);
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].stepId, 'a');
    assert.equal(result.finalResult.script, 'return 1;');
  });

  it('follows onSuccess to next step', async () => {
    const service = {
      targetUrl: 'http://example.com',
      steps: [
        { id: 'a', name: 'Step A', script: 'a', onSuccess: 'b', onFailure: 'TERMINATE' },
        { id: 'b', name: 'Step B', script: 'b', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
      ],
      config: {}
    };
    const deps = makeMockDeps();
    const result = await StepOrchestrator.execute(service, {}, deps);
    assert.equal(result.steps.length, 2);
    assert.equal(result.steps[0].stepId, 'a');
    assert.equal(result.steps[1].stepId, 'b');
    assert.equal(result.finalResult.script, 'b');
  });

  // ---- Model A: polling via maxIterations + not-ready signal (no SELF) ----

  it('retries a not-ready step until done, then follows onSuccess', async () => {
    // A poll step (maxIterations>1) returning {done:false} is re-invoked until it
    // returns a ready result, which then follows onSuccess to the next step.
    // This is the yuanbao "wait for AI answer" pattern, expressed without SELF.
    const results = [{ done: false }, { done: false }, { done: true }, { answer: 'final' }];
    let i = 0;
    const service = {
      targetUrl: 'http://example.com',
      steps: [
        { id: 'wait', name: 'Wait', script: 'x', onSuccess: 'extract', onFailure: 'TERMINATE', maxIterations: 10 },
        { id: 'extract', name: 'Extract', script: 'y', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
      ],
      config: {}
    };
    const deps = makeMockDeps({ executeScript: async () => results[i++] });
    const result = await StepOrchestrator.execute(service, {}, deps);
    assert.deepEqual(result.steps.map(s => s.stepId), ['wait', 'wait', 'wait', 'extract']);
    assert.deepEqual(result.finalResult, { answer: 'final' });
  });

  it('follows onFailure when a not-ready step exhausts maxIterations (no skip entry)', async () => {
    // Budget exhausted but onFailure points to a recovery step (not TERMINATE):
    // the recovery step runs and its result becomes finalResult. No synthetic
    // MAX_ITERATIONS skip entry is produced — the real not-ready result is
    // preserved for auto-fix to inspect.
    const service = {
      targetUrl: 'http://example.com',
      steps: [
        { id: 'poll', name: 'Poll', script: 'x', onSuccess: 'extract', onFailure: 'recover', maxIterations: 2 },
        { id: 'extract', name: 'Extract', script: 'y', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' },
        { id: 'recover', name: 'Recover', script: 'r', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
      ],
      config: {}
    };
    const deps = makeMockDeps({ executeScript: async (tabId, script) => script === 'r' ? { ok: true } : { done: false } });
    const result = await StepOrchestrator.execute(service, {}, deps);
    assert.deepEqual(result.steps.map(s => s.stepId), ['poll', 'poll', 'recover']);
    assert.ok(!result.steps.some(s => s.skipReason === 'MAX_ITERATIONS'), 'no MAX_ITERATIONS skip entry on budget exhaustion');
  });

  it('throws POLL_EXHAUSTED when a not-ready step exhausts and routes directly to TERMINATE', async () => {
    // Without this throw, finalResult would be the not-ready value {done:false},
    // which then fails outputSchema validation with a misleading "missing
    // required field" error. The throw surfaces the real cause: the step
    // exhausted without producing data.
    const service = {
      targetUrl: 'http://example.com',
      steps: [
        { id: 'poll', name: 'Poll', script: 'x', onSuccess: 'extract', onFailure: 'TERMINATE', maxIterations: 2 },
        { id: 'extract', name: 'Extract', script: 'y', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
      ],
      config: {}
    };
    const deps = makeMockDeps({ executeScript: async () => ({ done: false }) });
    await assert.rejects(
      () => StepOrchestrator.execute(service, {}, deps),
      (err) => err.code === 'POLL_EXHAUSTED' && err.stepId === 'poll' && err.message.includes('Poll') && err.message.includes('2')
    );
  });

  it('throws POLL_EXHAUSTED when the terminal step in a chain exhausts via not-ready signals', async () => {
    // Regression for the bc1.log case: step 2 exhausts → step 3 (terminal) also
    // exhausts via not-ready signals → TERMINATE. The throw must fire at step 3's
    // exhaustion, naming step 3, so the user sees the actual failing step.
    const service = {
      targetUrl: 'http://example.com',
      steps: [
        { id: 'collect', name: 'ScrollAndCollect', script: 'c', onSuccess: 'return', onFailure: 'return', maxIterations: 15 },
        { id: 'return', name: 'ReturnResults', script: 'r', onSuccess: 'TERMINATE', onFailure: 'TERMINATE', maxIterations: 3 }
      ],
      config: {}
    };
    const deps = makeMockDeps({ executeScript: async () => ({ done: false }) });
    await assert.rejects(
      () => StepOrchestrator.execute(service, {}, deps),
      (err) => err.code === 'POLL_EXHAUSTED' && err.stepId === 'return' && err.message.includes('ReturnResults')
    );
  });

  it('routes to onFailure when a step returns {failed:true}', async () => {
    // A failure signal bails to the failure branch without throwing — even on a
    // normal (maxIterations:1) step — so an expected failure can branch cleanly.
    const service = {
      targetUrl: 'http://example.com',
      steps: [
        { id: 'try', name: 'Try', script: 'x', onSuccess: 'win', onFailure: 'fallback', maxIterations: 1 },
        { id: 'win', name: 'Win', script: 'w', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' },
        { id: 'fallback', name: 'Fallback', script: 'f', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
      ],
      config: {}
    };
    const deps = makeMockDeps({ executeScript: async () => ({ failed: true }) });
    const result = await StepOrchestrator.execute(service, {}, deps);
    assert.deepEqual(result.steps.map(s => s.stepId), ['try', 'fallback']);
  });

  it('does not treat {error:null} or {error:""} as a failure signal', async () => {
    // Only a NON-EMPTY string error is a failure signal; null/empty are plain data
    // (prevents a step that legitimately returns {error:null} from mis-routing).
    const results = [{ error: null }, { error: '' }, { ok: true }];
    let i = 0;
    const service = {
      targetUrl: 'http://example.com',
      steps: [
        { id: 'a', name: 'A', script: 'x', onSuccess: 'b', onFailure: 'TERMINATE', maxIterations: 1 },
        { id: 'b', name: 'B', script: 'y', onSuccess: 'c', onFailure: 'TERMINATE', maxIterations: 1 },
        { id: 'c', name: 'C', script: 'z', onSuccess: 'TERMINATE', onFailure: 'TERMINATE', maxIterations: 1 }
      ],
      config: {}
    };
    const deps = makeMockDeps({ executeScript: async () => results[i++] });
    const result = await StepOrchestrator.execute(service, {}, deps);
    assert.deepEqual(result.steps.map(s => s.stepId), ['a', 'b', 'c'], 'null/empty error must not branch to onFailure');
  });

  it('treats {done:false} as data on a non-poll step (maxIterations:1) and follows onSuccess', async () => {
    // Data-collision regression: a normal extraction step whose data happens to
    // contain done:false must NOT be interpreted as a retry signal. Only
    // maxIterations>1 opts a step into polling semantics.
    const service = {
      targetUrl: 'http://example.com',
      steps: [
        { id: 'a', name: 'A', script: 'x', onSuccess: 'b', onFailure: 'TERMINATE', maxIterations: 1 },
        { id: 'b', name: 'B', script: 'y', onSuccess: 'TERMINATE', onFailure: 'TERMINATE', maxIterations: 1 }
      ],
      config: {}
    };
    const deps = makeMockDeps({ executeScript: async () => ({ done: false, items: [] }) });
    const result = await StepOrchestrator.execute(service, {}, deps);
    assert.deepEqual(result.steps.map(s => s.stepId), ['a', 'b'], '{done:false} as data must not loop a non-poll step');
  });

  it('auto-boosts maxIterations for a back-edge target so the loop is not prematurely capped', async () => {
    // 'a' is the back-edge target (b.onSuccess='a') with explicit maxIterations:1.
    // Without auto-boost, a would cap at 1 run and the loop would die. The
    // orchestrator raises back-edge targets to the global cap so loops run.
    let bCalls = 0;
    const service = {
      targetUrl: 'http://example.com',
      steps: [
        { id: 'a', name: 'A', script: 'a', onSuccess: 'b', onFailure: 'TERMINATE', maxIterations: 1 },
        { id: 'b', name: 'B', script: 'b', onSuccess: 'a', onFailure: 'TERMINATE', maxIterations: 50 }
      ],
      config: { maxStepIterations: 50 }
    };
    const deps = makeMockDeps({
      executeScript: async (tabId, script) => {
        if (script === 'b') { bCalls++; return bCalls >= 3 ? { failed: true } : { ok: true }; }
        return { ok: true };
      }
    });
    const result = await StepOrchestrator.execute(service, {}, deps);
    const aRuns = result.steps.filter(s => s.stepId === 'a').length;
    assert.ok(aRuns >= 3, 'back-edge target a should run multiple times (auto-boosted past maxIterations:1)');
    assert.ok(bCalls >= 3);
  });

  it('throws STEP_ITERATION_EXCEEDED when the global cap is hit during polling', async () => {
    const service = {
      targetUrl: 'http://example.com',
      steps: [
        { id: 'poll', name: 'Poll', script: 'x', onSuccess: 'extract', onFailure: 'TERMINATE', maxIterations: 100 },
        { id: 'extract', name: 'Extract', script: 'y', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
      ],
      config: { maxStepIterations: 5 }
    };
    const deps = makeMockDeps({ executeScript: async () => ({ done: false }) });
    await assert.rejects(
      async () => StepOrchestrator.execute(service, {}, deps),
      (err) => err.message === 'STEP_ITERATION_EXCEEDED'
    );
  });

  it('enriches error with stepId and accumulated step outputs when a retry throws', async () => {
    // Error enrichment is upstream of next-step logic; a poll step that throws on
    // its 2nd attempt must still attach stepId + the prior not-ready stepOutputs.
    let calls = 0;
    const service = {
      targetUrl: 'http://example.com',
      steps: [
        { id: 'poll', name: 'Poll', script: 'x', onSuccess: 'extract', onFailure: 'TERMINATE', maxIterations: 10 },
        { id: 'extract', name: 'Extract', script: 'y', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
      ],
      config: {}
    };
    const deps = makeMockDeps({
      executeScript: async () => {
        calls++;
        if (calls === 1) return { done: false };
        throw new Error('boom');
      }
    });
    await assert.rejects(
      async () => StepOrchestrator.execute(service, {}, deps),
      (err) => err.message === 'boom' && err.stepId === 'poll' && Array.isArray(err.steps) && err.steps.length === 1
    );
  });

  it('still produces a MAX_ITERATIONS skip when a back-edge re-enters a step beyond its cap', async () => {
    // The cap-skip backstop is preserved for back-edge structural re-entry
    // (distinct from a self-poll exhausting its budget, which routes to onFailure
    // directly without a skip entry). Here b is a back-edge target with an explicit
    // maxIterations:2 that is NOT auto-boosted (auto-boost only raises null/1).
    const service = {
      targetUrl: 'http://example.com',
      steps: [
        { id: 'a', name: 'A', script: 'a', onSuccess: 'b', onFailure: 'TERMINATE', maxIterations: 1 },
        { id: 'b', name: 'B', script: 'b', onSuccess: 'c', onFailure: 'TERMINATE', maxIterations: 2 },
        { id: 'c', name: 'C', script: 'c', onSuccess: 'b', onFailure: 'TERMINATE', maxIterations: 1 }
      ],
      config: { maxStepIterations: 50 }
    };
    const deps = makeMockDeps({ executeScript: async () => ({ ok: true }) });
    const result = await StepOrchestrator.execute(service, {}, deps);
    const skips = result.steps.filter(s => s.skipReason === 'MAX_ITERATIONS');
    assert.ok(skips.length >= 1, 'back-edge re-entry beyond maxIterations should produce a MAX_ITERATIONS skip');
    assert.equal(skips[0].stepId, 'b');
  });

  // ---- unchanged structural tests ----

  it('follows onFailure when condition is false', async () => {
    const service = {
      targetUrl: 'http://example.com',
      steps: [
        { id: 'check', name: 'Check', script: 's1', condition: 'false', onSuccess: 'good', onFailure: 'bad' },
        { id: 'good', name: 'Good', script: 'good-script', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' },
        { id: 'bad', name: 'Bad', script: 'bad-script', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
      ],
      config: {}
    };
    const deps = makeMockDeps({ evaluateCondition: async () => false });
    const result = await StepOrchestrator.execute(service, {}, deps);
    assert.equal(result.steps.length, 2);
    assert.strictEqual(result.steps[0].skipped, true);
    assert.strictEqual(result.steps[0].skipReason, 'CONDITION_FALSE');
    assert.equal(result.steps[1].stepId, 'bad');
    assert.equal(result.finalResult.script, 'bad-script');
  });

  it('enriches error with stepId on script failure', async () => {
    const service = {
      targetUrl: 'http://example.com',
      steps: [
        { id: 'fail', name: 'Fail', script: 'throw new Error("boom")', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
      ],
      config: {}
    };
    const deps = makeMockDeps({
      executeScript: async () => { throw new Error('boom'); }
    });
    await assert.rejects(
      async () => StepOrchestrator.execute(service, {}, deps),
      (err) => err.message === 'boom' && err.stepId === 'fail'
    );
  });

  it('throws STEP_NOT_FOUND for invalid step target', async () => {
    const service = {
      targetUrl: 'http://example.com',
      steps: [{ id: 'a', name: 'A', script: 'X', onSuccess: 'nonexistent', maxIterations: 1 }],
      config: { maxStepIterations: 50 }
    };
    const deps = makeMockDeps();
    await assert.rejects(
      async () => StepOrchestrator.execute(service, {}, deps),
      (err) => err.message === 'STEP_NOT_FOUND'
    );
  });

  it('defaults missing onFailure to TERMINATE', async () => {
    const service = {
      targetUrl: 'http://example.com',
      steps: [
        { id: 'check', name: 'Check', script: 'X', condition: 'false', onSuccess: 'a', maxIterations: 1 },
        { id: 'a', name: 'A', script: 'A', onSuccess: 'TERMINATE', maxIterations: 1 }
      ],
      config: { maxStepIterations: 50 }
    };
    const deps = makeMockDeps({ evaluateCondition: async () => false });
    const result = await StepOrchestrator.execute(service, {}, deps);
    assert.strictEqual(result.steps.length, 1);
    assert.strictEqual(result.steps[0].skipped, true);
  });

  it('passes timeoutMs to executeScript', async () => {
    let receivedTimeout;
    const deps = makeMockDeps({
      executeScript: async (tabId, script, input, timeoutMs) => {
        receivedTimeout = timeoutMs;
        return {};
      }
    });
    const service = {
      targetUrl: 'http://example.com',
      steps: [{ id: 'main', name: 'Main', script: 'X', onSuccess: 'TERMINATE', maxIterations: 1 }],
      config: { timeoutMs: 42000, maxStepIterations: 50 }
    };
    await StepOrchestrator.execute(service, {}, deps);
    assert.strictEqual(receivedTimeout, 42000);
  });

  // Regression for the "manually-added step never runs" bug. addStep() used to
  // just push to the array; the orchestrator follows onSuccess pointers, not
  // array position, so a new step appended after an auto-generated TERMINATE
  // was silent dead code. appendStepWithChainLink relinks prevLast.onSuccess
  // to the new step's id. This test builds the steps array the same way
  // wizard.js addStep() does, then proves every appended step is actually
  // reached during traversal.
  it('executes every step appended via appendStepWithChainLink', async () => {
    const { appendStepWithChainLink } = require('../lib/wizard-utils');
    const steps = [];
    appendStepWithChainLink(steps, { id: '1', name: 'A', script: 'return 1;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE', maxIterations: 1 });
    appendStepWithChainLink(steps, { id: '2', name: 'B', script: 'return 2;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE', maxIterations: 1 });
    appendStepWithChainLink(steps, { id: '3', name: 'C', script: 'return 3;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE', maxIterations: 1 });

    const service = { targetUrl: 'http://example.com', steps, config: {} };
    const executedScripts = [];
    const deps = makeMockDeps({
      executeScript: async (tabId, script) => { executedScripts.push(script); return script; }
    });
    const result = await StepOrchestrator.execute(service, {}, deps);

    assert.equal(result.steps.length, 3, 'all 3 appended steps should execute');
    assert.deepEqual(result.steps.map(s => s.stepId), ['1', '2', '3']);
    assert.deepEqual(executedScripts, ['return 1;', 'return 2;', 'return 3;']);
    assert.equal(steps[0].onSuccess, '2', 'appendStepWithChainLink relinked step 1 -> step 2');
    assert.equal(steps[1].onSuccess, '3', 'appendStepWithChainLink relinked step 2 -> step 3');
    assert.equal(steps[2].onSuccess, 'TERMINATE', 'final step remains the terminator');
  });

  it('resolves {{param}} placeholders in targetUrl before createTab', async () => {
    const service = {
      targetUrl: 'https://example.com/search?q={{keyword}}',
      steps: [
        { id: 'a', name: 'Step A', script: 'return 1;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
      ],
      config: {}
    };
    let openedUrl = null;
    const deps = makeMockDeps({
      createTab: async (url) => { openedUrl = url; return { id: 1, url }; }
    });
    await StepOrchestrator.execute(service, { keyword: 'shoes' }, deps);
    assert.equal(openedUrl, 'https://example.com/search?q=shoes');
  });

  it('throws MISSING_URL_PARAM when a templated param is absent from input', async () => {
    const service = {
      targetUrl: 'https://example.com/search?q={{keyword}}',
      steps: [
        { id: 'a', name: 'Step A', script: 'return 1;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
      ],
      config: {}
    };
    const deps = makeMockDeps();
    await assert.rejects(
      () => StepOrchestrator.execute(service, {}, deps),
      (err) => err.code === 'MISSING_URL_PARAM' && err.paramName === 'keyword'
    );
  });

  it('passes plain targetUrl through unchanged', async () => {
    const service = {
      targetUrl: 'https://example.com/search?q=shoes',
      steps: [
        { id: 'a', name: 'Step A', script: 'return 1;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
      ],
      config: {}
    };
    let openedUrl = null;
    const deps = makeMockDeps({
      createTab: async (url) => { openedUrl = url; return { id: 1, url }; }
    });
    await StepOrchestrator.execute(service, {}, deps);
    assert.equal(openedUrl, 'https://example.com/search?q=shoes');
  });
});

describe('StepOrchestrator onEvent callback', () => {
  function buildDeps(overrides = {}) {
    return {
      createTab: async () => ({ id: 1 }),
      waitForTabLoad: async () => {},
      waitForContentScript: async () => {},
      executeScript: overrides.executeScript || (async () => ({ done: true })),
      captureSnapshot: async () => ({}),
      evaluateCondition: async () => true,
      removeTab: async () => {},
      resetDomActivity: overrides.resetDomActivity || (async () => {}),
      getDomActivity: overrides.getDomActivity || (async () => []),
      ...overrides
    };
  }

  it('emits EXECUTION_START -> STEP_START -> STEP_ITERATION -> STEP_DONE -> EXECUTION_DONE for a single happy-path step', async () => {
    const service = {
      targetUrl: 'about:blank',
      steps: [{ id: 's1', name: 'one', script: 'return {done:true}', onSuccess: 'TERMINATE' }]
    };
    const events = [];
    await StepOrchestrator.execute(service, {}, buildDeps(), { onEvent: (e) => events.push(e) });
    const types = events.map(e => e.type);
    assert.deepEqual(types, ['EXECUTION_START', 'STEP_START', 'STEP_ITERATION', 'STEP_DONE', 'EXECUTION_DONE']);
    assert.equal(events[0].totalSteps, 1);
    assert.equal(events[1].stepId, 's1');
    assert.equal(events[2].iteration, 1);
    assert.ok(Array.isArray(events[2].domActivity));
  });

  it('omits STEP_ITERATION for a skipped (condition:false) step', async () => {
    const service = {
      targetUrl: 'about:blank',
      steps: [{ id: 's1', name: 'one', script: 'return 1', condition: 'false', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }]
    };
    const events = [];
    await StepOrchestrator.execute(service, {}, buildDeps({ evaluateCondition: async () => false }), { onEvent: (e) => events.push(e) });
    const types = events.map(e => e.type);
    assert.deepEqual(types, ['EXECUTION_START', 'STEP_START', 'STEP_DONE', 'EXECUTION_DONE']);
    assert.match(events[2].resultPreview, /skipped/i);
  });

  it('emits STEP_FAILED when a poll step exhausts to TERMINATE', async () => {
    const service = {
      targetUrl: 'about:blank',
      steps: [{ id: 's1', name: 'one', script: 'return {done:false}', onSuccess: 'TERMINATE', maxIterations: 2 }]
    };
    const events = [];
    await assert.rejects(
      () => StepOrchestrator.execute(service, {}, buildDeps({ executeScript: async () => ({ done: false }) }), { onEvent: (e) => events.push(e) }),
      /POLL_EXHAUSTED/
    );
    const types = events.map(e => e.type);
    assert.ok(types.includes('STEP_FAILED'));
    assert.equal(types[types.length - 1], 'EXECUTION_DONE');
  });

  it('swallows exceptions thrown by onEvent without breaking execution', async () => {
    const service = {
      targetUrl: 'about:blank',
      steps: [{ id: 's1', name: 'one', script: 'return {done:true}', onSuccess: 'TERMINATE' }]
    };
    let callCount = 0;
    const brokenCallback = (evt) => {
      callCount++;
      if (evt.type === 'STEP_ITERATION') throw new Error('UI explosion');
    };
    const result = await StepOrchestrator.execute(service, {}, buildDeps(), { onEvent: brokenCallback });
    assert.equal(callCount, 5);
    assert.ok(result.finalResult);
  });

  it('behaves identically when no options argument is passed (backward compat)', async () => {
    const service = {
      targetUrl: 'about:blank',
      steps: [{ id: 's1', name: 'one', script: 'return {done:true}', onSuccess: 'TERMINATE' }]
    };
    const result = await StepOrchestrator.execute(service, {}, buildDeps());
    assert.ok(result.finalResult);
    assert.equal(result.steps.length, 1);
  });

  it('produces STEP_ITERATION.domActivity === [] when deps.getDomActivity is missing', async () => {
    const service = {
      targetUrl: 'about:blank',
      steps: [{ id: 's1', name: 'one', script: 'return {done:true}', onSuccess: 'TERMINATE' }]
    };
    const events = [];
    const depsNoDom = buildDeps();
    delete depsNoDom.resetDomActivity;
    delete depsNoDom.getDomActivity;
    await StepOrchestrator.execute(service, {}, depsNoDom, { onEvent: (e) => events.push(e) });
    const iteration = events.find(e => e.type === 'STEP_ITERATION');
    assert.deepEqual(iteration.domActivity, []);
  });
});
