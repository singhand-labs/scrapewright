// extension/test/fifty-fourth-log-followups.test.js
// Fifty-fourth log — a TWO-MODEL comparison round; both sessions died.
//
//  console.log (glm-5.3-flash, 33 turns): stopped "protocol — not-object …
//  cut-off: braces never closed". The model drafts ENTIRE output schemas
//  inside its think text (2145-char replies), and the provider cuts the
//  completion mid-JSON while LYING finish_reason:"stop" (max_tokens is
//  32768 — nowhere near). Five truncation violations in 33 turns; the
//  shorter-resend + continuation chain saved four, the fifth cascade
//  (original cut → repair cut → continuation unspliceable) killed the
//  session during research (zero verifies — it never reached the artifact).
//
//  console5.3.log (glm-5.3, 47 turns): stopped "wallClock — ~2578s". The
//  repair call's prompt legitimately reached ~70K chars (transcript +
//  probe.sample payloads), glm-5.3 exceeds the user's 120s timeout, the
//  llm client retries 3× with backoff (~6-7 min per callLlm), and the
//  ENGINE callLlm loop retried THAT three more times — a ~20-minute spiral
//  that ate the wall clock. The v1 artifact landed 3ms before the stop:
//  the session never got to verify it.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createResearchSession } = require('../lib/research-session');
const Protocol = require('../lib/session-protocol');

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
function reply(content) {
  return { content, finish_reason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 10 } };
}
function envelope(tool, args) {
  return JSON.stringify({ think: 't', tool, args: args || {} });
}
function finishEnvelope(summary) { return JSON.stringify({ think: 'done', finish: { summary: summary || 'done' } }); }

// ---------------------------------------------------------------------------
// F1: deterministic close-braces salvage for the cut-off class
describe('F1: cut-off salvage (fifty-fourth log, glm-5.3-flash truncation)', () => {
  it('a reply cut mid-string inside a schema-drafting think closes to a think-only turn (missing-action, not not-object)', () => {
    // The real fifty-fourth-log shape: the schema draft rides INSIDE think
    // with properly escaped quotes; the provider cut the completion
    // mid-string, mid-schema.
    const cut = '{"think":"关键突破：先提出合同 {\\"posts\\":{\\"type\\":\\"array\\",\\"items\\":{\\"required\\":[\\"postTime\\"],\\"properties\\":{\\"postTime\\":{\\"type\\":\\"string\\",\\"description\\":\\"发帖时间（悬浮时间戳的完整绝对值）\\"},\\"location\\":{\\"type\\":\\"str';
    const out = Protocol.parseAssistantTurn(cut);
    assert.equal(out.ok, false);
    assert.equal(out.violation, 'missing-action',
      'the salvage closes the braces so the turn classifies as think-only (the fifty-third-log two-round repair path), not the fatal not-object: ' + JSON.stringify(out));
  });

  it('a reply cut inside the ACTION recovers the action outright', () => {
    const cut = '{"think":"count the cards now","tool":"probe.count","args":{"sel":"div.card';
    const out = Protocol.parseAssistantTurn(cut);
    assert.equal(out.ok, true, 'salvage completes the object: ' + JSON.stringify(out));
    assert.equal(out.turn.tool, 'probe.count');
  });

  it('a cut mid-escape does not corrupt the salvage', () => {
    const cut = '{"think":"nearing the end of the object\\';
    const out = Protocol.parseAssistantTurn(cut);
    // Either salvage succeeds (missing-action) or fails (not-object) — it
    // must never produce a WRONG ok turn or throw.
    assert.ok(out.ok === false);
  });

  it('balanced/garbage replies are untouched by the salvage (not-object stays not-object)', () => {
    const out = Protocol.parseAssistantTurn('this is not json { at all');
    assert.equal(out.ok, false);
    assert.equal(out.violation, 'not-object');
  });

  it('the system prompt keeps think SHORT and puts schema drafts in tool args', () => {
    const sys = Protocol.buildSystemPrompt({ base: '', toolSpecs: [], knowledgeIndex: [], attachedUnits: [] });
    assert.match(sys, /short/i);
    assert.match(sys, /think/i);
    assert.match(sys, /args/i);
    assert.match(sys, /draft|schema/i, 'names where drafts belong');
  });
});

// ---------------------------------------------------------------------------
// F2: the retry-spiral kill (glm-5.3 wallClock death)
describe('F2: engine-level retry de-multiplication + wallClock guard (fifty-fourth log)', () => {
  it('a TIMED-OUT llm call is NOT retried at the engine layer (the client already owns retries)', async () => {
    const calls = [];
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: scriptedLlm([{ __throw: 'LLM API timed out after 120000ms (https://open.bigmodel.cn/api/anthropic/v1/messages)' }], calls),
      tools: {}
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'llm:error');
    assert.equal(calls.length, 1, 'exactly ONE engine-side call — was: 3 engine × 3 client = 9 wire calls, ~20 min');
  });

  it('a NON-timeout llm error still gets engine retries (regression)', async () => {
    const calls = [];
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: scriptedLlm([{ __throw: 'network glitch' }, reply(envelope('probe.count', { sel: 'div.card' })), reply(finishEnvelope('ok'))], calls),
      tools: { 'probe.count': async () => ({ count: 1 }) }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed', 'a transient non-timeout error is still retried at the engine layer');
  });

  it('the retry loop stops on the wallClock margin instead of spiraling', async () => {
    const calls = [];
    let now = 1_000_000;
    const session = createResearchSession({
      requirement: 'collect posts',
      budgets: { wallClockMs: 60_000, maxTurns: 60 },
      clock: () => now,
      llm: async (req) => {
        calls.push(req);
        now += 30_000; // each failed call eats half the budget
        throw new Error('network glitch');
      },
      tools: {}
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'wallClock', 'died as a resumable wallClock stop, not an error spiral');
    assert.ok(calls.length <= 3, 'bounded calls: ' + calls.length);
  });
});
