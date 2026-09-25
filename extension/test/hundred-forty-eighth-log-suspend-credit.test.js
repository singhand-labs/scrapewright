// extension/test/hundred-forty-eighth-log-suspend-credit.test.js
//
// 148th log: the session's wall clock died to MACHINE SLEEP, not work. Two
// suspensions (25.6 min at 06:17, 34.7 min at 06:43 — llm_reply gaps, host
// poll errors bracketing them) consumed a 30-min wallClock whole; the v5
// verify (dispatched 06:43:35, deadline 06:45:35) woke at 07:04 to a
// long-expired deadline and correctly died OUTER_DEADLINE (the 138th/140th
// machinery working), but the session then had no wall budget left for the
// one re-verify that would have confirmed the postId fix — a fully
// researched session starved by sleep. The 71st round excluded llm waits;
// suspension gaps inside tool dispatches are the same class.
//
// Fixes under test:
//   A. computeEffectiveElapsed gains suspendCreditMs; the turn loop books
//      dispatch wall beyond the no-legit-dispatch floor (240s, injectable
//      via cfg.toolSuspendFloorMs) as suspendCredit, excluded from wallClock
//      and disclosed (spend.suspendCreditMs + transcript note + stop detail).
//   B. the OUTER_DEADLINE relay pre-check appends a suspension note when the
//      request arrived >60s past its deadline — the machine-sleep signature;
//      the model is told to re-run, not shrink the step.
//
// No site tokens.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createResearchSession } = require('../lib/research-session');

const RS_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'research-session.js'), 'utf8');
const BG_SRC = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function reply(content) {
  return { content, finish_reason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 10 } };
}
function envelope(tool, args) {
  return JSON.stringify({ think: 't', tool, args: args || {} });
}
function finishEnvelope(summary) { return JSON.stringify({ think: 'done', finish: { summary: summary || 'done' } }); }

describe('148th log A — suspension wall-credit', () => {
  it('a tool dispatch far beyond the floor is credited back; the wall budget is NOT consumed by sleep', async () => {
    const events = [];
    const session = createResearchSession({
      requirement: 'r',
      // floor injectable so the test does not wait 4 real minutes: floor
      // 50ms; the tool sleeps 250ms → credit 200ms
      toolSuspendFloorMs: 50,
      budgets: { maxTurns: 60, maxTokensPerCall: 8192, tokenCap: 2000000, wallClockMs: 300 },
      llm: (() => {
        const replies = [
          reply(envelope('probe.count', {})),
          reply(envelope('slow.tool', {})),
          reply(finishEnvelope())
        ];
        let i = 0;
        return async () => replies[i++];
      })(),
      tools: {
        'probe.count': async () => ({ count: 1 }),
        'slow.tool': async () => { await new Promise((r) => setTimeout(r, 250)); return { ok: true }; }
      },
      onEvent: (e) => events.push(e)
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed', 'with ~200ms credited back, the 300ms wall budget survives — got ' + JSON.stringify(report.stopped).slice(0, 160));
    assert.ok(report.spend.suspendCreditMs >= 150, 'credit disclosed — got ' + report.spend.suspendCreditMs);
    const st = session.state().session.transcript;
    assert.ok(st.some((t) => t.kind === 'system' && /SYSTEM SUSPENSION CREDIT/.test(t.text)), 'the transcript note names the credit');
    assert.match(st.find((t) => t.kind === 'system' && /SYSTEM SUSPENSION CREDIT/.test(t.text)).text, /slow\.tool/);
  });

  it('WITHOUT the credit the same shape dies to wallClock (the incident) — the credit is what saves it', async () => {
    const session = createResearchSession({
      requirement: 'r',
      toolSuspendFloorMs: 50,
      budgets: { maxTurns: 60, maxTokensPerCall: 8192, tokenCap: 2000000, wallClockMs: 300 },
      llm: (() => {
        const replies = [reply(envelope('slow.tool', {}))];
        let i = 0;
        return async () => replies[Math.min(i++, replies.length - 1)];
      })(),
      tools: { 'slow.tool': async () => { await new Promise((r) => setTimeout(r, 250)); return { ok: true }; } }
    });
    const report = await session.run();
    // without the credit the 250ms dispatch eats the 300ms budget mid-turn
    assert.notEqual(report.stopped.reason, 'completed');
  });

  it('dispatches under the floor cost full wall (no free budget for ordinary work)', async () => {
    const session = createResearchSession({
      requirement: 'r',
      toolSuspendFloorMs: 5000,
      budgets: { maxTurns: 60, maxTokensPerCall: 8192, tokenCap: 2000000, wallClockMs: 400 },
      llm: (() => {
        const replies = [reply(envelope('slow.tool', {}))];
        let i = 0;
        return async () => replies[Math.min(i++, replies.length - 1)];
      })(),
      tools: { 'slow.tool': async () => { await new Promise((r) => setTimeout(r, 250)); return { ok: true }; } }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'wallClock', 'a 250ms dispatch under a 5s floor gets NO credit — got ' + JSON.stringify(report.stopped).slice(0, 140));
    assert.equal((report.spend.suspendCreditMs || 0), 0);
    assert.match(report.stopped.detail, /system suspension credit 0s excluded/);
  });

  it('computeEffectiveElapsed subtracts suspendCredit alongside llmWait and parked', () => {
    const { computeEffectiveElapsed } = require('../lib/research-session');
    assert.equal(computeEffectiveElapsed(100000, 0, 10000, 5000, 20000), 65000);
    assert.equal(computeEffectiveElapsed(100000, 0, 10000, 5000), 85000, 'legacy 4-arg call unaffected');
  });
});

describe('148th log B — suspension-aware OUTER_DEADLINE hint', () => {
  it('the relay pre-check appends the re-run note when the overshoot exceeds 60s (source audit)', () => {
    const i = BG_SRC.indexOf('OUTER_DEADLINE_EXCEEDED: the owning script');
    assert.ok(i > -1, 'pre-check found');
    const region = BG_SRC.slice(i - 600, i + 900);
    assert.match(region, /overshootMs > 60000/, 'overshoot threshold');
    assert.match(region, /system suspension \(machine sleep \/ SW suspend\)/, 'names the cause');
    assert.match(region, /do NOT shrink the step budget/, 'forbids the wrong fix');
  });
});
