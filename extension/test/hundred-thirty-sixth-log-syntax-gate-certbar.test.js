// extension/test/hundred-thirty-sixth-log-syntax-gate-certbar.test.js
//
// 136th live log (80/80 maxTurns, v9 shipped unverified; v8 verify burned on
// a SyntaxError). Two root-caused defects:
//
// (1) UPDATE-TIME SYNTAX GAP. The final verify failed with
//     `SYNTAX_ERROR: Invalid regular expression: /?&]fbid=(\d{6,})/:
//     Nothing to repeat` — a `[` eaten (most plausibly by the lenient JSON
//     repair of one of the session's two truncated service.update replies)
//     yet the step LANDED as v8. The 98th-round construction parse lives
//     in wizard-utils validateForExecution — invoked only from wizard.js
//     deploy paths — while the session-time service.update pipeline runs
//     ONLY validateChain (pointer graph) + advisory lints. A
//     construction-broken script therefore surfaces exclusively at verify
//     (60-90s per burn), and when the budget dies first the broken script
//     is the shipped artifact. The parse now runs in the session-update
//     gate itself, covering single sends, chunk-assembled sends, patches,
//     and restores.
//
// (2) COLLECT-UNTIL CERTIFIES AT THE THEORETICAL MINIMUM. Three cold tabs
//     all read {collected:4, target:7, rounds:3, certifiedExhaustion:true}
//     while the research tab matched 19-20 containers for the SAME selector
//     family after persistent scrolling — the stallRounds>=2 bar certifies
//     at 3 total rounds (round 1 no stall, rounds 2-3 stall), the minimum
//     the loop can physically reach. Certification now requires
//     stallRounds >= 3 AND rounds >= 5; a loop that stops without that
//     evidence is NOT certified (the receipt says so) — exhaustion claims
//     need sustained evidence, not the first stall.
//
// No site tokens.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const SCHEMAS = {
  inputSchema: { type: 'object', properties: { k: { type: 'string' } } },
  outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } }
};

describe('136th log — session service.update runs the construction parse', () => {
  const { createSessionTools } = require('../lib/session-tools');
  function makeTools(applied) {
    return createSessionTools({
      rail: { executeDsl: async () => ({}), pageState: async () => ({}), epoch: 0 },
      runVerify: async () => ({ events: [], report: { ok: true, detectors: {} }, raw: {} }),
      probeFactory: () => ({ snippet: async () => ({ result: 'ok' }), count: async () => ({ count: 1 }) }),
      getDraftService: () => null,
      applyArtifact: (a) => applied.push(a),
      getTestInput: () => ({}),
      getOutputSchema: () => ({ type: 'object', properties: {} }),
      getSteps: () => [],
      ioConfirmBridge: { request: async (p) => ({ confirmed: true, testInput: p && p.testInput }) }
    }).tools;
  }
  async function confirm(tools) {
    await tools['io.confirm']({ testInput: { keyword: 'ml', count: 3 }, ...SCHEMAS });
  }
  const BAD = [{ id: 's1', script: 'const R=[/story_fbid=(\\w{8,})/,/?&]fbid=(\\d{6,})/];return {posts:R};', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }];
  const GOOD = [{ id: 's1', script: 'const R=[/story_fbid=(\\w{8,})/,/[?&]fbid=(\\d{6,})/];return {posts:R};', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }];

  it('a construction-broken regex is REJECTED at update time with the locator teaching', async () => {
    const applied = [];
    const tools = makeTools(applied);
    await confirm(tools);
    const r = await tools['service.update']({ steps: BAD });
    assert.ok(typeof r.error === 'string', 'rejected — got ' + JSON.stringify(r).slice(0, 140));
    assert.match(r.error, /STEP_SCRIPT_NOT_PARSEABLE/i);
    assert.match(r.error, /Invalid regular expression|Nothing to repeat/, 'names the actual parse failure');
    assert.match(r.error, /s1/, 'names the failing step');
    assert.equal(applied.length, 0, 'nothing applied');
  });

  it('the corrected regex passes — the gate is not a blanket reject', async () => {
    const applied = [];
    const tools = makeTools(applied);
    await confirm(tools);
    const r = await tools['service.update']({ steps: GOOD });
    assert.ok(r.updated === true || r.version, 'applies — got ' + JSON.stringify(r).slice(0, 140));
    assert.equal(applied.length, 1);
  });

  it('a chunk-assembled artifact is parsed AFTER assembly (the corrupted chunk cannot hide in the buffer)', async () => {
    const applied = [];
    const tools = makeTools(applied);
    await confirm(tools);
    const r1 = await tools['service.update']({ steps: [{ id: 's1', script: 'return 1;', onSuccess: 's2', onFailure: 'TERMINATE' }], more: true });
    assert.ok(r1.buffered === true);
    const r2 = await tools['service.update']({ steps: [{ id: 's2', script: BAD[0].script, onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }] });
    assert.ok(typeof r2.error === 'string', 'assembled artifact rejected');
    assert.match(r2.error, /s2/);
    assert.equal(applied.length, 0, 'nothing applied');
  });

  it('a patch whose merged graph contains the broken script is rejected too', async () => {
    const applied = [];
    const tools = makeTools(applied);
    await confirm(tools);
    void tools;
    // patch requires a current artifact via getDraftService; use a fresh
    // instance whose draft carries the GOOD standing artifact
    const { createSessionTools: cst } = require('../lib/session-tools');
    const t2 = cst({
      rail: { executeDsl: async () => ({}), pageState: async () => ({}), epoch: 0 },
      runVerify: async () => ({ events: [], report: { ok: true, detectors: {} }, raw: {} }),
      probeFactory: () => ({ snippet: async () => ({ result: 'ok' }), count: async () => ({ count: 1 }) }),
      getDraftService: () => ({ targetUrl: 'https://example.com', config: {}, steps: GOOD.map((s) => Object.assign({}, s)) }),
      applyArtifact: (a) => applied.push(a),
      getTestInput: () => ({}),
      getOutputSchema: () => ({ type: 'object', properties: {} }),
      getSteps: () => [],
      ioConfirmBridge: { request: async (p) => ({ confirmed: true, testInput: p && p.testInput }) }
    }).tools;
    await t2['io.confirm']({ testInput: { keyword: 'ml', count: 3 }, ...SCHEMAS });
    const rp = await t2['service.update']({ steps: BAD, patch: true });
    assert.ok(typeof rp.error === 'string', 'patch with broken script rejected — got ' + JSON.stringify(rp).slice(0, 140));
    assert.match(rp.error, /s1/);
    assert.equal(applied.length, 0);
  });
});

describe('136th log — collectUntil certification needs sustained evidence', () => {
  const CSRC = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
  function sliceFn(src, marker) {
    const i = src.indexOf(marker);
    assert.ok(i > -1, marker + ' found');
    let depth = 0, j = i;
    for (j = i; j < src.length; j++) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}') { depth -= 1; if (depth === 0) break; }
    }
    return src.slice(i, j + 1);
  }
  function makeCtx(counts, stallFromRound) {
    let rounds = 0;
    const ctx = {
      setTimeout, clearTimeout,
      querySelectorAllDeep: () => {
        const n = counts[Math.min(rounds - 1 < 0 ? 0 : rounds - 1, counts.length - 1)];
        return Array.from({ length: n }, (_, k) => ({ element: { getAttribute: (a) => a === 'href' ? '/p' + k : null } }));
      },
      getScrollOps: () => ({ scrollToBottomIncremental: async () => { rounds += 1; return { stalled: rounds >= stallFromRound, newScrollHeight: 1000, attempts: 1 }; } }),
      withTabActivation: async (l, fn) => fn(),
      resolveScrollTarget: () => null,
      sendDebugLog: () => {},
      notifyBackgroundDiagnostic: () => {},
      // 138th log: domCollectUntil now consults the outer-deadline guard
      // (no deadline passed in these tests → always null → no behavior
      // change for them).
      outerDeadlineExceeded: () => null,
      setTimeoutGlobal: null
    };
    vm.createContext(ctx);
    vm.runInContext(sliceFn(CSRC, 'async function domCollectUntil') + '\nthis.__f = domCollectUntil;', ctx);
    return ctx;
  }

  it('the theoretical minimum (stall at rounds 2-3, certified at 3) is NO LONGER certified', async () => {
    // counts: round0=4, then stall from round 2 → the old bar certified at rounds=3
    const ctx = makeCtx([4, 4, 4, 4, 4, 4, 4, 4], 2);
    const r = await ctx.__f('div.card', { targetCount: 7, idAttr: 'href', settleMs: 5, maxRounds: 3 });
    assert.equal(r.collected, 4);
    assert.ok(!r.exhaustion || r.exhaustion.certified !== true,
      '3 total rounds cannot certify — got ' + JSON.stringify(r.exhaustion));
  });

  it('sustained evidence (3 consecutive stalls, >=5 rounds) still certifies', async () => {
    const ctx = makeCtx([4, 4, 4, 4, 4, 4], 2);
    const r = await ctx.__f('div.card', { targetCount: 7, idAttr: 'href', settleMs: 5, maxRounds: 8 });
    assert.equal(r.collected, 4);
    assert.ok(r.exhaustion && r.exhaustion.certified === true, '5+ rounds with 3 consecutive stalls certifies');
    assert.match(String(r.exhaustion.evidence), /3 consecutive rounds/, 'the evidence names the sustained bar');
  });

  it('maxRounds exhaustion without the sustained bar is NOT certified and says why', async () => {
    const ctx = makeCtx([4, 4, 4, 4], 2);
    const r = await ctx.__f('div.card', { targetCount: 7, idAttr: 'href', settleMs: 5, maxRounds: 4 });
    assert.ok(!r.exhaustion || r.exhaustion.certified !== true);
    assert.ok(r.exhaustion && /insufficient|not sustained|not certified/i.test(JSON.stringify(r.exhaustion)),
      'the receipt discloses the insufficient evidence — got ' + JSON.stringify(r.exhaustion));
  });

  it('positive-frozen + sustained still certifies (133 everPositive guard intact)', async () => {
    const ctx = makeCtx([4, 4, 4, 4, 4, 4], 3);
    const r = await ctx.__f('div.card', { targetCount: 7, idAttr: 'href', settleMs: 5, maxRounds: 8 });
    assert.equal(r.collected, 4);
    assert.ok(r.exhaustion && r.exhaustion.certified === true);
  });
});
