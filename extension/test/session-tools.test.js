// extension/test/session-tools.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionTools } = require('../lib/session-tools');

function makeDeps(overrides) {
  const state = { applied: [], draft: null };
  const d = Object.assign({
    rail: {
      pageOpen: async (a) => ({ tabId: 1, url: 'https://example.com', ready: true }),
      pageState: async () => ({ open: true, tabId: 1, url: 'https://example.com' }),
      executeDsl: async (s) => 5,
      ensureLock: async () => {}, releaseLock: async () => {}, dispose: async () => {}, tabId: 1
    },
    runVerify: async (o) => ({
      report: { ok: true, error: null, aborted: false, score: { score: 100, isData: true, breakdown: {} }, schemaOk: true, schemaMissing: [], detectors: { emptyFields: [], duplicateFields: [], countShortfall: null }, steps: [{ stepId: 's1', stepName: 'extract', skipped: false, skipReason: null, iterations: 1 }], finalResult: { posts: [{ t: 1 }] }, pages: '1', eventCount: 2, events: [] },
      events: [{ type: 'STEP_ITERATION', stepId: 's1', iteration: 1, resultPreview: '{"done":true,"count":3}' }],
      raw: { testResult: { finalResult: { posts: [{ t: 1 }] }, steps: [] }, error: null, breaker: null }
    }),
    getDraftService: () => state.draft,
    applyArtifact: (a) => { state.applied.push(a); state.draft = { targetUrl: 'https://example.com', steps: a.steps }; },
    getTestInput: () => ({}),
    getOutputSchema: () => ({ type: 'object' }),
    getSteps: () => (state.draft ? state.draft.steps : []),
    annotationBridge: null
  }, overrides || {});
  return { deps: d, state };
}

const GOOD_STEPS = [
  { id: 's1', name: 'extract', script: "return $extractList('div.card', {t:{selector:'.t'}});", onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
];

describe('createSessionTools', () => {
  it('exposes the full tool bag + toolSpecs + DSL-contract system prompt', () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    for (const name of ['page.open', 'page.state', 'probe.count', 'probe.text', 'probe.attrStats', 'probe.sample', 'probe.hover', 'probe.scroll', 'probe.extract', 'diag.read', 'verify.run', 'annotate.request', 'service.update']) {
      assert.equal(typeof t.tools[name], 'function', name + ' wired');
    }
    assert.ok(t.toolSpecs.every(s => s.name && typeof s.returns === 'string'));
    assert.ok(t.toolSpecs.some(s => s.name === 'verify.run'));
    assert.ok(t.toolSpecs.some(s => s.name === 'probe.hover'), 'first-live-log P-A: hover probe in the spec list');
    assert.ok(t.toolSpecs.some(s => s.name === 'probe.scroll'), 'sixth-live-log I1: scroll probe in the spec list');
    assert.ok(t.toolSpecs.some(s => s.name === 'probe.extract'), 'sixth-log turn-sink: extraction dry-run probe in the spec list');
    const p = t.systemPromptBase;
    assert.ok(p.includes('$extractList'), 'DSL contract covers core APIs');
    assert.ok(p.includes('STANDARD CSS'), 'selector constraint present');
    assert.ok(p.includes('probe.hover'), 'methodology teaches the hover probe (do NOT call $hover as a tool)');
    assert.ok(/probe\.scroll/.test(p), 'methodology teaches the scroll probe (scroll during research, not just in steps)');
    assert.ok(/probe\.extract/.test(p), 'methodology teaches iterating the fieldMap in the live tab before verify');
    assert.ok(/VERBATIM/.test(p), 'sixth-live-log I2b: canonical popoverSelector verbatim-copy rule taught');
    assert.ok(p.includes('STEP_NO_RETURN'), 'second-live-log D1a: return-value contract taught with its detector name');
    assert.ok(!/facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i.test(p), 'no site tokens');
  });

  it('probe.scroll flows through rail.executeDsl with its receipt recorded', async () => {
    const snippets = [];
    const base = makeDeps();
    const { deps } = makeDeps({ rail: Object.assign(base.deps.rail, { executeDsl: async (s) => { snippets.push(s); return { scrolled: true, prevY: 0, newY: 9 }; } }) });
    const t = createSessionTools(deps);
    const r = await t.tools['probe.scroll']({ sel: "div[role='feed']" });
    assert.deepEqual(r, { scrolled: true, prevY: 0, newY: 9 });
    assert.ok(snippets[0].includes("return $scrollToBottom(\"div[role='feed']\")"), 'composed over the rail: ' + snippets[0]);
  });

  it('probe.count flows through rail.executeDsl', async () => {
    const { deps } = makeDeps({ rail: Object.assign(makeDeps().deps.rail, { executeDsl: async (s) => 7 }) });
    const t = createSessionTools(deps);
    const r = await t.tools['probe.count']({ sel: 'div.card' });
    assert.deepEqual(r, { count: 7 });
  });

  it('bindEngine connects the late-bound observation log so probes record receipts', async () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    const recorded = [];
    t.bindEngine({ observationLog: { record: (o) => recorded.push(o) } });
    await t.tools['probe.count']({ sel: 'div.card' });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].tool, 'probe.count');
    assert.deepEqual(recorded[0].selectors, ['div.card']);
  });

  it('verify.run rejects before any artifact exists; runs the draft service otherwise', async () => {
    const { deps, state } = makeDeps();
    const t = createSessionTools(deps);
    const r0 = await t.tools['verify.run']({});
    assert.match(r0.error, /service\.update first/);
    state.draft = { targetUrl: 'https://example.com', steps: GOOD_STEPS };
    const r = await t.tools['verify.run']({});
    assert.equal(r.ok, true);
    assert.ok(t.getLastVerify() && t.getLastVerify().events.length === 1, 'diag source stored');
  });

  it('diag.read before verify → error; after verify → digests with counters', async () => {
    const { deps, state } = makeDeps();
    const t = createSessionTools(deps);
    assert.match((await t.tools['diag.read']({})).error, /verify\.run first/);
    state.draft = { targetUrl: 'x', steps: GOOD_STEPS };
    await t.tools['verify.run']({});
    const r = await t.tools['diag.read']({});
    assert.equal(r.eventCount, 1);
    assert.ok(Array.isArray(r.counters) && r.counters[0].stepId === 's1');
    assert.ok(typeof r.selectorDiagnostics === 'string');
    const r2 = await t.tools['diag.read']({ kind: 'counters' });
    assert.ok(!('selectorDiagnostics' in r2), 'kind filter narrows channels');
  });

  it('diag.read popover digest surfaces failureReasons + guidance', async () => {
    const { deps, state } = makeDeps({
      runVerify: async () => ({
        report: { ok: false, error: { message: 'x', stepId: 's1' }, events: [] },
        events: [{ type: 'STEP_ITERATION', stepId: 's1', iteration: 1, resultPreview: '{"failureReasons":{"popover_timeout":9},"observedPopoverCount":4}' }],
        raw: { testResult: null, error: null, breaker: null }
      })
    });
    const t = createSessionTools(deps);
    state.draft = { targetUrl: 'x', steps: GOOD_STEPS };
    await t.tools['verify.run']({});
    const r = await t.tools['diag.read']({ kind: 'popover' });
    assert.deepEqual(r.popover.failureReasons, { popover_timeout: 9 });
    assert.equal(r.popover.observedPopoverCards, 4);
    assert.match(r.popover.hint, /popoverSel/);
  });

  it('service.update validates the chain, applies the artifact, echoes the engine version', async () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    const bad = await t.tools['service.update']({ steps: [{ id: 's1', script: 'return 1', onSuccess: 'NOPE' }] }, { session: { state: () => ({ session: { artifactVersions: [] } }) } });
    assert.match(bad.error, /chain invalid/);
    const out = await t.tools['service.update'](
      { steps: GOOD_STEPS, inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, testInput: {}, name: 'svc' },
      { session: { state: () => ({ session: { artifactVersions: [{ version: 1 }] } }) } });
    assert.deepEqual(out, { updated: true, version: 2 });
  });

  it('service.update rejects natural-language schemas with a teaching error; JSON-Schema shapes pass (fourth-live-log G1)', async () => {
    const { deps, state } = makeDeps();
    const t = createSessionTools(deps);
    const ctx = { session: { state: () => ({ session: { artifactVersions: [] } }) } };
    // Exact fourth-live-log shapes: {"posts":"array of post objects"} /
    // {"keyword":"搜索关键词"} — maps of field→description, not JSON Schema.
    const badOut = await t.tools['service.update'](
      { steps: GOOD_STEPS, outputSchema: { posts: 'array of post objects' } }, ctx);
    assert.match(badOut.error, /SCHEMA_NOT_JSON_SCHEMA/);
    assert.match(badOut.error, /score 0/, 'teaches WHY: every detector reads .required/.properties');
    assert.equal(state.applied.length, 0, 'artifact NOT applied on schema rejection');
    const badIn = await t.tools['service.update'](
      { steps: GOOD_STEPS, inputSchema: { keyword: '搜索关键词' } }, ctx);
    assert.match(badIn.error, /SCHEMA_NOT_JSON_SCHEMA/);
    const ok = await t.tools['service.update'](
      {
        steps: GOOD_STEPS,
        inputSchema: { type: 'object', required: ['keyword'], properties: { keyword: { type: 'string' } } },
        outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } }
      }, ctx);
    assert.deepEqual(ok, { updated: true, version: 1 });
  });

  it('diag.read failingStep channel keys off report.error.stepId; service.update marks lastVerify stale', async () => {
    const { deps, state } = makeDeps({
      runVerify: async () => ({
        report: { ok: false, error: { message: 'boom', stepId: 's1' }, events: [] },
        events: [{ type: 'STEP_ITERATION', stepId: 's1', iteration: 1, resultPreview: '{"done":false}' }],
        raw: { testResult: null, error: null, breaker: null }
      })
    });
    const t = createSessionTools(deps);
    state.draft = { targetUrl: 'x', steps: GOOD_STEPS };
    await t.tools['verify.run']({});
    const r = await t.tools['diag.read']({ kind: 'failingStep' });
    assert.ok(typeof r.failingStep === 'string');
    assert.ok(!('selectorDiagnostics' in r), 'kind narrowing');
    const upd = await t.tools['service.update']({ steps: GOOD_STEPS }, { session: { state: () => ({ session: { artifactVersions: [] } }) } });
    assert.equal(upd.updated, true);
    const r2 = await t.tools['diag.read']({});
    assert.match(r2.warning, /predates the current artifact/);
    await t.tools['verify.run']({});
    const r3 = await t.tools['diag.read']({});
    assert.ok(!('warning' in r3), 'fresh verify clears staleness');
  });

  it('popover digest counts observed popovers even on iterations without failure reasons', async () => {
    const { deps, state } = makeDeps({
      runVerify: async () => ({
        report: { ok: false, error: { message: 'x', stepId: 's1' }, events: [] },
        events: [{ type: 'STEP_ITERATION', stepId: 's1', iteration: 1, resultPreview: '{"observedPopoverCount":6}' }],
        raw: { testResult: null, error: null, breaker: null }
      })
    });
    const t = createSessionTools(deps);
    state.draft = { targetUrl: 'x', steps: GOOD_STEPS };
    await t.tools['verify.run']({});
    const r = await t.tools['diag.read']({ kind: 'popover' });
    assert.equal(r.popover.note, 'no hover failure reasons recorded in this verify run');
  });

  it('annotate.request without a bridge errors; picks enter the ledger as provenance user; cancel round-trips', async () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    assert.match((await t.tools['annotate.request']({ why: 'x' })).error, /bridge/);
    let resolveReq;
    const picks = [
      { selector: 'div.card', type: 'container', purpose: 'card container', outputField: '' },
      { selector: 'a.permalink', type: 'link', purpose: 'permalink', outputField: 'permalink' }
    ];
    const deps2 = makeDeps({ annotationBridge: { request: (req) => new Promise((res) => { resolveReq = res; }) } });
    const t2 = createSessionTools(deps2.deps);
    const pending = t2.tools['annotate.request']({ why: 'which card is organic?', containerSel: 'div.feed' }, { ledger: { add: (e) => deps2.state.ledgerAdded = (deps2.state.ledgerAdded || []).concat(e) } });
    resolveReq({ annotations: picks, url: 'https://example.com' });
    const r = await pending;
    assert.equal(r.annotations.length, 2);
    assert.equal(r.annotations[0].selector, 'div.card');
    assert.equal(deps2.state.ledgerAdded.length, 2);
    assert.equal(deps2.state.ledgerAdded[0].provenance, 'user');
    assert.deepEqual(deps2.state.ledgerAdded[0].selectors, ['div.card']);
    const pending2 = t2.tools['annotate.request']({ why: 'again' }, { ledger: { add: () => {} } });
    resolveReq({ cancelled: true });
    const r2 = await pending2;
    assert.equal(r2.cancelled, true);
  });
});

describe('page.open template parameters (ninth-log M3: the literal {{keyword}} tab poisoned ~30 turns of probes)', () => {
  it('substitutes {{param}} from testInput before the rail opens the tab', async () => {
    const opened = [];
    const base = makeDeps();
    const { deps } = makeDeps({
      rail: Object.assign(base.deps.rail, { pageOpen: async (a) => { opened.push(a.url); return { tabId: 1, url: a.url, ready: true }; } }),
      getTestInput: () => ({ keyword: 'news' })
    });
    const t = createSessionTools(deps);
    const r = await t.tools['page.open']({ url: 'https://example.com/search?q={{keyword}}' });
    assert.deepEqual(opened, ['https://example.com/search?q=news'], 'placeholder substituted from testInput');
    assert.equal(r.url, 'https://example.com/search?q=news');
    assert.ok(!r.error);
  });

  it('REFUSES to open when a {{param}} has no testInput value — a literal-placeholder page returns plausible-but-wrong evidence', async () => {
    let opened = 0;
    const base = makeDeps();
    const { deps } = makeDeps({
      rail: Object.assign(base.deps.rail, { pageOpen: async (a) => { opened += 1; return { tabId: 1, url: a.url, ready: true }; } }),
      getTestInput: () => ({})
    });
    const t = createSessionTools(deps);
    const r = await t.tools['page.open']({ url: 'https://example.com/search?q={{keyword}}&n={{count}}' });
    assert.equal(opened, 0, 'the rail must never be called with a literal placeholder');
    assert.ok(/error/.test(Object.keys(r).join(',')), 'returns an error');
    assert.match(r.error, /\{\{keyword\}\}/);
    assert.match(r.error, /\{\{count\}\}/);
    assert.match(r.error, /concrete sample/i);
  });

  it('urls without placeholders pass through to the rail untouched', async () => {
    const opened = [];
    const base = makeDeps();
    const { deps } = makeDeps({
      rail: Object.assign(base.deps.rail, { pageOpen: async (a) => { opened.push(a.url); return { tabId: 1, url: a.url, ready: true }; } })
    });
    const t = createSessionTools(deps);
    await t.tools['page.open']({ url: 'https://example.com/search?q=news' });
    assert.deepEqual(opened, ['https://example.com/search?q=news']);
  });

  it('partial substitution still refuses on the leftover token', async () => {
    let opened = 0;
    const base = makeDeps();
    const { deps } = makeDeps({
      rail: Object.assign(base.deps.rail, { pageOpen: async (a) => { opened += 1; return { tabId: 1, url: a.url, ready: true }; } }),
      getTestInput: () => ({ keyword: 'news' })
    });
    const t = createSessionTools(deps);
    const r = await t.tools['page.open']({ url: 'https://example.com/search?q={{keyword}}&near={{city}}' });
    assert.equal(opened, 0);
    assert.match(r.error, /\{\{city\}\}/);
    assert.ok(!/\{\{keyword\}\}/.test(r.error), 'the substituted token is not reported as missing');
  });
});
