// extension/test/hundred-forty-third-log-finish-gate.test.js
//
// 143rd log: the incident session finished at 79/80 shipping a RED v5 as
// "best-effort" while GREEN v3 sat one restore turn away — every disclosure
// fired (LAST VERIFY FAILED, LAST GREEN = v3 + restoreVersion hint,
// DUPLICATE-ITEMS with the content signature) and the model still shipped
// the red artifact, deploying an unverified service with a verified one in
// hand. The finish under LAST-VERIFY-RED + existing GREEN + current != green
// is now REJECTED with three exits: restore (one turn, then finish passes —
// the restored-green artifact is EXEMPT from the gate), verify the fix
// green, or an explicit shipRedArtifact:true override.
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
    if (typeof r === 'string') return { content: r, finish_reason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 10 } };
    return r;
  };
}
function reply(content) {
  return { content, finish_reason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 10 } };
}
function envelope(tool, args) {
  return JSON.stringify({ think: 't', tool, args: args || {} });
}
function finishEnvelope(summary, extra) {
  return JSON.stringify({ think: 'done', finish: Object.assign({ summary: summary || 'done' }, extra || {}) });
}

const SCHEMAS = {
  inputSchema: { type: 'object', properties: { k: { type: 'string' } } },
  outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } }
};

const STEP = (n) => ({ id: 's' + n, name: 'step' + n, onSuccess: 'TERMINATE', script: 'return ' + n + ';' });

function makeSession(replies, verifyResults) {
  let verifyIdx = 0;
  let draft = null;
  const applied = [];
  const { createSessionTools } = require('../lib/session-tools');
  const tools = createSessionTools({
    rail: { executeDsl: async () => ({}), pageState: async () => ({}), epoch: 0 },
    runVerify: async () => {
      const r = verifyResults[Math.min(verifyIdx, verifyResults.length - 1)];
      verifyIdx += 1;
      return r;
    },
    probeFactory: () => ({ snippet: async () => ({ result: 'ok' }), count: async () => ({ count: 1 }) }),
    getDraftService: () => draft,
    applyArtifact: (a) => { draft = { steps: a.steps, targetUrl: 'https://example.com/?k={{k}}', config: {} }; applied.push(a); },
    getTestInput: () => ({ k: 'ml' }),
    getOutputSchema: () => SCHEMAS.outputSchema,
    getSteps: () => (draft ? draft.steps : []),
    ioConfirmBridge: { request: async (p) => ({ confirmed: true, testInput: p && p.testInput }) }
  }).tools;
  const calls = [];
  const session = createResearchSession({
    requirement: 'collect posts',
    llm: scriptedLlm(replies, calls),
    tools: tools,
    onEvent: () => {}
  });
  return { session, calls, applied };
}

const GREEN_VERIFY = { events: [], report: { ok: true, detectors: {}, score: { score: 1 }, finalResult: { posts: [{ a: 1 }] } }, raw: {} };
const RED_VERIFY = { events: [], report: { ok: false, error: { message: 'DUPLICATE_ENTITY_PAIRS: red' }, detectors: {} }, raw: {} };

describe('143rd log — finish gate: red artifact + green predecessor', () => {
  it('a plain finish under red-verify-with-green-predecessor is BLOCKED with the three exits; restore then finish passes', async () => {
    const { session } = makeSession([
      envelope('io.confirm', Object.assign({ testInput: { keyword: 'ml', count: 3 } }, SCHEMAS)),
      envelope('service.update', { steps: [STEP(1)] }),      // v1
      envelope('verify.run', {}),                             // GREEN -> greenArtifactVersion = 1
      envelope('service.update', { steps: [STEP(2)] }),       // v2 (red candidate)
      envelope('verify.run', {}),                             // RED
      finishEnvelope('shipping best-effort'),                 // must be BLOCKED
      envelope('service.update', { restoreVersion: 1 }),      // restore the green steps
      finishEnvelope('shipping the restored green artifact')  // must PASS
    ], [GREEN_VERIFY, RED_VERIFY]);
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    const sysNotes = session.state().session.transcript.filter((t) => t.kind === 'system').map((t) => t.text);
    const block = sysNotes.find((t) => /FINISH BLOCKED/.test(t));
    assert.ok(block, 'the finish was blocked with the coercion note');
    assert.match(block, /restoreVersion:1/);
    assert.match(block, /shipRedArtifact/);
    // exactly ONE block (the second finish passed via the restored-green exemption)
    assert.equal(sysNotes.filter((t) => /FINISH BLOCKED/.test(t)).length, 1);
    assert.match(String(report.stopped.detail || ''), /restored green artifact/);
  });

  it('shipRedArtifact:true override ships the red artifact with disclosures (the explicit choice)', async () => {
    const { session } = makeSession([
      envelope('io.confirm', Object.assign({ testInput: { keyword: 'ml', count: 3 } }, SCHEMAS)),
      envelope('service.update', { steps: [STEP(1)] }),
      envelope('verify.run', {}),
      envelope('service.update', { steps: [STEP(2)] }),
      envelope('verify.run', {}),
      finishEnvelope('deliberate red ship', { shipRedArtifact: true })
    ], [GREEN_VERIFY, RED_VERIFY]);
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    const sysNotes = session.state().session.transcript.filter((t) => t.kind === 'system').map((t) => t.text);
    assert.ok(!sysNotes.some((t) => /FINISH BLOCKED/.test(t)), 'the override bypasses the gate');
    assert.match(String(report.stopped.detail || ''), /LAST VERIFY FAILED/);
  });

  it('red verify with NO green predecessor still finishes (disclosed) — the gate only guards a verified alternative', async () => {
    const { session } = makeSession([
      envelope('io.confirm', Object.assign({ testInput: { keyword: 'ml', count: 3 } }, SCHEMAS)),
      envelope('service.update', { steps: [STEP(1)] }),
      envelope('verify.run', {}),
      finishEnvelope('best effort, no green exists')
    ], [RED_VERIFY]);
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    const sysNotes = session.state().session.transcript.filter((t) => t.kind === 'system').map((t) => t.text);
    assert.ok(!sysNotes.some((t) => /FINISH BLOCKED/.test(t)), 'no gate without a green version');
  });

  it('a NON-restore update after a restore clears the exemption (the gate re-arms for new red steps)', async () => {
    const { session } = makeSession([
      envelope('io.confirm', Object.assign({ testInput: { keyword: 'ml', count: 3 } }, SCHEMAS)),
      envelope('service.update', { steps: [STEP(1)] }),
      envelope('verify.run', {}),
      envelope('service.update', { steps: [STEP(2)] }),
      envelope('verify.run', {}),
      envelope('service.update', { restoreVersion: 1 }),
      envelope('probe.snippet', { code: 'return 1;' }),       // dry-run (the snippet gate requires it after a red verify)
      envelope('service.update', { steps: [STEP(3)] }),      // new red steps after the restore
      finishEnvelope('shipping v4 best-effort')               // must be BLOCKED again
    ], [GREEN_VERIFY, RED_VERIFY]);
    await session.run();
    const sysNotes = session.state().session.transcript.filter((t) => t.kind === 'system').map((t) => t.text);
    const blocks = sysNotes.filter((t) => /FINISH BLOCKED/.test(t));
    assert.ok(blocks.length >= 1, 'the gate re-armed for post-restore red steps');
  });
});
