// extension/test/fifty-ninth-log-loginstate.test.js
// Fifty-ninth-log correction (user-reported): "无登录" was MY misjudgment —
// the browser was logged in the whole time; the 55th/58th sessions on the
// SAME browser extracted real posts, which already falsified the theory the
// 51st session's model asserted and I endorsed without evidence. The
// capability gap: NOTHING lets the model (or me) ground a login-state claim —
// "unauthenticated" was asserted from page SHAPE (recommendation cards) with
// zero login-marker evidence. Per the capability-walls-get-tools principle:
// probe.loginState, one call, marker census + interpretation.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createProbeTools } = require('../lib/probe-tools');
const { createObservationLog } = require('../lib/observation-log');
const { createSessionTools } = require('../lib/session-tools');

function makeTools(impl, snippetCapture) {
  const observationLog = createObservationLog();
  const tools = createProbeTools({ executeDsl: async (snippet) => {
    if (snippetCapture) snippetCapture(snippet);
    return impl(snippet);
  }, observationLog });
  return { tools, observationLog };
}

describe('probe.loginState (fifty-ninth-log correction)', () => {
  it('logout markers with no password fields → logged in, with the evidence numbers', async () => {
    const { tools } = makeTools(async () => ({ passwordFields: 0, loginLinks: 1, logoutMarkers: 2 }));
    const r = await tools.loginState({});
    assert.ok(!r.error, JSON.stringify(r));
    assert.equal(r.loggedIn, true);
    assert.equal(r.loginWall, false);
    assert.equal(r.evidence.logoutMarkers, 2);
    assert.match(r.note, /logged in/i);
  });

  it('password fields + login links, no logout markers → login wall', async () => {
    const { tools } = makeTools(async () => ({ passwordFields: 2, loginLinks: 5, logoutMarkers: 0 }));
    const r = await tools.loginState({});
    assert.equal(r.loggedIn, false);
    assert.equal(r.loginWall, true);
    assert.match(r.note, /log ?in wall|login wall|not logged in/i);
  });

  it('neither marker (SPA shell) → null verdict with an honest ambiguous note', async () => {
    const { tools } = makeTools(async () => ({ passwordFields: 0, loginLinks: 0, logoutMarkers: 0 }));
    const r = await tools.loginState({});
    assert.equal(r.loggedIn, null);
    assert.equal(r.loginWall, null);
    assert.match(r.note, /no decisive markers|ambiguous/i);
    assert.match(r.note, /retry|settle|menu/i, 'note teaches the next step (settle/retry, open the account menu marker)');
  });

  it('composes ONE snippet over the rail (a single round trip)', async () => {
    const snippets = [];
    const { tools } = makeTools(async () => ({ passwordFields: 0, loginLinks: 0, logoutMarkers: 1 }), (s) => snippets.push(s));
    await tools.loginState({});
    assert.equal(snippets.length, 1, 'exactly one executeDsl call');
    assert.ok(snippets[0].includes('$count'), 'composed over $count');
    assert.ok(snippets[0].includes('input[type=password]'), 'password marker');
    assert.ok(/logout/.test(snippets[0]), 'logout marker');
  });

  it('records an observation receipt', async () => {
    const { tools, observationLog } = makeTools(async () => ({ passwordFields: 0, loginLinks: 0, logoutMarkers: 1 }));
    await tools.loginState({});
    assert.equal(observationLog.size(), 1);
  });

  it('wired into the session bag + spec + system prompt (the anti-misjudgment routing)', async () => {
    const deps = {
      rail: {
        pageOpen: async () => ({ tabId: 1, url: 'https://example.com', ready: true }),
        pageState: async () => ({ open: true, tabId: 1, url: 'https://example.com' }),
        executeDsl: async () => ({}),
        ensureLock: async () => {}, releaseLock: async () => {}, dispose: async () => {}, tabId: 1
      },
      runVerify: async () => ({ report: { ok: true, error: null, aborted: false, score: { score: 1, isData: true, breakdown: {} }, schemaOk: true, schemaMissing: [], detectors: { emptyFields: [], duplicateFields: [], countShortfall: null }, steps: [], finalResult: {}, pages: '1', eventCount: 1, events: [] }, events: [], raw: {} }),
      getDraftService: () => null, applyArtifact: () => {}, getTestInput: () => null,
      getOutputSchema: () => null, getSteps: () => [],
      annotationBridge: null, ioConfirmBridge: { request: async () => ({ confirmed: true }) }
    };
    const t = createSessionTools(deps);
    assert.equal(typeof t.tools['probe.loginState'], 'function', 'wired');
    const spec = t.toolSpecs.find((s) => s.name === 'probe.loginState');
    assert.ok(spec, 'spec present');
    assert.match(spec.returns, /loggedIn|evidence/i);
    assert.match(t.systemPromptBase, /probe\.loginState/, 'the prompt teaches it');
    assert.match(t.systemPromptBase, /before concluding.*(unauthenticated|log.?in|login)/i, 'gates environmental conclusions on evidence');
  });

  it('universal — no site tokens in the probe source', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../lib/probe-tools.js'), 'utf8');
    const i = src.indexOf('async function loginState');
    assert.ok(i > -1, 'loginState present');
    assert.ok(!/facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i.test(src.slice(i, i + 2200)));
  });
});
