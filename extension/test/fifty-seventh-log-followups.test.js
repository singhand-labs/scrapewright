// extension/test/fifty-seventh-log-followups.test.js
// Fifty-seventh log — glm-5.1, 36 turns, ZERO protocol violations, completed
// with a documented negative conclusion (logged-out search renders zero real
// posts; the fifty-first-log ledger finding was REUSED, the grounding gate
// rejected an invented selector, and the fifty-first-log selector
// differential fired perfectly on the red verify: base div[role=feed]
// [role=article] → 2, +:has(permalink-links) → 0, SELECTOR_OVERFILTERED
// reroute, honest finish). The system worked. Two residual engine gaps:
//  F1 the model invented a Playwright-style pseudo-class AGAIN (:textless —
//     the 51st log had :textish; the STANDARD-CSS prompt rule does not
//     prevent the class) — a deterministic landing-time lint names it.
//  F2 when the differential PROVES the population is zero for an input
//     class, the artifact that THROWS makes the deployed SERVICE error on
//     every such call; the fail-soft pattern (allowEmpty + {posts:[],note})
//     turns that into an honest green-with-disclosure — teach it at the
//     exact evidence site (the container-zero census text).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionTools } = require('../lib/session-tools');
const { createVerifyRunner } = require('../lib/verify-runner');
const WU = require('../lib/wizard-utils');

// ---------------------------------------------------------------------------
// F1: non-standard pseudo-class static lint
describe('F1: detectNonStandardPseudoSelectors (fifty-seventh log)', () => {
  it('names the exact :textless selector from this log, plus the sibling Playwright-isms', () => {
    const steps = [
      { id: 'x', name: 'X', script: "await $click(\"div[role=feed] [role=article] div[role=button]:has(span:textless)\")" },
      { id: 'y', name: 'Y', script: "return $count('a:has-text(\"Next\"), li:contains(foo)')" }
    ];
    const out = WU.detectNonStandardPseudoSelectors(steps);
    assert.ok(out && out.length >= 3, 'finds :textless, :has-text, :contains: ' + JSON.stringify(out));
    const pseudos = out.map((h) => h.pseudo);
    assert.ok(pseudos.includes(':textless'));
    assert.ok(pseudos.some((p) => /has-text/i.test(p)));
    assert.ok(pseudos.some((p) => /contains/i.test(p)));
    assert.equal(out[0].stepId, 'x');
  });

  it('standard CSS pseudos (:has/:not/:is/:nth-of-type/:scope/:hover-free selectors) never trip it', () => {
    const steps = [
      { id: 'x', name: 'X', script: "return $extractList(\"div[role=feed] > div:has(a[href*='/posts/'], a[href*='/permalink/']):not(:has(h2))\", {t:{selector:':scope span'}})" }
    ];
    assert.equal(WU.detectNonStandardPseudoSelectors(steps), null);
  });

  it('prose containing "context: text" does not trip it (colon must hug the pseudo name in a selector-ish context)', () => {
    const steps = [{ id: 'x', name: 'X', script: "const note = 'the context: text matters'; return { note };" }];
    assert.equal(WU.detectNonStandardPseudoSelectors(steps), null);
  });

  it('empty / malformed steps → null, never throws', () => {
    assert.equal(WU.detectNonStandardPseudoSelectors([]), null);
    assert.equal(WU.detectNonStandardPseudoSelectors(null), null);
  });

  it('service.update lands the artifact but carries the pointed advisory receipt', async () => {
    const deps = makeDeps57();
    const applied = [];
    deps.applyArtifact = (a) => { applied.push(a); };
    deps.getDraftService = () => ({ name: 's', steps: [{ id: 'x', script: 'return 1', onSuccess: 'TERMINATE' }] });
    const t = createSessionTools(deps);
    await t.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } } });
    const r = await t.tools['service.update']({ steps: [
      { id: 'load', name: 'load', script: "await $wait('body'); return {ok:true};", onSuccess: 'x' },
      { id: 'x', name: 'X', script: "const sel = 'div[role=button]:has(span:textless)'; await $click(sel); return {done:true};", onSuccess: 'TERMINATE' }
    ] }, ctx57());
    assert.equal(r.updated, true, 'advisory-only — the artifact still applies');
    assert.ok(Array.isArray(r.staticLint) && r.staticLint.some((l) => /textless|non-standard pseudo/i.test(l)),
      'receipt names the class: ' + JSON.stringify(r.staticLint));
    assert.equal(applied.length, 1);
  });
});

// ---------------------------------------------------------------------------
// F2: fail-soft teaching at the container-zero evidence site
describe('F2: container-zero census teaches the fail-soft artifact (fifty-seventh log)', () => {
  it('the INPUT_VALUE_SUSPECT error mentions allowEmpty + {posts:[],note} so the SERVICE reports honestly instead of erroring', async () => {
    const events = [
      { type: 'STEP_FAILED', stepId: 'extract', error: '$extractWithHover: no containers matched', selectorDiagnostics: [{
        api: 'extractWithHover', containerSelector: "div[role=feed] [role=article]:has(a[href*='/posts/'])", containerMatches: 0,
        selectorDifferential: [
          { sel: "div[role=feed] [role=article]:has(a[href*='/posts/'])", count: 0 },
          { sel: 'div[role=feed] [role=article]', count: 2 }
        ]
      }] }
    ];
    const runner = makeRunner57(events, async (service, input, orchDeps, options) => {
      for (const e of events) options.onEvent(e);
      const err = new Error('$extractWithHover: no containers matched');
      err.stepId = 'extract';
      throw err;
    });
    const out = await runner({ service: SERVICE57, input: {}, outputSchema: SCHEMA57 });
    assert.equal(out.report.ok, false);
    const msg = String((out.report.error && out.report.error.message) || '');
    assert.match(msg, /SELECTOR_OVERFILTERED/, 'populated base → overfiltered lead (differential present)');
    assert.match(msg, /allowEmpty/i, 'teaches the fail-soft pattern');
    assert.match(msg, /posts:\s*\[\]|note/i, 'names the honest-empty return shape');
  });
});

// helpers
function makeDeps57() {
  return {
    rail: {
      pageOpen: async () => ({ tabId: 1, url: 'https://example.com', ready: true }),
      pageState: async () => ({ open: true, tabId: 1, url: 'https://example.com' }),
      executeDsl: async () => 5,
      ensureLock: async () => {}, releaseLock: async () => {}, dispose: async () => {}, tabId: 1
    },
    runVerify: async () => ({ report: { ok: true, error: null, aborted: false, score: { score: 100, isData: true, breakdown: {} }, schemaOk: true, schemaMissing: [], detectors: { emptyFields: [], duplicateFields: [], countShortfall: null }, steps: [], finalResult: {}, pages: '1', eventCount: 1, events: [] }, events: [], raw: {} }),
    getDraftService: () => null,
    applyArtifact: () => {},
    getTestInput: () => null,
    getOutputSchema: () => null,
    getSteps: () => [],
    annotationBridge: null,
    ioConfirmBridge: { request: async () => ({ confirmed: true }) }
  };
}
function ctx57() {
  return { session: { state: () => ({ session: { artifactVersions: [] } }) } };
}

function makeRunner57(eventsToEmit, orchestrateImpl) {
  const deps = {
    orchestrate: orchestrateImpl,
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
const SERVICE57 = { targetUrl: 'https://example.com', steps: [
  { id: 'extract', name: 'extract posts', script: 'return 1', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
], config: {} };
const SCHEMA57 = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', required: ['content'], properties: { content: { type: 'string' } } } } } };

// universality
describe('universality: fifty-seventh-log additions carry no site tokens', () => {
  const FORBIDDEN = /facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i;
  it('the pseudo lint stays generic', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, '../lib/wizard-utils.js'), 'utf8').replace(/\0/g, '');
    const i = src.indexOf('function detectNonStandardPseudoSelectors');
    assert.ok(i > -1, 'lint present');
    assert.ok(!FORBIDDEN.test(src.slice(i, i + 1800)));
  });
});
