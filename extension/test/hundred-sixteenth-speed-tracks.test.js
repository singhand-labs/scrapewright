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
    assert.match(made[0].title, /需要你的操作|action required/i);
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
