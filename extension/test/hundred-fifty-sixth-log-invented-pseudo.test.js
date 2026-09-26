// extension/test/hundred-fifty-sixth-log-invented-pseudo.test.js
//
// 156th log: the session finished GREEN v6 (5/5) under the 154th-round
// gates — COUNT_SHORTFALL_ASSEMBLY fired mid-session and the model fixed
// the count — but shipped six DECLARED fields empty in 5/5 records
// (postId, postTime, location, mediaUrls, comments, shares) with a finish
// claim that the page "does not render permalinks or absolute timestamps
// on cold load", while the same site yielded real postIds and ABSOLUTE
// postTimes in the 152nd-154th sessions. Two mechanical gaps:
//
// A. INVENTED PSEUDO-CLASS, third occurrence, novel name: the expand step
//    carried `div[role="button"]:has(> span:text-none)` — `:text-none` is
//    not in the 57th-round enumerated lint (textish/textless were), so it
//    landed and burned a verify round (CLICK_TARGET_NOT_FOUND: matched 8
//    containers, clicked 0, errored 8). Enumeration cannot win against
//    invention. The fix is an ORACLE, not a list: probe every
//    selector-shaped string literal against a document fragment — a
//    SyntaxError is the same deterministic browser verdict the step hits
//    at query time. Hard-reject at service.update when a DOM is available
//    (the wizard page always has one; node contexts keep the 57th
//    advisory-only lane).
//
// B. EMPTY-FIELD ROUTING: the knowledge units route time-field issues to
//    probe.timestamp FIRST MOVE — but only on POPULATED-but-wrong tags
//    (RELATIVE_TIMESTAMP / TIME_FIELD_IMPLAUSIBLE). The most common
//    late-session state — a time-named field EMPTY across records —
//    carried no routing at all, and the model shipped empty with a false
//    absence claim. The partialEmpty census note now routes by field
//    shape: time-named → probe.timestamp (the one-call tooltip route);
//    id-named → bind the per-card link href / harvest-and-filter.
//
// No site tokens.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const WU = require('../lib/wizard-utils');

const TEXT_NONE_STEP = {
  id: 'expand', name: 'expand',
  script: "const cs='div[role=button]:has(> span:text-none)'; await $clickInList('div[x]', cs); return {done:true};",
  onSuccess: 'TERMINATE'
};

describe('156th log A — mechanical invented-pseudo oracle', () => {
  it('extraction: the :text-none incident selector and :has-text are candidates; value strings are not', () => {
    const cands = WU.extractInventedPseudoCandidates(TEXT_NONE_STEP.script);
    assert.ok(cands && cands.length === 1, 'exactly the invented-pseudo string: ' + JSON.stringify(cands));
    assert.match(cands[0].sel, /text-none/);

    const hasText = WU.extractInventedPseudoCandidates("return $count('a:has-text(Next), li:contains(foo)')");
    assert.ok(hasText && hasText.length >= 1, ':has-text families are candidates');

    // value-shaped strings never reach the oracle
    assert.equal(WU.extractInventedPseudoCandidates("const role='mainAuthor', tag='role:mainAuthor', t='type:group'; return 1;").length, 0,
      'colon-value strings (role:mainAuthor / type:group) are not selector candidates');
    assert.equal(WU.extractInventedPseudoCandidates("const u='https://example.com/x-y'; return u;").length, 0,
      'URLs are skipped');
    assert.equal(WU.extractInventedPseudoCandidates("const note = 'the context: text matters'; return {note};").length, 0,
      'prose with colon-space is skipped');
  });

  it('extraction: concatenation fragments are skipped (a trailing-fragment literal is not a whole selector)', () => {
    const cands = WU.extractInventedPseudoCandidates("const sel = 'div:' + cls; await $click(sel);");
    assert.equal(cands.length, 0, 'a fragment adjacent to + would false-positive on the oracle');
  });

  it('oracle: standard hyphenated pseudos (:nth-last-child) pass; the invented ones are reported with the browser error', () => {
    const dom = new JSDOM('');
    const ok = WU.detectInventedPseudoSelectors([
      { id: 'a', script: "return $count('li:nth-last-child(2)')" },
      { id: 'b', script: "return $extract('[aria-label^=\"Like: 3 people\"]', 'aria-label')" }
    ], dom.window.document);
    assert.equal(ok, null, 'standard selectors — including hyphenated pseudos and colon-bearing attribute values — pass');

    const bad = WU.detectInventedPseudoSelectors([TEXT_NONE_STEP], dom.window.document);
    assert.ok(bad && bad.length === 1, 'the :text-none selector is rejected by the browser itself');
    assert.equal(bad[0].stepId, 'expand');
    assert.match(bad[0].selector, /text-none/);
    assert.ok(bad[0].error && bad[0].error.length > 0, 'the SyntaxError text rides along');
  });

  it('oracle without a document: the morpheme arm still catches the invented family; node advisory lanes stay unchanged (pinned by the 57th test)', () => {
    const docless = WU.detectInventedPseudoSelectors([TEXT_NONE_STEP], null);
    assert.ok(docless && docless.length === 1 && /text-none/.test(docless[0].selector),
      'the invented-morpheme arm does not need a DOM — lenient engines cannot absorb the family');
    // a parse-only invalid selector without invented morphemes needs the DOM arm
    assert.equal(WU.detectInventedPseudoSelectors([{ id: 'x', script: "return $count('div:foo(x)')" }], null), null,
      'non-morpheme invalid selectors belong to the DOM arm — docless stays silent there');
  });

  it('service.update HARD-REJECTS an invented pseudo-class when a DOM is available, and lands clean selectors', async () => {
    const { createSessionTools } = require('../lib/session-tools');
    function makeDeps(applied) {
      return {
        rail: {
          pageOpen: async () => ({ tabId: 1, url: 'https://example.com', ready: true }),
          pageState: async () => ({ open: true, tabId: 1, url: 'https://example.com' }),
          executeDsl: async () => 5,
          ensureLock: async () => {}, releaseLock: async () => {}, dispose: async () => {}, tabId: 1
        },
        runVerify: async () => ({ report: { ok: true, error: null, aborted: false, score: { score: 100, isData: true, breakdown: {} }, schemaOk: true, schemaMissing: [], detectors: { emptyFields: [], duplicateFields: [], countShortfall: null }, steps: [], finalResult: {}, pages: '1', eventCount: 1, events: [] }, events: [], raw: {} }),
        getDraftService: () => null,
        applyArtifact: (a) => { applied.push(a); },
        getTestInput: () => null,
        getOutputSchema: () => null,
        getSteps: () => [],
        annotationBridge: null,
        ioConfirmBridge: { request: async () => ({ confirmed: true }) }
      };
    }
    const dom = new JSDOM('');
    const prevDoc = global.document;
    global.document = dom.window.document;
    try {
      const ctx = { session: { state: () => ({ session: { artifactVersions: [] } }) } };
      const appliedBad = [];
      const tBad = createSessionTools(makeDeps(appliedBad));
      await tBad.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } } });
      const rBad = await tBad.tools['service.update']({ steps: [TEXT_NONE_STEP] }, ctx);
      assert.ok(rBad && typeof rBad.error === 'string' && /INVENTED_PSEUDO_SELECTOR/.test(rBad.error),
        'rejected with the class name: ' + JSON.stringify(rBad && rBad.error).slice(0, 120));
      assert.match(rBad.error, /text-none/);
      assert.match(rBad.error, /NOT applied|not applied/);
      assert.equal(appliedBad.length, 0, 'the artifact was never applied');

      const appliedGood = [];
      const tGood = createSessionTools(makeDeps(appliedGood));
      await tGood.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } } });
      const rGood = await tGood.tools['service.update']({ steps: [
        { id: 's1', name: 's', script: "return $extractList('div[role=feed] > div:has(a[href*=\"/posts/\"])', {t:{selector:'a'}})", onSuccess: 'TERMINATE' }
      ] }, ctx);
      assert.equal(rGood.updated, true, 'standard selectors still land');
      assert.equal(appliedGood.length, 1);
    } finally {
      if (prevDoc === undefined) delete global.document; else global.document = prevDoc;
    }
  });
});

describe('156th log B — partialEmpty census routes by field shape', () => {
  const { createVerifyRunner } = require('../lib/verify-runner');

  function makeRunner(orch) {
    return createVerifyRunner({
      ensureLock: async () => {},
      releaseLock: async () => {},
      createTab: async () => ({ id: 1 }),
      removeTab: async () => {},
      waitForTabLoad: async () => {},
      sendMessage: async () => ({ pong: true }),
      executeScript: async () => ({ result: 'ok', selectorDiagnostics: [] }),
      captureSnapshot: async () => ({ html: '<html></html>' }),
      evaluateCondition: async () => true,
      orchestrate: orch
    });
  }

  it('empty time-named and id-named fields carry probe.timestamp / per-card-href routes on the report', async () => {
    const SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object',
      required: ['content'],
      properties: { postId: { type: 'string' }, postTime: { type: 'string' }, content: { type: 'string' } } } } } };
    const orch = async (svc, input, d, opts) => {
      await d.createTab(svc.targetUrl);
      opts.onEvent({ type: 'EXECUTION_START' });
      return { finalResult: { posts: [
        { postId: '', postTime: '', content: 'c1' },
        { postId: '', postTime: '', content: 'c2' }
      ] }, steps: [], pages: [], pagesTruncated: false };
    };
    const out = await makeRunner(orch)({ service: { targetUrl: 'https://e.com', steps: [{ id: 's1', name: 'x', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }, input: { count: 2 }, outputSchema: SCHEMA });
    assert.equal(out.report.ok, true, 'optional empties stay advisory');
    assert.ok(out.report.partialEmptyNote, 'census note present');
    assert.match(out.report.partialEmptyNote, /probe\.timestamp/, 'time-named empties route to the one-call timestamp tool');
    assert.match(out.report.partialEmptyNote, /href/, 'id-named empties route to the per-card link binding');
  });
});
