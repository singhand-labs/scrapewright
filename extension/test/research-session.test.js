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
    assert.ok(nudges[0].text.includes('PROTOCOL VIOLATION (no-json)'));
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
    assert.equal(entry.result.totalCards, 8);
    assert.ok(entry.result.values.some(v => v.value === 'ad' && v.cards === 2));
  });
});
