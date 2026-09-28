// extension/test/hundred-seventieth-log-five-improvements.test.js
//
// 170th round — five harness improvements from the deep analysis of the
// 169th session (80 turns, 4/10 posts, first verify at 89% budget):
//
//   F1. CONTAINER IDENTITY CENSUS — the assembly-loss message said "the
//       collection satisfied the ask" from raw container count (12), but
//       the true supply was ~4-6 (nested/remounted nodes + recommendation
//       cards without permalinks). The message now carries an identity
//       census (distinct postId values) and BRANCHES: containers >= ask
//       but distinct ids < ask = SUPPLY problem (scroll-certify or narrow
//       the selector), NOT a merge fix.
//   F2. EARLY-VERIFY advisory at 45% turns with no artifact — the 75%
//       author advisory fires too late when research is deep.
//   F3. PREFLIGHT teaching in the assembly-loss message — cold-tab
//       divergence is invisible until the fresh-tab verify fails.
//   F4. TIME_SHAPE_VIOLATION — "Smileys & People" and "0:02 / 0:10"
//       passed every existing gate; a REQUIRED absoluteTime field with a
//       predicate-failing value is a contract-shape violation independent
//       of pool state.
//   F5. Prior-service evidence seed — same-URL prior sessions' probe
//       measurements injected as a system note (container counts, hover
//       costs, selector differentials).
//
// No site tokens.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const WU = require('../lib/wizard-utils');
const VR = require('../lib/verify-runner');
const RS = fs.readFileSync(path.join(__dirname, '..', 'lib', 'research-session.js'), 'utf8');

const SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object',
  required: ['postId', 'postTime', 'content'],
  properties: {
    postId: { type: 'string' }, postTime: { type: 'string' }, content: { type: 'string' }
  } } } } };

function mkRunner(orch) {
  return VR.createVerifyRunner({
    ensureLock: async () => {}, releaseLock: async () => {},
    createTab: async () => ({ id: 1 }), removeTab: async () => {},
    waitForTabLoad: async () => {}, sendMessage: async () => ({ pong: true }),
    executeScript: async () => ({ result: 'ok', selectorDiagnostics: [] }),
    captureSnapshot: async () => ({ html: '<html></html>' }),
    evaluateCondition: async () => true, orchestrate: orch
  });
}

describe('170 F1 — container identity census branches supply vs assembly', () => {
  it('12 containers but 4 distinct ids → SUPPLY diagnosis, not merge', async () => {
    const posts = [
      { postId: 'fbid1370476108534229', postTime: 'September 28, 2026 at 5:16 PM', content: 'c1' },
      { postId: 'fbid1370476108534229', postTime: 'September 27, 2026 at 3:00 PM', content: 'c2' },
      { postId: 'fbid28301629282862853', postTime: 'September 26, 2026 at 1:00 PM', content: 'c3' },
      { postId: '', postTime: 'September 25, 2026 at 11:00 AM', content: 'c4' }
    ];
    const orch = async (svc, input, d, opts) => {
      await d.createTab(svc.targetUrl);
      opts.onEvent({ type: 'EXECUTION_START' });
      opts.onEvent({ type: 'STEP_ITERATION', stepId: 's1', iteration: 1, resultPreview: '{"done":true}',
        selectorDiagnostics: [{ containerMatches: 12 }] });
      return { finalResult: { posts }, steps: [], pages: [], pagesTruncated: false };
    };
    const out = await mkRunner(orch)({ service: { targetUrl: 'https://e.com', steps: [{ id: 's1', name: 'x', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }, input: { count: 10 }, outputSchema: SCHEMA });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /COUNT_SHORTFALL_SUPPLY/, 'the supply branch fires when distinct ids < requested');
    assert.match(out.report.error.message, /SUPPLY/i, 'the diagnosis names the supply problem');
    assert.match(out.report.error.message, /distinct|identity/i, 'the identity census is present');
  });
  it('no identifier field → classic assembly-loss (merge fix)', async () => {
    // Without an identifier-semantic field the census cannot run, so the
    // default ASSEMBLY branch fires (enough containers, fewer records).
    const SCHEMA_NOID = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object',
      required: ['postTime', 'content'], properties: { postTime: { type: 'string' }, content: { type: 'string' } } } } } };
    const posts = Array.from({ length: 9 }, (_, i) => ({ postTime: 'September 2' + i + ', 2026 at 1:00 PM', content: 'c' + i }));
    const orch = async (svc, input, d, opts) => {
      await d.createTab(svc.targetUrl);
      opts.onEvent({ type: 'EXECUTION_START' });
      opts.onEvent({ type: 'STEP_ITERATION', stepId: 's1', iteration: 1, resultPreview: '{"done":true}',
        selectorDiagnostics: [{ containerMatches: 14 }] });
      return { finalResult: { posts }, steps: [], pages: [], pagesTruncated: false };
    };
    const out = await mkRunner(orch)({ service: { targetUrl: 'https://e.com', steps: [{ id: 's1', name: 'x', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }, input: { count: 10 }, outputSchema: SCHEMA_NOID });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /COUNT_SHORTFALL_ASSEMBLY/);
    assert.match(out.report.error.message, /ASSEMBLY/i, 'the assembly branch fires when no identifier field is detected');
  });
});

describe('170 F2 — early-verify advisory at 45% with no artifact', () => {
  it('exists in research-session source at the 0.45 threshold', () => {
    const i = RS.indexOf("state.budgetAdvisories.indexOf('first-verify-early')");
    assert.ok(i > -1, 'the advisory exists');
    const block = RS.slice(i - 500, i + 800);
    assert.match(block, /0\.45/, 'threshold is 45%');
    assert.match(block, /hasArtifact170|artifactVersions\.length === 0/, 'fires only with no artifact');
  });
});

describe('170 F4 — TIME_SHAPE_VIOLATION (predicate-failing required time field)', () => {
  it('postTime "Smileys & People" on a REQUIRED field → RED', async () => {
    const posts = [
      { postId: '943842055397354', postTime: 'Smileys &amp; People', content: 'c1' },
      { postId: '1370476108534229', postTime: '0:02 / 0:10', content: 'c2' }
    ];
    const orch = async (svc, input, d, opts) => {
      await d.createTab(svc.targetUrl);
      opts.onEvent({ type: 'EXECUTION_START' });
      return { finalResult: { posts }, steps: [], pages: [], pagesTruncated: false };
    };
    const out = await mkRunner(orch)({ service: { targetUrl: 'https://e.com', steps: [{ id: 's1', name: 'x', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }, input: { count: 2 }, outputSchema: SCHEMA });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /TIME_SHAPE_VIOLATION/);
    assert.match(out.report.error.message, /Smileys|anchor/i);
  });
  it('full-absolute postTime passes', async () => {
    const posts = [
      { postId: '943842055397354', postTime: 'September 28, 2026 at 5:16 PM', content: 'c1' },
      { postId: '1370476108534229', postTime: 'August 16, 2026 at 11:16 PM', content: 'c2' }
    ];
    const orch = async (svc, input, d, opts) => {
      await d.createTab(svc.targetUrl);
      opts.onEvent({ type: 'EXECUTION_START' });
      return { finalResult: { posts }, steps: [], pages: [], pagesTruncated: false };
    };
    const out = await mkRunner(orch)({ service: { targetUrl: 'https://e.com', steps: [{ id: 's1', name: 'x', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }, input: { count: 2 }, outputSchema: SCHEMA });
    assert.equal(out.report.ok, true);
  });
});

describe('170 F5 — prior-service evidence seed', () => {
  it('summarizePriorServiceEvidence extracts container counts from step scripts', () => {
    const svc = {
      targetUrl: 'https://example.com/search?q={{keyword}}',
      steps: [
        { id: 'scroll', script: "const c='div[role=feed] > div:has(h3)'; await $collectUntil(c,{targetCount:N,idAttr:'aria-posinset'}); return {done:true};" },
        { id: 'extract', script: "const r=await $extractWithHover(c,fm,{hover:{anchorSel:'h3 a[href]'}}); return {posts:r};" }
      ]
    };
    const out = WU.summarizePriorServiceEvidence(svc);
    assert.ok(out, 'a summary is produced');
    assert.match(out, /div\[role=feed\]/, 'the container selector rides the note');
    assert.match(out, /anchorSel|hover/i, 'the hover anchor rides the note');
  });
  it('no steps → null', () => {
    assert.equal(WU.summarizePriorServiceEvidence({ targetUrl: 'x', steps: [] }), null);
  });
});
