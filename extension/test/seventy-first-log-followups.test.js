// extension/test/seventy-first-log-followups.test.js
// Seventy-first log F1/F2:
//  F1 — verify.run economics disclosure (wallCostMs / wallBudgetRemainingMs /
//       medianVerifyCostMs + scarcity advisory) in session-tools.js
//  F2 — LLM/provider waits excluded from the wallClock budget with disclosure
//       (same semantics as parkedMs) in research-session.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionTools } = require('../lib/session-tools');
const { createResearchSession, computeEffectiveElapsed } = require('../lib/research-session');

// ---------- shared fixtures (shape mirrors session-tools.test.js makeDeps) ----------
function makeDeps(overrides) {
  const state = { draft: null };
  const d = Object.assign({
    rail: {
      pageOpen: async (a) => ({ tabId: 1, url: 'https://example.com', ready: true }),
      pageState: async () => ({ open: true, tabId: 1, url: 'https://example.com' }),
      executeDsl: async (s) => 5,
      ensureLock: async () => {}, releaseLock: async () => {}, dispose: async () => {}, tabId: 1
    },
    runVerify: async () => ({
      report: { ok: true, error: null, aborted: false, score: { score: 100 }, schemaOk: true, schemaMissing: [], detectors: {}, steps: [], finalResult: {}, pages: '1', eventCount: 0, events: [] },
      events: [], raw: {}
    }),
    getDraftService: () => state.draft,
    applyArtifact: (a) => { state.draft = { targetUrl: 'https://example.com', steps: a.steps }; },
    getTestInput: () => ({}),
    getOutputSchema: () => ({ type: 'object' }),
    getSteps: () => (state.draft ? state.draft.steps : []),
    annotationBridge: null,
    ioConfirmBridge: { request: async () => ({ confirmed: true }) }
  }, overrides || {});
  return { deps: d, state };
}
const GOOD_STEPS = [
  { id: 's1', name: 'extract', script: "return $extractList('div.card', {t:{selector:'.t'}});", onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
];
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function fakeSession(budgets, elapsedGetter) {
  return {
    spend: { turns: 1 },
    budgets: budgets,
    get elapsedMs() { return elapsedGetter(); }
  };
}

// ---------- F2: llm waits excluded from wallClock ----------
describe('71st log F2: llm/provider waits excluded from wallClock', () => {
  it('computeEffectiveElapsed subtracts llm waits and parked windows, floored at 0', () => {
    assert.equal(computeEffectiveElapsed(10000, 0, 3000, 2000), 5000);
    assert.equal(computeEffectiveElapsed(10000, 2000, 0, 0), 8000);
    assert.equal(computeEffectiveElapsed(100, 0, 99999, 0), 0, 'never negative');
    assert.equal(computeEffectiveElapsed(10000, 0, -50, null), 10000, 'garbage inputs are neutralized, not amplified');
  });

  function reply(content) { return { content, finish_reason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 1 } }; }
  function envelope(tool, args) { return JSON.stringify({ think: 't', tool, args: args || {} }); }
  function finishEnvelope() { return JSON.stringify({ think: 'done', finish: { summary: 'done' } }); }

  it('a slow provider does not consume the wall budget; the report discloses llmWaitMs', async () => {
    let t = 1000;
    const now = () => t;
    // The provider stalls 4s on EVERY call (rate-limit shape) while the
    // engine's own work costs ~100ms — wallClockMs 1000 would kill a
    // raw-clock session on turn 1.
    const replies = [envelope('noop'), envelope('noop'), finishEnvelope()];
    let i = 0;
    const session = createResearchSession({
      requirement: 'r',
      now: now,
      budgets: { wallClockMs: 1000, maxTurns: 10 },
      llm: async () => {
        const r = replies[Math.min(i, replies.length - 1)];
        i += 1;
        t += 4000; // provider stall — excluded from wallClock
        await sleep(1);
        return reply(r);
      },
      tools: { 'noop': async () => { t += 100; return { ok: true }; } }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed', 'net elapsed ~300ms < wallClock 1000ms — the 3×4s provider stalls must not count');
    assert.equal(report.spend.llmWaitMs, 12000, 'all three stalls disclosed');
  });

  it('the wallClock stop detail and TIME BUDGET suffix disclose the excluded llm waits', async () => {
    // Seed close to the ceiling: one llm call (20s provider stall, EXCLUDED)
    // then 2s of real tool work crosses the budget → wallClock stop with the
    // llm-wait disclosure on both the stop detail and the TIME BUDGET line.
    const seed = { session: { id: 'rs-71', status: 'stopped', requirement: 'r', goals: [], hypotheses: [], transcript: [], digest: '', spend: { turns: 0, llmCalls: 0, promptTokens: 0, completionTokens: 0, estimated: false, parkedMs: 0 }, attachedUnits: [], artifactVersions: [], elapsedMs: 499000, stopped: { reason: 'wallClock', detail: null }, budgetAdvisories: [] } };
    let t = 1000;
    const s = createResearchSession({
      requirement: 'r', now: () => t,
      budgets: { wallClockMs: 500000 },
      llm: async () => { t += 20000; return reply(envelope('burn')); },
      tools: { 'burn': async () => { t += 2000; return { ok: true }; } },
      seed
    });
    const r = await s.run();
    assert.equal(r.stopped.reason, 'wallClock');
    assert.match(r.stopped.detail, /LLM\/provider waits 20s excluded/);
    assert.match(r.stopped.detail, /\[TIME BUDGET — [^\]]*llm\/provider waits 20s \(excluded from wallClock\)/);
  });

  it('ctx.session.elapsedMs is a live getter (elapsed state + net segment) — the F1 economics data source', async () => {
    let t = 5000;
    let seen = null;
    let calls = 0;
    const s = createResearchSession({
      requirement: 'r', now: () => t,
      budgets: { wallClockMs: 100000 },
      llm: async () => {
        calls += 1;
        t += 1000; // provider wait — excluded
        return reply(calls === 1 ? envelope('probe.now') : finishEnvelope());
      },
      tools: { 'probe.now': async (a, ctx) => { seen = ctx.session.elapsedMs; t += 700; return { ok: true }; } }
    });
    await s.run();
    // tool ran after a 1000ms llm call (excluded) — elapsed must be ~0, not 1000+
    assert.ok(seen !== null && seen <= 100, 'llm wait excluded from live elapsedMs (got ' + seen + ')');
  });
});
