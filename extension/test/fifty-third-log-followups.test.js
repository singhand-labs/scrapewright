// extension/test/fifty-third-log-followups.test.js
// Fifty-third log — the FIRST session on glm-5.3-flash died at turn 18/60
// with reason "protocol": the model intermittently emits THINK-ONLY micro
// replies (131-144 chars: {"think":"8 个帖子位置 (aria…"} — valid JSON,
// reasoning, no action). Five violations in 18 turns; the repair round saved
// four (the "tiny prompt tokens" on repair calls are the gateway's
// uncached-delta reporting under the anthropic lane's automatic prompt
// caching, not a blind repair), the fifth repair ALSO came back think-only
// and the two-strike policy killed the session with 70% of the budget left.
// Zero tool errors, zero verifies — the only failure class was the protocol
// under-commitment.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createResearchSession } = require('../lib/research-session');
const { buildSystemPrompt } = require('../lib/session-protocol');

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
function thinkOnly(text) { return JSON.stringify({ think: text || 'considering the feed positions' }); }

// ---------------------------------------------------------------------------
// F1: class-aware nudges + the system-prompt commit line
describe('F1: think-only protocol teaching (fifty-third log)', () => {
  it('the system prompt teaches that a reply ending after think has no action', () => {
    const sys = buildSystemPrompt({ base: '', toolSpecs: [], knowledgeIndex: [], attachedUnits: [] });
    assert.match(sys, /think" alone is not a turn/i, 'commit line present');
    assert.match(sys, /commit/i);
  });

  it('the missing-action nudge teaches COMMITTING the action, not JSON quoting', async () => {
    const calls = [];
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: scriptedLlm([
        reply(thinkOnly()),
        reply(envelope('probe.count', { sel: 'div.card' })),
        reply(finishEnvelope('ok'))
      ], calls),
      tools: { 'probe.count': async () => ({ count: 1 }) }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    // The repair call (2nd LLM call) must carry the class-aware nudge.
    const repairMessages = calls[1].messages;
    const repairText = repairMessages.map((m) => m.content).join('\n');
    assert.match(repairText, /ended after .think.|never committed an action/i, 'names the real failure class');
    assert.match(repairText, /ADD exactly one of|"tool"|commit/i);
  });

  it('a JSON-shape violation (not-object) keeps the quoting-led nudge', async () => {
    const calls = [];
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: scriptedLlm([
        reply('this is not json at all'),
        reply(envelope('probe.count', { sel: 'div.card' })),
        reply(finishEnvelope('ok'))
      ], calls),
      tools: { 'probe.count': async () => ({ count: 1 }) }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    const repairText = calls[1].messages.map((m) => m.content).join('\n');
    assert.match(repairText, /Strict JSON quoting/i, 'JSON classes keep the quoting lecture');
  });
});

// ---------------------------------------------------------------------------
// F2: a second (escalated) repair round for action-shape violations
describe('F2: two repair rounds for action-shape violations (fifty-third log)', () => {
  it('think-only ×2 then a good reply → the session SURVIVES (the fifty-third-log death shape)', async () => {
    const events = [];
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: scriptedLlm([
        reply(thinkOnly()),
        reply(thinkOnly()),
        reply(envelope('probe.count', { sel: 'div.card' })),
        reply(finishEnvelope('survived'))
      ], []),
      tools: { 'probe.count': async () => ({ count: 1 }) },
      onEvent: (e) => events.push(e)
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed', 'was: stopped at reason "protocol" on the second think-only');
    assert.equal(report.stopped.detail, 'survived');
    assert.ok(events.some((e) => e.type === 'protocol_violation' && e.violation === 'missing-action'));
  });

  it('the second repair round carries the escalated FINAL-CHANCE nudge', async () => {
    const calls = [];
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: scriptedLlm([
        reply(thinkOnly()),
        reply(thinkOnly()),
        reply(envelope('probe.count', { sel: 'div.card' })),
        reply(finishEnvelope('ok'))
      ], calls),
      tools: { 'probe.count': async () => ({ count: 1 }) }
    });
    await session.run();
    const secondRepairText = calls[2].messages.map((m) => m.content).join('\n');
    assert.match(secondRepairText, /FINAL/i, 'escalation marker on the second round');
  });

  it('three think-only replies in one turn still stop the session (bounded)', async () => {
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: scriptedLlm([
        reply(thinkOnly()),
        reply(thinkOnly()),
        reply(thinkOnly())
      ], []),
      tools: { 'probe.count': async () => ({ count: 1 }) }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'protocol');
    assert.match(report.stopped.detail, /missing-action/);
  });

  it('JSON-shape classes keep the original two-strike behavior (one repair, then stop)', async () => {
    const calls = [];
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: scriptedLlm([
        reply('not json one'),
        reply('not json two')
      ], calls),
      tools: {}
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'protocol');
    // Turn-1 LLM calls only: the original + exactly one repair.
    assert.equal(calls.length, 2, 'no third call for JSON classes');
  });

  it('ambiguous-action (tool AND finish) is also an action-shape class with two rounds', async () => {
    const both = JSON.stringify({ think: 't', tool: 'probe.count', args: {}, finish: { summary: 's' } });
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: scriptedLlm([
        reply(both),
        reply(both),
        reply(finishEnvelope('done'))
      ], []),
      tools: { 'probe.count': async () => ({ count: 1 }) }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed', 'survives via the second round');
  });
});
