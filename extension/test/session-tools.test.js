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
    annotationBridge: null,
    ioConfirmBridge: { request: async () => ({ confirmed: true }) }
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
    for (const name of ['page.open', 'page.state', 'probe.count', 'probe.text', 'probe.attrStats', 'probe.sample', 'probe.hover', 'probe.scroll', 'probe.extract', 'diag.read', 'verify.run', 'annotate.request', 'io.confirm', 'service.update']) {
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
    await t.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } } });
    const bad = await t.tools['service.update']({ steps: [{ id: 's1', script: 'return 1', onSuccess: 'NOPE' }] }, { session: { state: () => ({ session: { artifactVersions: [] } }) } });
    assert.match(bad.error, /chain invalid/);
    const out = await t.tools['service.update'](
      { steps: GOOD_STEPS, inputSchema: { type: 'object' }, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } }, testInput: {}, name: 'svc' },
      { session: { state: () => ({ session: { artifactVersions: [{ version: 1 }] } }) } });
    assert.deepEqual(out, { updated: true, version: 2 });
  });

  it('service.update receipt carries a staticLint advisory when a step calls $ APIs without await (thirtieth log)', async () => {
    const { deps, state } = makeDeps();
    const t = createSessionTools(deps);
    await t.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } } });
    const out = await t.tools['service.update'](
      { steps: [
        { id: 's1', name: 'count gate', script: 'const n = $count("div.card"); if (n > 0) return { done: true, count: n }; return { done: false };', onSuccess: 's2', onFailure: 'TERMINATE' },
        { id: 's2', name: 'extract', script: "return $extractList('div.card', {t:{selector:'.t'}});", onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
      ] },
      { session: { state: () => ({ session: { artifactVersions: [] } }) } });
    assert.equal(out.updated, true, 'advisory is non-blocking — the artifact still lands');
    assert.equal(state.applied.length, 1, 'artifact applied despite lint hits');
    assert.equal(out.staticLint.length, 1, 'only the un-awaited step is flagged, not the return-promise idiom');
    assert.match(out.staticLint[0], /count gate/);
    assert.match(out.staticLint[0], /\$count/);
    assert.match(out.staticLint[0], /await/);
    // clean scripts get no field at all — receipts stay terse
    const clean = await t.tools['service.update']({ steps: GOOD_STEPS }, { session: { state: () => ({ session: { artifactVersions: [] } }) } });
    assert.equal(clean.updated, true);
    assert.equal(clean.staticLint, undefined);
  });

  it('service.update receipt names schema fields that exist ONLY as hardcoded literals (thirty-first log: comments/shares shipped as "")', async () => {
    const { deps, state } = makeDeps();
    const t = createSessionTools(deps);
    const outSchema = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', required: ['content'], properties: {
      content: { type: 'string' }, comments: { type: 'string' }, shares: { type: 'string' }
    } } } } };
    await t.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: outSchema });
    const out = await t.tools['service.update'](
      { steps: [
        { id: 's1', name: 'extract', script: "const recs = await $extractList('div.post', { content: { selector: 'span.txt' } });\nreturn { posts: recs.map(r => ({ content: r.content, comments: \"\", shares: \"\" })) };", onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
      ], outputSchema: outSchema },
      { session: { state: () => ({ session: { artifactVersions: [] } }) } });
    assert.equal(out.updated, true, 'advisory is non-blocking — the artifact still lands');
    assert.equal(out.staticLint.length, 2, 'comments and shares both named');
    const blob = out.staticLint.join('\n');
    assert.match(blob, /posts\.comments/, 'field named by schema path');
    assert.match(blob, /posts\.shares/);
    assert.match(blob, /no step extracts it/);
    // the schema may also come from the CONFIRMED contract (steps-only update)
    const out2 = await t.tools['service.update'](
      { steps: [
        { id: 's1', name: 'extract', script: "const c = await $extract('span.txt');\nreturn { posts: [{ content: c, comments: 'n/a' }] };", onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
      ] },
      { session: { state: () => ({ session: { artifactVersions: [] } }) } });
    assert.equal(out2.updated, true);
    assert.match(out2.staticLint.join('\n'), /posts\.comments/, 'confirmed-contract schema lints a steps-only update; non-empty literals flag too');
    assert.ok(!/posts\.content/.test(out2.staticLint.join('\n')), 'a computed/assigned mention keeps the field quiet');
  });

  it('service.update rejects natural-language schemas with a teaching error; JSON-Schema shapes pass (fourth-live-log G1)', async () => {
    const { deps, state } = makeDeps();
    const t = createSessionTools(deps);
    const ctx = { session: { state: () => ({ session: { artifactVersions: [] } }) } };
    await t.tools['io.confirm']({
      inputSchema: { type: 'object', required: ['keyword'], properties: { keyword: { type: 'string' } } },
      outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } }
    });
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
    await t.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } } });
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
    assert.equal(r.popover, undefined, 'C21: zero-failure-reason run emits no popover bucket');
  });

  it('annotate.request without a bridge errors; picks enter the ledger as provenance user; cancel round-trips', async () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    await t.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } } });
    assert.match((await t.tools['annotate.request']({ why: 'x' })).error, /bridge/);
    let resolveReq;
    const picks = [
      { selector: 'div.card', type: 'container', purpose: 'card container', outputField: '' },
      { selector: 'a.permalink', type: 'link', purpose: 'permalink', outputField: 'permalink' }
    ];
    const deps2 = makeDeps({ annotationBridge: { request: (req) => new Promise((res) => { resolveReq = res; }) } });
    const t2 = createSessionTools(deps2.deps);
    await t2.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } } });
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

describe('io.confirm — early I/O contract gate', () => {
  const IN = { type: 'object', required: ['keyword'], properties: { keyword: { type: 'string', description: 'search term' } } };
  const OUT = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } };

  it('service.update is rejected with a teaching error before any confirmation', async () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    const r = await t.tools['service.update']({ steps: GOOD_STEPS }, { session: { state: () => ({ session: { artifactVersions: [] } }) } });
    assert.match(r.error, /I\/O CONTRACT UNCONFIRMED/);
    assert.match(r.error, /io\.confirm/);
  });

  it('confirmation flows through the bridge, marks the ledger provenance:user, unlocks update', async () => {
    const added = [];
    let lastReq = null;
    const { deps } = makeDeps({
      ioConfirmBridge: { request: async (p) => { lastReq = p; return { confirmed: true }; } }
    });
    const ledger = { add: (e) => added.push(e) };
    const t = createSessionTools(deps);
    const r = await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT, note: 'coarse look done' }, { ledger });
    assert.equal(r.confirmed, true);
    assert.equal(lastReq && lastReq.note, 'coarse look done');
    assert.equal(added.length, 1);
    assert.match(added[0].finding, /I\/O CONTRACT CONFIRMED/);
    assert.equal(added[0].provenance, 'user');
    const upd = await t.tools['service.update'](
      { steps: GOOD_STEPS, inputSchema: IN, outputSchema: OUT },
      { ledger, session: { state: () => ({ session: { artifactVersions: [] } }) } });
    assert.equal(upd.updated, true);
  });

  it('revision path returns the user feedback; update stays gated', async () => {
    const { deps } = makeDeps({
      ioConfirmBridge: { request: async () => ({ confirmed: false, feedback: 'add publishDate' }) }
    });
    const t = createSessionTools(deps);
    const r = await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT });
    assert.equal(r.confirmed, false);
    assert.match(r.feedback, /publishDate/);
    const upd = await t.tools['service.update']({ steps: GOOD_STEPS }, { session: { state: () => ({ session: { artifactVersions: [] } }) } });
    assert.match(upd.error, /I\/O CONTRACT UNCONFIRMED/);
  });

  it('a renegotiation carries exact diff lines against the confirmed contract (thirty-first log: items.required weakening rubber-stamped from raw JSON)', async () => {
    const requests = [];
    const { deps } = makeDeps({
      ioConfirmBridge: { request: async (p) => { requests.push(p); return { confirmed: true }; } }
    });
    const ledger = { add: () => {} };
    const t = createSessionTools(deps);
    const v1 = {
      type: 'object', required: ['posts'],
      properties: { posts: { type: 'array', items: { type: 'object', required: ['content', 'popovers', 'time'], properties: {
        content: { type: 'string' }, popovers: { type: 'array', items: { type: 'object' } }, time: { type: 'string' }
      } } } }
    };
    await t.tools['io.confirm']({ inputSchema: IN, outputSchema: v1 }, { ledger });
    assert.deepEqual(requests[0].diffLines, [], 'first proposal has no prior contract — no diff');

    // Material renegotiation: popovers LEAVES items.required, comments/shares
    // arrive as optional fields. This is the exact weakening the 31st log
    // shipped — the panel must name it, not bury it in JSON.
    const v2 = {
      type: 'object', required: ['posts'],
      properties: { posts: { type: 'array', items: { type: 'object', required: ['content', 'time'], properties: {
        content: { type: 'string' }, popovers: { type: 'array', items: { type: 'object' } }, time: { type: 'string' },
        comments: { type: 'string' }, shares: { type: 'string' }
      } } } }
    };
    await t.tools['io.confirm']({ inputSchema: IN, outputSchema: v2, note: 'hovercards never render' }, { ledger });
    const diff = requests[1].diffLines;
    assert.ok(Array.isArray(diff) && diff.length, 'diff lines present on renegotiation');
    const blob = diff.join('\n');
    assert.match(blob, /record field of "posts" "popovers" LEAVING required/, 'names the field losing its REQUIRED guarantee');
    assert.match(blob, /"comments" ADDED/, 'names newly proposed fields');
    assert.ok(!/ENTERING required/.test(blob), 'no false ENTERING lines');

    // A resumed session recovers the prior contract from the ledger marker,
    // so the diff still lands (runtime ioConfirmedSchemas is gone).
    const { deps: deps2 } = makeDeps({
      ioConfirmBridge: { request: async (p) => { requests.push(p); return { confirmed: true }; } }
    });
    const ledgerEntries = [];
    const ledger2 = { add: (e) => ledgerEntries.push(e), serialize: () => ({ entries: ledgerEntries }) };
    const t3 = createSessionTools(deps2);
    await t3.tools['io.confirm']({ inputSchema: IN, outputSchema: v1 }, { ledger: ledger2 });
    await t3.tools['io.confirm']({ inputSchema: IN, outputSchema: v2 }, { ledger: ledger2 });
    assert.match(requests[3].diffLines.join('\n'), /"popovers" LEAVING required/,
      'ledger-recovered prior schema still produces the diff');
  });

  it('malformed schemas get the teaching error without consulting the bridge', async () => {
    let called = 0;
    const { deps } = makeDeps({
      ioConfirmBridge: { request: async () => { called += 1; return { confirmed: true }; } }
    });
    const t = createSessionTools(deps);
    const r = await t.tools['io.confirm']({ inputSchema: { keyword: '搜索关键词' }, outputSchema: OUT });
    assert.match(r.error, /SCHEMA_NOT_JSON_SCHEMA/);
    assert.equal(called, 0, 'bridge NOT consulted for malformed schemas');
  });

  it('missing bridge is a wiring error, not a usage error', async () => {
    const { deps } = makeDeps({ ioConfirmBridge: null });
    const t = createSessionTools(deps);
    const r = await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT });
    assert.match(r.error, /no confirmation bridge wired/);
  });

  it('material drift after confirmation is rejected until re-confirmation; description-only edits pass', async () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT });
    const ctx = { session: { state: () => ({ session: { artifactVersions: [] } }) } };
    const drifted = await t.tools['service.update'](
      { steps: GOOD_STEPS, outputSchema: { type: 'object', required: ['posts', 'publishDate'], properties: { posts: { type: 'array', items: { type: 'object' } }, publishDate: { type: 'string' } } } },
      ctx);
    assert.match(drifted.error, /I\/O CONTRACT DRIFT/);
    assert.match(drifted.error, /io\.confirm/);
    const IN2 = { type: 'object', required: ['keyword'], properties: { keyword: { type: 'string', description: 'CHANGED WORDING' } } };
    const cosmetic = await t.tools['service.update']({ steps: GOOD_STEPS, inputSchema: IN2, outputSchema: OUT }, ctx);
    assert.equal(cosmetic.updated, true, 'description-only edits are exempt from re-confirmation');
  });

  it('a ledger marker from a prior session (seed resume) unlocks update without the runtime flag', async () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    const ctx = {
      ledger: { serialize: () => ({ entries: [{ finding: 'I/O CONTRACT CONFIRMED — inputs: [keyword] outputs: [posts]', provenance: 'user' }] }) },
      session: { state: () => ({ session: { artifactVersions: [] } }) }
    };
    const upd = await t.tools['service.update'](
      { steps: GOOD_STEPS, outputSchema: { type: 'object', required: ['posts', 'extra'], properties: { posts: { type: 'array' }, extra: { type: 'string' } } } },
      ctx);
    assert.equal(upd.updated, true, 'recovery path skips drift comparison — the user drives those continuations');
  });

  it('system prompt teaches the EARLY rule and the tool spec lists io.confirm', () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    assert.match(t.systemPromptBase, /EARLY contract confirmation/);
    assert.match(t.systemPromptBase, /io\.confirm\(\{inputSchema, outputSchema/);
    assert.match(t.systemPromptBase, /MATERIAL change/);
    assert.ok(t.toolSpecs.some((s) => s.name === 'io.confirm'), 'io.confirm in the spec list');
  });

  it('rule 8 teaches verify-input consistency (thirteenth log: research q=news, verify keyword=cat — 0 /posts/ permalinks on the cat population)', () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    assert.match(t.systemPromptBase, /FIRST verify with the SAME input values that drove the research page/);
    assert.match(t.systemPromptBase, /change the result-card population ENTIRELY/);
    assert.match(t.systemPromptBase, /population divergence, not a rendering failure/);
    assert.match(t.systemPromptBase, /FIELD_MATCH_ZERO/);
  });

  // Fourteenth-log follow-up (user request): input values can be
  // unreasonable for the site — an obscure keyword leaves zero result items
  // and that is NOT a selector bug. Rule 8 must teach the alternate-value
  // re-test loop, and the verify.run spec must explain the input override.
  it('rule 8 teaches the INPUT_VALUE_SUSPECT loop: alternate value first, adopt via service.update, only then suspect selectors', () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    assert.match(t.systemPromptBase, /INPUT_VALUE_SUSPECT/);
    assert.match(t.systemPromptBase, /no content|nothing to extract/i);
    assert.match(t.systemPromptBase, /not a selector bug/i);
    const spec = t.toolSpecs.find((s) => s.name === 'verify.run');
    assert.ok(spec, 'verify.run spec present');
    assert.match(spec.returns + ' ' + (spec.args || ''), /input/, 'spec mentions the input override');
  });

  it('verify.run passes an explicit input override to the runner (mechanism for alternate-value re-tests)', async () => {
    const seen = [];
    const { deps } = makeDeps({ runVerify: async (o) => { seen.push(o.input); return { report: { ok: true, error: null, aborted: false, score: {}, schemaOk: true, schemaMissing: [], detectors: {}, steps: [], finalResult: {}, pages: '1', eventCount: 0, events: [] }, events: [], raw: {} }; } });
    const t = createSessionTools(deps);
    await t.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } } });
    await t.tools['service.update']({ steps: GOOD_STEPS }, { session: { state: () => ({ session: { artifactVersions: [] } }) } });
    await t.tools['verify.run']({});
    await t.tools['verify.run']({ input: { keyword: 'news' } });
    assert.deepEqual(seen[0], {}, 'no override falls back to the saved test input');
    assert.deepEqual(seen[1], { keyword: 'news' }, 'override reaches the runner');
  });

  it('service.update adopts a steps-less testInput without re-sending the step graph (alternate-value adoption path)', async () => {
    const { deps, state } = makeDeps();
    const t = createSessionTools(deps);
    const ctx = { session: { state: () => ({ session: { artifactVersions: [] } }) } };
    await t.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } } });
    await t.tools['service.update']({ steps: GOOD_STEPS }, ctx);
    const before = state.applied.length;
    const out = await t.tools['service.update']({ testInput: { keyword: 'news' } }, ctx);
    assert.equal(out.updated, true);
    assert.equal(out.testInputAdopted, true, 'names the adoption so the model knows to re-verify');
    assert.match(out.note, /verify\.run/, 'note points at re-verifying with the default input');
    assert.equal(state.applied.length, before + 1);
    assert.deepEqual(state.applied[state.applied.length - 1].testInput, { keyword: 'news' }, 'testInput applied');
    assert.deepEqual(state.applied[state.applied.length - 1].steps, GOOD_STEPS, 'current steps re-applied unchanged');
    // With no artifact yet, a steps-less testInput is not a valid update.
    const { deps: d2, state: s2 } = makeDeps();
    const t2 = createSessionTools(d2);
    await t2.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } } });
    const none = await t2.tools['service.update']({ testInput: { keyword: 'news' } }, ctx);
    assert.match(String(none.error), /no artifact|steps/, 'rejected without an existing artifact');
    assert.equal(s2.applied.length, 0);
  });
});

describe('annotation gate — user collaboration requires a confirmed I/O contract first', () => {
  it('annotate.request before any confirmation is rejected without consulting the bridge', async () => {
    let called = 0;
    const { deps } = makeDeps({
      annotationBridge: { request: async () => { called += 1; return { annotations: [] }; } }
    });
    const t = createSessionTools(deps);
    const r = await t.tools['annotate.request']({ why: 'which card is organic?' });
    assert.match(r.error, /I\/O CONTRACT UNCONFIRMED/);
    assert.match(r.error, /io\.confirm/);
    assert.equal(called, 0, 'the user is never asked to annotate before the contract is settled');
  });

  it('after a confirmed io.confirm the annotation bridge flows again', async () => {
    let called = 0;
    const { deps } = makeDeps({
      annotationBridge: { request: async () => { called += 1; return { annotations: [{ selector: 'a.permalink', purpose: 'link', outputField: 'permalink' }], url: 'https://example.com' }; } }
    });
    const t = createSessionTools(deps);
    await t.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } } });
    const r = await t.tools['annotate.request']({ why: 'ground the permalink field' });
    assert.equal(called, 1);
    assert.equal(r.annotations[0].outputField, 'permalink');
  });

  it('a ledger marker from a prior session (seed resume) also unlocks annotation', async () => {
    let called = 0;
    const { deps } = makeDeps({
      annotationBridge: { request: async () => { called += 1; return { annotations: [{ selector: 'div.card', purpose: 'container' }], url: 'https://example.com' }; } }
    });
    const t = createSessionTools(deps);
    const ctx = {
      ledger: { serialize: () => ({ entries: [{ finding: 'I/O CONTRACT CONFIRMED — inputs: [keyword] outputs: [posts]', provenance: 'user' }] }), add: () => {} }
    };
    const r = await t.tools['annotate.request']({ why: 'w' }, ctx);
    assert.equal(called, 1);
    assert.equal(r.annotations.length, 1);
  });

  it('system prompt teaches the ordering: contract confirmation precedes annotation collaboration', () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    assert.match(t.systemPromptBase, /annotate\.request is likewise rejected/);
    assert.match(t.systemPromptBase, /settle the contract first/);
    const spec = t.toolSpecs.find((s) => s.name === 'annotate.request');
    assert.match(spec.returns, /io\.confirm first/, 'tool spec carries the precondition');
  });
});

describe('io.confirm dedup — a confirmed contract is not re-prompted', () => {
  const IN = { type: 'object', required: ['keyword'], properties: { keyword: { type: 'string' } } };
  const OUT = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } };
  const OUT2 = { type: 'object', required: ['posts', 'publishDate'], properties: { posts: { type: 'array', items: { type: 'object' } }, publishDate: { type: 'string' } } };

  it('a same-shape re-proposal auto-confirms without consulting the bridge', async () => {
    let called = 0;
    const { deps } = makeDeps({ ioConfirmBridge: { request: async () => { called += 1; return { confirmed: true }; } } });
    const t = createSessionTools(deps);
    await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT });
    assert.equal(called, 1, 'first proposal pops');
    const again = await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT });
    assert.equal(again.confirmed, true);
    assert.match(again.note, /without re-prompting/i);
    assert.equal(called, 1, 'the user is NOT asked again for the same contract');
  });

  it('a materially different re-proposal still consults the bridge exactly once', async () => {
    let called = 0;
    const { deps } = makeDeps({ ioConfirmBridge: { request: async () => { called += 1; return { confirmed: true }; } } });
    const t = createSessionTools(deps);
    await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT });
    const revised = await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT2 });
    assert.equal(revised.confirmed, true);
    assert.equal(called, 2, 'the changed contract pops once');
    // The revised shape is now the confirmed one — a repeat is silent.
    const repeat = await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT2 });
    assert.equal(repeat.confirmed, true);
    assert.match(repeat.note, /without re-prompting/i);
    assert.equal(called, 2);
  });

  it('rejecting a material re-proposal leaves the ORIGINAL confirmation standing', async () => {
    const { deps } = makeDeps({ ioConfirmBridge: { request: async () => ({ confirmed: false, feedback: 'no, keep it simple' }) } });
    const t = createSessionTools(deps);
    await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT, note: 'first' });
    // First proposal was rejected by the harness → contract NOT confirmed.
    const rejected = await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT2 });
    assert.equal(rejected.confirmed, false);
    assert.match(rejected.feedback, /keep it simple/);
    const upd = await t.tools['service.update']({ steps: GOOD_STEPS }, { session: { state: () => ({ session: { artifactVersions: [] } }) } });
    assert.match(upd.error, /I\/O CONTRACT UNCONFIRMED/, 'a rejected proposal confirms nothing');
  });

  it('rejecting a REVISION after an established confirmation keeps the original contract usable', async () => {
    let n = 0;
    const { deps } = makeDeps({ ioConfirmBridge: { request: async () => { n += 1; return n === 1 ? { confirmed: true } : { confirmed: false, feedback: 'keep the original' }; } } });
    const t = createSessionTools(deps);
    await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT });
    const revised = await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT2 });
    assert.equal(revised.confirmed, false);
    const upd = await t.tools['service.update'](
      { steps: GOOD_STEPS, inputSchema: IN, outputSchema: OUT },
      { session: { state: () => ({ session: { artifactVersions: [] } }) } });
    assert.equal(upd.updated, true, 'the original confirmed contract still ships without re-prompting');
  });

  it('the ledger marker embeds the contract shape; a resumed session auto-confirms same-shape proposals', async () => {
    const added = [];
    let called = 0;
    const { deps } = makeDeps({ ioConfirmBridge: { request: async () => { called += 1; return { confirmed: true }; } } });
    const t = createSessionTools(deps);
    await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT }, { ledger: { add: (e) => added.push(e) } });
    assert.match(added[0].finding, / shape: \{"input"/, 'shape JSON embedded in the marker');
    // Fresh instance = runtime flag gone (reload / seed resume). The marker carries the shape.
    const t2 = createSessionTools(makeDeps({ ioConfirmBridge: { request: async () => { called += 1; return { confirmed: true }; } } }).deps);
    const resumed = await t2.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT }, { ledger: { serialize: () => ({ entries: added }), add: () => {} } });
    assert.equal(resumed.confirmed, true);
    assert.match(resumed.note, /without re-prompting/i);
    assert.equal(called, 1, 'no pop on resume for the same contract');
  });

  it('a legacy marker without the embedded shape falls back to prompting (safe default)', async () => {
    let called = 0;
    const { deps } = makeDeps({ ioConfirmBridge: { request: async () => { called += 1; return { confirmed: true }; } } });
    const t = createSessionTools(deps);
    const ctx = {
      ledger: { serialize: () => ({ entries: [{ finding: 'I/O CONTRACT CONFIRMED — inputs: [keyword] outputs: [posts]', provenance: 'user' }] }), add: () => {} }
    };
    const r = await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT }, ctx);
    assert.equal(called, 1, 'cannot compare shapes → the bridge is consulted');
    assert.equal(r.confirmed, true);
  });

  it('system prompt teaches: do not re-propose a confirmed contract', () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    assert.match(t.systemPromptBase, /auto-confirms without prompting/);
    const spec = t.toolSpecs.find((s) => s.name === 'io.confirm');
    assert.match(spec.returns, /auto-confirms without prompting/);
  });
});

describe('tenth-log N1: rule 10 — never ship junk; renegotiate unextractable fields', () => {
  it('system prompt teaches the junk-value rule and its detector', () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    assert.match(t.systemPromptBase, /Ship real values only/);
    assert.match(t.systemPromptBase, /detectors\.junkValues/);
    assert.match(t.systemPromptBase, /renegotiate the contract with io\.confirm/);
    assert.match(t.systemPromptBase, /http\(s\) entries/);
    assert.ok(!/facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i.test(t.systemPromptBase), 'no site tokens');
  });
});

describe('fifteenth-log: obfuscated text is junk; attributes carry the clean value', () => {
  it('rule 10 taxonomy includes anti-scrape obfuscated text with its markers', () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    assert.match(t.systemPromptBase, /OBFUSCATED text/i);
    assert.match(t.systemPromptBase, /interleaved|scrambled/i);
    assert.match(t.systemPromptBase, /zero-width/);
  });

  it('teaches the attribute fallback (aria-label/title/datetime) before declaring junk', () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    assert.match(t.systemPromptBase, /aria-label/);
    assert.match(t.systemPromptBase, /datetime/);
    assert.match(t.systemPromptBase, /bind the field to that attribute/i);
  });

  it('explicitly bans shipping obfuscated best-effort values in confirmed fields', () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    assert.match(t.systemPromptBase, /never ship an obfuscated "best-effort" value/i);
    assert.ok(!/facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i.test(t.systemPromptBase), 'no site tokens');
  });
});

describe('fifteenth-log: $ API data-contract wording (repeated sandbox mistakes)', () => {
  it('$list is documented as serializable data, NOT live DOM nodes', () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    assert.match(t.systemPromptBase, /NOT live DOM nodes/);
    assert.match(t.systemPromptBase, /querySelectorAll/);
    assert.ok(!/\$list\(sel\) → elements\b/.test(t.systemPromptBase), 'the misleading bare "→ elements" wording is gone');
  });

  it('teaches that DOM nodes and un-awaited Promises cannot cross the sandbox boundary', () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    assert.match(t.systemPromptBase, /cannot cross the sandbox boundary/i);
    assert.match(t.systemPromptBase, /un-awaited Promises|unawaited Promises/i);
    assert.ok(!/facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i.test(t.systemPromptBase), 'no site tokens');
  });
});

describe('sixteenth-log: persistent empties are named, not rationalized', () => {
  it('rule 10 teaches the partialEmptyFields census and the emptyRatio semantics', () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    assert.match(t.systemPromptBase, /detectors\.partialEmptyFields/);
    assert.match(t.systemPromptBase, /emptyRatio 1/);
    assert.match(t.systemPromptBase, /fix the binding \(attribute fallback\) or renegotiate with io\.confirm/i);
    assert.match(t.systemPromptBase, /move it to optional in the contract/i);
  });

  it('bans rationalizing persistent empties and hardcoding empty-string placeholders', () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    assert.match(t.systemPromptBase, /Never rationalize a persistent empty as timing/i);
    assert.match(t.systemPromptBase, /never hardcode an empty-string placeholder/i);
    assert.match(t.systemPromptBase, /An empty string is not a value/i);
    assert.ok(!/facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i.test(t.systemPromptBase), 'no site tokens');
  });

  it('verify.run spec mentions the partialEmptyFields detector', () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    const specs = t.toolSpecs.map((s) => s.name + ' ' + String(s.returns || ''));
    const vr = specs.find((s) => s.startsWith('verify.run'));
    assert.ok(vr, 'verify.run spec present');
    assert.match(vr, /partialEmptyFields/);
    assert.match(vr, /emptyRatio/);
  });
});

describe('sixteenth-log: the $ helper list is exhaustive ($json hallucination guard)', () => {
  it('states there is no $json/$log/$fetch and points at plain JS builtins', () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    assert.match(t.systemPromptBase, /The \$ list above is exhaustive/i);
    assert.match(t.systemPromptBase, /there is no \$json, \$log, \$fetch/i);
    assert.match(t.systemPromptBase, /JSON\.stringify/);
    assert.ok(!/facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i.test(t.systemPromptBase), 'no site tokens');
  });
});


describe('eleventh-log O1: rule 6 — popover absence is anchor-specific', () => {
  it('teaches varying the anchor before concluding popovers do not work', () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    assert.match(t.systemPromptBase, /ANCHOR-specific/);
    assert.match(t.systemPromptBase, /element that carries identity or author metadata is the usual hovercard carrier/);
    assert.match(t.systemPromptBase, /before concluding popovers do not work/);
    assert.ok(!/facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i.test(t.systemPromptBase), 'no site tokens');
  });
});

describe('audit C1: bridge waits park the engine clock', () => {
  it('io.confirm wraps bridge.request with parkBegin/parkEnd', async () => {
    const parks = [];
    const { deps } = makeDeps({ ioConfirmBridge: { request: async () => ({ confirmed: true }) } });
    const t = createSessionTools(deps);
    const ctx = { ledger: null, session: { parkBegin: () => parks.push('b'), parkEnd: () => parks.push('e') } };
    const r = await t.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } } }, ctx);
    assert.equal(r.confirmed, true);
    assert.deepEqual(parks, ['b', 'e']);
  });

  it('annotate.request wraps bridge.request with parkBegin/parkEnd', async () => {
    const parks = [];
    const { deps } = makeDeps({
      annotationBridge: { request: async () => ({ cancelled: true }) }
    });
    const t = createSessionTools(deps);
    await t.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } } });
    const ctx = { ledger: null, session: { parkBegin: () => parks.push('b'), parkEnd: () => parks.push('e') } };
    const r = await t.tools['annotate.request']({ why: 'w' }, ctx);
    assert.equal(r.cancelled, true);
    assert.deepEqual(parks, ['b', 'e']);
  });
});

describe('audit prompt universality + diag (C15/C17/C18/C21)', () => {
  it('systemPromptBase is shape-neutral and keeps the anchor-evidence balance', () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    const p = t.systemPromptBase;
    assert.ok(!/card author|profile link/i.test(p), 'C18: no card/author vocabulary');
    assert.ok(/repeating item/.test(p), 'C18: shape-neutral wording present');
    assert.ok(/two different anchors show no popover, stop/.test(p), 'C15: bounded second-anchor rule');
    assert.ok(/Scalar or single-value outputs skip the array filters/.test(p), 'C17: scalar-output clause');
    assert.ok(!/facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i.test(p), 'no site tokens');
  });

  it('C21: diag.read omits the popover bucket when there are no hover failure reasons', async () => {
    const { deps } = makeDeps();
    deps.runVerify = async () => ({
      report: { ok: true, error: null, detectors: {}, events: [] },
      events: [{ type: 'STEP_ITERATION', stepId: 's1', iteration: 1, resultPreview: '{"done":true}' }],
      raw: { testResult: { finalResult: {} }, error: null, breaker: null }
    });
    const t = createSessionTools(deps);
    await t.tools['verify.run']({});
    const r = await t.tools['diag.read']({});
    assert.equal(r.popover, undefined, 'empty bucket skipped');
  });
});

describe('audit C14 (pin): artifact version is read AFTER apply, one source of truth', () => {
  it('service.update returns the next version derived from session artifactVersions', async () => {
    const { deps, state } = makeDeps();
    const t = createSessionTools(deps);
    const mk = (n) => ({ ledger: null, session: { state: () => ({ session: { artifactVersions: new Array(n) } }) } });
    await t.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } } });
    const r1 = await t.tools['service.update']({ steps: GOOD_STEPS, inputSchema: { type: 'object' }, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } } }, mk(0));
    assert.equal(r1.updated, true);
    assert.equal(r1.version, 1);
    const r3 = await t.tools['service.update']({ steps: GOOD_STEPS }, mk(2));
    assert.equal(r3.version, 3);
    assert.ok(state.applied.length >= 1);
  });
});

describe('audit C3: probe receipts stamped with the rail page epoch', () => {
  it('epoch at record time — a reload between probes bumps the stamp', async () => {
    const base = makeDeps();
    const rail = Object.assign(base.deps.rail, { epoch: 1 });
    const { deps } = makeDeps({ rail });
    const t = createSessionTools(deps);
    const recorded = [];
    t.bindEngine({ observationLog: { record: (o) => recorded.push(o) } });
    await t.tools['probe.count']({ sel: 'div.card' });
    rail.epoch = 2; // the research tab reloaded between probes
    await t.tools['probe.count']({ sel: 'div.card' });
    assert.equal(recorded.length, 2);
    assert.equal(recorded[0].epoch, 1);
    assert.equal(recorded[1].epoch, 2);
  });

  it('no rail.epoch on the rail (legacy) leaves receipts unstamped', async () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    const recorded = [];
    t.bindEngine({ observationLog: { record: (o) => recorded.push(o) } });
    await t.tools['probe.count']({ sel: 'div.card' });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].epoch, undefined);
  });
});

describe('outputSchema field-shape gate (seventeenth log: fieldless schema shipped score-0 green garbage)', () => {
  const FIELDED = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } };

  it('io.confirm rejects an outputSchema with neither required nor properties — and never prompts the user', async () => {
    let bridgeCalls = 0;
    const { deps } = makeDeps({ ioConfirmBridge: { request: async () => { bridgeCalls += 1; return { confirmed: true }; } } });
    const t = createSessionTools(deps);
    // deliberately fieldless — the exact seventeenth-log shape
    const r = await t.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: { type: 'object' } });
    assert.match(r.error, /SCHEMA_NO_FIELDS/);
    assert.match(r.error, /properties/, 'teaches where fields must be declared');
    assert.equal(bridgeCalls, 0, 'the user is never prompted to confirm a blind contract');
  });

  it('io.confirm accepts fields declared via properties alone (required absent)', async () => {
    const { deps } = makeDeps({ ioConfirmBridge: { request: async () => ({ confirmed: true }) } });
    const t = createSessionTools(deps);
    const r = await t.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: { type: 'object', properties: { posts: { type: 'array' } } } });
    assert.equal(r.confirmed, true);
  });

  it('io.confirm accepts a fieldless inputSchema (no-parameter service) paired with a fielded outputSchema', async () => {
    const { deps } = makeDeps({ ioConfirmBridge: { request: async () => ({ confirmed: true }) } });
    const t = createSessionTools(deps);
    const r = await t.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: FIELDED });
    assert.equal(r.confirmed, true);
  });

  it('service.update rejects a fieldless outputSchema even after the contract was confirmed fielded', async () => {
    const { deps, state } = makeDeps();
    const t = createSessionTools(deps);
    const ctx = { session: { state: () => ({ session: { artifactVersions: [] } }) } };
    await t.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: FIELDED });
    // deliberately fieldless — must be rejected even with a confirmed contract
    const bad = await t.tools['service.update']({ steps: GOOD_STEPS, outputSchema: { type: 'object' } }, ctx);
    assert.match(bad.error, /SCHEMA_NO_FIELDS/);
    assert.equal(state.applied.length, 0, 'artifact NOT applied on schema rejection');
  });
});

describe('twentieth log: execution-model teaching', () => {
  it('system prompt describes the real async-function-BODY wrapping, not the false "placed after return" model', () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    const p = t.systemPromptBase;
    assert.ok(!p.includes('placed after `return`'), 'false execution-model sentence removed (it produced a wrong IIFE-wrapper repair at turn 59 of the twentieth log)');
    assert.ok(p.includes('BODY of an async function'), 'accurate body-wrap description present');
  });
});

describe('twentieth log: steps-less waiver amendment', () => {
  const FIELDED = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } };
  it('an overrides-only update against an existing artifact records the waiver', async () => {
    const { deps, state } = makeDeps();
    const t = createSessionTools(deps);
    const ctx = { session: { state: () => ({ session: { artifactVersions: [] } }) } };
    await t.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: FIELDED });
    const full = await t.tools['service.update']({ steps: GOOD_STEPS }, ctx);
    assert.equal(full.updated, true);
    const r = await t.tools['service.update']({ overrides: { selectors: ['div[role="none"]'] } }, ctx);
    assert.equal(r.updated, true);
    assert.equal(r.waiverRecorded, true, 'waiver acknowledged against the current artifact');
    assert.equal(state.applied.length, 1, 'a waiver amendment re-applies nothing');
  });

  it('an overrides-only update with no artifact yet fails with a teaching error', async () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    const ctx = { session: { state: () => ({ session: { artifactVersions: [] } }) } };
    await t.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: FIELDED });
    const r = await t.tools['service.update']({ overrides: ['div[role="none"]'] }, ctx);
    assert.match(r.error, /no artifact yet/);
  });
});

describe('twenty-first log: the confirmed contract lands in the artifact', () => {
  const IN = { type: 'object', required: ['keyword'], properties: { keyword: { type: 'string' } } };
  const OUT = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } };
  const OUT2 = { type: 'object', required: ['posts', 'time'], properties: { posts: { type: 'array', items: { type: 'object' } }, time: { type: 'string' } } };
  const CTX = () => ({ session: { state: () => ({ session: { artifactVersions: [] } }) } });

  it('a steps-only update after confirmation auto-attaches the confirmed schemas (schema-blind verify eliminated)', async () => {
    const { deps, state } = makeDeps();
    const t = createSessionTools(deps);
    await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT });
    const upd = await t.tools['service.update']({ steps: GOOD_STEPS }, CTX());
    assert.equal(upd.updated, true);
    assert.deepEqual(state.applied[0].inputSchema, IN, 'confirmed inputSchema merged into the apply payload');
    assert.deepEqual(state.applied[0].outputSchema, OUT, 'confirmed outputSchema merged into the apply payload');
    assert.equal(upd.schemasAttached, true, 'names the attachment so the model knows verify sees the contract');
  });

  it('the ledger marker embeds the FULL schemas; a resumed session attaches them without the runtime flag', async () => {
    const added = [];
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT }, { ledger: { add: (e) => added.push(e) } });
    assert.match(added[0].finding, / schemas: \{"inputSchema"/, 'full schemas embedded in the marker');
    assert.match(added[0].finding, / shape: \{"input"/, 'shape JSON still embedded (dedup path intact)');
    // Fresh instance = runtime flag gone (reload / seed resume).
    const second = makeDeps();
    const t2 = createSessionTools(second.deps);
    const upd = await t2.tools['service.update']({ steps: GOOD_STEPS }, {
      ledger: { serialize: () => ({ entries: added }), add: () => {} },
      session: { state: () => ({ session: { artifactVersions: [] } }) }
    });
    assert.equal(upd.updated, true);
    assert.deepEqual(second.state.applied[0].outputSchema, OUT, 'schemas recovered from the ledger marker after resume');
  });

  it('DRIFT rejection embeds the confirmed schemas verbatim and teaches the omit path', async () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT });
    const drifted = await t.tools['service.update']({ steps: GOOD_STEPS, outputSchema: OUT2 }, CTX());
    assert.match(drifted.error, /I\/O CONTRACT DRIFT/);
    assert.ok(drifted.error.indexOf(JSON.stringify(OUT)) !== -1, 'the confirmed schema itself is embedded for verbatim copy');
    assert.match(drifted.error, /steps ONLY|omit/i, 'teaches the steps-only resend path (schemas auto-attach)');
    assert.match(drifted.error, /io\.confirm/, 'teaches the renegotiation path');
  });

  it('a steps-less schema-only amendment attaches the confirmed schemas to the existing artifact and marks the last verify stale', async () => {
    const { deps, state } = makeDeps();
    const t = createSessionTools(deps);
    await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT });
    state.draft = { targetUrl: 'x', steps: GOOD_STEPS };
    await t.tools['verify.run']({});
    const amend = await t.tools['service.update']({ outputSchema: OUT }, CTX());
    assert.equal(amend.updated, true);
    assert.equal(amend.schemasAttached, true);
    const applied = state.applied[state.applied.length - 1];
    assert.deepEqual(applied.outputSchema, OUT, 'schema applied against the current steps');
    assert.ok(Array.isArray(applied.steps) && applied.steps.length === 1, 'existing steps preserved');
    const r = await t.tools['diag.read']({});
    assert.match(r.warning, /predates the current artifact/, 'stale verify flagged — re-verify before shipping');
  });

  it('a schema-only amendment whose shape DRIFTS is rejected with the renegotiation teaching', async () => {
    const { deps, state } = makeDeps();
    const t = createSessionTools(deps);
    await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT });
    state.draft = { targetUrl: 'x', steps: GOOD_STEPS };
    const amend = await t.tools['service.update']({ outputSchema: OUT2 }, CTX());
    assert.match(amend.error, /I\/O CONTRACT DRIFT/);
    assert.match(amend.error, /io\.confirm/);
  });

  it('a schema-only amendment with no artifact yet fails with a teaching error', async () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT });
    const r = await t.tools['service.update']({ outputSchema: OUT }, CTX());
    assert.match(r.error, /no artifact yet/);
  });

  it('verify.run falls back to the ledger-confirmed outputSchema when the artifact has none (resume was schema-blind)', async () => {
    const added = [];
    const seen = [];
    const { deps, state } = makeDeps({
      runVerify: async (o) => { seen.push(o.outputSchema); return { report: { ok: true, error: null, score: {}, events: [] }, events: [], raw: {} }; }
    });
    deps.getOutputSchema = () => null;
    const t = createSessionTools(deps);
    await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT }, { ledger: { add: (e) => added.push(e) } });
    state.draft = { targetUrl: 'x', steps: GOOD_STEPS };
    await t.tools['verify.run']({}, { ledger: { serialize: () => ({ entries: added }) } });
    assert.deepEqual(seen[0], OUT, 'verify used the confirmed schema recovered from the ledger');
  });

  it('diag.read {kind:"contract"} exposes confirmed-vs-artifact schema state without needing a verify run', async () => {
    const added = [];
    const { deps, state } = makeDeps({ getOutputSchema: () => null });
    const t = createSessionTools(deps);
    state.draft = { targetUrl: 'x', steps: GOOD_STEPS };
    const pre = await t.tools['diag.read']({ kind: 'contract' }, { ledger: { serialize: () => ({ entries: [] }) } });
    assert.equal(pre.contract.confirmed, false);
    assert.match(pre.contract.hint, /io\.confirm/);
    await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT }, { ledger: { add: (e) => added.push(e) } });
    const post = await t.tools['diag.read']({ kind: 'contract' }, { ledger: { serialize: () => ({ entries: added }) } });
    assert.equal(post.contract.confirmed, true);
    assert.equal(post.contract.artifactOutputSchema, 'MISSING');
    assert.match(post.contract.hint, /service\.update/);
  });

  it('rule 9 teaches that post-confirmation updates may omit schemas (they attach automatically)', () => {
    const { deps } = makeDeps();
    const t = createSessionTools(deps);
    assert.match(t.systemPromptBase, /schemas attach to the artifact automatically/i);
    assert.match(t.systemPromptBase, /schema-only service\.update/i);
    assert.ok(!/facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i.test(t.systemPromptBase), 'no site tokens');
  });
});
