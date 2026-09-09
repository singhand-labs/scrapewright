// extension/test/fiftieth-log-followups.test.js
// Fiftieth log — the session finally completed green (47 turns, score 153.5) but
// four compounding gaps showed up in the evidence:
//  F1 detectFrozenScrollCount fired on a SELF-RESOLVED freeze (2×6 then done:true
//     count:5 — the count grew, the tag still attached on a green run) while the
//     v2 red run (0, 2×14 terminal POLL_EXHAUSTED — the REAL freeze) got NO tag
//     because the whole census block hangs off `else if (result)` and an
//     orchestrationError run skips every census.
//  F2 io.confirm carried testInput {keyword, count} at turn 22; the artifact
//     landed at turn 39 WITHOUT it (attachConfirmedTestInput defers to "attaches
//     on landing" but the landing merge fills only schemas); verify {} burned a
//     red "Missing URL template parameter" + a fix turn.
//  F3 likes 5/5 empty while shares 5/5 populated in the same action-bar family —
//     the empty count's value lives in an aria-label attribute / aria-labelledby
//     reference (the timestamp mechanism proved on the same page), but no census
//     contrasts sibling count fields, so the model shipped empty.
//  F4 POLL_EXHAUSTED showed 15 frozen returns but not that they ran in 1.1s —
//     avg 74ms/attempt means no settle between polls; the model guessed the fix.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WU = require('../lib/wizard-utils');
const { createSessionTools } = require('../lib/session-tools');
const { KNOWLEDGE_UNITS } = require('../lib/knowledge-units');

function evtIter(stepId, preview, diags) {
  return { type: 'STEP_ITERATION', stepId, resultPreview: preview, selectorDiagnostics: diags || [] };
}
const SCROLL_DIAG = [{ api: 'scrollBy', selector: 'body', moved: true }];
const COUNT_DIAG = [{ api: 'count', selector: '.c' }];

// ---------------------------------------------------------------------------
// F1a: detectFrozenScrollCount self-resolved suppression
describe('F1: detectFrozenScrollCount self-resolved suppression (fiftieth log)', () => {
  it('the fiftieth-log v3 shape — 2 frozen ×6 then done:true count:5 — suppresses (the freeze resolved; a green run must not be tagged)', () => {
    const events = [];
    for (let i = 0; i < 6; i++) events.push(evtIter('load', '{"done":false,"count":2}', SCROLL_DIAG));
    events.push(evtIter('load', '{"done":true,"count":5}', SCROLL_DIAG));
    assert.equal(WU.detectFrozenScrollCount(events).length, 0);
  });

  it('done:true at the SAME plateau value also suppresses — the step met its own criterion', () => {
    const events = [];
    for (let i = 0; i < 6; i++) events.push(evtIter('load', '{"done":false,"count":2}', SCROLL_DIAG));
    events.push(evtIter('load', '{"done":true,"count":2}', SCROLL_DIAG));
    assert.equal(WU.detectFrozenScrollCount(events).length, 0);
  });

  it('the fiftieth-log v2 shape — 0 then 2×14 TERMINAL (exhausted while frozen) — still fires with grewFrom', () => {
    const events = [evtIter('load', '{"done":false,"count":0}', SCROLL_DIAG)];
    for (let i = 0; i < 14; i++) events.push(evtIter('load', '{"done":false,"count":2}', SCROLL_DIAG));
    const out = WU.detectFrozenScrollCount(events);
    assert.equal(out.length, 1);
    assert.equal(out[0].frozenCount, 2);
    assert.equal(out[0].grewFrom, null, 'positive-only parser: the leading 0 iteration is the zero-trap class; the positives never grew above 2');
  });

  it('pure frozen with no done:true at all (the forty-ninth-log shape) still fires', () => {
    const events = [];
    for (let i = 0; i < 7; i++) events.push(evtIter('scroll', '{"done":false,"count":2}', SCROLL_DIAG));
    assert.equal(WU.detectFrozenScrollCount(events).length, 1);
  });
});

// ---------------------------------------------------------------------------
// F1b: red-run census un-gating (events-only censuses must run on error runs)
function makeRunner(eventsToEmit, orchestrateImpl) {
  const deps = {
    orchestrate: orchestrateImpl || (async (service, input, orchDeps, options) => {
      for (const e of eventsToEmit) options.onEvent(e);
      return {
        finalResult: { posts: [{ postId: '111', content: 'a' }, { postId: '222', content: 'b' }, { postId: '333', content: 'c' }] },
        steps: [{ stepId: 'extract', stepName: 'extract', result: { done: true } }],
        pages: []
      };
    }),
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
  // eslint-disable-next-line global-require
  const { createVerifyRunner } = require('../lib/verify-runner');
  return createVerifyRunner(deps);
}

const SERVICE = { targetUrl: 'https://example.com', steps: [
  { id: 'load', name: 'load', script: 'return 1', onSuccess: 'extract', onFailure: 'TERMINATE', maxIterations: 15 },
  { id: 'extract', name: 'extract', script: 'return 1', onSuccess: 'TERMINATE' }
], config: {} };

const SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', required: ['postId'], properties: {
  postId: { type: 'string' }, content: { type: 'string' }
} } } } };

describe('F1b: red-run census un-gating (orchestrationError runs need the events censuses too)', () => {
  it('a POLL_EXHAUSTED red run with a terminal frozen counter carries SCROLL_COUNT_FROZEN (the v2 verify of the fiftieth log)', async () => {
    const events = [evtIter('load', '{"done":false,"count":0}', SCROLL_DIAG)];
    for (let i = 0; i < 14; i++) events.push(evtIter('load', '{"done":false,"count":2}', SCROLL_DIAG));
    const runner = makeRunner(events, async (service, input, orchDeps, options) => {
      for (const e of events) options.onEvent(e);
      const err = new Error('POLL_EXHAUSTED: Step "load" exhausted after 15 attempt(s) without producing a ready result; last not-ready return(s): {"done":false,"count":2}');
      err.code = 'POLL_EXHAUSTED';
      throw err;
    });
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA });
    assert.equal(out.report.ok, false);
    assert.ok(Array.isArray(out.report.detectors.scrollCountFrozen) && out.report.detectors.scrollCountFrozen.length === 1,
      'the red run that MOST needs the freeze evidence gets it: ' + JSON.stringify(out.report.detectors.scrollCountFrozen));
    assert.ok(out.report.events.includes('SCROLL_COUNT_FROZEN'), 'tags: ' + JSON.stringify(out.report.events));
  });

  it('a self-resolved freeze on a green run no longer tags (suppression flows through the wiring)', async () => {
    const events = [];
    for (let i = 0; i < 6; i++) events.push(evtIter('load', '{"done":false,"count":2}', SCROLL_DIAG));
    events.push(evtIter('load', '{"done":true,"count":5}', SCROLL_DIAG));
    const runner = makeRunner(events);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA });
    assert.equal(out.report.ok, true);
    assert.equal(out.report.detectors.scrollCountFrozen, null);
    assert.ok(!out.report.events.includes('SCROLL_COUNT_FROZEN'), 'no nag on a resolved freeze: ' + JSON.stringify(out.report.events));
  });
});

// ---------------------------------------------------------------------------
// F2: service.update attaches the confirmed testInput on artifact landing
function makeDepsF2() {
  const state = { applied: [], draft: null };
  const deps = {
    rail: {
      pageOpen: async () => ({ tabId: 1, url: 'https://example.com', ready: true }),
      pageState: async () => ({ open: true, tabId: 1, url: 'https://example.com' }),
      executeDsl: async () => 5,
      ensureLock: async () => {}, releaseLock: async () => {}, dispose: async () => {}, tabId: 1
    },
    runVerify: async () => ({ report: { ok: true, error: null, aborted: false, score: { score: 100, isData: true, breakdown: {} }, schemaOk: true, schemaMissing: [], detectors: { emptyFields: [], duplicateFields: [], countShortfall: null }, steps: [], finalResult: { posts: [{ t: 1 }] }, pages: '1', eventCount: 2, events: [] }, events: [], raw: {} }),
    getDraftService: () => state.draft,
    applyArtifact: (a) => { state.applied.push(a); state.draft = { targetUrl: 'https://example.com', steps: a.steps, testInput: a.testInput, inputSchema: a.inputSchema, outputSchema: a.outputSchema }; },
    getTestInput: () => (state.draft ? state.draft.testInput : null),
    getOutputSchema: () => (state.draft ? state.draft.outputSchema : null),
    getSteps: () => (state.draft ? state.draft.steps : []),
    annotationBridge: null,
    ioConfirmBridge: { request: async () => ({ confirmed: true }) }
  };
  return { deps, state };
}

const IN2 = { type: 'object', required: ['keyword'], properties: { keyword: { type: 'string' } } };
const OUT2 = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } };
const GOOD_STEPS2 = [
  { id: 's1', name: 'extract', script: "return $extractList('div.card', {t:{selector:'.t'}});", onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
];
const CTX2 = () => ({ session: { state: () => ({ session: { artifactVersions: [] } }) } });

describe('F2: service.update attaches the confirmed testInput on artifact landing (fiftieth log)', () => {
  it('io.confirm carried testInput; the steps-only landing merges it alongside the schemas', async () => {
    const { deps, state } = makeDepsF2();
    const t = createSessionTools(deps);
    await t.tools['io.confirm']({ inputSchema: IN2, outputSchema: OUT2, testInput: { keyword: '机器学习', count: 5 } });
    const upd = await t.tools['service.update']({ steps: GOOD_STEPS2 }, CTX2());
    assert.equal(upd.updated, true);
    assert.deepEqual(state.applied[0].testInput, { keyword: '机器学习', count: 5 },
      'the landing merge must carry the confirmed test values, not just the schemas');
    assert.equal(upd.testInputAttached, true, 'names the attachment so the model knows verify runs the confirmed values without an override');
  });

  it('an explicit testInput in the update is NOT overwritten by the confirmed one', async () => {
    const { deps, state } = makeDepsF2();
    const t = createSessionTools(deps);
    await t.tools['io.confirm']({ inputSchema: IN2, outputSchema: OUT2, testInput: { keyword: 'a', count: 5 } });
    // NOTE: a DIFFERING explicit testInput is a material change the drift gate
    // rejects; the SAME values pass and must not double-apply.
    const upd = await t.tools['service.update']({ steps: GOOD_STEPS2, testInput: { keyword: 'a', count: 5 } }, CTX2());
    assert.equal(upd.updated, true);
    assert.deepEqual(state.applied[0].testInput, { keyword: 'a', count: 5 });
  });

  it('no confirmed testInput anywhere → landing stays as-is (no invention)', async () => {
    const { deps, state } = makeDepsF2();
    const t = createSessionTools(deps);
    await t.tools['io.confirm']({ inputSchema: IN2, outputSchema: OUT2 });
    const upd = await t.tools['service.update']({ steps: GOOD_STEPS2 }, CTX2());
    assert.equal(upd.updated, true);
    assert.equal(state.applied[0].testInput, undefined);
  });
});

// ---------------------------------------------------------------------------
// F3: sibling count contrast census
const COUNT_SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', properties: {
  likes: { type: 'string' }, comments: { type: 'string' }, shares: { type: 'string' }, postId: { type: 'string' }
} } } } };

describe('F3: detectSiblingCountContrast census (fiftieth log)', () => {
  it('likes 5/5 + comments 3/5 empty while shares 5/5 populated → both named with the populated sibling as proof', () => {
    const data = { posts: [
      { postId: '1', likes: '', comments: '', shares: '4' },
      { postId: '2', likes: '', comments: '', shares: '425' },
      { postId: '3', likes: '', comments: '69', shares: '2.4K' },
      { postId: '4', likes: '', comments: '', shares: '1' },
      { postId: '5', likes: '', comments: '3', shares: '170' }
    ] };
    const out = WU.detectSiblingCountContrast(data, COUNT_SCHEMA);
    assert.equal(out.length, 2);
    const likes = out.find(x => x.field === 'likes');
    assert.ok(likes, 'likes named');
    assert.equal(likes.populatedSibling, 'shares');
    assert.equal(likes.emptyRatio, 1);
    const comments = out.find(x => x.field === 'comments');
    assert.ok(comments, 'comments named');
    assert.equal(comments.populatedSibling, 'shares');
    assert.ok(comments.emptyRatio >= 0.6);
    for (const e of out) {
      assert.ok(/aria/i.test(e.note), 'note must name the aria routes');
      assert.ok(/labelledby/.test(e.note), 'note must name the labelledby route');
      assert.ok(/attrStats/.test(e.note) || /attr/.test(e.note), 'note must name the attribute route');
    }
  });

  it('ALL counts empty → no contrast (nothing proves the family renders counts as text)', () => {
    const data = { posts: [
      { likes: '', comments: '', shares: '' }, { likes: '', comments: '', shares: '' }
    ] };
    assert.equal(WU.detectSiblingCountContrast(data, COUNT_SCHEMA).length, 0);
  });

  it('non-count fields are invisible to the census', () => {
    const schema = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', properties: {
      postId: { type: 'string' }, location: { type: 'string' }, shares: { type: 'string' }
    } } } } };
    const data = { posts: [
      { postId: '', location: '', shares: '4' }, { postId: '', location: '', shares: '9' }
    ] };
    assert.equal(WU.detectSiblingCountContrast(data, schema).length, 0);
  });

  it('malformed input → empty, never throws', () => {
    assert.equal(WU.detectSiblingCountContrast(null, COUNT_SCHEMA).length, 0);
    assert.equal(WU.detectSiblingCountContrast(undefined, null).length, 0);
  });

  it('verify wiring: report-only advisory + COUNT_FIELD_HIDDEN_VALUE tag on a green run', async () => {
    const data = { posts: [
      { postId: '1', likes: '', shares: '4' }, { postId: '2', likes: '', shares: '9' },
      { postId: '3', likes: '', shares: '2' }, { postId: '4', likes: '', shares: '7' }
    ] };
    const schema = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', required: ['postId'], properties: {
      postId: { type: 'string' }, likes: { type: 'string' }, shares: { type: 'string' }
    } } } } };
    const runner = makeRunner([], async (service, input, orchDeps, options) => ({
      finalResult: data,
      steps: [{ stepId: 'extract', stepName: 'extract', result: { done: true } }],
      pages: []
    }));
    const out = await runner({ service: SERVICE, input: {}, outputSchema: schema });
    assert.equal(out.report.ok, true, 'report-only: the census is evidence, not a verdict');
    const d = out.report.detectors.siblingCountContrast;
    assert.ok(Array.isArray(d) && d.length === 1 && d[0].field === 'likes', 'census wired: ' + JSON.stringify(d));
    assert.ok(out.report.events.includes('COUNT_FIELD_HIDDEN_VALUE'), 'tags: ' + JSON.stringify(out.report.events));
  });

  it('knowledge unit count-field-hidden-value exists, keyed to the tag, teaching the aria routes', () => {
    const u = KNOWLEDGE_UNITS.find(x => x.id === 'count-field-hidden-value');
    assert.ok(u, 'unit must exist');
    assert.ok(u.matchEvents.includes('COUNT_FIELD_HIDDEN_VALUE'));
    assert.ok(/aria-label/.test(u.body), 'must name the aria-label attribute route');
    assert.ok(/labelledby/.test(u.body), 'must name the labelledby reference route');
    assert.ok(/sibling/i.test(u.body), 'must teach the sibling-contrast reasoning');
  });
});

// ---------------------------------------------------------------------------
// F4: POLL_EXHAUSTED pacing evidence
describe('F4: POLL_EXHAUSTED carries iteration pacing evidence (fiftieth log)', () => {
  global.debugLogger = global.debugLogger || { log: () => {} };
  global.UrlTemplate = global.UrlTemplate || require('../lib/url-template');
  const { StepOrchestrator } = require('../lib/step-orchestrator');

  function mkDeps(exec) {
    return {
      createTab: async () => ({ id: 1 }),
      removeTab: async () => {},
      waitForTabLoad: async () => {},
      executeScript: exec,
      captureSnapshot: async () => ({ html: '' }),
      evaluateCondition: async () => true,
      log: () => {}
    };
  }

  it('back-to-back not-ready returns (avg < 300ms) → pacing numbers + settle teaching', async () => {
    const service = {
      targetUrl: 'http://example.com',
      steps: [
        { id: 'poll', name: 'Poll', script: 'x', onSuccess: 'extract', onFailure: 'TERMINATE', maxIterations: 6 },
        { id: 'extract', name: 'Extract', script: 'y', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
      ],
      config: {}
    };
    const deps = mkDeps(async () => ({ done: false, count: 2 }));
    let msg = '';
    await assert.rejects(() => StepOrchestrator.execute(service, {}, deps), (err) => {
      msg = err.message;
      return err.code === 'POLL_EXHAUSTED';
    });
    assert.match(msg, /avg \d+ms\/attempt/, 'pacing numbers embedded: ' + msg);
    assert.match(msg, /settle/i, 'settle teaching embedded: ' + msg);
  });

  it('a slow poll (avg ≥ 300ms) → pacing numbers but NO settle nag', async () => {
    const service = {
      targetUrl: 'http://example.com',
      steps: [
        { id: 'poll', name: 'Poll', script: 'x', onSuccess: 'extract', onFailure: 'TERMINATE', maxIterations: 3 },
        { id: 'extract', name: 'Extract', script: 'y', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
      ],
      config: {}
    };
    const deps = mkDeps(async () => {
      await new Promise((r) => setTimeout(r, 340));
      return { done: false, count: 2 };
    });
    let msg = '';
    await assert.rejects(() => StepOrchestrator.execute(service, {}, deps), (err) => {
      msg = err.message;
      return err.code === 'POLL_EXHAUSTED';
    });
    assert.match(msg, /avg \d+ms\/attempt/, 'pacing still disclosed');
    assert.ok(!/settle/i.test(msg), 'no settle nag when the poll already waits: ' + msg);
  });
});

// ---------------------------------------------------------------------------
// universality: no site tokens in the new surfaces
describe('universality: fiftieth-log additions carry no site tokens', () => {
  const FORBIDDEN = /facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i;
  it('new wizard-utils detectors + knowledge unit stay generic', () => {
    const wuSrc = fs.readFileSync(path.join(__dirname, '../lib/wizard-utils.js'), 'utf8').replace(/\0/g, '');
    for (const marker of ['detectSiblingCountContrast', 'detectFrozenScrollCount']) {
      assert.ok(wuSrc.includes(marker), marker + ' present');
    }
    const unit = KNOWLEDGE_UNITS.find(x => x.id === 'count-field-hidden-value');
    assert.ok(!FORBIDDEN.test(unit.id + ' ' + unit.title + ' ' + unit.body + ' ' + unit.matchEvents.join(' ')), 'unit generic');
    const soSrc = fs.readFileSync(path.join(__dirname, '../lib/step-orchestrator.js'), 'utf8');
    const pacingIdx = soSrc.indexOf('ms/attempt');
    assert.ok(pacingIdx > 0, 'pacing note present');
    assert.ok(!FORBIDDEN.test(soSrc.slice(pacingIdx - 400, pacingIdx + 400)), 'pacing note generic');
  });
});
