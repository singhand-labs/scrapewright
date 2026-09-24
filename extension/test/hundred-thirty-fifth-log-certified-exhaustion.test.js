// extension/test/hundred-thirty-fifth-log-certified-exhaustion.test.js
//
// 135th live log: the best delivery yet — postTime FULL absolutes 4/4 (the
// long-standing #1 ask), hovercards with roles, green v5 — but the count
// shortfall (4/6) shipped under a "feed exhausted" claim produced by a
// HAND-ROLLED scroll step that returned {done:true, exhausted:true} after a
// SINGLE iteration on the cold verify tab. Third session in a row where a
// hand-rolled scroll step produced the shortfall (133: frozen at 4/20 on a
// diverged selector; 134: loadPosts; 135: scrollcheck exhausted-in-1).
// $collectUntil's certification needs the scroll machinery to stall AND the
// unique count unchanged for two consecutive rounds - one settled round
// without growth proves nothing on a cold tab.
//
// The countShortfall census now mechanically distinguishes a CERTIFIED
// exhaustion receipt (a $collectUntil exhaustion.certified marker in the
// run's own step previews) from a hand-rolled exhausted flag: the note and
// the finish coercion name the difference, so "supply limit" claims are
// falsifiable instead of free.
//
// No site tokens.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const { createVerifyRunner } = require('../lib/verify-runner');

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
const SCHEMA = {
  type: 'object', required: ['posts'],
  properties: { posts: { type: 'array', items: { type: 'object' } } }
};

function shortfallEvents(preview) {
  return [
    { type: 'STEP_ITERATION', stepId: 's1', resultPreview: '{"done":true,"cards":4}',
      selectorDiagnostics: [{ api: 'extractWithHover', containerSelector: 'div.card', containerMatches: 4 }] },
    { type: 'STEP_ITERATION', stepId: 's2', resultPreview: preview, selectorDiagnostics: [] }
  ];
}

describe('135th log — countShortfall distinguishes certified vs hand-rolled exhaustion', () => {
  const FINAL = { posts: [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }] };
  const INPUT = { count: 6 };

  it('a hand-rolled exhausted flag → note names NOT-certified + the falsifiable bar', async () => {
    const runner = makeRunner(orchWithEvents(FINAL, shortfallEvents('{"done":true,"exhausted":true}')));
    const out = await runner({ service: SERVICE, input: INPUT, outputSchema: SCHEMA });
    const cs = out.report.detectors.countShortfall;
    assert.ok(cs, 'shortfall detected');
    assert.equal(cs.extracted, 4);
    assert.equal(cs.exhaustionCertified, false, 'no certified receipt in the run');
    assert.match(String(cs.note), /NOT certified/i);
    assert.match(String(cs.note), /exhaustion\.certified|\$collectUntil/, 'names the certification bar');
    assert.match(String(cs.note), /one settled round without growth proves nothing|cold tab/i);
  });

  it('a $collectUntil certified receipt in the run → the certified ship-disclosed exit stands', async () => {
    const runner = makeRunner(orchWithEvents(FINAL, shortfallEvents(
      '{"satisfied":false,"collected":4,"targetCount":6,"rounds":5,"exhaustion":{"certified":true,"evidence":"scroll stalled; unique unchanged 2 rounds"}}'
    )));
    const out = await runner({ service: SERVICE, input: INPUT, outputSchema: SCHEMA });
    const cs = out.report.detectors.countShortfall;
    assert.equal(cs.exhaustionCertified, true);
    assert.doesNotMatch(String(cs.note || ''), /NOT certified/i, 'a certified verdict is a page-supply fact');
  });

  it('no exhaustion claim at all → still flagged uncertified (the claim is absent, not proven)', async () => {
    const runner = makeRunner(orchWithEvents(FINAL, shortfallEvents('{"done":true}')));
    const out = await runner({ service: SERVICE, input: INPUT, outputSchema: SCHEMA });
    assert.equal(out.report.detectors.countShortfall.exhaustionCertified, false);
  });
});

describe('135th log — finish coercion carries the certification state', () => {
  const { createResearchSession } = require('../lib/research-session');
  function scriptedLlm(replies) {
    let i = 0;
    return async () => replies[Math.min(i++, replies.length - 1)];
  }
  function reply(content) {
    return { content, finish_reason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 10 } };
  }
  function envelope(tool, args) { return JSON.stringify({ think: 't', tool, args: args || {} }); }
  function finishEnvelope(summary) { return JSON.stringify({ think: 'done', finish: { summary: summary || 'done' } }); }

  it('a shortfall with UNcertified exhaustion names the unproven claim in the stop detail', async () => {
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: scriptedLlm([
        reply(envelope('verify.run', {})),
        reply(finishEnvelope('feed exhausted, shipped 4'))
      ]),
      tools: {
        'verify.run': async () => ({
          ok: true, score: 100, detectors: {
            countShortfall: { field: 'posts', requested: 6, extracted: 4, ratio: 0.67, severe: false, exhaustionCertified: false }
          }, executedArtifactVersion: 1, finalResult: { posts: [{ a: 1 }] }
        })
      },
      onEvent: () => {}
    });
    const report = await session.run();
    const d = String(report.stopped.detail);
    assert.match(d, /COUNT-SHORTFALL/);
    assert.match(d, /NOT certified/i, 'the exhaustion claim is named unproven');
  });

  it('a CERTIFIED shortfall keeps the honest ship-disclosed phrasing without the unproven marker', async () => {
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: scriptedLlm([
        reply(envelope('verify.run', {})),
        reply(finishEnvelope('certified exhaustion, shipped 4'))
      ]),
      tools: {
        'verify.run': async () => ({
          ok: true, score: 100, detectors: {
            countShortfall: { field: 'posts', requested: 6, extracted: 4, ratio: 0.67, severe: false, exhaustionCertified: true }
          }, executedArtifactVersion: 1, finalResult: { posts: [{ a: 1 }] }
        })
      },
      onEvent: () => {}
    });
    const report = await session.run();
    const d = String(report.stopped.detail);
    assert.match(d, /COUNT-SHORTFALL/);
    assert.doesNotMatch(d, /NOT certified/i);
  });
});
