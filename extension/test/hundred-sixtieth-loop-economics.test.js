// extension/test/hundred-sixtieth-loop-economics.test.js
//
// 160th round (spec A/B/D/E): loop economics + spot-check provenance.
// Evidence base: docs/sessionlog.log (159th session) — 26 snippets with 2
// DSL-argument errors while probe.extract was used once; a 165s
// OUTER_DEADLINE red verify from an oversized hover batch; the final
// spot-check verify (travel/5) overwrote the contract run (beauty/10) in
// the panel. Item C (verify-receipt aging) was WITHDRAWN on measurement:
// history tool entries already carry ~200-char summaries; the per-turn
// constant is the 65KB system layer, not history.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RS = fs.readFileSync(path.join(__dirname, '..', 'lib', 'research-session.js'), 'utf8');
const LLC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'llm-client.js'), 'utf8');
const ST = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session-tools.js'), 'utf8');
const LEO = fs.readFileSync(path.join(__dirname, '..', 'lib', 'list-extract-ops.js'), 'utf8');
const CS = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
const VR = fs.readFileSync(path.join(__dirname, '..', 'lib', 'verify-runner.js'), 'utf8');
const WU = require('../lib/wizard-utils');
const WJ = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');

describe('160 A — prompt_digest + usage ride the journal', () => {
  it('prompt_digest feeds the page journal sink (best-effort guarded)', () => {
    const i = RS.indexOf("console.log('[session] prompt_digest '");
    assert.ok(i > -1, 'digest console line found');
    const block = RS.slice(i, i + 1200);
    assert.match(block, /__scrapewrightJournalSink/, 'the same digest rides the sink');
    assert.match(block, /typeof window !== 'undefined'/, 'guarded for non-page contexts');
  });
  it('response usage goes through logContentChunks (which feeds the sink)', () => {
    const i = LLC.indexOf('[LLMClient] Response usage');
    assert.ok(i > -1);
    const block = LLC.slice(i - 200, i + 300);
    assert.match(block, /logContentChunks\('\[LLMClient\] Response usage'/, 'usage line via the chunker+sink path');
  });
});

describe('160 B — DSL-argument errors route to the structured probes', () => {
  const { createSessionTools } = require('../lib/session-tools');
  function makeDeps160(executeDsl) {
    return {
      rail: {
        pageOpen: async () => ({ tabId: 1, url: 'https://example.com', ready: true }),
        pageState: async () => ({ open: true, tabId: 1, url: 'https://example.com' }),
        executeDsl,
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
  const ctx160 = () => ({ session: { state: () => ({ session: { artifactVersions: [] } }) } });

  async function snippetError(exec, code) {
    const t = createSessionTools(makeDeps160(exec));
    await t.tools['io.confirm']({ inputSchema: { type: 'object' }, outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } } });
    return await t.tools['probe.snippet']({ code: code || 'return 1;' }, ctx160());
  }

  it('a fieldMap argument error gains the structured-probe ROUTE note', async () => {
    const r = await snippetError(async () => { throw new Error("$extractList fieldMap must be a non-empty object"); }, 'await $extractList("div", null); return 1;');
    assert.match(r.error, /fieldMap must be a non-empty object/);
    assert.match(r.error, /ROUTE: this is a typed-probe argument error/);
    assert.match(r.error, /probe\.extract/);
  });
  it('the hover-opts and range-arity argument errors route too', async () => {
    const r1 = await snippetError(async () => { throw new Error("$extractWithHover opts.hover must be an object"); });
    assert.match(r1.error, /ROUTE:/);
    const r2 = await snippetError(async () => { throw new Error("$extractWithHover only one of containerIndex/containerRange/maxContainers may be set"); });
    assert.match(r2.error, /ROUTE:/);
  });
  it('non-argument errors are unchanged (zero behavior drift)', async () => {
    const r = await snippetError(async () => { throw new Error('snippet exceeded 60000ms — size the batch'); });
    assert.ok(!/ROUTE:/.test(r.error), 'timeout errors carry no route note');
    const r2 = await snippetError(async () => { throw new Error('SYNTAX_ERROR: Unexpected token'); });
    assert.ok(!/ROUTE:/.test(r2.error), 'syntax errors carry no route note');
  });
  it('a CLICK-op containerSel argument error gets NO route note (wrong advice class)', async () => {
    const r = await snippetError(async () => { throw new Error('$clickInList containerSel must be a non-empty string'); });
    assert.ok(!/ROUTE:/.test(r.error), 'click-op argument errors are not extraction-route material');
  });
});

describe('160 D — hoverBatchCostHint (data-driven batch sizing)', () => {
  const LEOm = require('../lib/list-extract-ops');
  it('measures per-container/per-anchor price and derives the suggested batch', () => {
    const h = LEOm.hoverBatchCostHint({ processedContainers: 4, anchorsHovered: 8, batchWallMs: 20000, deadlineAt: 100000, now: 60000 });
    assert.equal(h.batchWallMs, 20000);
    assert.equal(h.perContainerMs, 5000);
    assert.equal(h.perAnchorMs, 2500);
    assert.equal(h.budgetRemainingMs, 40000);
    assert.equal(h.suggestedBatchContainers, 6); // floor(40000*0.8/5000)
  });
  it('no deadline → budget fields null (graceful)', () => {
    const h = LEOm.hoverBatchCostHint({ processedContainers: 2, anchorsHovered: 2, batchWallMs: 4000 });
    assert.equal(h.budgetRemainingMs, null);
    assert.equal(h.suggestedBatchContainers, null);
  });
  it('zero/degenerate inputs never divide by zero', () => {
    const h = LEOm.hoverBatchCostHint({ processedContainers: 0, anchorsHovered: 0, batchWallMs: 0, deadlineAt: 10, now: 5 });
    assert.equal(h.perContainerMs, 0);
    assert.equal(h.suggestedBatchContainers, null); // perContainer 0 → null, never Infinity
  });
  it('content-script wires hoverCost into extractWithHover diagnostics (source audit)', () => {
    const i = CS.indexOf('async function domExtractWithHover(');
    const body = CS.slice(i, CS.indexOf('async function domOpenTab', i));
    assert.match(body, /hoverBatchCostHint\(/, 'the pure helper is called');
    assert.match(body, /_diagnostics\.hoverCost/, 'diagnostics carry hoverCost');
    assert.match(body, /suggestedBatchContainers/, 'the suggestion rides the receipt');
  });
});

describe('160 E1 — executedInput + pickPrimaryResultForPanel', () => {
  it('pickPrimaryResultForPanel prefers the LAST confirmed-input green run', () => {
    const runs = [
      { input: { keyword: 'A', count: 10 }, ok: true, testResult: { r: 1 }, executedArtifactVersion: 6 },
      { input: { keyword: 'B', count: 5 }, ok: true, testResult: { r: 2 }, executedArtifactVersion: 7 },
      { input: { keyword: 'A', count: 10 }, ok: true, testResult: { r: 3 }, executedArtifactVersion: 7 }
    ];
    const pick = WU.pickPrimaryResultForPanel({ runs, confirmedInput: { count: 10, keyword: 'A' } });
    assert.equal(pick.primary.testResult.r, 3, 'key order must not matter (stable compare)');
    assert.equal(pick.primaryIsConfirmedInput, true);
    assert.deepEqual(pick.spotChecks, [{ input: { keyword: 'B', count: 5 }, executedArtifactVersion: 7 }]);
  });
  it('confirmed input never green → latest green primary + flagged', () => {
    const runs = [
      { input: { keyword: 'A', count: 10 }, ok: false, testResult: null, executedArtifactVersion: 6 },
      { input: { keyword: 'B', count: 5 }, ok: true, testResult: { r: 9 }, executedArtifactVersion: 7 }
    ];
    const pick = WU.pickPrimaryResultForPanel({ runs, confirmedInput: { keyword: 'A', count: 10 } });
    assert.equal(pick.primary.testResult.r, 9);
    assert.equal(pick.primaryIsConfirmedInput, false);
  });
  it('no confirmedInput (manual runs) → last green primary, unflagged', () => {
    const runs = [{ input: null, ok: true, testResult: { r: 1 }, executedArtifactVersion: 1 }];
    const pick = WU.pickPrimaryResultForPanel({ runs, confirmedInput: null });
    assert.equal(pick.primary.testResult.r, 1);
    assert.equal(pick.primaryIsConfirmedInput, false);
  });
  it('the verify report carries executedInput (behavioral)', async () => {
    const { createVerifyRunner } = require('../lib/verify-runner');
    const orch = async (svc, input, d, opts) => {
      await d.createTab(svc.targetUrl);
      opts.onEvent({ type: 'EXECUTION_START' });
      return { finalResult: { posts: [{ postId: 'a', content: 'c', likeCount: '1' }] }, steps: [], pages: [], pagesTruncated: false };
    };
    const runner = createVerifyRunner({
      ensureLock: async () => {}, releaseLock: async () => {},
      createTab: async () => ({ id: 1 }), removeTab: async () => {},
      waitForTabLoad: async () => {}, sendMessage: async () => ({ pong: true }),
      executeScript: async () => ({ result: 'ok', selectorDiagnostics: [] }),
      captureSnapshot: async () => ({ html: '<html></html>' }),
      evaluateCondition: async () => true, orchestrate: orch
    });
    const SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', required: ['postId', 'content', 'likeCount'], properties: { postId: { type: 'string' }, content: { type: 'string' }, likeCount: { type: 'string' } } } } } };
    const out = await runner({
      service: { targetUrl: 'https://e.com', steps: [{ id: 's1', name: 'x', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} },
      input: { keyword: 'travel', count: 5 }, outputSchema: SCHEMA
    });
    assert.deepEqual(out.report.executedInput, { keyword: 'travel', count: 5 });
  });
});
