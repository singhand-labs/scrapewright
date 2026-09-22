// Harness 对标整改轮（2026-09-11 用户指示 ①③④）：
//   ① user.observe 用户观察桥（避免猜测页面行为）
//   ③ 收场审查门（结果审查面板 renderResultReview）
//   ④ probe.snippet 先测后写（任意 DSL 片段研究页试跑）
// ② wizard Back 已由 sixty-sixth-round-wizard-nav.test.js 覆盖。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('node:path');

const { createSessionTools } = require('../lib/session-tools');
const { createProbeTools } = require('../lib/probe-tools');
const { createFindingsLedger } = require('../lib/findings-ledger');

const WIZARD_JS = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');
const WIZARD_HTML = fs.readFileSync(path.join(__dirname, '..', 'wizard.html'), 'utf8');
const SESSION_TOOLS_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session-tools.js'), 'utf8');
const PROBE_TOOLS_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'probe-tools.js'), 'utf8');

// Universality guard (用户原则：基础设施级方案，禁止站点特化) — the NEW
// teaching strings introduced by this round must not name any specific site.
const FORBIDDEN = /facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i;

function makeDeps(observeBridge) {
  return {
    rail: {
      pageOpen: async () => ({ tabId: 1, url: 'https://example.com', ready: true }),
      pageState: async () => ({ open: true, tabId: 1, url: 'https://example.com' }),
      executeDsl: async () => 5,
      ensureLock: async () => {}, releaseLock: async () => {}, dispose: async () => {}, tabId: 1
    },
    runVerify: async () => ({ report: { ok: true, error: null, aborted: false, score: { score: 100, isData: true, breakdown: {} }, schemaOk: true, schemaMissing: [], detectors: { emptyFields: [], duplicateFields: [], countShortfall: null }, steps: [], finalResult: { posts: [{ t: 1 }] }, pages: '1', eventCount: 1, events: [] }, events: [], raw: {} }),
    getDraftService: () => null,
    applyArtifact: () => {},
    getTestInput: () => null,
    getOutputSchema: () => null,
    getSteps: () => [],
    annotationBridge: null,
    ioConfirmBridge: { request: async () => ({ confirmed: true }) },
    observeBridge: observeBridge
  };
}

// ---------------------------------------------------------------------------
// 1. user.observe behavior
describe('user.observe (human-sensor bridge tool)', () => {
  it('missing question → pointed error teaching how to phrase it', async () => {
    const t = createSessionTools(makeDeps({ request: async () => ({ answer: 'x' }) }));
    const r = await t.tools['user.observe']({});
    assert.match(String(r.error), /question \(required\)/);
  });

  it('forwards the question and returns the answer; ledger records provenance user', async () => {
    const seen = [];
    const t = createSessionTools(makeDeps({ request: async (req) => { seen.push(req); return { answer: 'a tooltip with a full date appears' }; } }));
    const ledger = createFindingsLedger();
    const parks = [];
    const ctx = { ledger, session: { parkBegin: () => parks.push('b'), parkEnd: () => parks.push('e') } };
    const r = await t.tools['user.observe']({ question: 'hover the first timestamp — does a tooltip appear?', hint: 'watch the top-left' }, ctx);
    assert.equal(r.answer, 'a tooltip with a full date appears');
    assert.equal(seen.length, 1);
    assert.match(seen[0].question, /tooltip/);
    assert.equal(seen[0].hint, 'watch the top-left');
    assert.deepEqual(parks, ['b', 'e'], 'the wait parks the session clock');
    const entries = ledger.serialize().entries;
    assert.ok(entries.some((e) => e.provenance === 'user' && /user observation/.test(e.finding) && e.evidence === 'user.observe'),
      'ledger entry with provenance user: ' + JSON.stringify(entries));
  });

  it('cancelled → note teaches falling back to probing, never guessing', async () => {
    const t = createSessionTools(makeDeps({ request: async () => ({ cancelled: true }) }));
    const r = await t.tools['user.observe']({ question: 'q' });
    assert.equal(r.cancelled, true);
    assert.match(r.note, /fall back to probing, never guess/);
  });

  it('bridge absent → honest error (wiring, not usage)', async () => {
    const t = createSessionTools(makeDeps(null));
    const r = await t.tools['user.observe']({ question: 'q' });
    assert.match(String(r.error), /bridge not wired/);
  });

  it('is registered with a teaching toolSpec the system prompt picks up', () => {
    const t = createSessionTools(makeDeps({ request: async () => ({ answer: 'x' }) }));
    const spec = t.toolSpecs.find((s) => s.name === 'user.observe');
    assert.ok(spec, 'user.observe toolSpec present');
    assert.match(spec.returns, /eyes are the best sensor/i);
    assert.match(spec.returns, /does not consume the session clock/);
  });
});

// ---------------------------------------------------------------------------
// 2. probe.snippet behavior
describe('probe.snippet (test-before-artifact)', () => {
  function makeTools(impl) {
    return createProbeTools({ executeDsl: impl });
  }

  it('runs the snippet body on the research tab and returns the raw JSON result', async () => {
    const calls = [];
    const tools = makeTools(async (code) => { calls.push(code); return { posts: [{ id: 'a1' }] }; });
    const r = await tools.snippet({ code: "const rows = await $list('div.card'); return { posts: rows.length };" });
    assert.ok(!r.error, 'no error: ' + JSON.stringify(r));
    assert.match(r.result, /"posts"/);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /return/);
    assert.ok(!r.truncated);
  });

  it('missing return statement → STEP_NO_RETURN-shaped teaching error', async () => {
    const tools = makeTools(async () => ({}));
    const r = await tools.snippet({ code: "await $count('div');" });
    assert.match(String(r.error), /top-level return/);
  });

  it('empty code → required error; >8000 chars → split-the-experiment error', async () => {
    const tools = makeTools(async () => ({}));
    assert.match(String((await tools.snippet({ code: ' ' })).error), /code \(required\)/);
    const r = await tools.snippet({ code: 'return ' + '"' + 'x'.repeat(8000) + '";' });
    assert.match(String(r.error), /code too long/);
  });

  it('oversized output is head+tail truncated with truncated:true and a disclosed remainder', async () => {
    const tools = makeTools(async () => ({ blob: 'y'.repeat(9000) }));
    const r = await tools.snippet({ code: 'return { blob: bigBlob };' });
    assert.equal(r.truncated, true);
    assert.match(r.result, /\+\d+ chars\]/);
    assert.ok(r.result.length < 5000, 'capped around 4K, got ' + r.result.length);
  });

  it('snippet errors propagate as error', async () => {
    const tools = makeTools(async () => ({ error: 'SyntaxError: unexpected token' }));
    const r = await tools.snippet({ code: 'return 1;' });
    assert.match(String(r.error), /SyntaxError/);
  });

  it('session-tools registers probe.snippet with the test-before-artifact teaching', () => {
    const t = createSessionTools(makeDeps(null));
    assert.ok(t.tools['probe.snippet'], 'tool registered');
    const spec = t.toolSpecs.find((s) => s.name === 'probe.snippet');
    assert.ok(spec, 'toolSpec present');
    assert.match(spec.returns, /Test-before-artifact/);
  });
});

// ---------------------------------------------------------------------------
// 3a. wizard user-observe panel + bridge wiring (source audit)
describe('wizard user-observe bridge wiring (source audit)', () => {
  it('wizard.html carries the hidden-by-default userObservePanel with submit/cancel buttons', () => {
    assert.match(WIZARD_HTML, /id="userObservePanel" class="exploration-panel hidden"/);
    assert.match(WIZARD_HTML, /id="btnUserObserveSubmit"/);
    assert.match(WIZARD_HTML, /id="btnUserObserveCancel"/);
    assert.match(WIZARD_HTML, /id="userObserveAnswer"/);
  });

  it('wizard.js defines the bridge, registers the listeners and the userBridges entry', () => {
    assert.match(WIZARD_JS, /let wizardObserveBridge = null;/);
    assert.match(WIZARD_JS, /function createWizardObserveBridge\(\)/);
    assert.match(WIZARD_JS, /btnUserObserveSubmit'\)\.addEventListener\('click', \(\) => \{ wizardObserveBridge && wizardObserveBridge\.submit\(\); \}\)/);
    assert.match(WIZARD_JS, /btnUserObserveCancel'\)\.addEventListener\('click', \(\) => \{ wizardObserveBridge && wizardObserveBridge\.cancel\(\); \}\)/);
    assert.match(WIZARD_JS, /userBridges: \[wizardIoBridge, wizardAnnotationBridge, wizardObserveBridge\]/);
    assert.match(WIZARD_JS, /observeBridge: wizardObserveBridge/);
    // engine stop cancels the pending observe wait alongside io/annotation
    assert.match(WIZARD_JS, /wizardObserveBridge && wizardObserveBridge\.cancel\(\);/);
  });

  it('submit resolves the answer; cancel resolves cancelled; no inline handlers', () => {
    assert.match(WIZARD_JS, /r\(\{ answer: answer \}\)/);
    assert.match(WIZARD_JS, /r\(\{ cancelled: true \}\)/);
    assert.doesNotMatch(WIZARD_HTML, /onclick=/);
  });
});

// ---------------------------------------------------------------------------
// 3b. result review panel (source audit)
describe('result review panel (source audit)', () => {
  it('wizard.html carries the resultReviewList inside the session feedback panel', () => {
    const panel = WIZARD_HTML.indexOf('id="sessionFeedbackPanel"');
    const list = WIZARD_HTML.indexOf('id="resultReviewList"');
    assert.ok(panel !== -1 && list > panel, 'resultReviewList sits inside/after the feedback panel');
    const textarea = WIZARD_HTML.indexOf('id="sessionFeedbackText"');
    assert.ok(textarea > list, 'review list renders before the feedback textarea');
  });

  it('wizard.js renders review items from getLastVerify().report with a feedback-append click path', () => {
    assert.match(WIZARD_JS, /function renderResultReview\(\)/);
    assert.match(WIZARD_JS, /getLastVerify\(\)/);
    assert.match(WIZARD_JS, /result-review-item/);
    assert.match(WIZARD_JS, /Please fix:/);
    assert.match(WIZARD_JS, /sessionFeedbackText/);
    assert.match(WIZARD_JS, /addEventListener\('click'/);
  });

  it('presentSessionCompletion calls renderResultReview on the two presented paths', () => {
    const i = WIZARD_JS.indexOf('async function presentSessionCompletion()');
    const body = WIZARD_JS.slice(i, WIZARD_JS.indexOf('function showSessionFeedbackPanel()', i));
    const calls = (body.match(/renderResultReview\(\)/g) || []).length;
    assert.ok(calls >= 2, 'both presenting paths call renderResultReview, got ' + calls);
  });
});

// ---------------------------------------------------------------------------
// 4. universality guard over the NEW teaching strings
describe('universality guard — no site-specific teaching in the new round', () => {
  it('user.observe and probe.snippet toolSpec copy name no site', () => {
    const t = createSessionTools(makeDeps(null));
    for (const name of ['user.observe', 'probe.snippet']) {
      const spec = t.toolSpecs.find((s) => s.name === name);
      assert.ok(spec, name + ' spec');
      assert.ok(!FORBIDDEN.test(spec.returns + ' ' + spec.args), name + ' copy is site-agnostic');
    }
  });

  it('the new bridge/panel code carries no site tokens', () => {
    const io = WIZARD_JS.indexOf('function createWizardObserveBridge()');
    const bridge = WIZARD_JS.slice(io, WIZARD_JS.indexOf('\n}', io) + 2);
    assert.ok(!FORBIDDEN.test(bridge), 'bridge body site-agnostic');
    const rr = WIZARD_JS.slice(WIZARD_JS.indexOf('function renderResultReview()'), WIZARD_JS.indexOf('function renderResultReview()') + 4000);
    assert.ok(!FORBIDDEN.test(rr), 'result-review body site-agnostic');
    const snip = PROBE_TOOLS_SRC.slice(PROBE_TOOLS_SRC.indexOf('async function snippet('));
    assert.ok(!FORBIDDEN.test(snip.slice(0, snip.indexOf('return { count'))), 'probe.snippet body site-agnostic');
  });

  it('session-tools wires the observeBridge dep through createSessionTools', () => {
    assert.match(SESSION_TOOLS_SRC, /'user\.observe': userObserve/);
    assert.match(SESSION_TOOLS_SRC, /d\.observeBridge/);
  });
});
