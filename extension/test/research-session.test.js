// extension/test/research-session.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createResearchSession } = require('../lib/research-session');

function scriptedLlm(replies, calls) {
  let i = 0;
  return async (req) => {
    calls.push(req);
    const r = replies[Math.min(i, replies.length - 1)];
    i++;
    if (r && r.__throw) throw new Error(r.__throw);
    return r;
  };
}
function reply(content, extra) {
  return Object.assign({ content, finish_reason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 10 } }, extra || {});
}
function envelope(tool, args, extraJson) {
  return JSON.stringify(Object.assign({ think: 't', tool, args: args || {} }, extraJson || {}));
}
function finishEnvelope(summary) { return JSON.stringify({ think: 'done', finish: { summary: summary || 'done' } }); }

describe('engine happy path', () => {
  it('runs tool turns to a finish and reports completion', async () => {
    const calls = [];
    const events = [];
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: scriptedLlm([
        reply(envelope('probe.count', { sel: 'div.card' })),
        reply(finishEnvelope('2 turns done'))
      ], calls),
      tools: { 'probe.count': async (args) => ({ count: 8 }) },
      onEvent: (e) => events.push(e)
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    assert.equal(report.stopped.detail, '2 turns done');
    assert.equal(report.turns, 2);
    assert.equal(report.status, 'stopped');
    assert.ok(report.sessionId.startsWith('rs-'));
    assert.ok(events.some(e => e.type === 'session_start'));
    assert.ok(events.some(e => e.type === 'tool_result' && e.tool === 'probe.count' && e.ok === true));
    assert.ok(events.some(e => e.type === 'stopped'));
  });

  it('sends an explicit maxTokens on EVERY llm call (RC52 class guard)', async () => {
    const calls = [];
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([reply(finishEnvelope())], calls),
      tools: {}
    });
    await session.run();
    assert.ok(calls.length >= 1);
    assert.ok(calls.every(c => c.maxTokens === 8192), 'default per-call cap must be explicit');
    const calls2 = [];
    const s2 = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([reply(finishEnvelope())], calls2),
      tools: {},
      budgets: { maxTokensPerCall: 16000 }
    });
    await s2.run();
    assert.ok(calls2.every(c => c.maxTokens === 16000));
  });

  it('replays transcript into messages: assistant envelope raw, tool result as user turn', async () => {
    const calls = [];
    const session = createResearchSession({
      requirement: 'REQ-MARKER',
      llm: scriptedLlm([
        reply(envelope('probe.count', { sel: 'div.card' })),
        reply(finishEnvelope())
      ], calls),
      tools: { 'probe.count': async () => ({ count: 3 }) }
    });
    await session.run();
    const second = calls[1].messages;
    assert.ok(second.some(m => m.role === 'user' && m.content.includes('REQ-MARKER')));
    assert.ok(second.some(m => m.role === 'assistant' && m.content.includes('probe.count')));
    assert.ok(second.some(m => m.role === 'user' && /^TOOL RESULT probe\.count/.test(m.content)));
  });

  it('requires an llm function and throws at creation otherwise', () => {
    assert.throws(() => createResearchSession({ requirement: 'r', tools: {} }), /llm/);
  });

  it('a cyclic tool result is sanitized at the dispatch boundary, never crashes state()', async () => {
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply(envelope('probe.weird', {})),
        reply(finishEnvelope())
      ], []),
      tools: { 'probe.weird': async () => { const c = {}; c.self = c; return c; } }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    const st = session.state();
    const entry = st.session.transcript.find(e => e.kind === 'tool');
    assert.equal(entry.ok, false);
    assert.ok(entry.result.error.includes('unserializable'));
  });

  it('a tool returning undefined becomes an error result, not a crash', async () => {
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply(envelope('probe.void', {})),
        reply(finishEnvelope())
      ], []),
      tools: { 'probe.void': async () => {} }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    const entry = session.state().session.transcript.find(e => e.kind === 'tool');
    assert.equal(entry.ok, false);
    assert.ok(entry.result.error.includes('unserializable'));
  });
});

describe('tool dispatch', () => {
  it('returns a structured error for unknown tools and lists what exists', async () => {
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply(envelope('probe.nope', {})),
        reply(finishEnvelope())
      ], []),
      tools: { 'probe.count': async () => ({ count: 0 }) }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    const saved = session.state().session.transcript;
    const toolEntry = saved.find(e => e.kind === 'tool');
    assert.equal(toolEntry.ok, false);
    assert.ok(toolEntry.result.error.includes('unknown tool: probe.nope'));
    assert.ok(toolEntry.result.available.includes('probe.count'));
    assert.ok(toolEntry.result.available.includes('ledger.add'));
    assert.ok(toolEntry.result.available.includes('service.update'));
  });

  it('converts thrown tool errors into error results the LLM can read', async () => {
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply(envelope('probe.count', {})),
        reply(finishEnvelope())
      ], []),
      tools: { 'probe.count': async () => { throw new Error('tab died'); } }
    });
    await session.run();
    const toolEntry = session.state().session.transcript.find(e => e.kind === 'tool');
    assert.equal(toolEntry.result.error, 'tab died');
  });

  it('caps tool results replayed into later prompts (context diet)', async () => {
    const calls = [];
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply(envelope('probe.sample', {})),
        reply(finishEnvelope())
      ], calls),
      tools: { 'probe.sample': async () => ({ blob: 'y'.repeat(20000) }) },
      toolResultCapChars: 300
    });
    await session.run();
    const replay = calls[1].messages.filter(m => m.role === 'user' && m.content.startsWith('TOOL RESULT'));
    assert.equal(replay.length, 1);
    assert.ok(replay[0].content.length <= 300 + 60, 'replayed result must be capped');
    assert.ok(replay[0].content.includes('…[truncated]'));
  });
});

describe('budgets and breakers', () => {
  const toolTurn = envelope('probe.count', { sel: 'div.card' });

  it('stops gracefully at maxTurns and reports open state', async () => {
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([reply(toolTurn)], []),   // repeats forever
      tools: { 'probe.count': async () => ({ count: 1 }) },
      budgets: { maxTurns: 3 }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'maxTurns');
    assert.equal(report.turns, 3);
    assert.equal(report.status, 'stopped');
  });

  it('stops at the wall-clock cap using the injected clock', async () => {
    let clock = 1000;
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([reply(toolTurn)], []),
      tools: { 'probe.count': async () => { clock += 6000; return { count: 1 }; } },
      now: () => clock,
      budgets: { maxTurns: 50, wallClockMs: 5000 }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'wallClock');
    assert.equal(report.turns, 1);
  });

  it('stops at the session token cap from llm usage', async () => {
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([reply(toolTurn, { usage: { prompt_tokens: 600, completion_tokens: 100 } })], []),
      tools: { 'probe.count': async () => ({ count: 1 }) },
      budgets: { maxTurns: 50, tokenCap: 1000 }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'tokenCap');
    assert.equal(report.turns, 2);   // second turn trips the cap at loop top
  });

  it('estimates tokens (chars/4) when usage is absent', async () => {
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([reply(toolTurn, { usage: undefined })], []),
      tools: { 'probe.count': async () => ({ count: 1 }) },
      budgets: { maxTurns: 1 }
    });
    const report = await session.run();
    assert.ok(report.spend.estimated);
    assert.ok(report.spend.promptTokens > 0);
  });
});

describe('LLM failure discipline', () => {
  it('empty + finish_reason length is NON-RETRYABLE: exactly one call, stop llm:length', async () => {
    const calls = [];
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([reply('', { finish_reason: 'length' })], calls),
      tools: {},
      retry: { attempts: 3, backoffMs: 0 }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'llm:length');
    assert.equal(calls.length, 1, 'RC55: retrying empty+length burns the same budget again');
    assert.equal(report.spend.llmCalls, 1);
  });

  it('transient errors retry with backoff and succeed', async () => {
    const calls = [];
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        { __throw: 'ECONNRESET' },
        { __throw: 'timeout' },
        reply(finishEnvelope('recovered'))
      ], calls),
      tools: {},
      retry: { attempts: 3, backoffMs: 0 }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    assert.equal(calls.length, 3);
  });

  it('exhausted retries stop with llm:error', async () => {
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([{ __throw: 'down' }], []),
      tools: {},
      retry: { attempts: 2, backoffMs: 0 }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'llm:error');
    assert.ok(String(report.stopped.detail).includes('down'));
  });

  it('empty replies WITHOUT length are retried, then stop as llm:error', async () => {
    const calls = [];
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([reply('')], calls),
      tools: {},
      retry: { attempts: 3, backoffMs: 0 }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'llm:error');
    assert.equal(calls.length, 3);
  });

  it('honors exponential backoff (deterministic via timing-free config)', async () => {
    // backoffMs 0 keeps tests instant; this pins that backoffMs is respected structurally
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([{ __throw: 'x' }, reply(finishEnvelope())], []),
      tools: {},
      retry: { attempts: 2, backoffMs: 5 }
    });
    const t0 = Date.now();
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    assert.ok(Date.now() - t0 >= 5, 'at least one backoff wait happened');
  });
});
