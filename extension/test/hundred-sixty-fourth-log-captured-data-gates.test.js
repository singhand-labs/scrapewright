// extension/test/hundred-sixty-fourth-log-captured-data-gates.test.js
//
// 164th round — user rejection of the 163rd "healthy" verdict: "有的悬浮
// 卡是空的，有的时间是相对时间，还有问题". The output shipped:
//   - hovercards as SHELLS: every entry {link, type, role, kv:{label}} —
//     name/followers/members all missing while the primitive has attached
//     popoverText to EVERY hovercard entry since the 2026-09-11 spec 3.B
//     (机械-语义分离) and the run captured 10 popovers (unusedCaptures
//     10/0 — an advisory ignored in EVERY session since the 154th);
//   - postTime 4/10 relative/partial while the session captures held a
//     FULL absolute (timeAbsoluteCapturedUnbound advisory — the 130th
//     deliberately kept it report-only);
//   - duplicated hovercards (same entity twice, near-dupes reported but
//     not vetoed).
//
// The advisory tier demonstrably does not change model behavior. Three
// escalations, all keyed on the SAME root evidence — the run captured
// popover data and the assembly never wired the read channel
// (unusedCaptures.popoverReadFields === 0):
//   [165th-round consolidation] G1/G2 below now exercise the ONE
//   universal gate CAPTURED_VALUE_UNBOUND (the invariant: the assembly
//   must not drop a captured value satisfying the field semantic). The
//   164th special-case vetoes were removed; these fixtures keep their
//   incident shapes (event-diagnostic captures, channel-bound legal
//   lanes) and assert the universal gate covers them.
//   G3. Nested NEAR-duplicate hovercards (same identity, enrichment
//       divergent) now veto too — the same entity twice is wrong data at
//       any enrichment level; the message keeps the merge teaching.
const { test, describe, it } = require('node:test');
const assert = require('assert');

const WU = require('../lib/wizard-utils');

const SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object',
  required: ['postId', 'postTime', 'content'],
  properties: {
    postId: { type: 'string' }, postTime: { type: 'string' }, content: { type: 'string' },
    hovercards: { type: 'array', items: { type: 'object', properties: {
      link: { type: 'string' }, type: { type: 'string' }, role: { type: 'string' }, kv: { type: 'object' } } } }
  } } } } };

const SHELL_HC = (link) => ({ link: link, type: 'account', role: 'author', kv: { label: '美女' } });
const ENRICHED_HC = (link) => ({ link: link, type: 'account', role: 'author',
  kv: { label: '美女', bio: 'Verified account · Public figure 9.3K Followers Lives in Taipei, Taiwan · Join many others' } });

function makeRunner(orch) {
  const { createVerifyRunner } = require('../lib/verify-runner');
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

function orchWith(finalData, evs) {
  return async (svc, input, d, opts) => {
    await d.createTab(svc.targetUrl);
    opts.onEvent({ type: 'EXECUTION_START' });
    for (const e of evs || []) opts.onEvent(e);
    return { finalResult: finalData, steps: [], pages: [], pagesTruncated: false };
  };
}

const CAPTURE_DIAGS = (extra) => {
  const popoverReadFields = (extra && extra.popoverReadFields) || 0;
  const base = {
    api: 'extractWithHover', containerSelector: 'div[x]', containerMatches: 11,
    anchorsFound: 3, hoverSummary: { anchorsFound: 3, hovercardsCaptured: 3, hoverFailures: 0 },
    capturedPopovers: {
      captured: 3, popoverReadFields: popoverReadFields,
      samples: ['美女 Page · Public figure 9.3K Followers Verified', 'September 12, 2026 at 3:18 PM']
    }
  };
  if (extra && extra.popoverReadFields !== undefined) delete extra.popoverReadFields;
  return Object.assign(base, extra || {});
};

describe('164 G1 — TIME_ABSOLUTE_CAPTURED_UNBOUND veto (channel-unwired calibration)', () => {
  const mixedPosts = () => ({ posts: [
    { postId: '943842055397354', postTime: 'September 12, 2026 at 3:18 PM', content: 'c1' },
    { postId: '1370476108534229', postTime: '2 days ago', content: 'c2' },
    { postId: '28233260189699763', postTime: 'April 17', content: 'c3' }
  ] });
  const EV = { popoverSamples: ['September 12, 2026 at 3:18 PM'], probeTimestampCalls: 1, lastFullAbsolute: 'September 12, 2026 at 3:18 PM' };

  it('required relative/partial + captured full absolute + channel never bound → RED', async () => {
    const out = await makeRunner(orchWith(mixedPosts(), [
      { type: 'STEP_ITERATION', stepId: 's1', iteration: 1, resultPreview: '{"done":true}', selectorDiagnostics: [CAPTURE_DIAGS()] }
    ]))({ service: { targetUrl: 'https://e.com', steps: [{ id: 's1', name: 'x', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }, input: { count: 3 }, outputSchema: SCHEMA, sessionEvidence: EV });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /CAPTURED_VALUE_UNBOUND/);
    assert.match(out.report.error.message, /postTime/);
  });

  it('channel BOUND (popoverReadFields>0) → per-record residuals legal, ok stays', async () => {
    const out = await makeRunner(orchWith(mixedPosts(), [
      { type: 'STEP_ITERATION', stepId: 's1', iteration: 1, resultPreview: '{"done":true}', selectorDiagnostics: [CAPTURE_DIAGS({ popoverReadFields: 1 })] }
    ]))({ service: { targetUrl: 'https://e.com', steps: [{ id: 's1', name: 'x', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }, input: { count: 3 }, outputSchema: SCHEMA, sessionEvidence: EV });
    assert.equal(out.report.ok, true, 'the route was exercised AND bound — per-record gaps are honest');
  });
});

describe('164 G2 — HOVERCARDS_SHELL veto', () => {
  it('shell hovercards (label-only) with captures present and channel unbound → RED', async () => {
    const data = { posts: [
      { postId: '943842055397354', postTime: 'September 12, 2026 at 3:18 PM', content: 'c1', likes: '12', hovercards: [SHELL_HC('https://www.facebook.com/profile.php?id=100063493312571')] },
      { postId: '1370476108534229', postTime: 'September 11, 2026 at 9:00 AM', content: 'c2', likes: '7', hovercards: [SHELL_HC('/groups/2957266634525773/')] }
    ] };
    const out = await makeRunner(orchWith(data, [
      { type: 'STEP_ITERATION', stepId: 's1', iteration: 1, resultPreview: '{"done":true}', selectorDiagnostics: [CAPTURE_DIAGS()] }
    ]))({ service: { targetUrl: 'https://e.com', steps: [{ id: 's1', name: 'x', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }, input: { count: 2 }, outputSchema: SCHEMA });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /CAPTURED_VALUE_UNBOUND|SHELL_ENTRIES/);
    assert.match(out.report.error.message, /hovercards/);
  });

  it('enriched hovercards (bio-bearing kv) pass', async () => {
    const data = { posts: [
      { postId: '943842055397354', postTime: 'September 12, 2026 at 3:18 PM', content: 'c1', likes: '12', hovercards: [ENRICHED_HC('https://www.facebook.com/profile.php?id=100063493312571')] }
    ] };
    const out = await makeRunner(orchWith(data, [
      { type: 'STEP_ITERATION', stepId: 's1', iteration: 1, resultPreview: '{"done":true}', selectorDiagnostics: [CAPTURE_DIAGS({ popoverReadFields: 1 })] }
    ]))({ service: { targetUrl: 'https://e.com', steps: [{ id: 's1', name: 'x', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }, input: { count: 1 }, outputSchema: SCHEMA });
    assert.equal(out.report.ok, true);
  });
});

describe('164 G3 — nested NEAR-duplicates veto', () => {
  it('same-entity hovercards with divergent enrichment are RED (merge, not ship-both)', async () => {
    const data = { posts: [
      { postId: 'a1', postTime: 'September 12, 2026 at 3:18 PM', content: 'c1', hovercards: [
        { link: '/groups/366863238003058/?__cft__[0]=TOKEN_A', htmlSnippet: '', type: 'group', role: 'group', kv: { groupId: '366863238003058' } },
        { link: '/groups/366863238003058/?__cft__[0]=TOKEN_C', htmlSnippet: '', type: 'group', role: 'group', kv: { groupId: '366863238003058', members: '343.3K members' } }
      ] }
    ] };
    const out = await makeRunner(orchWith(data, []))({ service: { targetUrl: 'https://e.com', steps: [{ id: 's1', name: 'x', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }, input: { count: 1 }, outputSchema: SCHEMA });
    assert.equal(out.report.ok, false, 'the same entity twice is wrong data at any enrichment level');
    assert.match(out.report.error.message, /DUPLICATE_NESTED_ENTRIES/);
    assert.match(out.report.error.message, /MERGE|keep the enriched/i);
  });
});

describe('164 — detectShellHovercards unit', () => {
  it('URLs and short labels are contentless; a 60+ char prose value is content', () => {
    const data = { posts: [
      { hovercards: [SHELL_HC('https://www.facebook.com/profile.php?id=100063493312571&__cft__[0]=AZx')] },
      { hovercards: [ENRICHED_HC('/groups/1/')] }
    ] };
    const out = WU.detectShellHovercards(data, SCHEMA);
    assert.equal(out.length, 1, 'only the shell record is flagged');
    assert.equal(out[0].parentIndex, 1);
    assert.equal(out[0].contentless, 1);
    assert.equal(out[0].total, 1);
  });
});
