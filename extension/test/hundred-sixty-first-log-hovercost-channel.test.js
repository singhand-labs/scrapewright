// extension/test/hundred-sixty-first-log-hovercost-channel.test.js
//
// 161st round, from the first field run of the round-160 features
// (docs/sessionlog.log 2026-09-26 22:28 + result.json):
//   - A/B/E verified live (129 prompt_digest lines, 130 usage lines, 6
//     ROUTE notes, final verify on the CONFIRMED input 美女/10 — the
//     exported result.json is the contract run, 10 posts).
//   - D was INVISIBLE: 0 hoverCost occurrences in a 19.8MB journal while
//     the model self-discovered "$extractWithHover internally caps
//     containers per call; single call returned 6 of 8" by COUNTING
//     records — burning a red verify (v15, COUNT_SHORTFALL_ASSEMBLY
//     4/10 vs 19 containers) that a one-line receipt would have
//     prevented. Root cause: _diagnostics ride DOM_RESPONSE →
//     execResult.selectorDiagnostics → STEP_ITERATION events, but
//     compactSteps builds the model-facing receipt steps WITHOUT them.
//   - result.json post #9 shipped postId "card-9-日本美女小姐姐為了男服務
//     員付出所有，不…" — a FABRICATED fallback id (synthetic prefix +
//     the record index + a content slice) on a green run with zero
//     disclosure. Fabricated ids poison dedup and downstream joins; the
//     honest shape for a card without a permalink is an EMPTY id +
//     disclosure (fail-soft doctrine).
//
// Fixes under test:
//   F1. compactSteps entries gain a compact `diag` digest (last
//       iteration selectorDiagnostics: containerMatches + hoverCost) so
//       measured batch cost reaches the model's eyes in every verify
//       receipt.
//   F2. detectInventedIdFallbacks — id-named fields whose value carries
//       PROSE (CJK runs or space-separated word runs), not a token/url
//       shape. REQUIRED → INVENTED_ID_FALLBACK veto; optional → report.
const { test, describe, it } = require('node:test');
const assert = require('assert');

const WU = require('../lib/wizard-utils');

const SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object',
  required: ['postId', 'content'],
  properties: { postId: { type: 'string' }, content: { type: 'string' }, authorId: { type: 'string' } } } } } };

describe('161 F1 — verify receipt steps carry the diagnostics digest', () => {
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

  it('a step whose iteration carried selectorDiagnostics exposes containerMatches + hoverCost on the receipt', async () => {
    const orch = async (svc, input, d, opts) => {
      await d.createTab(svc.targetUrl);
      opts.onEvent({ type: 'EXECUTION_START' });
      opts.onEvent({
        type: 'STEP_ITERATION', stepId: 'extract', iteration: 1,
        resultPreview: '{"done":true}',
        selectorDiagnostics: [{
          api: 'extractWithHover',
          containerSelector: 'div[x]',
          containerMatches: 19,
          processedContainers: 4,
          anchorsFound: 4,
          hoverSummary: { anchorsFound: 4, hovercardsCaptured: 4, hoverFailures: 0 },
          hoverCost: { batchWallMs: 21000, perContainerMs: 5250, perAnchorMs: 3000, budgetRemainingMs: 9000, suggestedBatchContainers: 1,
            note: 'this batch cost ~5250ms/container; with ~9000ms of step budget left the next batch should process <= 1 container(s)' }
        }]
      });
      return { finalResult: { posts: [{ postId: 'a1', content: 'c1' }, { postId: 'a2', content: 'c2' }] }, steps: [{ stepId: 'extract', stepName: 'extract', result: { done: true } }], pages: [], pagesTruncated: false };
    };
    const out = await makeRunner(orch)({ service: { targetUrl: 'https://e.com', steps: [{ id: 'extract', name: 'extract', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }, input: { count: 2 }, outputSchema: SCHEMA });
    assert.equal(out.report.ok, true);
    const step = out.report.steps.find((s) => s.stepId === 'extract');
    assert.ok(step.diag, 'the diag digest rides the receipt step');
    assert.equal(step.diag.containerMatches, 19);
    assert.equal(step.diag.hoverCost.suggestedBatchContainers, 1, 'the model reads the suggested batch size in the receipt');
  });

  it('steps without diagnostics carry no diag key (zero shape noise)', async () => {
    const orch = async (svc, input, d, opts) => {
      await d.createTab(svc.targetUrl);
      opts.onEvent({ type: 'EXECUTION_START' });
      opts.onEvent({ type: 'STEP_ITERATION', stepId: 's1', iteration: 1, resultPreview: '{"done":true}' });
      return { finalResult: { posts: [{ postId: 'a1', content: 'c1' }] }, steps: [{ stepId: 's1', stepName: 'x', result: { done: true } }], pages: [], pagesTruncated: false };
    };
    const out = await makeRunner(orch)({ service: { targetUrl: 'https://e.com', steps: [{ id: 's1', name: 'x', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }, input: { count: 1 }, outputSchema: SCHEMA });
    assert.equal(out.report.ok, true);
    assert.ok(!('diag' in out.report.steps[0]));
  });
});

describe('161 F2 — invented id fallback detection', () => {
  it('prose-stuffed synthetic ids are flagged; real token/url ids are not', () => {
    const data = { posts: [
      { postId: '943842055397354', content: 'real numeric id' },
      { postId: 'card-9-日本美女小姐姐為了男服務生付出所有，不', content: 'fabricated fallback' },
      { postId: '/groups/366863238003058', content: 'url path id' },
      { postId: 'how-to-train-your-dragon', content: 'slug id stays clean (no spaces, no CJK)' },
      { postId: 'Post Title Words Here', content: 'space-separated prose words ARE prose' }
    ] };
    const out = WU.detectInventedIdFallbacks(data, SCHEMA);
    assert.ok(Array.isArray(out), 'detector runs');
    const flagged = out.map((e) => e.index);
    assert.ok(flagged.includes(2), 'the card-9 CJK-stuffed id is flagged');
    assert.ok(flagged.includes(5), 'space-separated prose id is flagged');
    assert.ok(!flagged.includes(1) && !flagged.includes(3) && !flagged.includes(4),
      'numeric, url-path, and hyphen-slug ids stay clean');
    const entry = out.find((e) => e.index === 2);
    assert.equal(entry.field, 'postId');
    assert.match(entry.evidence, /card-9-/);
  });

  it('the verify vetoes a REQUIRED prose-stuffed id; optional fields stay report-only', async () => {
    const { createVerifyRunner } = require('../lib/verify-runner');
    function makeRunner(orch) {
      return createVerifyRunner({
        ensureLock: async () => {}, releaseLock: async () => {},
        createTab: async () => ({ id: 1 }), removeTab: async () => {},
        waitForTabLoad: async () => {}, sendMessage: async () => ({ pong: true }),
        executeScript: async () => ({ result: 'ok', selectorDiagnostics: [] }),
        captureSnapshot: async () => ({ html: '<html></html>' }),
        evaluateCondition: async () => true, orchestrate: orch
      });
    }
    const orchReq = async (svc, input, d, opts) => {
      await d.createTab(svc.targetUrl);
      opts.onEvent({ type: 'EXECUTION_START' });
      return { finalResult: { posts: [
        { postId: '943842055397354', content: 'c1' },
        { postId: 'card-9-日本美女小姐姐為了男服務生付出所有，不', content: 'c9' }
      ] }, steps: [], pages: [], pagesTruncated: false };
    };
    const outReq = await makeRunner(orchReq)({ service: { targetUrl: 'https://e.com', steps: [{ id: 's1', name: 'x', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }, input: { count: 2 }, outputSchema: SCHEMA });
    assert.equal(outReq.report.ok, false, 'a REQUIRED fabricated id vetoes');
    assert.match(outReq.report.error.message, /INVENTED_ID_FALLBACK/);
    assert.match(outReq.report.error.message, /EMPTY id plus disclosure/);

    const SCHEMA_OPT = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object',
      required: ['content'], properties: { authorId: { type: 'string' }, content: { type: 'string' } } } } } };
    const orchOpt = async (svc, input, d, opts) => {
      await d.createTab(svc.targetUrl);
      opts.onEvent({ type: 'EXECUTION_START' });
      return { finalResult: { posts: [{ content: 'c1', authorId: 'card-2-某位作者的長篇內容介紹文字' }] }, steps: [], pages: [], pagesTruncated: false };
    };
    const outOpt = await makeRunner(orchOpt)({ service: { targetUrl: 'https://e.com', steps: [{ id: 's1', name: 'x', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }, input: { count: 1 }, outputSchema: SCHEMA_OPT });
    assert.equal(outOpt.report.ok, true, 'optional fabricated ids are advisory');
    assert.ok(outOpt.report.detectors.inventedIdFallbacks && outOpt.report.detectors.inventedIdFallbacks.length === 1);
  });
});
