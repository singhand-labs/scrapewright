// extension/test/hundred-thirty-first-log-chunk-protocol.test.js
//
// 131st live log (FB keyword-search service, second 80-turn session on the
// same URL; v11 shipped best-effort with postId/comments/shares empty).
// The round-130 fixes are validated in production by this very log (s1
// carries the settle the pacing teaching prescribes; the
// timeAbsoluteCapturedUnbound advisory fired verbatim). The NEW defects are
// all in the chunked service.update protocol's edge paths:
//
// (1) {abortChunk:true} ALONE died at the engine wrapper with "steps
//     (non-empty array) required" — the twentieth-log steps-less allowlist
//     predates the 125th-round chunking (two-layer validation drift).
// (2) {steps, abortChunk:true} silently DISCARDED the steps (the model had
//     to resend chunk 1 next turn), AND the engine pushed a PHANTOM
//     artifact version v8 for the aborted call (the fourth-log
//     phantom-artifact class resurfacing through the abort branch).
// (3) A final chunk landing on an EMPTY buffer silently applied a
//     suffix/prefix-only artifact — the session's lineage shows v5 (1
//     steps: s2) and v6 (1 steps: s1) — REPLACES semantics with zero
//     disclosure.
// (4) Every post-verify re-author of a 2-step artifact cost TWO turns
//     (chunk s1 + chunk s2) because REPLACES has no single-step merge; the
//     endgame burned 5 such cycles.
//
// Also pins that assembled/patched arrays mutate the args IN PLACE so the
// engine's lineage records the APPLIED artifact, not the raw last chunk.
//
// No site tokens.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

function envelope(tool, args, extraJson) {
  return JSON.stringify(Object.assign({ think: 't', tool, args: args || {} }, extraJson || {}));
}
function finishEnvelope(summary) { return JSON.stringify({ think: 'done', finish: { summary: summary || 'done' } }); }
function reply(content) {
  return { content, finish_reason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 10 } };
}
function scriptedLlm(replies, calls) {
  let i = 0;
  return async (req) => {
    calls.push(req);
    const r = replies[Math.min(i, replies.length - 1)];
    i++;
    return r;
  };
}

// ---------------------------------------------------------------------------
describe('131st log — engine wrapper: abortChunk is buffer management, not an artifact change', () => {
  const { createResearchSession } = require('../lib/research-session');

  it('{abortChunk:true} alone reaches the handler instead of "steps (non-empty array) required"', async () => {
    const calls = [];
    const events = [];
    const seen = [];
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: scriptedLlm([
        reply(envelope('service.update', { abortChunk: true })),
        reply(finishEnvelope('aborted'))
      ], calls),
      tools: { 'service.update': async (args) => { seen.push(args); return { aborted: true, note: 'pending update chunks cleared' }; } },
      onEvent: (e) => events.push(e)
    });
    await session.run();
    assert.equal(seen.length, 1, 'handler received the abort call');
    assert.equal(seen[0] && seen[0].abortChunk, true);
    const tr = events.find((e) => e.type === 'tool_result' && e.tool === 'service.update');
    assert.ok(tr && tr.ok === true, 'the abort call resolved ok — got ' + JSON.stringify(tr && tr.result));
    assert.ok(!/steps \(non-empty array\) required/.test(JSON.stringify(tr && tr.result)), 'not the steps-required rejection');
  });

  it('{steps, abortChunk:true} bypasses grounding + the phantom version push (no artifact_version event)', async () => {
    const calls = [];
    const events = [];
    const seen = [];
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: scriptedLlm([
        reply(envelope('service.update', { steps: [{ id: 's1', script: 'await $count("div.zz-ungrounded")', onSuccess: 'TERMINATE' }], abortChunk: true })),
        reply(finishEnvelope('aborted'))
      ], calls),
      tools: { 'service.update': async (args) => { seen.push(args); return { aborted: true, note: 'pending update chunks cleared' }; } },
      onEvent: (e) => events.push(e)
    });
    await session.run();
    assert.equal(seen.length, 1, 'handler received the call');
    const tr = events.find((e) => e.type === 'tool_result' && e.tool === 'service.update');
    assert.ok(tr && tr.ok === true, 'aborted cleanly, no grounding rejection — got ' + JSON.stringify(tr && tr.result));
    assert.equal(events.filter((e) => e.type === 'artifact_version').length, 0, 'an aborted call announces NO artifact version (131st log: phantom v8)');
  });
});

// ---------------------------------------------------------------------------
describe('131st log — session-tools: abort semantics, replacement disclosure, patch mode', () => {
  const { createSessionTools } = require('../lib/session-tools');

  function makeDeps(opts) {
    const applied = [];
    const draft = () => (opts && opts.draft) || null;
    const deps = {
      rail: { executeDsl: async () => ({}), pageState: async () => ({}), epoch: 0 },
      runVerify: async () => ({ events: [], report: { ok: true, detectors: {} }, raw: {} }),
      probeFactory: () => ({ snippet: async () => ({ result: 'ok' }), count: async () => ({ count: 1 }) }),
      getDraftService: draft,
      applyArtifact: (a) => applied.push(a),
      getTestInput: () => ({}),
      getOutputSchema: () => ({ type: 'object', properties: {} }),
      getSteps: () => [],
      ioConfirmBridge: { request: async (p) => ({ confirmed: true, inputSchema: p && p.inputSchema, outputSchema: p && p.outputSchema }) }
    };
    deps.__applied = applied;
    return deps;
  }

  async function confirm(tools) {
    await tools.tools['io.confirm']({ inputSchema: { type: 'object', properties: { k: { type: 'string' } } }, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array' } } } });
  }

  const S1 = () => [{ id: 's1', script: 'await $extract("a");', onSuccess: 's2', onFailure: 'TERMINATE' }];
  const S2 = () => [{ id: 's2', script: 'return {posts: __lastResult__};', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }];

  it('abort WITH steps clears the old buffer and buffers the sent steps as the NEW chunk 1 (no silent discard)', async () => {
    const deps = makeDeps();
    const tools = createSessionTools(deps);
    await confirm(tools);
    const r1 = await tools.tools['service.update']({ steps: [{ id: 'junk', script: 'return 0;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }], more: true });
    assert.ok(r1.buffered === true);
    const r2 = await tools.tools['service.update']({ steps: S1(), abortChunk: true });
    assert.equal(r2.aborted, true);
    assert.equal(r2.bufferedSteps, 1, 'the aborted-with-steps call buffers its steps as the new chunk 1');
    assert.match(String(r2.note), /NEW chunk 1/i, 'the receipt discloses the re-buffer');
    const r3 = await tools.tools['service.update']({ steps: S2() });
    assert.ok(r3.updated === true || r3.version, 'final chunk applies');
    assert.deepEqual(deps.__applied[deps.__applied.length - 1].steps.map((s) => s.id), ['s1', 's2'], 'the junk chunk is GONE, the abort-attached s1 leads the assembly');
  });

  it('a final chunk on an EMPTY buffer that shrinks the artifact discloses the replacement (no silent suffix-only artifact)', async () => {
    const deps = makeDeps({
      draft: { targetUrl: 'https://example.com', config: {}, steps: S1().concat(S2()) }
    });
    const tools = createSessionTools(deps);
    await confirm(tools);
    const r = await tools.tools['service.update']({ steps: S2() });
    assert.ok(r.updated === true || r.version, 'applied (REPLACES is legal) — got ' + JSON.stringify(r).slice(0, 140));
    assert.deepEqual(r.replacedStepIds, { from: ['s1', 's2'], to: ['s2'] }, 'receipt names the id delta');
    assert.match(String(r.replacementNote || ''), /REPLACED a 2-step artifact with 1 step/, 'proper-subset shrink carries the mis-assembly warning');
  });

  it('an EQUIVALENT-id replacement carries no shrink warning', async () => {
    const deps = makeDeps({
      draft: { targetUrl: 'https://example.com', config: {}, steps: S1().concat(S2()) }
    });
    const tools = createSessionTools(deps);
    await confirm(tools);
    const r = await tools.tools['service.update']({ steps: S1().concat(S2()) });
    assert.ok(r.updated === true || r.version);
    assert.equal(r.replacementNote, undefined, 'same id set — no mis-assembly warning');
  });

  it('patch:true merges by id — one turn re-authors one step of a multi-step artifact', async () => {
    const deps = makeDeps({
      draft: { targetUrl: 'https://example.com', config: {}, steps: S1().concat(S2()) }
    });
    const tools = createSessionTools(deps);
    await confirm(tools);
    const newS2 = [{ id: 's2', script: 'return {posts: (__lastResult__||[]).slice(0, __input__.count)};', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }];
    const r = await tools.tools['service.update']({ steps: newS2, patch: true });
    assert.ok(r.updated === true || r.version, 'patch applies — got ' + JSON.stringify(r).slice(0, 160));
    assert.equal(r.patched, true);
    assert.deepEqual(r.stepsNow, ['s1', 's2']);
    const applied = deps.__applied[deps.__applied.length - 1];
    assert.deepEqual(applied.steps.map((s) => s.id), ['s1', 's2'], 's1 kept, s2 replaced');
    assert.match(applied.steps[1].script, /slice\(0, __input__\.count\)/, 'the patched script is the new one');
    assert.equal(applied.steps[0].script, 'await $extract("a");', 'the untouched step rides along verbatim');
  });

  it('patch:true with NEW step ids appends them when the merged chain stays valid', async () => {
    const deps = makeDeps({
      draft: { targetUrl: 'https://example.com', config: {}, steps: S1().concat(S2()) }
    });
    const tools = createSessionTools(deps);
    await confirm(tools);
    const r = await tools.tools['service.update']({
      steps: [
        { id: 's2', script: 'return {posts: __lastResult__};', onSuccess: 's3', onFailure: 'TERMINATE' },
        { id: 's3', script: 'return 1;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
      ],
      patch: true
    });
    assert.ok(r.patched === true, 'patch applies — got ' + JSON.stringify(r).slice(0, 160));
    assert.deepEqual(r.stepsNow, ['s1', 's2', 's3']);
  });

  it('patch:true guard rails: mutually exclusive with more:true, blocked while chunks pending, needs a current artifact', async () => {
    const deps = makeDeps();
    const tools = createSessionTools(deps);
    await confirm(tools);
    const rMore = await tools.tools['service.update']({ steps: S2(), patch: true, more: true });
    assert.match(String(rMore.error), /mutually exclusive/i);
    const rEmpty = await tools.tools['service.update']({ steps: S2(), patch: true });
    assert.match(String(rEmpty.error), /no current artifact/i, 'patch with no artifact teaches the REPLACES form');
    const deps2 = makeDeps({ draft: { targetUrl: 'https://example.com', config: {}, steps: S1().concat(S2()) } });
    const tools2 = createSessionTools(deps2);
    await confirm(tools2);
    await tools2.tools['service.update']({ steps: S1(), more: true });
    const rPending = await tools2.tools['service.update']({ steps: S2(), patch: true });
    assert.match(String(rPending.error), /chunks are pending/i, 'patch cannot run against a half-assembled buffer');
  });

  it('assembled chunk arrays mutate the SENT args in place — the engine lineage records the APPLIED artifact', async () => {
    const deps = makeDeps();
    const tools = createSessionTools(deps);
    await confirm(tools);
    const chunk1 = S1();
    const finalChunk = S2();
    const r1 = await tools.tools['service.update']({ steps: chunk1, more: true });
    assert.ok(r1.buffered === true);
    const sentArgs = { steps: finalChunk };
    await tools.tools['service.update'](sentArgs);
    assert.deepEqual(sentArgs.steps.map((s) => s.id), ['s1', 's2'], 'the args object the engine holds now carries the ASSEMBLED graph');
  });
});

describe('131st log — tool spec teaches the patch mode and the working abort', () => {
  it('service.update spec mentions patch:true and abortChunk semantics', () => {
    const rs = fs.readFileSync(path.join(__dirname, '../lib/research-session.js'), 'utf8');
    const i = rs.indexOf("name: 'service.update'");
    assert.ok(i > -1, 'spec found in research-session');
    const specLine = rs.slice(i, i + 5000);
    assert.match(specLine, /patch:true/, 'spec documents the merge-by-id mode');
    assert.match(specLine, /abortChunk:true clears buffered chunks/, 'spec documents the abort semantics');
  });
});
