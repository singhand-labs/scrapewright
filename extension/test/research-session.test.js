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

  it('DEFAULT maxTurns is 60 (sixth-log G5: first two full sessions died at the 40 cap)', async () => {
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([reply(toolTurn)], []),
      tools: { 'probe.count': async () => ({ count: 1 }) }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'maxTurns');
    assert.equal(report.turns, 60, 'no budgets override → engine default 60');
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

  it('every llm call carries a turn-budget line in the session-state block (seventh-log J1)', async () => {
    const calls = [];
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([reply(toolTurn)], calls),
      tools: { 'probe.count': async () => ({ count: 1 }) },
      budgets: { maxTurns: 3 }
    });
    await session.run();
    assert.ok(calls.length >= 3);
    for (const c of calls) {
      const sys = c.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
      assert.match(sys, /Turn budget: \d+ used \/ 3 max — \d+ left/, 'budget line visible on every call');
    }
  });

  it('fires one directional advisory per bucket (50%/75%/90%) and never repeats (seventh-log J1)', async () => {
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([reply(toolTurn)], []),
      tools: { 'probe.count': async () => ({ count: 1 }) },
      budgets: { maxTurns: 20 }   // buckets at turns 10 / 15 / 18
    });
    await session.run();
    const st = session.state().session;
    const advisories = st.transcript.filter(e => e.kind === 'system' && /BUDGET ADVISORY/.test(e.text));
    assert.equal(advisories.length, 3, 'exactly one advisory per bucket');
    assert.match(advisories[0].text, /half the turn budget spent: 10 of 20/);
    assert.match(advisories[1].text, /75% of the turn budget spent: 15 of 20/);
    assert.match(advisories[2].text, /90% of the turn budget spent: 18 of 20/);
    assert.match(advisories[2].text, /FINALIZE/);
    assert.deepEqual(st.budgetAdvisories.sort(), ['author', 'finalize', 'half']);
  });

  it('a resumed session past all buckets fires only the highest advisory once (seventh-log J1)', async () => {
    const seed = {
      session: {
        id: 'rs-seed-1', status: 'idle', requirement: 'r',
        goals: [], hypotheses: [], transcript: [], digest: '',
        spend: { turns: 16, llmCalls: 16, promptTokens: 100, completionTokens: 10, estimated: false },
        attachedUnits: [], artifactVersions: [], elapsedMs: 0, stopped: null,
        budgetAdvisories: ['half']   // half fired pre-resume; author (15) was passed while stopped
      }
    };
    const session = createResearchSession({
      requirement: 'r',
      seed: seed,
      llm: scriptedLlm([reply(toolTurn)], []),
      tools: { 'probe.count': async () => ({ count: 1 }) },
      budgets: { maxTurns: 20 }
    });
    await session.run();
    const st = session.state().session;
    const advisories = st.transcript.filter(e => e.kind === 'system' && /BUDGET ADVISORY/.test(e.text));
    // At resume (turns 16): only the 75% advisory fires — 'half' is marked
    // sent and 16 < 18. The 90% advisory still fires later at turn 18 as the
    // run continues toward maxTurns.
    assert.equal(advisories.length, 2);
    assert.match(advisories[0].text, /75% of the turn budget spent: 16 of 20/);
    assert.match(advisories[1].text, /90% of the turn budget spent: 18 of 20/);
    assert.deepEqual(st.budgetAdvisories.sort(), ['author', 'finalize', 'half']);
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

describe('protocol violations', () => {
  it('one repair round recovers a sloppy reply', async () => {
    const calls = [];
    const events = [];
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply('Sure! Let me count the cards for you.'),          // violation: no-json
        reply(envelope('probe.count', { sel: 'div.card' })),
        reply(finishEnvelope())
      ], calls),
      tools: { 'probe.count': async () => ({ count: 4 }) },
      onEvent: (e) => events.push(e)
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    assert.equal(report.turns, 2);
    assert.equal(calls.length, 3);
    assert.ok(events.some(e => e.type === 'protocol_violation' && e.violation === 'no-json'));
    const nudges = session.state().session.transcript.filter(e => e.kind === 'system');
    assert.equal(nudges.length, 1);
    assert.ok(/^PROTOCOL VIOLATION \(no-json/.test(nudges[0].text), 'violation named (detail may follow)');
  });

  it('the repair nudge carries the parse-error detail so the model can fix quoting (third live log F3)', async () => {
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply('{"think":"He said "ok", and left the room","tool":"page.state"}'), // unrepairable → not-object + detail
        reply(envelope('probe.count', {})),
        reply(finishEnvelope())
      ], []),
      tools: { 'probe.count': async () => ({ count: 4 }) }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    const nudges = session.state().session.transcript.filter(e => e.kind === 'system');
    assert.ok(nudges[0].text.includes('PROTOCOL VIOLATION (not-object'), 'violation named');
    assert.ok(/position/i.test(nudges[0].text), 'parse position carried into the nudge');
    assert.ok(nudges[0].text.includes('unescaped'), 'nudge teaches the quoting fix');
  });

  it('a truncated reply gets a cut-off-specific nudge demanding a SHORTER resend (fifth live log turn 21)', async () => {
    const events = [];
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        // Fifth-log shape: reply cut before the closing braces (finish_reason
        // stop) — the two replies that killed the real session.
        reply('{"think":"Groups block","goals":null,"hypotheses":{"add":"Non-post recommendation articles contain a[href*=\'/groups/\'] links instead of permalinks"},"tool":"probe.count","args":{"sel":"div[role=\'feed\'] div[role=\'article\']:not(:has(a[href*=\'/groups/\']))"'),
        reply(envelope('probe.count', { sel: 'div.card' })),
        reply(finishEnvelope())
      ], []),
      tools: { 'probe.count': async () => ({ count: 4 }) },
      onEvent: (e) => events.push(e)
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    assert.equal(report.turns, 2, 'repair round recovered the turn');
    const nudges = session.state().session.transcript.filter(e => e.kind === 'system');
    assert.ok(/CUT OFF/i.test(nudges[0].text), 'nudge names the truncation class');
    assert.ok(/SHORTER/i.test(nudges[0].text), 'nudge demands a shorter resend (glm tail degradation grows with reply length)');
    const ev = events.find(e => e.type === 'protocol_violation');
    assert.ok(ev && ev.detail && /cut-off|Unterminated|Unexpected end/i.test(ev.detail), 'violation event carries the truncation evidence');
  });

  it('a second consecutive violation stops the session with reason protocol', async () => {
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([reply('I will just describe it in prose.')], []),
      tools: {}
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'protocol');
    assert.equal(report.stopped.detail, 'no-json');
    assert.equal(report.turns, 0);
  });

  it('a repaired turn does not count as two turns', async () => {
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply('prose'),
        reply(envelope('probe.count', {})),
        reply(finishEnvelope())
      ], []),
      tools: { 'probe.count': async () => ({ count: 1 }) }
    });
    const report = await session.run();
    assert.equal(report.turns, 2);   // repair round is not a turn
    assert.equal(report.spend.llmCalls, 3);
  });
});

describe('goals and hypotheses', () => {
  it('applies envelope updates and injects SESSION STATE into the next call', async () => {
    const calls = [];
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply(envelope('probe.count', { sel: 'div.card' }, {
          goals: { push: 'find the organic card container' },
          hypotheses: { add: 'div.card is the organic container' }
        })),
        reply(envelope('ledger.add', { finding: 'organic container = div.card', confidence: 'high' })),
        reply(finishEnvelope())
      ], calls),
      tools: { 'probe.count': async () => ({ count: 8 }) }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    const second = calls[1].messages;
    const stateMsg = second.find(m => m.role === 'system' && m.content.startsWith('SESSION STATE'));
    assert.ok(stateMsg, 'SESSION STATE block must be injected');
    assert.ok(stateMsg.content.includes('[open] g1: find the organic card container'));
    assert.ok(stateMsg.content.includes('1. div.card is the organic container — OPEN'));
    // ledger.add is engine-internal (Task 11); with tools registry lacking it, this turn
    // errors — acceptable for this test; what matters here is the state block.
  });

  it('complete/resolve update state and drop out of openQuestions', async () => {
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply(envelope('probe.count', {}, {
          goals: { push: 'A' },
          hypotheses: { add: 'H1' }
        })),
        reply(envelope('probe.count', {}, {
          goals: { complete: 'g1' },
          hypotheses: { resolve: { n: 1, verdict: 'confirmed' } }
        })),
        reply(envelope('probe.count', {}, {
          goals: { push: 'B' },
          hypotheses: { add: 'H2' }
        })),
        reply(envelope('probe.count', {})),
        reply(envelope('probe.count', {}))
      ], []),
      tools: { 'probe.count': async () => ({ count: 1 }) },
      budgets: { maxTurns: 4 }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'maxTurns');
    assert.deepEqual(report.openQuestions, [
      { kind: 'goal', id: 'g2', text: 'B' },
      { kind: 'hypothesis', n: 2, text: 'H2' }
    ]);
  });

  it('SESSION STATE shows resolved hypotheses and the ledger tail', async () => {
    const calls = [];
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply(envelope('probe.count', {}, { hypotheses: { add: 'X marks cards' } })),
        reply(envelope('probe.count', {}, { hypotheses: { resolve: { n: 1, verdict: 'refuted' } } })),
        reply(finishEnvelope())
      ], calls),
      tools: { 'probe.count': async () => ({ count: 1 }) }
    });
    await session.run();
    const third = calls[2].messages;
    const stateMsg = third.find(m => m.role === 'system' && m.content.startsWith('SESSION STATE'));
    assert.ok(stateMsg.content.includes('1. X marks cards — refuted'));
  });
});

describe('compaction', () => {
  function noisySession(calls) {
    return createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply(envelope('probe.count', { sel: '.a' })),
        reply(envelope('probe.count', { sel: '.b' })),
        reply(envelope('probe.count', { sel: '.c' })),
        reply(envelope('probe.count', { sel: '.d' })),
        reply(finishEnvelope())
      ], calls),
      tools: { 'probe.count': async (args) => ({ count: args.sel.length }) },
      compaction: { thresholdChars: 400, keepTurns: 1 }
    });
  }

  it('collapses older turns into the digest and keeps the last pair verbatim', async () => {
    const calls = [];
    const session = noisySession(calls);
    await session.run();
    const s = session.state().session;
    assert.ok(s.digest.includes('probe.count'));
    assert.ok(s.digest.length > 0);
    const kinds = s.transcript.map(e => e.kind);
    assert.ok(s.transcript.length <= 3, 'only the kept window (+ trailing) survives');
    const lastCall = calls[calls.length - 1].messages;
    const stateMsg = lastCall.find(m => m.role === 'system' && m.content.startsWith('SESSION STATE'));
    assert.ok(stateMsg.content.includes('# Earlier investigation (digest)'), 'digest must be injected');
    assert.ok(stateMsg.content.includes('.a'), 'collapsed turns survive as digest lines');
  });

  it('replays the kept window verbatim (assistant raw + TOOL RESULT)', async () => {
    const calls = [];
    const session = noisySession(calls);
    await session.run();
    const lastCall = calls[calls.length - 1].messages;
    const toolReplays = lastCall.filter(m => m.role === 'user' && m.content.startsWith('TOOL RESULT'));
    assert.equal(toolReplays.length, 1, 'keepTurns=1 keeps exactly one tool replay');
    assert.ok(lastCall.some(m => m.role === 'assistant' && m.content.includes('probe.count')));
  });

  it('emits a compaction event and never compacts below the keep window', async () => {
    const events = [];
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply(envelope('probe.count', { sel: '.a' })),
        reply(envelope('probe.count', { sel: '.b' })),
        reply(finishEnvelope())
      ], []),
      tools: { 'probe.count': async () => ({ count: 1 }) },
      compaction: { thresholdChars: 10, keepTurns: 1 },
      onEvent: (e) => events.push(e)
    });
    await session.run();
    assert.ok(events.some(e => e.type === 'compaction'));
    const tr = session.state().session.transcript;
    assert.ok(tr.length >= 2, 'keep window is never compacted away');
  });
});

const { KNOWLEDGE_UNITS } = require('../lib/knowledge-units');
const KnowledgeBase = require('../lib/knowledge-base');

describe('knowledge integration', () => {
  const knowledge = {
    units: KNOWLEDGE_UNITS,
    index: KnowledgeBase.buildIndex(KNOWLEDGE_UNITS)
  };

  it('auto-attaches matched unit bodies into the NEXT system prompt (spec §3 trigger a)', async () => {
    const calls = [];
    const events = [];
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply(envelope('verify.run', {})),
        reply(finishEnvelope())
      ], calls),
      tools: { 'verify.run': async () => ({ ok: false, events: ['COUNT_SHORTFALL'] }) },
      knowledge,
      onEvent: (e) => events.push(e)
    });
    await session.run();
    assert.ok(events.some(e => e.type === 'knowledge_attached' && /polarity|count/.test(e.id)),
      'a COUNT_SHORTFALL-signature unit must attach');
    const second = calls[1].messages;
    const sys = second[0].content;
    assert.ok(sys.includes('## Knowledge (auto-attached'), 'unit bodies injected into system prompt');
    const first = calls[0].messages[0].content;
    assert.ok(!first.includes('## Knowledge (auto-attached'), 'nothing attached before the signal');
  });

  it('attaches each unit at most once', async () => {
    const events = [];
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply(envelope('verify.run', {})),
        reply(envelope('verify.run', {})),
        reply(finishEnvelope())
      ], []),
      tools: { 'verify.run': async () => ({ ok: false, events: ['COUNT_SHORTFALL'] }) },
      knowledge,
      onEvent: (e) => events.push(e)
    });
    await session.run();
    const attaches = events.filter(e => e.type === 'knowledge_attached');
    assert.equal(attaches.length, 1);
  });

  it('dispatches knowledge.query and returns unit bodies', async () => {
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply(envelope('knowledge.query', { ids: ['card-polarity'] })),
        reply(finishEnvelope())
      ], []),
      tools: {},
      knowledge
    });
    await session.run();
    const entry = session.state().session.transcript.find(e => e.kind === 'tool' && e.name === 'knowledge.query');
    assert.equal(entry.ok, true);
    assert.ok(entry.result.units[0].id === 'card-polarity');
    assert.ok(entry.result.units[0].body.length > 100);
  });

  it('knowledge.query without ids is a structured error', async () => {
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply(envelope('knowledge.query', {})),
        reply(finishEnvelope())
      ], []),
      tools: {},
      knowledge
    });
    await session.run();
    const entry = session.state().session.transcript.find(e => e.kind === 'tool');
    assert.equal(entry.ok, false);
    assert.ok(entry.result.error.includes('ids'));
  });
});

const { createProbeTools } = require('../lib/probe-tools');

describe('ledger.add (engine-internal)', () => {
  it('writes findings with provenance session and surfaces them in SESSION STATE', async () => {
    const calls = [];
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply(envelope('ledger.add', { finding: 'popover = div[role=tooltip]', confidence: 'high', selectors: ['div[role=tooltip]'] })),
        reply(finishEnvelope())
      ], calls),
      tools: {}
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    assert.equal(report.ledgerEntries, 1);
    const entries = session.ledger.serialize().entries;
    assert.equal(entries[0].provenance, 'session');
    assert.equal(entries[0].confidence, 'high');
    const stateMsg = calls[1].messages.find(m => m.role === 'system' && m.content.startsWith('SESSION STATE'));
    assert.ok(stateMsg.content.includes('popover = div[role=tooltip]'));
  });

  it('rejects findings without text', async () => {
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply(envelope('ledger.add', {})),
        reply(finishEnvelope())
      ], []),
      tools: {}
    });
    await session.run();
    const entry = session.state().session.transcript.find(e => e.kind === 'tool');
    assert.equal(entry.ok, false);
    assert.ok(entry.result.error.includes('finding'));
  });
});

describe('service.update grounding chokepoint (spec §8)', () => {
  const AD_SELECTOR = "div.card:not([data-kind='ad'])";

  function makeRail(countResult) {
    // A fake executeDsl answering every $count snippet with countResult and
    // the attrStats fieldMap snippet with a mixed population.
    return async (snippet) => {
      if (snippet.includes('$count')) return countResult;
      if (snippet.includes('$extractList')) {
        return [
          { m: 'ad' }, { m: 'ad' }, { m: 'organic' }, { m: 'organic' },
          { m: 'organic' }, { m: 'organic' }, { m: 'organic' }, { m: 'organic' }
        ];
      }
      return null;
    };
  }

  function updateStep(selector) {
    return [{
      id: '1',
      script: 'return $extractList(' + JSON.stringify(selector) + ', { postId: { selector: "a", attr: "href" } });'
    }];
  }

  // The engine keeps cfg.tools BY REFERENCE, so wiring real probe tools into
  // a mutable bag AFTER createResearchSession works — the tests below use it.

  it('REJECTS the seventh-log shape: filter attr with no attrStats receipt', async () => {
    const bag = {};
    const handlerCalls = [];
    const session = createResearchSession({
      requirement: 'collect cards',
      llm: scriptedLlm([
        reply(envelope('service.update', { steps: updateStep(AD_SELECTOR) })),
        reply(finishEnvelope())
      ], []),
      tools: bag,
      budgets: { maxTurns: 10 }
    });
    const probe = createProbeTools({ executeDsl: makeRail(8), observationLog: session.observationLog });
    bag['probe.count'] = probe.count;
    bag['service.update'] = async () => { handlerCalls.push(1); return { version: 1 }; };

    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    assert.equal(report.artifactVersions, 0, 'no version may be created');
    assert.equal(handlerCalls.length, 0, 'the write handler must NOT run');
    const entry = session.state().session.transcript.find(e => e.kind === 'tool' && e.name === 'service.update');
    assert.equal(entry.result.grounding, 'rejected');
    assert.ok(entry.result.rejections.some(r => r.missing === 'attr-distribution' && r.attr === 'data-kind'),
      'the polarity receipt demand is the rejection: ' + JSON.stringify(entry.result.rejections));
  });

  it('ADMITS after attrStats + selector grounding and versions the artifact', async () => {
    const bag = {};
    const handlerCalls = [];
    const session = createResearchSession({
      requirement: 'collect cards',
      llm: scriptedLlm([
        reply(envelope('probe.attrStats', { containerSel: 'div.card', attr: 'data-kind' })),
        reply(envelope('service.update', { steps: updateStep(AD_SELECTOR) })),
        reply(finishEnvelope())
      ], []),
      tools: bag,
      budgets: { maxTurns: 10 }
    });
    const probe = createProbeTools({ executeDsl: makeRail(8), observationLog: session.observationLog });
    bag['probe.attrStats'] = probe.attrStats;
    bag['probe.count'] = probe.count;
    bag['service.update'] = async () => { handlerCalls.push(1); return { version: 1 }; };

    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    assert.equal(handlerCalls.length, 1);
    assert.equal(report.artifactVersions, 1);
    const entry = session.state().session.transcript.find(e => e.kind === 'tool' && e.name === 'service.update');
    assert.ok(!entry.result.grounding, 'admitted: ' + JSON.stringify(entry.result));
    assert.equal(entry.result.version, 1);
    assert.equal(session.state().session.artifactVersions[0].steps[0].id, '1');
  });

  it('accepts overrides as {"selectors":[...]} — the shape the model actually sent (sixth-live-log turn 22)', async () => {
    const bag = {};
    const handlerCalls = [];
    const UNGROUNDED = 'div.sneaky';
    const session = createResearchSession({
      requirement: 'collect cards',
      llm: scriptedLlm([
        reply(envelope('service.update', {
          steps: updateStep(UNGROUNDED),
          overrides: { selectors: [UNGROUNDED] }
        })),
        reply(finishEnvelope())
      ], []),
      tools: bag,
      budgets: { maxTurns: 10 }
    });
    // makeRail(0): auto-verify count 0 — WITHOUT the override this must reject.
    const probe = createProbeTools({ executeDsl: makeRail(0), observationLog: session.observationLog });
    bag['probe.count'] = probe.count;
    bag['service.update'] = async () => { handlerCalls.push(1); return { version: 1 }; };

    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    assert.equal(handlerCalls.length, 1, 'the object-shaped override waives the receipt — handler runs');
    assert.equal(report.artifactVersions, 1);
    const entry = session.state().session.transcript.find(e => e.kind === 'tool' && e.name === 'service.update');
    assert.ok(!entry.result.grounding, 'admitted via override: ' + JSON.stringify(entry.result));
  });

  it('a failed write handler creates NO version and emits NO artifact_version event (fourth-live-log G2)', async () => {
    const bag = {};
    const events = [];
    const session = createResearchSession({
      requirement: 'collect cards',
      llm: scriptedLlm([
        reply(envelope('probe.attrStats', { containerSel: 'div.card', attr: 'data-kind' })),
        reply(envelope('service.update', { steps: updateStep(AD_SELECTOR) })),
        reply(finishEnvelope())
      ], []),
      tools: bag,
      budgets: { maxTurns: 10 },
      onEvent: (e) => events.push(e)
    });
    const probe = createProbeTools({ executeDsl: makeRail(8), observationLog: session.observationLog });
    bag['probe.attrStats'] = probe.attrStats;
    bag['probe.count'] = probe.count;
    // Fourth-log turn-19 shape: grounding admitted the update, but the
    // handler rejected the artifact (invalid chain). The engine must not
    // announce a version that was never created.
    bag['service.update'] = async () => ({ error: 'step chain invalid: unknown onSuccess target NOPE' });

    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    assert.equal(report.artifactVersions, 0, 'failed handler → no version counted');
    assert.ok(!events.some(e => e.type === 'artifact_version'), 'no artifact_version event emitted');
    const entry = session.state().session.transcript.find(e => e.kind === 'tool' && e.name === 'service.update');
    assert.match(entry.result.error, /chain invalid/);
    assert.equal(entry.ok, false, 'handler failure flagged not-ok in the transcript');
  });

  it('a grounding rejection is flagged not-ok in transcript and tool_result event (fourth-live-log G3)', async () => {
    const bag = {};
    const events = [];
    const session = createResearchSession({
      requirement: 'collect cards',
      llm: scriptedLlm([
        reply(envelope('service.update', { steps: updateStep(AD_SELECTOR) })),
        reply(finishEnvelope())
      ], []),
      tools: bag,
      budgets: { maxTurns: 10 },
      onEvent: (e) => events.push(e)
    });
    const probe = createProbeTools({ executeDsl: makeRail(8), observationLog: session.observationLog });
    bag['probe.count'] = probe.count;

    await session.run();
    const entry = session.state().session.transcript.find(e => e.kind === 'tool' && e.name === 'service.update');
    assert.equal(entry.result.grounding, 'rejected');
    assert.equal(entry.ok, false, 'grounding rejection is an error result');
    const ev = events.find(e => e.type === 'tool_result' && e.tool === 'service.update');
    assert.ok(ev, 'tool_result event captured');
    assert.equal(ev.ok, false, 'mirror event says ERR, not ok');
  });

  it('the attrStats result itself reaches the LLM (the semantic revealer)', async () => {
    const bag = {};
    const session = createResearchSession({
      requirement: 'collect cards',
      llm: scriptedLlm([
        reply(envelope('probe.attrStats', { containerSel: 'div.card', attr: 'data-kind' })),
        reply(finishEnvelope())
      ], []),
      tools: bag
    });
    const probe = createProbeTools({ executeDsl: makeRail(8), observationLog: session.observationLog });
    bag['probe.attrStats'] = probe.attrStats;
    await session.run();
    const entry = session.state().session.transcript.find(e => e.kind === 'tool');
    assert.equal(entry.result.totalItems, 8);
    assert.ok(entry.result.values.some(v => v.value === 'ad' && v.items === 2));
  });

  it('a cyclic handler return from service.update degrades to an error result, state() never throws', async () => {
    const bag = {};
    const session = createResearchSession({
      requirement: 'collect cards',
      llm: scriptedLlm([
        reply(envelope('probe.attrStats', { containerSel: 'div.card', attr: 'data-kind' })),
        reply(envelope('service.update', { steps: updateStep(AD_SELECTOR) })),
        reply(finishEnvelope())
      ], []),
      tools: bag,
      budgets: { maxTurns: 10 }
    });
    const probe = createProbeTools({ executeDsl: makeRail(8), observationLog: session.observationLog });
    bag['probe.attrStats'] = probe.attrStats;
    bag['probe.count'] = probe.count;
    bag['service.update'] = async () => { const c = {}; c.self = c; return c; };

    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    const entry = session.state().session.transcript.find(e => e.kind === 'tool' && e.name === 'service.update');
    assert.equal(entry.ok, false);
    assert.ok(entry.result.error.includes('unserializable'));
  });
});

describe('persistence and lifecycle', () => {
  it('persists at every turn boundary and at stop', async () => {
    const saves = [];
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply(envelope('probe.count', {})),
        reply(finishEnvelope())
      ], []),
      tools: { 'probe.count': async () => ({ count: 1 }) },
      persistence: { save: async (s) => saves.push(s) }
    });
    await session.run();
    assert.ok(saves.length >= 3, 'turn 1 + turn 2 + final stop = 3 saves');
    assert.equal(saves[saves.length - 1].session.stopped.reason, 'completed');
    assert.ok(saves[0].observation && saves[0].ledger, 'persisted state carries the Plan-1 lib snapshots');
  });

  it('persistence failures never kill the loop', async () => {
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply(envelope('probe.count', {})),
        reply(finishEnvelope())
      ], []),
      tools: { 'probe.count': async () => ({ count: 1 }) },
      persistence: { save: async () => { throw new Error('storage full'); } }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
  });

  it('abort() stops at the next turn boundary with everything kept', async () => {
    const events = [];
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([reply(envelope('probe.count', {}))], []),
      tools: {
        'probe.count': async (args, ctx) => { ctx.session.abort('user said stop'); return { count: 1 }; }
      },
      onEvent: (e) => events.push(e)
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'aborted');
    assert.equal(report.stopped.detail, 'user said stop');
    assert.equal(report.turns, 1);
    assert.ok(session.state().session.transcript.length === 2);
  });

  it('pause() yields control and run() resumes from the transcript', async () => {
    const calls = [];
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply(envelope('probe.count', { sel: '.first' })),
        reply(envelope('probe.count', { sel: '.second' })),
        reply(finishEnvelope())
      ], calls),
      tools: {
        'probe.count': async (args, ctx) => {
          if (args.sel === '.first') ctx.session.pause();
          return { count: 1 };
        }
      }
    });
    const mid = await session.run();
    assert.equal(mid.stopped.reason, 'paused');
    assert.equal(mid.turns, 1);
    assert.equal(mid.status, 'paused');
    const end = await session.run();
    assert.equal(end.stopped.reason, 'completed');
    assert.equal(end.turns, 3, 'turn count is cumulative across pause/resume (work, not wall-clock)');
    assert.equal(calls.length, 3);
    const resumed = calls[2].messages;
    assert.ok(resumed.some(m => m.role === 'user' && m.content.includes('.first')),
      'resumed context still carries the pre-pause turn');
  });

  it('wall-clock budget EXCLUDES paused time', async () => {
    let clock = 0;
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply(envelope('probe.count', {})),
        reply(envelope('probe.count', {})),
        reply(finishEnvelope())
      ], []),
      tools: {
        'probe.count': async (args, ctx) => {
          if (clock === 0) { clock = 100; ctx.session.pause(); }
          return { count: 1 };
        }
      },
      now: () => clock,
      budgets: { maxTurns: 10, wallClockMs: 500 }
    });
    const mid = await session.run();
    assert.equal(mid.stopped.reason, 'paused');
    clock = 100000;                       // the user thinks for a long time
    const end = await session.run();      // resume — segmentStart resets
    assert.equal(end.stopped.reason, 'completed', 'pause gap must not eat the budget: ' + JSON.stringify(end.stopped));
  });

  it('seed resume: a fresh session continues from a persisted state', async () => {
    const calls1 = [];
    const first = createResearchSession({
      requirement: 'REQ-RESUME',
      llm: scriptedLlm([reply(envelope('probe.count', { sel: '.a' }))], calls1),
      tools: {
        'probe.count': async (args, ctx) => { ctx.session.pause(); return { count: 2 }; }
      }
    });
    await first.run();
    const saved = first.state();   // captured AFTER the pause so it carries turn 1

    const calls2 = [];
    const second = createResearchSession({
      requirement: 'REQ-RESUME',
      llm: scriptedLlm([reply(finishEnvelope())], calls2),
      tools: { 'probe.count': async () => ({ count: 0 }) },
      seed: saved
    });
    const report = await second.run();
    assert.equal(report.stopped.reason, 'completed');
    assert.equal(report.turns, 2, 'turn count continues across the resume');
    assert.equal(second.observationLog.size(), first.observationLog.size(), 'observation log carries over');
    const msgs = calls2[0].messages;
    assert.ok(msgs.some(m => m.role === 'user' && m.content.includes('REQ-RESUME')));
    assert.ok(msgs.some(m => m.role === 'assistant' && m.content.includes('.a')));
  });

  it('state() is a deep copy — mutating it cannot corrupt the session', async () => {
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([reply(finishEnvelope())], []),
      tools: {}
    });
    const s = session.state();
    s.session.goals.push({ id: 'gX', text: 'fake', status: 'open' });
    s.session.transcript.push({ kind: 'tool', name: 'x', ok: true, result: {}, summary: '' });
    assert.equal(session.report().openQuestions.length, 0);
    assert.equal(session.state().session.transcript.length, 0);
  });
});

describe('universality: engine sources carry no site tokens', () => {
  const FORBIDDEN = /facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i;
  it('research-session.js', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'research-session.js'), 'utf8');
    assert.ok(!FORBIDDEN.test(src));
  });
  it('session-protocol.js', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session-protocol.js'), 'utf8');
    assert.ok(!FORBIDDEN.test(src));
  });
});

describe('service.update artifact contract mentions testInput (first-live-log P-E)', () => {
  it('the rendered system prompt tells the LLM that artifacts can carry testInput for {{param}} URLs', async () => {
    const calls = [];
    const session = createResearchSession({
      requirement: 'collect cards',
      llm: scriptedLlm([reply(finishEnvelope())], calls),
      tools: {},
      budgets: { maxTurns: 3 }
    });
    await session.run();
    const sys = calls[0].messages[0].content;
    assert.match(sys, /service\.update[^\n]*testInput/);
    assert.match(sys, /MISSING_URL_PARAM/);
    assert.match(sys, /service\.update[^\n]*REPLACES/, 'second-live-log D3: replace-whole-artifact semantics stated');
  });

  it('the spec demands JSON-Schema-shaped inputSchema/outputSchema (fourth-live-log G1)', async () => {
    const calls = [];
    const session = createResearchSession({
      requirement: 'collect cards',
      llm: scriptedLlm([reply(finishEnvelope())], calls),
      tools: {},
      budgets: { maxTurns: 3 }
    });
    await session.run();
    const sys = calls[0].messages[0].content;
    assert.match(sys, /outputSchema[^\n]*JSON Schema/i, 'schema shape requirement stated on the service.update line');
    assert.match(sys, /"required"/, 'the example shows the required array that unlocks verify scoring');
  });

  it('the spec documents BOTH overrides shapes (sixth-live-log I2a)', async () => {
    const calls = [];
    const session = createResearchSession({
      requirement: 'collect cards',
      llm: scriptedLlm([reply(finishEnvelope())], calls),
      tools: {},
      budgets: { maxTurns: 3 }
    });
    await session.run();
    const sys = calls[0].messages[0].content;
    assert.match(sys, /overrides[^\n]*\{"selectors":\[/, 'service.update line teaches the object shape the model tends to send');
    assert.match(sys, /overrides[^\n]*array of selector strings/, 'and the plain string-array shape');
  });
});

describe('tenth-log N3: session_start resuming flag', () => {
  it('a seed with transcript history but a reset budget segment still reports resuming:true (feedback continuation shape)', async () => {
    const events = [];
    const seed = {
      session: {
        id: 'rs-seed-cont', status: 'idle', requirement: 'r',
        goals: [], hypotheses: [],
        transcript: [{ kind: 'system', text: 'USER FEEDBACK (fix request): a field comes back empty' }],
        digest: '',
        spend: { turns: 0, llmCalls: 0, promptTokens: 0, completionTokens: 0, estimated: false },
        attachedUnits: [], artifactVersions: [], elapsedMs: 0, stopped: null,
        budgetAdvisories: []
      }
    };
    const session = createResearchSession({
      requirement: 'r',
      seed: seed,
      llm: scriptedLlm([reply(finishEnvelope())], []),
      tools: {},
      budgets: { maxTurns: 5 },
      onEvent: (e) => events.push(e)
    });
    await session.run();
    const start = events.find((e) => e.type === 'session_start');
    assert.equal(start.resuming, true, 'transcript history marks the continuation');
  });

  it('a fresh session reports resuming:false', async () => {
    const events = [];
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([reply(finishEnvelope())], []),
      tools: {},
      onEvent: (e) => events.push(e)
    });
    await session.run();
    const start = events.find((e) => e.type === 'session_start');
    assert.equal(start.resuming, false);
  });
});

describe('audit C4: abort/stop cancels pending user bridges (no deadlock)', () => {
  it('abort() while a user bridge is parked resolves run() and cancels the bridge', async () => {
    const cancelled = [];
    let releaseRequest = null;
    const bridge = {
      request: () => new Promise((resolve) => { releaseRequest = resolve; }),
      cancel: (reason) => { cancelled.push(String(reason)); releaseRequest({ confirmed: false, cancelled: true, feedback: 'user stopped' }); }
    };
    const toolResults = [];
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([
        reply(envelope('io.confirm', { note: 'x' })),
        reply(finishEnvelope())
      ], []),
      tools: { 'io.confirm': async () => { const r = await bridge.request({}); toolResults.push(r); return r; } },
      userBridges: [bridge]
    });
    const runP = session.run();
    const deadline = Date.now() + 2000;
    while (!releaseRequest && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
    assert.ok(releaseRequest, 'bridge must be parked before abort');
    session.abort('user');
    const report = await Promise.race([
      runP,
      new Promise((_, rej) => setTimeout(() => rej(new Error('deadlock: run() never resolved')), 1000))
    ]);
    assert.equal(report.stopped.reason, 'aborted');
    assert.equal(cancelled.length, 1);
    assert.ok(toolResults.length === 1 && toolResults[0].cancelled === true, 'cancelled response flows back as the tool result');
  });

  it('stop() (natural completion) also cancels any pending bridge', async () => {
    const cancelled = [];
    const bridge = { request: () => new Promise(() => {}), cancel: (r) => cancelled.push(String(r)) };
    const session = createResearchSession({
      requirement: 'r',
      llm: scriptedLlm([reply(finishEnvelope())], []),
      tools: {},
      userBridges: [bridge]
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    assert.equal(cancelled.length, 1, 'stop() cancels bridges even when none pending matters not — it must be idempotent-safe');
  });
});

describe('audit C1: parked bridge time does not consume wallClock', () => {
  it('parkBegin/parkEnd window is excluded and reported as spend.parkedMs', async () => {
    let t = 1000;
    const now = () => t;
    const session = createResearchSession({
      requirement: 'r',
      now: now,
      budgets: { wallClockMs: 1000, maxTurns: 10 },
      llm: scriptedLlm([
        reply(envelope('ask.user', {})),
        reply(finishEnvelope())
      ], []),
      tools: { 'ask.user': async (args, ctx) => {
        ctx.session.parkBegin();
        t += 4000; // the user thinks for 4s while parked
        await new Promise((r) => setTimeout(r, 1));
        ctx.session.parkEnd();
        t += 500; // 500ms of real work afterwards
        return { ok: true };
      } }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed', 'net elapsed 500ms < wallClock 1000ms — parked 4000ms must not count');
    assert.equal(report.spend.parkedMs, 4000);
  });
});

describe('audit C12+C5: terminal persistence + budget-stop hints', () => {
  it('stop() flushes persistence (debounce cannot swallow the final state)', async () => {
    const ops = [];
    const persistence = {
      save: async (s) => { ops.push(['save', s.session.status]); },
      flush: async () => { ops.push(['flush']); }
    };
    const session = createResearchSession({
      requirement: 'r', llm: scriptedLlm([reply(finishEnvelope())], []), tools: {},
      persistence: persistence
    });
    await session.run();
    assert.ok(ops.some((o) => o[0] === 'flush'), 'stop() must flush, not only debounce-save');
    assert.equal(ops[ops.length - 1][0], 'flush');
  });

  it('C5: a maxTurns-exhausted seed reports HOW to continue', async () => {
    const seed = { session: { id: 'rs-x', status: 'stopped', requirement: 'r', goals: [], hypotheses: [], transcript: [], digest: '', spend: { turns: 60, llmCalls: 60, promptTokens: 1, completionTokens: 1, estimated: false, parkedMs: 0 }, attachedUnits: [], artifactVersions: [], elapsedMs: 0, stopped: { reason: 'maxTurns', detail: null }, budgetAdvisories: ['half', 'author', 'finalize'] } };
    const s1 = createResearchSession({ requirement: 'r', llm: scriptedLlm([], []), tools: {}, seed });
    const r1 = await s1.run();
    assert.equal(r1.stopped.reason, 'maxTurns');
    assert.match(r1.stopped.detail, /raise the budget \(maxTurns\)/);
    const s2 = createResearchSession({ requirement: 'r', budgets: { maxTurns: 61 }, llm: scriptedLlm([reply(finishEnvelope())], []), tools: {}, seed });
    const r2 = await s2.run();
    assert.equal(r2.stopped.reason, 'completed', 'raised budget resumes past the old ceiling');
  });

  it('C5: wallClock stop carries the same hint shape', async () => {
    const seed = { session: { id: 'rs-y', status: 'stopped', requirement: 'r', goals: [], hypotheses: [], transcript: [], digest: '', spend: { turns: 0, llmCalls: 0, promptTokens: 0, completionTokens: 0, estimated: false, parkedMs: 0 }, attachedUnits: [], artifactVersions: [], elapsedMs: 999999, stopped: { reason: 'wallClock', detail: null }, budgetAdvisories: [] } };
    const s = createResearchSession({ requirement: 'r', budgets: { wallClockMs: 500000 }, llm: scriptedLlm([], []), tools: {}, seed });
    const r = await s.run();
    assert.equal(r.stopped.reason, 'wallClock');
    assert.match(r.stopped.detail, /raise the budget \(wallClockMs\)/);
  });
});

describe('audit C6: digest keeps assistant think excerpts and is capped', () => {
  it('compaction digests include think summaries and cap at 24000 chars', async () => {
    const think = 'hypothesis H1 looks wrong because the second anchor carried the metadata link and the popover mounted there — '.repeat(3);
    const replies = [];
    for (let i = 0; i < 150; i++) replies.push(reply(envelope('probe.count', { sel: '.c' + i }, { think })));
    replies.push(reply(finishEnvelope()));
    const session = createResearchSession({
      requirement: 'r',
      compaction: { thresholdChars: 4000, keepTurns: 2 },
      budgets: { maxTurns: 200 },
      llm: scriptedLlm(replies, []),
      tools: { 'probe.count': async () => ({ count: 1 }) }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    const st = session.state().session;
    assert.ok(st.digest.length > 0, 'digest built');
    assert.ok(st.digest.length <= 24500, 'digest capped (got ' + st.digest.length + ')');
    assert.match(st.digest, /chars elided/, 'elision disclosed');
    assert.match(st.digest, /hypothesis H1 looks wrong/, 'assistant think survives into the digest');
  });
});

describe('audit C13: budget advisories coordinate with the io.confirm gate', () => {
  it('author/finalize advisories tell the model to confirm the contract first', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'research-session.js'), 'utf8');
    assert.match(src, /If the I\/O contract is not confirmed yet, complete io\.confirm first/, 'author advisory');
    assert.match(src, /io\.confirm comes first/, 'finalize advisory');
    assert.ok(!/facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i.test(src));
  });
});

describe('audit C3: service.update gate consults cfg.epochOf', () => {
  it('a mid-session reload rejects receipts recorded in an earlier page epoch', async () => {
    const Obs = require('../lib/observation-log');
    let fakeEpoch = 2; // the research tab reloaded AFTER the probe was recorded
    const seedLog = Obs.createObservationLog();
    seedLog.record({ tool: 'probe.count', selectors: ['div.card'], summary: 'count=4', epoch: 1 });
    const session = createResearchSession({
      requirement: 'collect cards',
      llm: scriptedLlm([
        reply(envelope('service.update', { steps: [{ id: '1', script: 'return $extractList("div.card", { t: { selector: ".t" } });' }] })),
        reply(finishEnvelope())
      ], []),
      tools: {},
      epochOf: () => fakeEpoch,
      seed: { observation: seedLog.serialize() }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    const entry = session.state().session.transcript.find(e => e.kind === 'tool' && e.name === 'service.update');
    assert.ok(entry, 'service.update ran');
    assert.equal(entry.result.grounding, 'rejected');
    assert.match(JSON.stringify(entry.result.rejections), /stale/);
  });
});
