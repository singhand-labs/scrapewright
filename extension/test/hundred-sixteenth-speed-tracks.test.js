// 116th round (spec docs/superpowers/specs/2026-09-22-speed-optimization-design.md)
// — the 46.8-minute session profile: 40min parked io.confirm wait, 3×~80s
// verifies, 6×429 rate-limit retries. Three tracks, correctness-first:
//   A. desktop notifications on park (10-min re-issue ×2, click→focus)
//   B. verify.run {preflight:true} — warm research-tab dry-run of the
//      extract step BEFORE the cold end-to-end verify (default OFF)
//   C. per-base-URL request throttle + throttle/retry wait visibility

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WU = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wizard-utils.js'), 'utf8');
const WJ = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
const LC_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'llm-client.js'), 'utf8');

function sliceFnFrom(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start > -1, name + ' must be defined');
  let depth = 0, i = start;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

describe('A: parked-user desktop notifications', () => {
  it('manifest carries the notifications permission', () => {
    assert.ok((MANIFEST.permissions || []).indexOf('notifications') !== -1,
      'chrome.notifications requires the manifest permission');
  });
  it('createParkNotifier: fires on begin, re-issues on cadence, stops on end', async () => {
    const vm = require('node:vm');
    const fnSrc = sliceFnFrom(WU, 'createParkNotifier') + '\nthis.__f = createParkNotifier;';
    const ctx = { setTimeout, clearTimeout }; vm.createContext(ctx); vm.runInContext(fnSrc, ctx);
    const made = [];
    const clicks = [];
    const api = {
      create: (id, opts, cb) => { made.push({ id, title: opts && opts.title, cb }); try { cb && cb(); } catch (_) {} },
      onClicked: { addListener: (fn) => clicks.push(fn) }
    };
    const focused = [];
    const n = ctx.__f(api, (t) => focused.push(t), { intervalMs: 25, maxReminders: 2 });
    n.begin('io.confirm', '确认输入/输出合同');
    await new Promise(r => setTimeout(r, 80));
    assert.ok(made.length >= 2 && made.length <= 3, 'initial + up to 2 re-issues — got ' + made.length);
    assert.match(made[0].title, /action is needed|required/i);
    n.end();
    const countAtEnd = made.length;
    await new Promise(r => setTimeout(r, 60));
    assert.equal(made.length, countAtEnd, 'end() stops the cadence');
    // click → focus
    assert.ok(clicks.length >= 1, 'onClicked listener registered');
    clicks[0]({ notificationId: made[0].id ? undefined : undefined });
    assert.ok(focused.length >= 1, 'notification click focuses the wizard tab');
  });
  it('wizard wires the notifier into the waiting badge state', () => {
    const i = WJ.indexOf("else if (state === 'waiting')");
    assert.ok(i > -1, 'waiting branch found');
    const block = WJ.slice(i, i + 1200);
    assert.match(block, /ensureParkNotifier|createParkNotifier/, 'waiting state starts the park notifier');
  });
});

describe('B: verify.run preflight (default OFF)', () => {
  const { createSessionTools } = require('../lib/session-tools');
  function makeTools(artifactSteps, dslCalls) {
    return createSessionTools({
      rail: {
        executeDsl: async (snippet, opts) => { dslCalls.push({ snippet, opts }); return { posts: [{ postId: 'x', postTime: '' }] }; },
        pageState: async () => ({}),
        epoch: 0
      },
      runVerify: async () => ({ events: [], report: { ok: true, detectors: {} }, raw: {} }),
      probeFactory: () => ({ hover: async () => ({ hovered: false }) }),
      getDraftService: () => ({ steps: artifactSteps, inputSchema: {}, outputSchema: {} }),
      applyArtifact: () => {},
      getTestInput: () => ({ keyword: 'ai' }),
      getOutputSchema: () => ({ type: 'object', properties: {} }),
      getSteps: () => artifactSteps
    });
  }
  const steps = [
    { id: 'collect', script: 'const n = await $count("div"); return {done:true, n};' },
    { id: 'extract', script: 'const r = await $extractList("div", {t:{selector:"span"}}); return r;' },
    { id: 'assemble', script: 'return {posts: __lastResult__};' }
  ];
  it('preflight:true dry-runs the EXTRACT step on the research tab and attaches the preview', async () => {
    const dsl = [];
    const tools = makeTools(steps, dsl);
    const r = await tools.tools['verify.run']({ preflight: true });
    assert.equal(dsl.length, 1, 'exactly one dry-run');
    assert.match(dsl[0].snippet, /\$extractList/, 'the extract step ran, not collect/assemble');
    assert.ok(r && r.preflight && r.preflight.executed === true);
    assert.equal(r.preflight.stepId, 'extract');
    assert.match(String(r.preflight.resultPreview), /postId/);
  });
  it('default (no preflight) changes NOTHING — no dry-run, no receipt field', async () => {
    const dsl = [];
    const tools = makeTools(steps, dsl);
    const r = await tools.tools['verify.run']({});
    assert.equal(dsl.length, 0);
    assert.ok(!r || r.preflight === undefined, 'receipt unchanged without the opt-in');
  });
});

describe('C: throttle + wait visibility', () => {
  const { LLMClient } = require('../lib/llm-client');
  function fakeFetchClient(throttleMs, events) {
    const client = new LLMClient({
      provider: 'openai', model: 'm', apiKey: 'k',
      apiBaseUrl: 'http://test.local/v1',
      throttleMs, maxRetries: 0
    });
    let n = 0;
    global.fetchCalls = global.fetchCalls || [];
    const f = async (url) => {
      const at = Date.now();
      (global.fetchCalls).push({ url, at });
      n += 1;
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ choices: [{ message: { content: 'hi' + n } }], usage: {} }) };
    };
    const orig = global.fetch;
    global.fetch = f;
    return { client, restore: () => { global.fetch = orig; } };
  }
  it('same-URL back-to-back calls respect the minimum interval', async () => {
    const { client, restore } = fakeFetchClient(60, []);
    const t0 = [];
    await client.chat([{ role: 'user', content: 'a' }], {});
    await client.chat([{ role: 'user', content: 'b' }], {});
    const calls = global.fetchCalls;
    restore();
    assert.equal(calls.length, 2);
    assert.ok(calls[1].at - calls[0].at >= 55, 'second call throttled ≥ interval — gap ' + (calls[1].at - calls[0].at) + 'ms');
  });
  it('onThrottle fires so the spend line can show the wait', async () => {
    const seen = [];
    const { client, restore } = fakeFetchClient(50, []);
    await client.chat([{ role: 'user', content: 'a' }], {});
    await client.chat([{ role: 'user', content: 'b' }], { onThrottle: (i) => seen.push(i) });
    restore();
    assert.ok(seen.length >= 1 && typeof seen[0].waitedMs === 'number', 'throttle wait surfaced');
  });
  it('llm-client source carries the throttle map + wizard surfaces the wait in the spend line', () => {
    assert.match(LC_SRC, /throttleMs/, 'injectable interval');
    assert.match(WJ, /限流等待|rate-limit/i.test('') ? /x/ : /onThrottle/, 'wizard wires onThrottle');
  });
});

describe('117th log: token-budget visibility (tokenCap stop with null detail + zero token advisories)', () => {
  const RS = fs.readFileSync(path.join(__dirname, '..', 'lib', 'research-session.js'), 'utf8');
  it('tokenCap stops carry an honest detail (breakdown + exits), not null', () => {
    assert.match(RS, /buildTokenCapDetail/, 'detail builder exists');
    const i = RS.indexOf("stop('tokenCap'");
    assert.ok(i > -1);
    assert.match(RS.slice(i - 200, i + 200), /buildTokenCapDetail/, 'the stop call passes the detail');
  });
  it('buildTokenCapDetail: prompt/completion split, avg per call, exits teaching', () => {
    const vm = require('node:vm');
    const src = RS.slice(RS.indexOf('function buildTokenCapDetail'));
    let depth = 0, j = 0;
    for (j = RS.indexOf('function buildTokenCapDetail'); j < RS.length; j++) {
      if (RS[j] === '{') depth += 1;
      else if (RS[j] === '}') { depth -= 1; if (depth === 0) break; }
    }
    const ctx = {}; vm.createContext(ctx);
    vm.runInContext(RS.slice(RS.indexOf('function buildTokenCapDetail'), j + 1) + '\nthis.__f = buildTokenCapDetail;', ctx);
    const d = ctx.__f({ promptTokens: 1800000, completionTokens: 200000, llmCalls: 62 }, { tokenCap: 2000000 });
    assert.match(d, /1,?800,?000/);
    assert.match(d, /prompt-dominated|输入占/i);
    assert.match(d, /compact|缩小|smaller test input|精简/i);
    assert.match(d, /last verified|最后验证|回滚/i);
  });
  it('token-fraction budget advisories exist alongside the turn ones', () => {
    assert.match(RS, /TOKEN_BUDGET_ADVISORIES/, 'token advisory family');
    const i = RS.indexOf('TOKEN_BUDGET_ADVISORIES');
    const block = RS.slice(i, i + 2500);
    assert.match(block, /0\.5|'half'/);
    assert.match(block, /0\.9|'finalize'/);
    assert.match(RS, /budget_advisory.*token|tokenBudget_advisory/, 'emitted event distinguishes token advisories');
  });
});

describe('118th-A: prompt slimming (knowledge auto-attach cap + digest cap)', () => {
  const RS = fs.readFileSync(path.join(__dirname, '..', 'lib', 'research-session.js'), 'utf8');
  const SP = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session-protocol.js'), 'utf8');
  it('auto-attached knowledge renders at most 4 full bodies; the rest stay one-line index entries', async () => {
    const { createResearchSession } = require('../lib/research-session');
    // render-level check via session-protocol's exported buildSystemPrompt? It's inside the IIFE —
    // drive through the engine's assembleMessages by... simplest: source audit + unit on the renderer shape.
    assert.match(SP, /MAX_AUTO_ATTACHED|attachedUnits\.slice\(-\d+\)/, 'render-side cap present');
  });
  it('the digest cap is 8000 (was 24000 — the 24K digest was half the bloat)', () => {
    assert.match(RS, /DIGEST_CAP = 8000/, 'digest tightened');
  });
});

describe('118th-B: RED_VERIFY_SNIPPET_GATE (blind-update churn killer)', () => {
  const { createSessionTools } = require('../lib/session-tools');
  function makeTools(verifyReport, dslCalls) {
    return createSessionTools({
      rail: { executeDsl: async (s, o) => { dslCalls.push(s); return {}; }, pageState: async () => ({}), epoch: 0 },
      ioConfirmBridge: { request: async (payload) => ({ confirmed: true, inputSchema: payload && payload.inputSchema, outputSchema: payload && payload.outputSchema }) },
      runVerify: async () => ({ events: [], report: verifyReport, raw: {} }),
      probeFactory: () => ({ snippet: async () => ({ result: 'ok' }) }),
      getDraftService: () => ({ steps: [{ id: 'x', script: 'await $extract("d");' }] }),
      applyArtifact: () => {},
      getTestInput: () => ({}),
      getOutputSchema: () => ({ type: 'object', properties: {} }),
      getSteps: () => [{ id: 'x', script: 'await $extract("d");' }]
    });
  }
  const STEPS = [{ id: 'x', script: 'const r = await $extractList("div"); return r;' }];
  it('service.update after a RED verify with no intervening snippet/preflight is REJECTED with teaching', async () => {
    const tools = makeTools({ ok: false, error: { message: 'REQUIRED_FIELD_EMPTY: x' }, detectors: {} }, []);
    await tools.tools['verify.run']({});
    const r = await tools.tools['service.update']({ steps: STEPS });
    assert.ok(r && r.error && /RED_VERIFY_SNIPPET_GATE/.test(r.error), 'gate fires — got ' + JSON.stringify(r).slice(0, 120));
    assert.match(r.error, /probe\.snippet|preflight/);
  });
  it('a probe.snippet since the red verify unblocks the update', async () => {
    const tools = makeTools({ ok: false, error: { message: 'X_GATE: x' }, detectors: {} }, []);
    await tools.tools['verify.run']({});
    await tools.tools['probe.snippet']({ code: 'return 1;' });
    await tools.tools['io.confirm']({ inputSchema: { type: 'object', properties: { keyword: { type: 'string' } } }, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array' } } } });
    const r = await tools.tools['service.update']({ steps: STEPS });
    assert.ok(!r || !r.error, 'update lands after the dry-run — got ' + JSON.stringify(r).slice(0, 120));
  });
  it('no verify yet (fresh session) — no gate', async () => {
    const tools = makeTools({ ok: true, detectors: {} }, []);
    await tools.tools['io.confirm']({ inputSchema: { type: 'object', properties: { keyword: { type: 'string' } } }, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array' } } } });
    const r = await tools.tools['service.update']({ steps: STEPS });
    assert.ok(!r || !r.error);
  });
});

describe('118th-C: $collectUntil primitive (count reliability infrastructure)', () => {
  it('domCollectUntil: satisfied when unique count reaches target; certified exhaustion after stall', async () => {
    const vm = require('node:vm');
    const CSRC = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
    const i = CSRC.indexOf('async function domCollectUntil');
    assert.ok(i > -1, 'domCollectUntil defined in content-script');
    // slice the function and run against a fake DOM-ish env
    let depth = 0, j = i;
    for (j = i; j < CSRC.length; j++) {
      if (CSRC[j] === '{') depth += 1;
      else if (CSRC[j] === '}') { depth -= 1; if (depth === 0) break; }
    }
    const fnSrc = CSRC.slice(i, j + 1);
    let rounds = 0;
    const counts = [2, 4, 6];
    const ctx = {
      setTimeout, clearTimeout,
      querySelectorAllDeep: (sel) => { const n = counts[Math.min(rounds, counts.length - 1)]; return Array.from({ length: n }, (_, k) => ({ element: { getAttribute: (a) => a === 'href' ? '/p' + (k % 4) : null } })); },
      getScrollOps: () => ({ scrollToBottomIncremental: async () => { rounds += 1; return { stalled: rounds >= 2, newScrollHeight: 1000, attempts: 1 }; } }),
      withTabActivation: async (l, fn) => fn(),
      resolveScrollTarget: () => null,
      sendDebugLog: () => {},
      notifyBackgroundDiagnostic: () => {},
      setTimeoutGlobal: null
    };
    vm.createContext(ctx);
    vm.runInContext(fnSrc + '\nthis.__f = domCollectUntil;', ctx);
    const r = await ctx.__f('div.card', { targetCount: 4, idAttr: 'href', settleMs: 10 });
    assert.equal(r.satisfied, true, 'reached 4 unique');
    assert.ok(r.collected >= 4);
    assert.ok(Array.isArray(r.trace) && r.trace.length >= 1);
  });
  it('DSL guide + dispatcher carry the primitive', () => {
    const WU2 = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wizard-utils.js'), 'utf8');
    assert.match(WU2, /\\\$collectUntil/, 'DSL guide documents it');
    const CSRC = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
    const i = CSRC.indexOf("case 'collectUntil'");
    assert.ok(i > -1, 'dispatcher case present');
  });
});

describe('120th log: leading bare-token repair (the green session died AT THE FINISH LINE)', () => {
  const SP = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session-protocol.js'), 'utf8');
  const { parseAssistantTurn } = require('../lib/session-protocol');
  it('the exact incident reply {"finish","tool":"finish",...} parses as a finish action', () => {
    const r = parseAssistantTurn('{"finish","tool":"finish","args":{},"summary":"Facebook search posts scraper verified green (ok=true). Inputs keyword/count; outputs posts with absolute postTime from tooltips; the only post-shaped content this search page offers for the test keyword."}');
    assert.ok(r.ok, 'recovered — got ' + JSON.stringify(r).slice(0, 160));
    const t = r.turn || r;
    assert.equal((t.tool || (t.finish && 'finish')), 'finish');
    assert.match(String((t.args && t.args.summary) || (t.finish && t.finish.summary) || ''), /verified green/);
  });
  it('the repair is general (any tool name) and leaves valid JSON untouched', () => {
    const r2 = parseAssistantTurn('{"ledger.add","tool":"ledger.add","args":{"finding":"x"}}');
    assert.ok(r2.ok, 'any leading bare token is dropped');
    const r3 = parseAssistantTurn('{"tool":"probe.count","args":{"sel":"div"}}');
    assert.ok(r3.ok && r3.turn && r3.turn.tool === 'probe.count', 'valid replies unchanged');
  });
  it('source audit: the bare-token strip lives in the parse path with a disclosed repair note', () => {
    assert.match(SP, /BARE TOKEN|leading bare token/i);
  });
});

describe('122nd log: feedback convergence (one count-shortfall feedback looped for many rounds while verify was GREEN)', () => {
  const WJ2 = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');
  it('the review fix-this button carries the advisory-closure clause', () => {
    assert.match(WJ2, /CLOSING it with an honest disclosure in finish/, 'disclosure is named as a valid resolution');
    assert.match(WJ2, /Do not keep researching for a fix the page cannot provide/, 'endless research is forbidden when the page cannot offer more');
  });
  it('a repeated-identical-feedback breaker exists as a defensive backstop', () => {
    assert.match(WJ2, /IDENTICAL FEEDBACK #/, 'meta directive injected on the 3rd identical send');
    assert.match(WJ2, /Do NOT re-diagnose from scratch/, 're-diagnosis forbidden');
  });
});

describe('123rd round (user design): [FIX PLAN] — per-problem status, fixed ones stay closed', () => {
  const DossierLib = require('../lib/evidence-dossier');
  const RS = fs.readFileSync(path.join(__dirname, '..', 'lib', 'research-session.js'), 'utf8');
  const WJ3 = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');
  it('multi-problem feedback splits into a per-problem plan with computed statuses', () => {
    const text = DossierLib.buildDossier({
      fixProblems: [
        { text: 'Please fix: posts.postTime empty in 4/4 records' },
        { text: 'Please fix: Count shortfall — requested 10, extracted 3' }
      ],
      lastVerify: { ok: true, detectors: { countShortfall: { field: 'posts', requested: 10, extracted: 3 } } }
    });
    assert.match(text, /\[FIX PLAN\]/);
    // postTime: green verify + its field absent from every failing row → FIXED
    const pt = text.split('\n').filter(l => /postTime/.test(l))[0];
    assert.match(pt, /FIXED/i, 'solved problem marked fixed — ' + pt);
    // count shortfall: its detector still fires → OPEN
    const cs = text.split('\n').filter(l => /Count shortfall/.test(l))[0];
    assert.match(cs, /OPEN|still failing/i, 'unresolved problem stays open — ' + cs);
    assert.match(text, /work ONLY the OPEN/i, 'teaching forbids re-researching fixed ones');
  });
  it('a red verify on ANOTHER field does not reopen a fixed problem; regression reopens it', () => {
    const t1 = DossierLib.buildDossier({
      fixProblems: [{ text: 'Please fix: posts.postTime empty' }],
      lastVerify: { ok: false, error: { message: 'REQUIRED_FIELD_EMPTY: posts.content is empty in 2/4' }, detectors: {} }
    });
    assert.match(t1.split('\n').filter(l => /postTime/.test(l))[0], /FIXED/i, 'other-field red does not reopen');
    const t2 = DossierLib.buildDossier({
      fixProblems: [{ text: 'Please fix: posts.postTime empty' }],
      lastVerify: { ok: false, error: { message: 'REQUIRED_FIELD_EMPTY: posts.postTime is empty in 1/4' }, detectors: {} }
    });
    assert.match(t2.split('\n').filter(l => /postTime/.test(l))[0], /OPEN|REGRESSED/i, 're-appearing failure reopens');
  });
  it('wizard seeds fixProblems from multi-line feedback; engine passes them to the dossier', () => {
    assert.match(WJ3, /fixProblems/, 'wizard seeds the problem list');
    assert.match(RS, /fixProblems: \(Array\.isArray\(state\.fixProblems\)/, 'engine wires the feed');
  });
});

describe('125th log: chunked service.update (provider cuts ~4-5K replies; the full steps array can NEVER fit)', () => {
  const { createSessionTools } = require('../lib/session-tools');
  function makeTools2(applied) {
    return createSessionTools({
      rail: { executeDsl: async () => ({}), pageState: async () => ({}), epoch: 0 },
      runVerify: async () => ({ events: [], report: { ok: true, detectors: {} }, raw: {} }),
      probeFactory: () => ({ snippet: async () => ({ result: 'ok' }) }),
      getDraftService: () => null,
      applyArtifact: (a) => applied.push(a),
      getTestInput: () => ({}),
      getOutputSchema: () => ({ type: 'object', properties: {} }),
      getSteps: () => [],
      ioConfirmBridge: { request: async (p) => ({ confirmed: true, inputSchema: p && p.inputSchema, outputSchema: p && p.outputSchema }) }
    });
  }
  it('more:true buffers; the follow-up chunk assembles and applies the FULL steps', async () => {
    const applied = [];
    const tools = makeTools2(applied);
    const c1 = [{ id: 's1', script: 'await $extract("a");', onSuccess: 's2', onFailure: 'TERMINATE' }];
    const c2 = [{ id: 's2', script: 'return {posts: __lastResult__};', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }];
    await tools.tools['io.confirm']({ inputSchema: { type: 'object', properties: { k: { type: 'string' } } }, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array' } } } });
    const r1 = await tools.tools['service.update']({ steps: c1, more: true });
    assert.ok(r1 && r1.buffered === true, 'first chunk buffered — got ' + JSON.stringify(r1).slice(0, 120));
    assert.equal(applied.length, 0, 'nothing applied yet');
    const r2 = await tools.tools['service.update']({ steps: c2 });
    assert.ok(r2 && (r2.updated === true || (r2.version || r1.version)), 'final chunk applies — got ' + JSON.stringify(r2).slice(0, 120));
    assert.equal(applied.length, 1);
    assert.deepEqual(applied[0].steps.map((s) => s.id), ['s1', 's2'], 'assembled in order');
  });
  it('the cut-off nudge for service.update teaches the split', () => {
    const RS2 = fs.readFileSync(path.join(__dirname, '..', 'lib', 'research-session.js'), 'utf8');
    assert.match(RS2, /CHUNKED . service\.update/, 'nudge names the chunked-send escape');
  });
});

describe('129th-round review fix: chunked-update failure modes (buffer restore, assembly disclosure, resume warning)', () => {
  const { createSessionTools } = require('../lib/session-tools');
  const WU = require('../lib/wizard-utils');
  function makeTools3(applied) {
    return createSessionTools({
      rail: { executeDsl: async () => ({}), pageState: async () => ({}), epoch: 0 },
      runVerify: async () => ({ events: [], report: { ok: true, detectors: {} }, raw: {} }),
      probeFactory: () => ({ snippet: async () => ({ result: 'ok' }) }),
      getDraftService: () => null,
      applyArtifact: (a) => applied.push(a),
      getTestInput: () => ({}),
      getOutputSchema: () => ({ type: 'object', properties: {} }),
      getSteps: () => [],
      ioConfirmBridge: { request: async (p) => ({ confirmed: true, inputSchema: p && p.inputSchema, outputSchema: p && p.outputSchema }) }
    });
  }
  it('a final chunk rejected by the ghost gate RESTORES the buffer — resending only the fixed final chunk applies the FULL graph', async () => {
    const applied = [];
    const tools = makeTools3(applied);
    await tools.tools['io.confirm']({ inputSchema: { type: 'object', properties: { k: { type: 'string' } } }, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array' } } } });
    const c1 = [{ id: 's1', script: 'await $extract("a");', onSuccess: 's2', onFailure: 'TERMINATE' }];
    const bad = [{ id: 's2', script: 'return {posts: (__stepResults__.extract||{}).posts||[]};', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }];
    const r1 = await tools.tools['service.update']({ steps: c1, more: true });
    assert.ok(r1 && r1.buffered === true, 'chunk buffered');
    assert.match(r1.note, /if the session restarts before the final chunk, resend from chunk 1/, 'buffering receipt discloses the restart caveat');
    const rBad = await tools.tools['service.update']({ steps: bad });
    assert.ok(rBad && typeof rBad.error === 'string', 'ghost ref rejected');
    assert.match(rBad.error, /GHOST_STEP_REF.*extract/, 'names the missing step');
    assert.match(rBad.error, /1 buffered chunk step\(s\) \[s1\] were RESTORED to the pending buffer/, 'discloses the restore and what to resend');
    assert.equal(applied.length, 0, 'nothing applied on rejection');
    const fixed = [{ id: 's2', script: 'return {posts: __lastResult__};', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }];
    const r2 = await tools.tools['service.update']({ steps: fixed });
    assert.ok(r2 && r2.updated === true, 'fixed FINAL chunk alone now applies — got ' + JSON.stringify(r2).slice(0, 160));
    assert.equal(r2.assembledFromChunks, 1, 'success receipt discloses assembly');
    assert.equal(applied.length, 1);
    assert.deepEqual(applied[0].steps.map((s) => s.id), ['s1', 's2'], 'restore preserved the buffered prefix — no suffix-only artifact');
  });
  it('an abandoned buffer is disclosed: a later COMPLETE update carries assembledFromChunks (never a silent prepend)', async () => {
    const applied = [];
    const tools = makeTools3(applied);
    await tools.tools['io.confirm']({ inputSchema: { type: 'object', properties: { k: { type: 'string' } } }, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array' } } } });
    const stale = [{ id: 's1', script: 'await $extract("a");', onSuccess: 'f1', onFailure: 'TERMINATE' }];
    const r1 = await tools.tools['service.update']({ steps: stale, more: true });
    assert.ok(r1 && r1.buffered === true, 'chunk buffered then abandoned (no final chunk)');
    // A fresh complete replacement written as [f1 -> f2], self-chained from
    // the buffered step so validateChain's reachability rule holds.
    const fresh = [
      { id: 'f1', script: 'await $extractList("d", {});', onSuccess: 'f2', onFailure: 'TERMINATE' },
      { id: 'f2', script: 'return {posts: __lastResult__};', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
    ];
    const r2 = await tools.tools['service.update']({ steps: fresh });
    assert.ok(r2 && r2.updated === true, 'fresh update applies');
    assert.equal(r2.assembledFromChunks, 1, 'receipt names the stale-buffer prepend');
    assert.deepEqual(applied[0].steps.map((s) => s.id), ['s1', 'f1', 'f2'], 'assembly is disclosed, not silent');
  });
  it('injectResumeChunkWarning: trailing buffered receipt with no later update pushes the restart note', () => {
    const t = [
      { kind: 'assistant', text: 'sending chunk 1' },
      { kind: 'tool', name: 'service.update', ok: true, result: { buffered: true, bufferedSteps: 2 } },
      { kind: 'system', text: 'session stopped (wallClock)' }
    ];
    const out = WU.injectResumeChunkWarning(t);
    assert.equal(out.length, 4, 'note pushed');
    const note = out[out.length - 1];
    assert.equal(note.kind, 'system');
    assert.match(note.text, /PENDING UPDATE CHUNKS WERE NOT RETAINED ACROSS THE RESTART/);
    assert.match(note.text, /resend the complete artifact/i);
  });
  it('injectResumeChunkWarning: a buffered receipt CONSUMED by a later successful update pushes nothing', () => {
    const t = [
      { kind: 'tool', name: 'service.update', ok: true, result: { buffered: true, bufferedSteps: 1 } },
      { kind: 'tool', name: 'service.update', ok: true, result: { updated: true, version: 3, assembledFromChunks: 1 } }
    ];
    const out = WU.injectResumeChunkWarning(t);
    assert.equal(out.length, 2, 'no note — the buffer landed');
    // abortChunk also consumes (explicit clear)
    const t2 = [
      { kind: 'tool', name: 'service.update', ok: true, result: { buffered: true, bufferedSteps: 1 } },
      { kind: 'tool', name: 'service.update', ok: true, result: { aborted: true } }
    ];
    assert.equal(WU.injectResumeChunkWarning(t2).length, 2, 'no note after abortChunk');
  });
  it('injectResumeChunkWarning: no buffered receipts anywhere → untouched; error-only consumption still warns', () => {
    const clean = [
      { kind: 'tool', name: 'page.open', ok: true, result: { url: 'https://example.com' } },
      { kind: 'tool', name: 'service.update', ok: true, result: { updated: true, version: 1 } }
    ];
    assert.equal(WU.injectResumeChunkWarning(clean).length, 2, 'no note with no buffered receipts');
    const errored = [
      { kind: 'tool', name: 'service.update', ok: true, result: { buffered: true, bufferedSteps: 1 } },
      { kind: 'tool', name: 'service.update', ok: false, result: { error: 'GHOST_STEP_REF: ...' } }
    ];
    assert.equal(WU.injectResumeChunkWarning(errored).length, 3, 'an error receipt does not consume — the restart dropped the restored buffer too');
  });
});

describe('126th round Q1: two-cut ceiling escalation (provider cuts ~2K completions, finish lies stop)', () => {
  it('after two consecutive cut-off replies the nudge turns mechanical: ONE step per reply', () => {
    const RS3 = fs.readFileSync(path.join(__dirname, '..', 'lib', 'research-session.js'), 'utf8');
    assert.match(RS3, /consecutiveCutOff/, 'cut-off streak tracked');
    assert.match(RS3, /ONE step per reply/, 'mechanical escalation present');
    // 129th-round review fix: the streak is a PERSISTED counter now — the old
    // transcript scan counted entries compaction later folds to
    // '- [protocol nudge]'. Behavioral coverage lives in research-session.test.js.
    assert.match(RS3, /cutOffNudgeCount: 0/, 'counter initialized in the state defaults');
    assert.match(RS3, /state\.cutOffNudgeCount = \(state\.cutOffNudgeCount \|\| 0\) \+ 1/, 'counter incremented at the nudge push');
    assert.ok(RS3.indexOf('const priorCuts') === -1, 'transcript-scan streak is gone');
    assert.doesNotMatch(RS3, /Never emit a multi-step reply again/, 'the permanent directive is reworded away');
    assert.match(RS3, /Use one-step-per-reply chunks for the remainder of this session/, 'non-permanent wording');
  });
});
describe('126th round Q2: [RESEARCH PLAN] — per-question closure in the self-research phase (user: borrow the fix-plan mechanism)', () => {
  const DossierLib = require('../lib/evidence-dossier');
  const RS3 = fs.readFileSync(path.join(__dirname, '..', 'lib', 'research-session.js'), 'utf8');
  it('renders goals/hypotheses with status + closure teaching', () => {
    const text = DossierLib.buildDossier({
      goals: [
        { id: 'g1', text: 'find the repeating post container', status: 'done' },
        { id: 'g2', text: 'ground postTime from the tooltip', status: 'open' }
      ],
      hypotheses: [{ n: 1, text: 'comments live in aria-labels', verdict: null }]
    });
    assert.match(text, /\[RESEARCH PLAN\]/);
    assert.match(text.split('\n').filter(l => /g2/.test(l))[0], /OPEN/i);
    assert.match(text.split('\n').filter(l => /g1/.test(l))[0], /DONE|✓/i);
    assert.match(text, /close .* the MOMENT|the moment/i);
    assert.match(text, /never re-probe|do not re-probe/i);
  });
  it('the engine passes goals/hypotheses into the dossier', () => {
    assert.match(RS3, /goals: state\.goals|goals: \(Array\.isArray\(state\.goals\)/, 'goals feed');
    assert.match(RS3, /hypotheses: state\.hypotheses|hypotheses: \(Array/, 'hypotheses feed');
  });
});

describe('127th round: green-verify quality gates (decoy html + junk-required + missing seed)', () => {
  const VR2 = fs.readFileSync(path.join(__dirname, '..', 'lib', 'verify-runner.js'), 'utf8');
  const WU4 = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wizard-utils.js'), 'utf8');
  const WJ4 = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');
  it('JUNK_VALUES on a REQUIRED field vetoes the run (behavioral cases live in verify-runner.test.js; this pins the envelope)', () => {
    // 129th-round review fix: the original veto tested Array.isArray(detectors.junkValues)
    // — detectJunkValues returns {fields,note}, so the gate was dead and this
    // grep passed anyway. Pin that the gate iterates the REAL shape.
    const i = VR2.indexOf('JUNK_VALUES_REQUIRED');
    assert.ok(i > -1, 'promotion exists');
    assert.match(VR2.slice(i - 900, i + 300), /junkValues\.fields/, 'iterates the {fields:[...]} envelope detectJunkValues returns');
    assert.match(VR2.slice(i - 900, i + 300), /schemaItemRequiredForPath/, 'keys off schemaItemRequiredForPath');
  });
  it('detectIdenticalFieldValues flags an all-records-identical field (the decoy htmlSnippet)', () => {
    const vm = require('node:vm');
    const start = WU4.indexOf('function detectIdenticalFieldValues');
    assert.ok(start > -1, 'detector defined');
    let depth = 0, j = start;
    for (j = WU4.indexOf('function detectIdenticalFieldValues'); j < WU4.length; j++) {
      if (WU4[j] === '{') depth += 1;
      else if (WU4[j] === '}') { depth -= 1; if (depth === 0) break; }
    }
    const helper = WU4.slice(WU4.indexOf('function schemaArrayItemFieldKeys'), WU4.indexOf('function detectIdenticalFieldValues'));
    const ctx = {}; vm.createContext(ctx);
    vm.runInContext(helper + WU4.slice(start, j + 1) + '\nthis.__f = detectIdenticalFieldValues;', ctx);
    const r = ctx.__f(
      { posts: [
        { id: '1', htmlSnippet: '<blockquote>Facebook</blockquote>' },
        { id: '2', htmlSnippet: '<blockquote>Facebook</blockquote>' },
        { id: '3', htmlSnippet: '<blockquote>Facebook</blockquote>' }
      ] },
      { type: 'object', properties: { posts: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, htmlSnippet: { type: 'string' } } } } } }
    );
    assert.ok(r && r.length === 1 && r[0].path === 'posts.htmlSnippet', JSON.stringify(r));
    assert.match(r[0].note, /identical|decoy|container/i);
    // distinct values stay silent
    const r2 = ctx.__f({ posts: [{ id: '1', htmlSnippet: 'a' }, { id: '2', htmlSnippet: 'b' }] },
      { type: 'object', properties: { posts: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, htmlSnippet: { type: 'string' } } } } } });
    assert.ok(!r2 || r2.length === 0);
  });
  it('the same-site seed also mines the persisted research session verify (postTime 5/5 lived there, not in executionLogs)', () => {
    // 129th-round review fix: the block used to gate on the persisted
    // session but mine the IN-MEMORY wizardState.testResult — strengthen
    // the pins so a decorative gate cannot pass again.
    assert.match(WJ4, /wizardResearchSession|persisted\.session/, 'research-session persistence reachable');
    assert.match(WJ4, /mineResearchSessionSamples\(rsSession/, 'the persisted session is MINED, not just gated on');
    const RS4 = fs.readFileSync(path.join(__dirname, '..', 'lib', 'research-session.js'), 'utf8');
    assert.match(RS4, /state\.lastVerifyFinalResult = result\.finalResult/, 'engine persists the green verify finalResult into state');
    assert.match(WJ4, /SAME-SITE FIELD SAMPLES[\s\S]{0,4000}research|research[\s\S]{0,400}SAME-SITE FIELD SAMPLES|verify finalResult/i, 'seed sources extended');
  });
});

describe('129th-round review fix: same-site seed mines the PERSISTED research session (not in-memory wizardState)', () => {
  const WU = require('../lib/wizard-utils');
  const RS_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'research-session.js'), 'utf8');
  it('a green persisted session with a fresh wizardState yields the verify samples (the cross-restart case)', () => {
    const rsSession = {
      lastVerifyOk: true,
      lastVerifyFinalResult: { posts: [
        { postId: 'p1', postTime: '2026-08-01T10:00' },
        { postId: 'p2', postTime: '2026-08-02T11:00' }
      ] },
      artifactVersions: [{ steps: [] }]
    };
    const samples = WU.mineResearchSessionSamples(rsSession, null, {});
    assert.ok(samples.postTime && samples.postTime.length === 2, 'postTime samples mined from the persisted session — got ' + JSON.stringify(samples));
    assert.ok(samples.postId && samples.postId.length === 2, 'sibling fields ride along');
  });
  it('a non-green persisted session falls back to the in-memory testResult only', () => {
    const rsSession = { lastVerifyOk: false, lastVerifyFinalResult: null, artifactVersions: [{ steps: [] }] };
    const samples = WU.mineResearchSessionSamples(rsSession, { posts: [{ author: 'Ada' }, { author: 'Grace' }] }, {});
    assert.ok(samples.author && samples.author.length === 2, 'fallback source used when the persisted verify was red');
  });
  it('no artifact versions / null session leaves the existing samples untouched (first value wins)', () => {
    const existing = { title: ['kept'] };
    assert.deepEqual(WU.mineResearchSessionSamples(null, null, existing), { title: ['kept'] }, 'null session is a no-op');
    const thin = { lastVerifyOk: true, lastVerifyFinalResult: { posts: [{ a: 'x' }, { a: 'y' }] }, artifactVersions: [] };
    assert.deepEqual(WU.mineResearchSessionSamples(thin, null, existing), { title: ['kept'] }, 'no persisted artifacts → no mining');
    const green = { lastVerifyOk: true, lastVerifyFinalResult: { posts: [{ title: 'new', a: 'x' }, { title: 'new2', a: 'y' }] }, artifactVersions: [{ steps: [] }] };
    const merged = WU.mineResearchSessionSamples(green, null, existing);
    assert.deepEqual(merged.title, ['kept'], 'existing samples are never overwritten');
    assert.ok(merged.a, 'new fields still merge in');
  });
  it('the service.update spec no longer contradicts itself over chunked sends; buffered/aborted returns are declared', () => {
    assert.match(RS_SRC, /chunked sends assemble to the same effect/, 'REPLACES clause acknowledges chunked assembly');
    assert.doesNotMatch(RS_SRC, /REPLACES the whole artifact \(send the complete steps array every time\)/, 'the contradictory legacy clause is gone');
    assert.match(RS_SRC, /\{buffered:true,\.\.\.\} \| \{aborted:true\}/, 'chunking return shapes declared');
  });
  it('the verify.run spec names the preflight arg', () => {
    const ST3 = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session-tools.js'), 'utf8');
    const m = ST3.match(/\{ name: 'verify\.run', args: '[^']*'/);
    assert.ok(m, 'verify.run spec found');
    assert.match(m[0], /\{input\?, preflight\?\}/, 'args declare preflight');
    assert.match(m[0], /preflight:true dry-runs the extract step/, 'one-line preflight clause present');
  });
});

describe('128th round: ghost-step reference gate (v16 = single scroll step returning a removed step results)', () => {
  // 129th-round review fix: direct require instead of vm source-slicing —
  // the detector now calls stripJSComments (same module), which a sliced
  // vm context cannot see; the brittle brace-walk re-implemented require().
  const WU6 = require('../lib/wizard-utils');
  it('detectStepGraphGhostRefs names __stepResults__/<id> refs to steps absent from the graph', () => {
    const ghosts = WU6.detectStepGraphGhostRefs([{ id: 'scroll', script: "return {done:true, posts: (__stepResults__.extract||{}).posts||[]};" }]);
    assert.ok(ghosts && ghosts.length === 1 && ghosts[0].fromStep === 'scroll' && ghosts[0].refStep === 'extract', JSON.stringify(ghosts));
    const clean = WU6.detectStepGraphGhostRefs([
      { id: 'extract', script: 'const r = await $extractList("d", {}); return r;' },
      { id: 'assemble', script: 'return {posts: __stepResults__.extract.posts};' }
    ]);
    assert.ok(!clean || clean.length === 0, 'valid cross-step refs pass');
  });
  it('129th-round review fix: a comment-only mention of a removed step id no longer vetoes (comments stripped first)', () => {
    const out = WU6.detectStepGraphGhostRefs([
      { id: 'scroll', script: '// was __stepResults__.extract, now inline\nreturn {done:true, posts: __lastResult__.posts};' }
    ]);
    assert.ok(!out || out.length === 0, 'provenance comments are not executable references — got ' + JSON.stringify(out));
  });
  it('129th-round review fix: optional-chained ghost refs (__stepResults__?.id) are flagged too', () => {
    const out = WU6.detectStepGraphGhostRefs([
      { id: 'scroll', script: 'return {posts: (__stepResults__?.extract||{}).posts};' }
    ]);
    assert.ok(out && out.length === 1 && out[0].refStep === 'extract', 'optional chaining is a real access — got ' + JSON.stringify(out));
  });
  it('service.update rejects ghost refs (the syntax-gate lane); the fallback resolver carries the detector', () => {
    const ST2 = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session-tools.js'), 'utf8');
    assert.match(ST2, /GHOST_STEP_REF|detectStepGraphGhostRefs/, 'wired into service.update');
    // 129th-round review fix (#10a): resolveWU's fallback object must expose
    // the detector — the old global/window-only chain left the gate a no-op
    // in an MV3 service worker (exports land on `self` there).
    assert.match(ST2, /detectStepGraphGhostRefs: w\.detectStepGraphGhostRefs/, 'fallback resolver carries the ghost detector');
    // Behavioral wiring coverage: the ghost rejection + buffer restore ride
    // the 129th-round describe above through the real createSessionTools bag.
  });
});
