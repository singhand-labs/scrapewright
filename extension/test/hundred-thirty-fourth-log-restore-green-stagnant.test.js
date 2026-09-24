// extension/test/hundred-thirty-fourth-log-restore-green-stagnant.test.js
//
// 134th live log (build 133-zero-cert live; probe.timestamp exercised; the
// 132B gates all complied). The session reached a GREEN v11 (5 posts,
// disclosed relative postTime) - then STAGNANT_DISCLOSURES fired ON THE
// GREEN receipt (the census has no verdict gating; a green verify's stable
// disclosures are ACCEPTED limits, not a stuck loop), the model took the
// "fix" exit, v12 regressed (postTime 3/5 EMPTY, postId 5/5 EMPTY), and the
// budget died on the red artifact while the green v11 sat one version away
// with no cheap restore (its steps were compacted out of the transcript).
//
// (1) STAGNANT_DISCLOSURES is red-only now: a GREEN verify resets the
//     signature history (the loop ended; the disclosures are the accepted
//     ship) instead of teaching "re-verifying cannot fix them".
//
// (2) service.update {restoreVersion:N} restores a prior artifact version's
//     steps in ONE turn (the engine owns artifactVersions; the model cannot
//     reconstruct compacted steps). The finish/budget coercions name the
//     last GREEN version and the restore op whenever the last verify is red
//     and a green predecessor exists.
//
// No site tokens.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const { createResearchSession } = require('../lib/research-session');

function scriptedLlm(replies, calls = []) {
  let i = 0;
  return async (req) => {
    calls.push(req);
    const r = replies[Math.min(i, replies.length - 1)];
    i++;
    return r;
  };
}
function reply(content) {
  return { content, finish_reason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 10 } };
}
function envelope(tool, args) {
  return JSON.stringify({ think: 't', tool, args: args || {} });
}
function finishEnvelope(summary) { return JSON.stringify({ think: 'done', finish: { summary: summary || 'done' } }); }

const SCHEMAS = {
  inputSchema: { type: 'object', properties: { k: { type: 'string' } } },
  outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } }
};

function confirmArgs(extra) {
  return Object.assign({ testInput: { keyword: 'ml', count: 3 } }, SCHEMAS, extra || {});
}

describe('134th log — restoreVersion: one-turn restore of a prior artifact', () => {
  function makeTools(updateCalls) {
    const { createSessionTools } = require('../lib/session-tools');
    return createSessionTools({
      rail: { executeDsl: async () => ({}), pageState: async () => ({}), epoch: 0 },
      runVerify: async () => ({ events: [], report: { ok: true, detectors: {} }, raw: {} }),
      probeFactory: () => ({ snippet: async () => ({ result: 'ok' }), count: async () => ({ count: 1 }) }),
      getDraftService: () => null,
      applyArtifact: (a) => updateCalls.push(a),
      getTestInput: () => ({}),
      getOutputSchema: () => ({ type: 'object', properties: {} }),
      getSteps: () => [],
      ioConfirmBridge: { request: async (p) => ({ confirmed: true, testInput: p && p.testInput }) }
    }).tools;
  }

  it('engine restores v1 steps via {restoreVersion:1}; the restored update reaches the handler with the ORIGINAL script', async () => {
    const updateCalls = [];
    const tools = makeTools(updateCalls);
    const events = [];
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: scriptedLlm([
        reply(envelope('io.confirm', confirmArgs())),
        reply(envelope('service.update', { steps: [{ id: 's1', script: 'return {posts:[{a:1}]};', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }] })),
        reply(envelope('service.update', { steps: [{ id: 's1', script: 'return {posts:[]};', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }] })),
        reply(envelope('service.update', { restoreVersion: 1 })),
        reply(finishEnvelope('restored'))
      ]),
      tools,
      onEvent: (e) => events.push(e)
    });
    await session.run();
    const handlerCalls = updateCalls;
    assert.ok(handlerCalls.length >= 2, 'updates applied');
    const last = handlerCalls[handlerCalls.length - 1];
    assert.match(last.steps[0].script, /posts:\[\{a:1\}\]/, 'the RESTORED v1 script reached applyArtifact');
    const versions = events.filter((e) => e.type === 'artifact_version').map((e) => e.version);
    assert.ok(versions.length >= 3, 'restore bumps a new version — got ' + JSON.stringify(versions));
  });

  it('{restoreVersion} alone passes the steps-less engine allowlist (no "steps required" rejection)', async () => {
    const updateCalls = [];
    const tools = makeTools(updateCalls);
    const events = [];
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: scriptedLlm([
        reply(envelope('io.confirm', confirmArgs())),
        reply(envelope('service.update', { steps: [{ id: 's1', script: 'return 1;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }] })),
        reply(envelope('service.update', { restoreVersion: 1 })),
        reply(finishEnvelope('ok'))
      ]),
      tools,
      onEvent: (e) => events.push(e)
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    const tr = events.find((e) => e.type === 'tool_result' && e.tool === 'service.update' && /restoreVersion/.test(JSON.stringify(e)));
    assert.ok(tr, 'restore call dispatched');
    assert.ok(!/steps \(non-empty array\) required/.test(JSON.stringify(tr.result)), 'not the steps-less rejection');
  });

  it('restoring an UNKNOWN version errors with the available range', async () => {
    const updateCalls = [];
    const tools = makeTools(updateCalls);
    const events = [];
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: scriptedLlm([
        reply(envelope('io.confirm', confirmArgs())),
        reply(envelope('service.update', { steps: [{ id: 's1', script: 'return 1;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }] })),
        reply(envelope('service.update', { restoreVersion: 9 })),
        reply(finishEnvelope('ok'))
      ]),
      tools,
      onEvent: (e) => events.push(e)
    });
    await session.run();
    const tr = events.filter((e) => e.type === 'tool_result' && e.tool === 'service.update').pop();
    assert.match(String((tr && (tr.summary || JSON.stringify(tr.result))) || ''), /restoreVersion: 9 names no stored version \(versions 1\.\./i);
  });

  it('finish coercion names the LAST GREEN version + the one-turn restore when the last verify is red', async () => {
    const updateCalls = [];
    const tools = makeTools(updateCalls);
    // verify.run injected directly: green on v1, red on v2
    let verifyCount = 0;
    tools['verify.run'] = async () => {
      verifyCount += 1;
      if (verifyCount === 1) {
        return { ok: true, score: 10, detectors: {}, executedArtifactVersion: 1, finalResult: { posts: [{ a: 1 }] } };
      }
      return { ok: false, score: 5, detectors: { partialEmptyFields: [{ field: 'postTime', path: 'posts.postTime', emptyCount: 3, totalCount: 3 }] }, executedArtifactVersion: 2, error: { message: 'REQUIRED_FIELD_EMPTY: posts.postTime' } };
    };
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: scriptedLlm([
        reply(envelope('io.confirm', confirmArgs())),
        reply(envelope('service.update', { steps: [{ id: 's1', script: 'return 1;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }] })),
        reply(envelope('verify.run', {})),
        reply(envelope('service.update', { steps: [{ id: 's1', script: 'return 2;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }] })),
        reply(envelope('verify.run', {})),
        reply(finishEnvelope('shipped'))
      ]),
      tools,
      onEvent: () => {}
    });
    const report = await session.run();
    const d = String(report.stopped.detail);
    assert.match(d, /LAST VERIFY FAILED/);
    assert.match(d, /LAST GREEN = v1/i, 'names the green predecessor');
    assert.match(d, /restoreVersion:\s*1/, 'names the one-turn restore');
  });
});

describe('134th log — STAGNANT_DISCLOSURES is red-only (a green breaks the loop)', () => {
  const { createSessionTools } = require('../lib/session-tools');

  function makeTools(reportFactory) {
    let n = 0;
    return createSessionTools({
      rail: { executeDsl: async () => ({}), pageState: async () => ({}), epoch: 0 },
      runVerify: async () => { n += 1; return reportFactory(n); },
      probeFactory: () => ({ snippet: async () => ({ result: 'ok' }), count: async () => ({ count: 1 }) }),
      getDraftService: () => ({ targetUrl: 'https://example.com', config: {}, steps: [{ id: 's1', script: 'return 1;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }] }),
      applyArtifact: async () => ({}),
      getTestInput: () => ({}),
      getOutputSchema: () => ({ type: 'object', properties: {} }),
      getSteps: () => [],
      ioConfirmBridge: { request: async (p) => ({ confirmed: true, testInput: p && p.testInput }) }
    }).tools;
  }
  const SAME_DISCLOSURES = (ok) => ({
    report: {
      ok, error: null, aborted: false, score: { score: 100, isData: true, breakdown: {} }, schemaOk: true, schemaMissing: [],
      detectors: {
        emptyFields: [], duplicateFields: [], countShortfall: null,
        partialEmptyFields: [{ field: 'location', path: 'posts.location', emptyCount: 3, totalCount: 3 }]
      },
      steps: [], finalResult: { posts: [{}] }, pages: '1', eventCount: 1, events: []
    },
    events: [], raw: {}
  });

  it('red, red, red with shared entries → fires (the 52nd contract stands)', async () => {
    const tools = makeTools(() => SAME_DISCLOSURES(false));
    await tools['io.confirm'](confirmArgs());
    const r1 = await tools['verify.run']({}, { session: {} });
    const r2 = await tools['verify.run']({}, { session: {} });
    const r3 = await tools['verify.run']({}, { session: {} });
    assert.ok(!r1.stagnationNote && !r2.stagnationNote, 'first two carry no note');
    assert.match(String(r3.stagnationNote || ''), /STAGNANT_DISCLOSURES/);
  });

  it('red, red, GREEN with the same entries → NO note on the green; the history resets', async () => {
    const tools = makeTools((n) => SAME_DISCLOSURES(n > 2));
    await tools['io.confirm'](confirmArgs());
    await tools['verify.run']({}, { session: {} });
    await tools['verify.run']({}, { session: {} });
    const r3 = await tools['verify.run']({}, { session: {} });
    assert.ok(!r3.stagnationNote, 'a green verify never gets the stuck-loop teaching — got ' + String(r3.stagnationNote).slice(0, 120));
    // after the green reset, one more red sharing entries does NOT re-fire (needs 3 fresh)
    const r4 = await tools['verify.run']({}, { session: {}} );
    assert.ok(!r4.stagnationNote, 'history was reset by the green — a single fresh red cannot fire');
  });
});
