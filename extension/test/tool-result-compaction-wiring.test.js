// Thirty-second log wiring (RC-A + RC-B engine side): the transcript entry and
// the tool_result event must render tool results with structure-aware
// compaction — every key name alive, head+tail strings, array counts — not the
// flat head-only slice that hid the verify report's tail from both the model
// and the exported console log.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createResearchSession } = require('../lib/research-session');

function scriptedLlm(replies, calls) {
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

// The 32nd log's failure shape: a verify report whose tail keys lived past
// byte ~4000 of the flat serialization and never reached the model.
function bigVerifyReport() {
  const steps = [];
  for (let i = 0; i < 6; i++) {
    steps.push({ stepId: 'step' + i, ok: true, resultPreview: '{"records":' + JSON.stringify(Array.from({ length: 8 }, (_, j) => ({ idx: j, text: 'value ' + j }))) + '}' });
  }
  return {
    executedArtifactVersion: 4,
    ok: false,
    error: { message: 'REQUIRED_FIELD_EMPTY: posts.postTime is empty in 9/9 records. ' + 'advice sentence. '.repeat(60) + 'final advice: read steps[].resultPreview.' },
    aborted: false,
    score: { score: 193.2, isData: true, breakdown: {} },
    detectors: { partialEmptyFields: [{ path: 'posts.postTime', emptyCount: 9, totalCount: 9 }], emptyFieldDiagnostics: null },
    steps: steps,
    finalResult: null,
    pages: '0',
    eventCount: 42
  };
}

describe('transcript renders tool results structure-aware (RC-A)', () => {
  it('the NEXT llm call sees the report tail keys the flat slice destroyed', async () => {
    const calls = [];
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: scriptedLlm([
        reply(envelope('verify.run', {})),
        reply(finishEnvelope('done'))
      ], calls),
      tools: { 'verify.run': async () => bigVerifyReport() },
      budgets: { maxTurns: 4 }
    });
    await session.run();
    assert.ok(calls.length >= 2, 'two llm calls happened');
    const second = calls[1];
    const toolResultMsg = second.messages.filter((m) => typeof m.content === 'string' && m.content.indexOf('TOOL RESULT verify.run') === 0).pop();
    assert.ok(toolResultMsg, 'tool result message present');
    for (const key of ['"detectors"', '"steps"', '"finalResult"', '"pages"', '"eventCount"']) {
      assert.ok(toolResultMsg.content.includes(key), key + ' must reach the model');
    }
    assert.ok(toolResultMsg.content.length <= 4600, 'the 4000-char budget is respected (marker slack only)');
    assert.match(toolResultMsg.content, /final advice/, 'the long error message keeps its tail');
  });

  it('a long-args label does not eat the result budget (service.update echo)', async () => {
    const calls = [];
    const longSteps = Array.from({ length: 8 }, (_, i) => ({ id: 's' + i, script: 'x'.repeat(300) }));
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: scriptedLlm([
        reply(envelope('service.update', { steps: longSteps })),
        reply(finishEnvelope('done'))
      ], calls),
      tools: { 'service.update': async () => ({ updated: true, artifactVersion: 3 }) },
      budgets: { maxTurns: 4 }
    });
    await session.run();
    const toolResultMsg = calls[1].messages.filter((m) => typeof m.content === 'string' && m.content.indexOf('TOOL RESULT service.update') === 0).pop();
    assert.ok(toolResultMsg, 'tool result message present');
    assert.ok(toolResultMsg.content.indexOf('"artifactVersion":3') !== -1, 'result survives the long-args label');
    assert.ok(toolResultMsg.content.length <= 4600);
  });
});

describe('tool_result event carries a full compact detail (RC-B engine side)', () => {
  it('the event exposes ev.detail with every key alive next to the 600 one-liner', async () => {
    const events = [];
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: scriptedLlm([
        reply(envelope('verify.run', {})),
        reply(finishEnvelope('done'))
      ], []),
      tools: { 'verify.run': async () => bigVerifyReport() },
      onEvent: (e) => events.push(e)
    });
    await session.run();
    const tr = events.filter((e) => e.type === 'tool_result' && e.tool === 'verify.run').pop();
    assert.ok(tr, 'tool_result event fired');
    assert.ok(typeof tr.summary === 'string' && tr.summary.length > 0, 'the UI one-liner stays');
    assert.ok(typeof tr.detail === 'string', 'the compact detail attaches');
    for (const key of ['"detectors"', '"steps"', '"finalResult"', '"pages"', '"eventCount"', '"score"']) {
      assert.ok(tr.detail.includes(key), key + ' visible in the event detail');
    }
    assert.ok(tr.detail.length <= 12600, 'detail respects its 12000 budget');
  });
});
