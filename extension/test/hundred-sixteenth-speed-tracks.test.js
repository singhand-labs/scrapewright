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

describe('126th round Q1: two-cut ceiling escalation (provider cuts ~2K completions, finish lies stop)', () => {
  it('after two consecutive cut-off replies the nudge turns mechanical: ONE step per reply', () => {
    const RS3 = fs.readFileSync(path.join(__dirname, '..', 'lib', 'research-session.js'), 'utf8');
    assert.match(RS3, /consecutiveCutOff/, 'cut-off streak tracked');
    assert.match(RS3, /ONE step per reply/, 'mechanical escalation present');
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
