// extension/test/fifty-sixth-log-followups.test.js
// Fifty-sixth log — glm-5.1, 59 turns, completed with "[LAST VERIFY FAILED —
// shipped best-effort]": the final TWO verify attempts both died on
// "Failed to create tab (10s timeout)" — Chrome tab creation stalled twice
// in a row (transient browser load), and a possibly-green v6 artifact
// shipped behind a failed-verify verdict. The session's recurring capability
// wall: postTime — v6 composes labelledby + hover-fallback + regex, and the
// finish honestly admits "full absolute timestamps were only sometimes
// reachable" — the SAME wall as logs 15/24/28/31/52/55. Per the user's
// directive (model-capability problems deserve new tools/loops/knowledge,
// not more prompt-preaching), three fixes:
//  F1 tab-create RETRY — one fresh 10s window on a stalled create.
//  F2 probe.timestamp — ONE composite research call: candidate anchors →
//     hover → labelledby/aria/text harvest → date-shape filtering (the
//     exact dance the models keep re-discovering at 5-10 turns a session).
//  F3 STAGNANT_DISCLOSURES must not fire on an ALL-EMPTY signature — the
//     56th log tagged stagnation across a red→green boundary where every
//     signature was empty (nothing to disclose = nothing stagnant).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionTools } = require('../lib/session-tools');
const { createProbeTools } = require('../lib/probe-tools');
const { createObservationLog } = require('../lib/observation-log');
const WU = require('../lib/wizard-utils');

// ---------------------------------------------------------------------------
// F1: tab-create retry in the verify rail
describe('F1: verify tab-create retry (fifty-sixth log)', () => {
  const { createVerifyRunner } = require('../lib/verify-runner');

  function runnerWithCreateAttempts(attempts, eventsToEmit) {
    let calls = 0;
    const deps = {
      orchestrate: async (service, input, orchDeps, options) => {
        for (const e of (eventsToEmit || [])) options.onEvent(e);
        // The real orchestrator creates the tab through the runner's
        // wrapped orchDeps.createTab — exercise exactly that path.
        const t = await orchDeps.createTab(service.targetUrl);
        await orchDeps.waitForTabLoad(t.id);
        return {
          finalResult: { posts: [{ postId: '1', content: 'a' }] },
          steps: [{ stepId: 'extract', stepName: 'extract', result: { done: true } }],
          pages: []
        };
      },
      ensureLock: async () => {},
      getSignal: () => null,
      log: () => {},
      onEvent: () => {},
      // The createTab dep stalls past any sane timeout on the FIRST call,
      // succeeds on the second (the transient-stall shape).
      createTab: async (url) => {
        calls += 1;
        if (calls <= attempts.stallCount) {
          await new Promise((res) => setTimeout(res, 30000));
          return { id: 99, url };
        }
        return { id: 42, url };
      },
      removeTab: async () => {},
      waitForTabLoad: async () => {},
      sendMessage: async () => ({ pong: true }),
      executeScript: async () => ({ result: 'ok', selectorDiagnostics: [] }),
      captureSnapshot: async () => ({ html: '<html></html>' }),
      evaluateCondition: async () => true
    };
    return { runner: createVerifyRunner(deps), getCalls: () => calls };
  }

  const SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', required: ['postId'], properties: {
    postId: { type: 'string' }, content: { type: 'string' }
  } } } } };
  const SERVICE = { targetUrl: 'https://example.com', steps: [
    { id: 'extract', name: 'extract', script: 'return 1', onSuccess: 'TERMINATE' }
  ], config: {} };

  it('a stalled first create is retried once and the verify proceeds green', async () => {
    const { runner, getCalls } = runnerWithCreateAttempts({ stallCount: 1 });
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA });
    assert.equal(out.report.ok, true, 'the retry saved the run');
    assert.equal(getCalls(), 2, 'exactly two create attempts');
  }, 45000);

  it('a double stall still fails honestly (bounded retry)', async () => {
    const { runner, getCalls } = runnerWithCreateAttempts({ stallCount: 2 });
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA });
    assert.equal(out.report.ok, false);
    assert.match(String((out.report.error && out.report.error.message) || ''), /Failed to create tab/);
    assert.equal(getCalls(), 2, 'no third attempt');
  }, 45000);
});

// ---------------------------------------------------------------------------
// F2: probe.timestamp composite
describe('F2: probe.timestamp (fifty-sixth log capability add)', () => {
  function makeTools(snippetCapture, impl) {
    const observationLog = createObservationLog();
    const tools = createProbeTools({ executeDsl: async (snippet) => {
      if (snippetCapture) snippetCapture(snippet);
      return impl(snippet);
    }, observationLog });
    return { tools, observationLog };
  }

  it('returns date-shaped candidates with sources, preferring an ABSOLUTE value, from one extractWithHover composition', async () => {
    const snippets = [];
    const { tools } = makeTools((s) => snippets.push(s), async (snippet) => {
      assert.ok(snippet.includes('$extractWithHover'), 'composed over the atomic primitive');
      return [{
        __t_label: '2 hours ago',
        __t_aria: '',
        __t_text: '2 hours ago',
        hovercards: [
          { labelledbyText: 'August 23 at 5:30 PM', anchorText: 'Aug 23' },
          { labelledbyText: '', anchorText: 'photo' }
        ]
      }];
    });
    const r = await tools.timestamp({ containerSel: 'div.card', index: 0 });
    assert.ok(!r.error, 'no error: ' + JSON.stringify(r));
    assert.equal(r.absolute, 'August 23 at 5:30 PM', 'the hover-labelledby absolute wins over the relative text');
    assert.equal(r.relative, '2 hours ago');
    assert.ok(Array.isArray(r.candidates) && r.candidates.length >= 2, 'carries all date-shaped candidates');
    const sources = r.candidates.map((c) => c.source);
    assert.ok(sources.includes('hover.labelledbyText'));
    assert.ok(sources.includes('labelledby') || sources.includes('text'));
    assert.ok(snippets[0].includes('div.card'), 'container scoped');
    assert.equal(tools.observationLog ? undefined : undefined, undefined);
  });

  it('no date-shaped value anywhere → honest note, empty absolute (the fifty-sixth-log wall made visible in ONE call)', async () => {
    // hovercards carries a (failed) entry so the anchors EXISTED — a zero-
    // anchor run is the 85th log's VACUOUS-negative lane, not this one.
    const { tools } = makeTools(null, async () => [{
      __t_label: 'Learn More',
      __t_aria: '',
      __t_text: 'See more',
      hovercards: [{ hovered: false, htmlSnippet: null, labelledbyText: 'Learn More' }]
    }]);
    const r = await tools.timestamp({ containerSel: 'div.card' });
    assert.equal(r.absolute, null);
    assert.equal(r.relative, null);
    assert.match(r.note, /no date-shaped/i);
    assert.match(r.note, /renegotiat|hover|timestamp/i, 'note teaches the exits');
  });

  it('missing containerSel → teaching error', async () => {
    const { tools } = makeTools(null, async () => ({}));
    const r = await tools.timestamp({});
    assert.match(r.error, /containerSel/);
  });

  it('runs the observation receipt (grounding: the container selector is claimed)', async () => {
    const { tools, observationLog } = makeTools(null, async () => [{ __t_label: 'June 25', __t_aria: '', __t_text: 'June 25', hovercards: [] }]);
    await tools.timestamp({ containerSel: 'div.card' });
    assert.equal(observationLog.size(), 1);
    assert.deepEqual(observationLog.serialize().entries[0].selectors, ['div.card']);
  });

  it('session tool bag exposes the spec + system prompt mentions it', async () => {
    const deps = {
      rail: {
        pageOpen: async () => ({ tabId: 1, url: 'https://example.com', ready: true }),
        pageState: async () => ({ open: true, tabId: 1, url: 'https://example.com' }),
        executeDsl: async () => ({}),
        ensureLock: async () => {}, releaseLock: async () => {}, dispose: async () => {}, tabId: 1
      },
      runVerify: async () => ({ report: { ok: true, error: null, aborted: false, score: { score: 1, isData: true, breakdown: {} }, schemaOk: true, schemaMissing: [], detectors: { emptyFields: [], duplicateFields: [], countShortfall: null }, steps: [], finalResult: {}, pages: '1', eventCount: 1, events: [] }, events: [], raw: {} }),
      getDraftService: () => null, applyArtifact: () => {}, getTestInput: () => null,
      getOutputSchema: () => null, getSteps: () => [],
      annotationBridge: null, ioConfirmBridge: { request: async () => ({ confirmed: true }) }
    };
    const t = createSessionTools(deps);
    assert.equal(typeof t.tools['probe.timestamp'], 'function', 'wired into the bag');
    const spec = t.toolSpecs.find((s) => s.name === 'probe.timestamp');
    assert.ok(spec, 'spec present');
    assert.match(spec.returns, /absolute/i);
    assert.match(t.systemPromptBase, /probe\.timestamp/, 'methodology names it (the first move when postTime comes back relative)');
  });

  it('WU exports the date-shape predicate the probe reuses', () => {
    assert.equal(typeof WU.looksLikeDate, 'function', 'looksLikeDate exported');
    assert.ok(WU.looksLikeDate('August 23 at 5:30 PM'));
    assert.ok(WU.looksLikeDate('2026年6月25日'));
    assert.ok(WU.looksLikeDate('2 hours ago'));
    assert.ok(!WU.looksLikeDate('Learn More'));
    assert.ok(!WU.looksLikeDate('m.meCatMachine Learning Explained'));
  });
});

// ---------------------------------------------------------------------------
// F3: stagnation must not fire on an all-empty signature
describe('F3: STAGNANT_DISCLOSURES empty-signature guard (fifty-sixth log)', () => {
  function makeSessionDeps() {
    const deps = {
      rail: {
        pageOpen: async () => ({ tabId: 1, url: 'https://example.com', ready: true }),
        pageState: async () => ({ open: true, tabId: 1, url: 'https://example.com' }),
        executeDsl: async () => ({}),
        ensureLock: async () => {}, releaseLock: async () => {}, dispose: async () => {}, tabId: 1
      },
      runVerify: async () => ({
        report: { ok: false, error: { message: 'POLL_EXHAUSTED: ...' }, aborted: false, score: { score: 0, isData: false, breakdown: {} }, schemaOk: true, schemaMissing: [],
          detectors: { emptyFields: [], duplicateFields: [], countShortfall: null, partialEmptyFields: [], junkValues: null, relativeTimestamps: [] },
          steps: [], finalResult: null, pages: '0', eventCount: 1, events: [] },
        events: [], raw: {}
      }),
      getDraftService: () => ({ name: 's', steps: [{ id: 'x', script: 'return 1', onSuccess: 'TERMINATE' }] }),
      getOutputSchema: () => null, getTestInput: () => ({}),
      getSteps: () => [{ id: 'x', script: 'return 1', onSuccess: 'TERMINATE' }],
      applyArtifact: () => {},
      annotationBridge: null, ioConfirmBridge: { request: async () => ({ confirmed: true }) }
    };
    return deps;
  }

  it('three consecutive verifies with NOTHING to disclose do not tag stagnation (the red→green boundary shape)', async () => {
    const deps = makeSessionDeps();
    const t = createSessionTools(deps);
    await t.tools['verify.run']({});
    await t.tools['verify.run']({});
    const r3 = await t.tools['verify.run']({});
    assert.ok(!r3.stagnationNote, 'an all-empty signature is not stagnation — the error CLASS changed between runs here');
    assert.ok(!(r3.events || []).includes('STAGNANT_DISCLOSURES'));
  });

  it('a NON-EMPTY identical signature across three verifies still fires (regression, fifty-second log)', async () => {
    const deps = makeSessionDeps();
    const t = createSessionTools(deps);
    const withEmpties = () => ({
      report: { ok: true, error: null, aborted: false, score: { score: 100, isData: true, breakdown: {} }, schemaOk: true, schemaMissing: [],
        detectors: { emptyFields: [], duplicateFields: [], countShortfall: null,
          partialEmptyFields: [{ field: 'location', path: 'posts.location', emptyCount: 5, totalCount: 5 }] },
        steps: [], finalResult: { posts: [{}] }, pages: '1', eventCount: 1, events: [] },
      events: [], raw: {}
    });
    deps.runVerify = withEmpties;
    await t.tools['verify.run']({});
    await t.tools['verify.run']({});
    const r3 = await t.tools['verify.run']({});
    assert.ok(r3.stagnationNote, 'identical real disclosures still stagnate');
  });
});
