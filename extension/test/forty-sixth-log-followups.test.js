// Forty-sixth live-log followups.
//
// Log evidence (docs/console.log, 46th survey): the session shipped v4 with
// comments/shares/location hardcoded to '' (green verify by construction —
// the fields were moved out of required at io.confirm and the user approved
// the contract), 3 records against a requested count of 5 (detectCountShortfall
// stayed null: severe-only gate at 60%), and postTime carrying RELATIVE
// timestamps ("a day ago") described in the very schema note as absolute
// tooltip timestamps. probe.scrollUntil had declared "the feed is exhausted"
// on window-bottom evidence while the feed scrolled in an inner container.
//
// F5 (this block): service.update's two static lints (thirty-first log
// detectNeverExtractedFields, thirtieth log detectUnawaitedDollarCalls)
// never ran in the wizard PAGE for the whole campaign. Root cause:
// session-tools' page-context resolveWU falls back to a literal 3-key bag
// when window.__wizardUtilsModuleMarker__ is absent — and NOTHING ever set
// the marker. Top-level function declarations hoist onto window in a
// classic script, which healed some callers by accident, but resolveWU's
// fallback discards everything outside its 3 keys, so WU.detectNeverExtractedFields
// stayed undefined and the `comments: ""` lint was structurally silent in
// the only context that matters (the log's v4 service.update returned no
// staticLint despite the literal pattern).
//
// Fix: wizard-utils.js builds ONE literal export bag and assigns it to
// window/self __wizardUtilsModuleMarker__ (plus Object.assign onto the
// global) — the resolution protocol session-tools and verify-runner already
// implement. Tests below prove the marker exists in page and worker
// contexts, its keys match module.exports exactly (drift guard), and the
// page-context session-tools now produces the staticLint advisory the
// thirty-first-log tests could only prove under require().

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createSessionTools } = require('../lib/session-tools');

function makeIoDeps(overrides) {
  const state = { applied: [], draft: null, testInput: {}, bridgeCalls: [], ledgerEntries: [] };
  const d = Object.assign({
    rail: { executeDsl: async () => 5, ensureLock: async () => {}, releaseLock: async () => {}, dispose: async () => {}, tabId: 1 },
    runVerify: async () => ({ report: { ok: true }, events: [], raw: {} }),
    getDraftService: () => state.draft,
    applyArtifact: (a) => { state.applied.push(a); state.draft = { targetUrl: 'https://example.com', steps: a.steps }; if (a.testInput) state.testInput = a.testInput; },
    getTestInput: () => state.testInput,
    getOutputSchema: () => (state.draft && state.draft.outputSchema) || null,
    getInputSchema: () => (state.draft && state.draft.inputSchema) || null,
    getSteps: () => (state.draft ? state.draft.steps : []),
    annotationBridge: null,
    ioConfirmBridge: {
      request: async (payload) => {
        state.bridgeCalls.push(payload);
        return state.nextBridgeResponse || { confirmed: true };
      }
    }
  }, overrides || {});
  return { deps: d, state };
}

const IN_SCHEMA = { type: 'object', required: ['keyword'], properties: { keyword: { type: 'string' }, count: { type: 'number' } } };
const OUT_SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', required: ['content'], properties: { content: { type: 'string' } } } } } };
const CTX = () => ({ session: { state: () => ({ session: { artifactVersions: [] } }) } });

const SEED_STEPS = [{ id: 's1', name: 'x', script: 'return 1;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }];
async function seedArtifact(t, ctx) {
  const out = await t.tools['service.update']({ steps: SEED_STEPS }, ctx || CTX());
  assert.equal(out.updated, true, 'artifact seeded');
}


const WIZARD_JS = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');
const WIZARD_HTML = fs.readFileSync(path.join(__dirname, '..', 'wizard.html'), 'utf8');
const SESSION_TOOLS_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session-tools.js'), 'utf8');
const RESEARCH_SESSION_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'research-session.js'), 'utf8');

const WU_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wizard-utils.js'), 'utf8');
const ST_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session-tools.js'), 'utf8');
const PT_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'probe-tools.js'), 'utf8');
const WU_REQUIRE = require('../lib/wizard-utils');

function runPageContext() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext('var window = this; var self = this;', sandbox);
  vm.runInContext(WU_SRC, sandbox, { filename: 'wizard-utils.js' });
  return sandbox;
}

describe('forty-sixth log F5 — wizard-utils marker bag', () => {
  it('sets __wizardUtilsModuleMarker__ on window when loaded as a classic page script', () => {
    const sandbox = runPageContext();
    assert.ok(sandbox.window.__wizardUtilsModuleMarker__, 'marker assigned in the page branch');
    const marker = sandbox.window.__wizardUtilsModuleMarker__;
    assert.equal(typeof marker.validateChain, 'function');
    assert.equal(typeof marker.detectNeverExtractedFields, 'function', 'the thirty-first-log lint reaches the marker bag');
    assert.equal(typeof marker.detectUnawaitedDollarCalls, 'function', 'the thirtieth-log lint reaches the marker bag');
    assert.equal(typeof marker.SCRIPT_DSL_GUIDE, 'string');
  });

  it('marker bag keys match module.exports exactly (drift guard: a new export cannot land on one surface only)', () => {
    const sandbox = runPageContext();
    const markerKeys = Object.keys(sandbox.window.__wizardUtilsModuleMarker__).sort();
    const exportKeys = Object.keys(WU_REQUIRE).sort();
    assert.deepEqual(markerKeys, exportKeys);
  });

  it('sets __wizardUtilsModuleMarker__ on self in a worker-style context (no window)', () => {
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext('var self = this;', sandbox);
    vm.runInContext(WU_SRC, sandbox, { filename: 'wizard-utils.js' });
    assert.ok(sandbox.self.__wizardUtilsModuleMarker__, 'marker assigned in the self branch');
    assert.equal(typeof sandbox.self.__wizardUtilsModuleMarker__.detectNeverExtractedFields, 'function');
  });

  it('session-tools page-context resolveWU heals: service.update lints `comments: ""` literals without require()', async () => {
    const sandbox = runPageContext();
    vm.runInContext(PT_SRC, sandbox, { filename: 'probe-tools.js' });
    vm.runInContext(ST_SRC, sandbox, { filename: 'session-tools.js' });
    assert.ok(sandbox.window.SessionTools, 'session-tools attaches its api in the page context');
    const createSessionTools = sandbox.window.SessionTools.createSessionTools;
    assert.equal(typeof createSessionTools, 'function');

    const state = { applied: [], draft: null };
    const deps = {
      rail: { executeDsl: async () => 5, ensureLock: async () => {}, releaseLock: async () => {}, dispose: async () => {}, tabId: 1 },
      runVerify: async () => ({ report: { ok: true }, events: [], raw: {} }),
      getDraftService: () => state.draft,
      applyArtifact: (a) => { state.applied.push(a); state.draft = { targetUrl: 'https://example.com', steps: a.steps }; },
      getTestInput: () => ({}),
      getOutputSchema: () => ({ type: 'object' }),
      getSteps: () => (state.draft ? state.draft.steps : []),
      annotationBridge: null,
      ioConfirmBridge: { request: async () => ({ confirmed: true }) }
    };
    const t = createSessionTools(deps);
    const outSchema = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', required: ['content'], properties: {
      content: { type: 'string' }, comments: { type: 'string' }
    } } } } };
    await t.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: outSchema });
    const out = await t.tools['service.update'](
      { steps: [
        { id: 's1', name: 'extract', script: "const recs = await $extractList('div.post', { content: { selector: 'span.txt' } });\nreturn { posts: recs.map(r => ({ content: r.content, comments: \"\" })) };", onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
      ], outputSchema: outSchema },
      { session: { state: () => ({ session: { artifactVersions: [] } }) } });
    assert.equal(out.updated, true, 'artifact still lands — the lint is advisory');
    assert.ok(out.staticLint && out.staticLint.length >= 1, 'page context now produces the never-extracted-field advisory (was structurally silent pre-fix)');
    assert.match(out.staticLint.join('\n'), /posts\.comments/);
  });
});

// F1 — the user's explicit request for this log: confirm the TEST REQUEST
// PARAMETERS together with the input/output schemas. In the 46th log the
// model silently picked {keyword:"人工智能", count:5} itself; the user never
// saw those values, yet every verify.run (and the shipped service) executed
// them. io.confirm now carries testInput through the SAME user gate: the
// panel renders an editable parameter block, the confirmed values become the
// artifact's testInput, and service.update({testInput}) with DIFFERING
// values is rejected until re-confirmed.
describe('forty-sixth log F1 — io.confirm confirms testInput with the user', () => {
  it('io.confirm forwards the proposed testInput to the bridge; the confirmed values are stored and adoptable', async () => {
    const { deps, state } = makeIoDeps();
    const t = createSessionTools(deps);
    state.nextBridgeResponse = { confirmed: true, testInput: { keyword: '人工智能', count: 5 } };
    const res = await t.tools['io.confirm']({ inputSchema: IN_SCHEMA, outputSchema: OUT_SCHEMA, testInput: { keyword: '人工智能', count: 5 }, note: 'x' });
    assert.equal(res.confirmed, true);
    assert.equal(state.bridgeCalls.length, 1);
    assert.deepEqual(state.bridgeCalls[0].testInput, { keyword: '人工智能', count: 5 });
    await seedArtifact(t);
    const adopt = await t.tools['service.update']({ testInput: { count: 5, keyword: '人工智能' } }, CTX());
    assert.equal(adopt.testInputAdopted, true, 'key ORDER is not drift — sorted-key equality');
  });

  it('user-EDITED testInput wins: the model cannot adopt its own differing values without re-confirmation', async () => {
    const { deps, state } = makeIoDeps();
    const t = createSessionTools(deps);
    state.nextBridgeResponse = { confirmed: true, testInput: { keyword: '机器学习', count: 3 } };
    await t.tools['io.confirm']({ inputSchema: IN_SCHEMA, outputSchema: OUT_SCHEMA, testInput: { keyword: '人工智能', count: 5 } });
    await seedArtifact(t);
    const bad = await t.tools['service.update']({ testInput: { keyword: '人工智能', count: 5 } }, CTX());
    assert.equal(bad.error != null && /TEST_INPUT_UNCONFIRMED/.test(bad.error), true, 'differing values rejected');
    assert.match(bad.error, /io\.confirm/, 'the rejection teaches the re-confirm path');
    const good = await t.tools['service.update']({ testInput: { keyword: '机器学习', count: 3 } }, CTX());
    assert.equal(good.testInputAdopted, true, 'the user-edited values adopt');
  });

  it('a steps-bearing service.update carrying a DIFFERING testInput is rejected; matching values land on the artifact', async () => {
    const { deps, state } = makeIoDeps();
    const t = createSessionTools(deps);
    state.nextBridgeResponse = { confirmed: true, testInput: { keyword: 'k', count: 2 } };
    await t.tools['io.confirm']({ inputSchema: IN_SCHEMA, outputSchema: OUT_SCHEMA, testInput: { keyword: 'k', count: 2 } });
    const steps = [{ id: 's1', name: 'x', script: 'return 1;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }];
    const bad = await t.tools['service.update']({ steps, testInput: { keyword: 'other' } }, CTX());
    assert.match(String(bad.error || ''), /TEST_INPUT_UNCONFIRMED/);
    const ok = await t.tools['service.update']({ steps, testInput: { count: 2, keyword: 'k' } }, CTX());
    assert.equal(ok.updated, true);
    assert.deepEqual(state.applied[state.applied.length - 1].testInput, { keyword: 'k', count: 2 });
  });

  it('same-shape re-proposal auto-confirms ONLY when testInput matches; differing test values pop the panel again', async () => {
    const { deps, state } = makeIoDeps();
    const t = createSessionTools(deps);
    state.nextBridgeResponse = { confirmed: true, testInput: { keyword: 'a', count: 1 } };
    await t.tools['io.confirm']({ inputSchema: IN_SCHEMA, outputSchema: OUT_SCHEMA, testInput: { keyword: 'a', count: 1 } });
    assert.equal(state.bridgeCalls.length, 1);
    const again = await t.tools['io.confirm']({ inputSchema: IN_SCHEMA, outputSchema: OUT_SCHEMA, testInput: { keyword: 'a', count: 1 } });
    assert.equal(again.confirmed, true);
    assert.equal(state.bridgeCalls.length, 1, 'same schemas + same test values — no re-prompt');
    state.nextBridgeResponse = { confirmed: true, testInput: { keyword: 'b', count: 1 } };
    const retake = await t.tools['io.confirm']({ inputSchema: IN_SCHEMA, outputSchema: OUT_SCHEMA, testInput: { keyword: 'b', count: 1 } });
    assert.equal(retake.confirmed, true);
    assert.equal(state.bridgeCalls.length, 2, 'same schemas but NEW test values — the user must bless them');
  });

  it('when the proposal omits testInput, the CURRENT artifact testInput is what the user is asked to bless', async () => {
    const { deps, state } = makeIoDeps();
    state.testInput = { keyword: 'existing-value' };
    const t = createSessionTools(deps);
    state.nextBridgeResponse = { confirmed: true, testInput: { keyword: 'user-rewrite' } };
    await t.tools['io.confirm']({ inputSchema: IN_SCHEMA, outputSchema: OUT_SCHEMA });
    assert.deepEqual(state.bridgeCalls[0].testInput, { keyword: 'existing-value' }, 'prefilled from the live artifact, not invented');
    await seedArtifact(t);
    const bad = await t.tools['service.update']({ testInput: { keyword: 'existing-value' } }, CTX());
    assert.match(String(bad.error || ''), /TEST_INPUT_UNCONFIRMED/, 'the model adopting the un-blessed original value is still a change');
    const good = await t.tools['service.update']({ testInput: { keyword: 'user-rewrite' } }, CTX());
    assert.equal(good.testInputAdopted, true);
  });

  it('the confirmation ledger entry embeds the confirmed testInput and a resumed session recovers it (auto-confirm dedup + adoption gate)', async () => {
    const ledgerEntries = [];
    const ledger = {
      add: (e) => { ledgerEntries.push(e); },
      serialize: () => ({ entries: ledgerEntries })
    };
    const { deps, state } = makeIoDeps();
    const t = createSessionTools(deps);
    state.nextBridgeResponse = { confirmed: true, testInput: { keyword: 'a', count: 1 } };
    const ctx = Object.assign(CTX(), { ledger });
    await t.tools['io.confirm']({ inputSchema: IN_SCHEMA, outputSchema: OUT_SCHEMA, testInput: { keyword: 'a', count: 1 } }, ctx);
    const marker = ledgerEntries.find((e) => /I\/O CONTRACT CONFIRMED/.test(e.finding));
    assert.ok(marker, 'ledger marker written');
    assert.match(marker.finding, / testInput: /, 'testInput embedded for resume recovery');
    assert.ok(JSON.parse(marker.finding.slice(marker.finding.indexOf(' testInput: ') + ' testInput: '.length)) .keyword === 'a');

    // fresh closure — everything recovered from the ledger alone
    const { deps: deps2, state: state2 } = makeIoDeps();
    const t2 = createSessionTools(deps2);
    const ctx2 = Object.assign(CTX(), { ledger });
    const same = await t2.tools['io.confirm']({ inputSchema: IN_SCHEMA, outputSchema: OUT_SCHEMA, testInput: { keyword: 'a', count: 1 } }, ctx2);
    assert.equal(same.confirmed, true, 'ledger shape recovery still auto-confirms a same-shape re-proposal');
    assert.equal(state2.bridgeCalls.length, 0, 'shape parse must survive the appended testInput field');
    await seedArtifact(t2, ctx2);
    const adopt = await t2.tools['service.update']({ testInput: { keyword: 'a', count: 1 } }, ctx2);
    assert.equal(adopt.testInputAdopted, true, 'recovered testInput gates adoption');
    const drift = await t2.tools['service.update']({ testInput: { keyword: 'zzz' } }, ctx2);
    assert.match(String(drift.error || ''), /TEST_INPUT_UNCONFIRMED/, 'drifting from the recovered values is rejected');
  });

  it('parameterless services stay friction-free: no input properties + no testInput → no testInput gate', async () => {
    const { deps, state } = makeIoDeps();
    const t = createSessionTools(deps);
    state.nextBridgeResponse = { confirmed: true };
    const emptyIn = { type: 'object' };
    await t.tools['io.confirm']({ inputSchema: emptyIn, outputSchema: OUT_SCHEMA });
    await seedArtifact(t);
    const adopt = await t.tools['service.update']({ testInput: {} }, CTX());
    assert.equal(adopt.testInputAdopted, true, 'nothing to bless — legacy adoption behavior intact');
  });

  it('non-object testInput proposals are rejected with a teaching error at BOTH gates', async () => {
    const { deps, state } = makeIoDeps();
    const t = createSessionTools(deps);
    const bad = await t.tools['io.confirm']({ inputSchema: IN_SCHEMA, outputSchema: OUT_SCHEMA, testInput: 'keyword=x' });
    assert.match(String(bad.error || ''), /TEST_INPUT_NOT_OBJECT/);
    state.nextBridgeResponse = { confirmed: true, testInput: { keyword: 'a' } };
    await t.tools['io.confirm']({ inputSchema: IN_SCHEMA, outputSchema: OUT_SCHEMA, testInput: { keyword: 'a' } });
    await seedArtifact(t);
    const bad2 = await t.tools['service.update']({ testInput: ['a'] }, CTX());
    assert.match(String(bad2.error || ''), /TEST_INPUT_NOT_OBJECT/);
  });

  it('wizard panel renders an EDITABLE test-parameter block and confirm() parses it (invalid JSON keeps the panel open)', () => {
    assert.match(WIZARD_HTML, /id="ioConfirmTestInput"/, 'editable textarea in the panel');
    assert.match(WIZARD_HTML, /id="ioConfirmTestInputRow"/);
    const start = WIZARD_JS.indexOf('function createWizardIoBridge');
    const end = WIZARD_JS.indexOf('wizardMaxTurns');
    assert.ok(start > -1 && end > start);
    const bridge = WIZARD_JS.slice(start, end);
    assert.match(bridge, /ioConfirmTestInput/, 'bridge request() prefills the test-parameter block');
    assert.match(bridge, /JSON\.parse\(tiEl\.value/, 'confirm() parses the user-edited values');
    assert.match(bridge, /testInput: parsed/, 'parsed values ride the confirmation back to the session');
    assert.ok(/return;/.test(bridge.slice(bridge.indexOf('confirm()'), bridge.indexOf('revise('))), 'invalid JSON returns WITHOUT resolving — panel stays open');
  });

  it('tool specs and the methodology guide teach the testInput confirmation contract', () => {
    assert.match(SESSION_TOOLS_SRC, /io\.confirm[^]*?testInput/, 'io.confirm toolSpec mentions testInput');
    const rule9 = SESSION_TOOLS_SRC.slice(SESSION_TOOLS_SRC.indexOf("'9. EARLY contract confirmation"), SESSION_TOOLS_SRC.indexOf("'10. Ship real values"));
    assert.ok(rule9.length > 0, 'rule 9 found');
    assert.match(rule9, /testInput/, 'rule 9 teaches proposing test request values with the schemas');
    assert.match(rule9, /TEST_INPUT_UNCONFIRMED|re-confirm/i);
    assert.match(RESEARCH_SESSION_SRC, /TEST_INPUT_UNCONFIRMED/, 'service.update spec in research-session names the rejection');
  });
});

// F2 — evidence honesty from the scroll tools. In the 46th log
// probe.scrollUntil returned at_bottom ("the feed is exhausted ... the
// visible data is all there is") on a page whose feed scrolled in an INNER
// container: the window really was at its bottom (y 1478 == h - clientHeight)
// but that proves nothing about the feed. The model then shipped 3/5 and
// rationalized via the tool's false note. Two layers:
//   (a) $scrollBy gains domScrollToBottom's inner-container fallback — when
//       the primary root makes NO position change, probe for a real
//       scrollable element and scroll THAT (disclosed as
//       fallback:"inner-container", coordinates switch to the root that
//       actually scrolled). scrollUntil composes $scrollBy, so its loop
//       heals automatically.
//   (b) the at_bottom note stops claiming total exhaustion — it names the
//       scroll root tested and points at scrollSel for inner-container pages.
const CS_SRC = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');

function sliceCsFn(name) {
  let start = CS_SRC.indexOf('async function ' + name + '(');
  if (start === -1) start = CS_SRC.indexOf('function ' + name + '(');
  assert.ok(start !== -1, 'function ' + name + ' exists in content-script.js');
  let i = CS_SRC.indexOf('{', start);
  let depth = 0;
  for (; i < CS_SRC.length; i++) {
    if (CS_SRC[i] === '{') depth += 1;
    else if (CS_SRC[i] === '}') { depth -= 1; if (depth === 0) return CS_SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces for ' + name);
}

function buildCsFn(name, deps) {
  const keys = Object.keys(deps);
  const factory = eval('(function (' + keys.join(', ') + ') { return (' + sliceCsFn(name) + '); })');
  return factory(...keys.map((k) => deps[k]));
}

function movingRoot(y0) {
  return { tagName: 'HTML', scrollTop: y0, scrollBy(x, y) { this.scrollTop += y; } };
}
function frozenRoot(y0) {
  return { tagName: 'HTML', scrollTop: y0, scrollBy() { /* no overflow — position clamps */ } };
}

describe('forty-sixth log F2 — $scrollBy inner-container fallback + honest at_bottom', () => {
  // Forty-ninth log: domScrollBy now wraps in withTabActivation and returns
  // {result, _diagnostics} like every other DOM op (scroll used to be the
  // only family with no diagnostics). The stubs keep these 46th-log
  // behavioral tests on the inner-container contract.
  function makeScrollDeps(root, inner, findCalls) {
    return {
      resolveScrollTarget: () => null,
      sendDebugLog: () => {},
      withTabActivation: (label, fn) => fn(),
      attachScrollEvidence: async (r) => r,
      getScrollOps: () => ({
        findScrollableContainer: () => { if (findCalls) findCalls.n++; return inner; }
      }),
      document: { scrollingElement: root, documentElement: root }
    };
  }

  it('primary root moves → no fallback probe at all', async () => {
    const findCalls = { n: 0 };
    const deps = makeScrollDeps(movingRoot(0), null, findCalls);
    const domScrollBy = buildCsFn('domScrollBy', deps);
    const r = await domScrollBy(null, 900);
    assert.deepEqual(r.result, { scrolled: true, prevY: 0, newY: 900 });
    assert.equal(r._diagnostics.api, 'scrollBy');
    assert.equal(r._diagnostics.moved, true);
    assert.equal(findCalls.n, 0, 'no probe when the primary root scrolled');
  });

  it('primary root frozen + inner scrollable found → the INNER container scrolls, disclosed as fallback', async () => {
    const findCalls = { n: 0 };
    const inner = movingRoot(1478);
    const deps = makeScrollDeps(frozenRoot(1478), inner, findCalls);
    const domScrollBy = buildCsFn('domScrollBy', deps);
    const r = await domScrollBy(null, 900);
    assert.equal(findCalls.n, 1);
    assert.equal(r.result.scrolled, true);
    assert.equal(r.result.fallback, 'inner-container');
    assert.deepEqual([r.result.prevY, r.result.newY], [1478, 2378], 'coordinates switch to the root that actually scrolled');
    assert.equal(r.result.rootY, 1478, 'window coordinate preserved for diagnostics');
    assert.equal(inner.scrollTop, 2378);
  });

  it('primary frozen + finder returns nothing (or the root itself) → plain scrolled:false, no fallback key', async () => {
    const deps1 = makeScrollDeps(frozenRoot(500), null, { n: 0 });
    const r1 = await buildCsFn('domScrollBy', deps1)(null, 300);
    assert.deepEqual(r1.result, { scrolled: false, prevY: 500, newY: 500 });
    const root = frozenRoot(500);
    const deps2 = makeScrollDeps(root, root, { n: 0 });
    const r2 = await buildCsFn('domScrollBy', deps2)(null, 300);
    assert.equal(r2.result.scrolled, false);
    assert.equal(r2.result.fallback, undefined);
  });

  it('fallback fires but the inner container is also at its bottom → scrolled:false WITH the fallback disclosure', async () => {
    const deps = makeScrollDeps(frozenRoot(100), frozenRoot(880), { n: 0 });
    const r = await buildCsFn('domScrollBy', deps)(null, 300);
    assert.equal(r.result.scrolled, false);
    assert.equal(r.result.fallback, 'inner-container', 'the disclosure is the evidence the infra tried the inner path');
  });

  it('delta 0 short-circuits before any probe', async () => {
    const findCalls = { n: 0 };
    const deps = makeScrollDeps(frozenRoot(0), movingRoot(0), findCalls);
    const r = await buildCsFn('domScrollBy', deps)(null, 0);
    assert.deepEqual(r.result, { scrolled: false, prevY: 0, newY: 0 });
    assert.equal(findCalls.n, 0);
  });

  it('scrollUntil at_bottom note no longer claims total exhaustion — it names the tested root and the inner-container remedy', async () => {
    const { createProbeTools } = require('../lib/probe-tools');
    const { createObservationLog } = require('../lib/observation-log');
    const rounds = [
      { c0: 2, c1: 3, scrolled: true, y: 800, h: 9000 },
      { c0: 3, c1: 3, scrolled: false, y: 9000, h: 9000 },
      { c0: 3, c1: 3, scrolled: false, y: 9000, h: 9000 }
    ];
    let call = 0;
    const tools = createProbeTools({
      executeDsl: async () => { call += 1; return call === 1 ? 2 : rounds.shift(); },
      observationLog: createObservationLog()
    });
    const r = await tools.scrollUntil({ sel: '.items', targetCount: 10, settleMs: 100 });
    assert.equal(r.reason, 'at_bottom');
    assert.match(r.note, /scroll root/i);
    assert.match(r.note, /inner/i, 'names the inner-container possibility');
    assert.match(r.note, /scrollSel/, 'points at the concrete remedy');
    assert.ok(!/the visible data is all there is/.test(r.note), 'the total-exhaustion claim is gone');
  });

  it('the scrollUntil tool spec text matches the honest semantics', () => {
    const specLine = SESSION_TOOLS_SRC.split('\n').find((l) => l.indexOf("name: 'probe.scrollUntil'") !== -1);
    assert.ok(specLine, 'spec found');
    assert.ok(!/at_bottom means the feed is exhausted/.test(specLine), 'old claim removed');
    assert.match(specLine, /scroll root/i);
  });
});

// F3+F4 — the 46th log's green-with-holes verify. count requested 5,
// extracted 3: detectCountShortfall's severe-only gate (extracted >=
// requested*0.5 → continue) returned null, so neither the report nor the
// finish disclosure ever compared extracted-vs-requested — the model had
// converted the same red into green via a count-equality early-exit and
// nothing contradicted it. postTime shipped "a day ago" (relative ages)
// while the schema note described absolute tooltip timestamps — a string is
// a string, so every shape check passed.
//
// F3: the detector now reports ANY extracted < requested (severe flag at
// <0.5); the COUNT_SHORTFALL tag (and its knowledge attach) stays
// severe-only so 9/10 runs are not nagged, but the report, the verify
// digest, and the finish/stop ladder disclose every shortfall — the USER
// asked for N, the ship note says what they got.
// F4: detectRelativeTimestamps names time-like fields carrying relative
// ages; RELATIVE_TIMESTAMP tags the verify and the ladder discloses it.
const WU = require('../lib/wizard-utils');
const { createVerifyRunner } = require('../lib/verify-runner');
const { createResearchSession } = require('../lib/research-session');

const VR_HARNESS = (function () {
  function makeRunner(orchestrate) {
    const deps = {
      orchestrate,
      ensureLock: async () => {},
      getSignal: () => null,
      log: () => {},
      onEvent: () => {},
      createTab: async (url) => ({ id: 11, url }),
      removeTab: async () => {},
      waitForTabLoad: async () => {},
      sendMessage: async () => ({ pong: true }),
      executeScript: async () => ({ result: 'ok', selectorDiagnostics: [] }),
      captureSnapshot: async () => ({ html: '<html></html>' }),
      evaluateCondition: async () => true
    };
    return createVerifyRunner(deps);
  }
  return { makeRunner };
})();

function orchReturning(finalResult) {
  return async () => ({
    finalResult,
    steps: [{ stepId: 's1', stepName: 'one', result: { done: true }, snapshot: null }],
    pages: [], pagesTruncated: false
  });
}

describe('forty-sixth log F3 — count shortfall leaves the severe-only closet', () => {
  const SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } };

  it('detectCountShortfall reports 3/5 (the log\'s exact case) with severe:false', () => {
    const r = WU.detectCountShortfall({ posts: [{ a: 1 }, { a: 2 }, { a: 3 }] }, { count: 5 }, SCHEMA);
    assert.ok(r, '3/5 was invisible pre-fix (60% >= the 50% severe gate)');
    assert.equal(r.requested, 5);
    assert.equal(r.extracted, 3);
    assert.equal(r.severe, false);
    assert.ok(Math.abs(r.ratio - 0.6) < 1e-9);
  });

  it('severe stays severe (1/10) and satisfaction stays null (5/5); 9/10 is reported non-severe', () => {
    const one = WU.detectCountShortfall({ posts: [{ a: 1 }] }, { count: 10 }, SCHEMA);
    assert.equal(one.severe, true);
    assert.equal(WU.detectCountShortfall({ posts: [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }, { a: 5 }] }, { count: 5 }, SCHEMA), null);
    const nine = WU.detectCountShortfall({ posts: Array.from({ length: 9 }, () => ({ a: 1 })) }, { count: 10 }, SCHEMA);
    assert.ok(nine && nine.severe === false, 'reported, not nagged');
  });

  it('verify.run: non-severe shortfall populates the detector WITHOUT the COUNT_SHORTFALL tag; severe keeps it', async () => {
    const SERVICE = { targetUrl: 'https://example.com', steps: [{ id: 's1', name: 'one', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} };
    const runner = VR_HARNESS.makeRunner(orchReturning({ posts: [{ a: 1 }, { a: 2 }, { a: 3 }] }));
    const out = await runner({ service: SERVICE, input: { count: 5 }, outputSchema: SCHEMA });
    assert.equal(out.report.ok, true);
    assert.equal(out.report.detectors.countShortfall.extracted, 3);
    assert.equal(out.report.detectors.countShortfall.severe, false);
    assert.equal(out.report.events.indexOf('COUNT_SHORTFALL'), -1, 'non-severe does not attach the knowledge unit');
    const runner2 = VR_HARNESS.makeRunner(orchReturning({ posts: [{ a: 1 }] }));
    const out2 = await runner2({ service: SERVICE, input: { count: 10 }, outputSchema: SCHEMA });
    assert.equal(out2.report.detectors.countShortfall.severe, true);
    assert.ok(out2.report.events.indexOf('COUNT_SHORTFALL') !== -1, 'severe keeps the tag + knowledge attach');
  });

  it('the finish ladder and the budget stop disclose an extracted-vs-requested shortfall on a GREEN verify', async () => {
    const csVerify = async () => ({
      ok: true,
      score: { score: 120, isData: true, breakdown: {} },
      detectors: { partialEmptyFields: [], countShortfall: { field: 'posts', requested: 5, extracted: 3, ratio: 0.6, severe: false } },
      events: []
    });
    const session = createResearchSession({
      requirement: 'collect 5 posts',
      llm: scriptedLlmFor46([replyFor46(envelopeFor46('verify.run', {})), replyFor46(finishEnvelopeFor46('v4 verified green'))]),
      tools: { 'verify.run': csVerify }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    assert.match(report.stopped.detail, /COUNT-SHORTFALL/i);
    assert.match(report.stopped.detail, /requested 5/);
    assert.match(report.stopped.detail, /extracted 3/);

    const session2 = createResearchSession({
      requirement: 'collect 5 posts',
      llm: scriptedLlmFor46([replyFor46(envelopeFor46('verify.run', {})), replyFor46(envelopeFor46('probe.count', { sel: 'x' }))]),
      tools: { 'verify.run': csVerify, 'probe.count': async () => ({ count: 3 }) },
      budgets: { maxTurns: 2 }
    });
    const report2 = await session2.run();
    assert.equal(report2.stopped.reason, 'maxTurns');
    assert.match(report2.stopped.detail, /COUNT-SHORTFALL/i, 'budget stops carry the same disclosure');
  });
});

describe('forty-sixth log F4 — relative timestamps in time-like fields', () => {
  const TIME_SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', required: ['postTime'], properties: {
    postTime: { type: 'string', description: '从时间戳悬浮窗提取的发帖时间' }, title: { type: 'string' }
  } } } } };

  it('flags EN and ZH relative ages in time-like record fields; absolute values and non-time fields stay quiet', () => {
    const data = { posts: [
      { postTime: 'a day ago', title: 'x' },
      { postTime: 'August 27 at 9:01 PM', title: 'y' },
      { postTime: '3天前', title: 'z' }
    ] };
    const r = WU.detectRelativeTimestamps(data, TIME_SCHEMA);
    assert.equal(r.length, 1);
    assert.equal(r[0].field, 'postTime');
    assert.equal(r[0].path, 'posts.postTime');
    assert.equal(r[0].relativeCount, 2);
    assert.equal(r[0].totalRecords, 3);
    assert.match(r[0].sampleValue, /a day ago/);

    const clean = WU.detectRelativeTimestamps({ posts: [{ postTime: '2026-08-27T21:01:00+08:00', title: 'x' }] }, TIME_SCHEMA);
    assert.equal(clean.length, 0, 'absolute timestamps are the contract\'s ask');
    const decoy = WU.detectRelativeTimestamps({ posts: [{ postTime: '2026-08-27', title: 'a day ago' }] }, TIME_SCHEMA);
    assert.equal(decoy.length, 0, 'a relative age in a NON-time field is out of scope');
  });

  it('covers scalar top-level time fields and empty strings never count', () => {
    const schema = { type: 'object', required: ['updatedAt'], properties: { updatedAt: { type: 'string' } } };
    const r = WU.detectRelativeTimestamps({ updatedAt: '昨天' }, schema);
    assert.equal(r.length, 1);
    assert.equal(r[0].path, 'updatedAt');
    assert.equal(WU.detectRelativeTimestamps({ updatedAt: '' }, schema).length, 0);
  });

  it('verify.run populates detectors.relativeTimestamps and tags RELATIVE_TIMESTAMP (report-only, ok stays green)', async () => {
    const SERVICE = { targetUrl: 'https://example.com', steps: [{ id: 's1', name: 'one', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} };
    const runner = VR_HARNESS.makeRunner(orchReturning({ posts: [
      { postTime: 'a day ago', title: 'x' },
      { postTime: '2 hrs ago', title: 'y' }
    ] }));
    const out = await runner({ service: SERVICE, input: {}, outputSchema: TIME_SCHEMA });
    assert.equal(out.report.ok, true, 'disclosure, not a gate');
    assert.ok(out.report.detectors.relativeTimestamps);
    assert.equal(out.report.detectors.relativeTimestamps[0].relativeCount, 2);
    assert.ok(out.report.events.indexOf('RELATIVE_TIMESTAMP') !== -1);
  });

  it('the finish ladder discloses relative timestamps on a GREEN ship', async () => {
    const session = createResearchSession({
      requirement: 'collect posts with absolute post times',
      llm: scriptedLlmFor46([replyFor46(envelopeFor46('verify.run', {})), replyFor46(finishEnvelopeFor46('v4 verified green'))]),
      tools: { 'verify.run': async () => ({
        ok: true,
        score: { score: 130, isData: true, breakdown: {} },
        detectors: { partialEmptyFields: [], relativeTimestamps: [{ field: 'postTime', path: 'posts.postTime', relativeCount: 3, totalRecords: 3, sampleValue: 'a day ago' }] },
        events: ['RELATIVE_TIMESTAMP']
      }) }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    assert.match(report.stopped.detail, /RELATIVE-TIMESTAMP/i);
    assert.match(report.stopped.detail, /a day ago/);
  });
});

function scriptedLlmFor46(replies) {
  let i = 0;
  return async () => {
    const r = replies[Math.min(i, replies.length - 1)];
    i++;
    return r;
  };
}
function replyFor46(content) {
  return Object.assign({ content, finish_reason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 10 } });
}
function envelopeFor46(tool, args) {
  return JSON.stringify(Object.assign({ think: 't', tool, args: args || {} }));
}
function finishEnvelopeFor46(summary) { return JSON.stringify({ think: 'done', finish: { summary: summary || 'done' } }); }
