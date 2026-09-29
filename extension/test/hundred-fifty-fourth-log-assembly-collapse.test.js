// extension/test/hundred-fifty-fourth-log-assembly-collapse.test.js
//
// 154th log: the session ended GREEN on maxTurns with a hollow result —
// result.json carries 4 posts against a user-confirmed count of 10, and the
// green verify itself diagnosed why: countShortfall {requested:10,
// extracted:4, ratio:0.4, severe:true, exhaustionCertified:false} with the
// provenance note "containers matched 14 (>= requested 10) but only 4
// record(s) survived — the loss is in the ASSEMBLY". $collectUntil had
// SATISFIED its target (14 unique items collected of 14 asked by the step);
// the collapse happened in the extract->assemble steps (a merge keyed on a
// weak/positional value). No gate owned that shape: PREMATURE_EXHAUSTION
// covers scroll steps that exit done after <=3 iterations, and the 145th
// certification doctrine only guards the EXHAUSTION claim — a satisfied
// collection feeding a collapsing assembly sailed through green.
//
// The same result ships posts[].hovercards with the SAME entity twice per
// post (group x2 — one bare, one members-enriched; author x2 identical
// modulo __cft__ tracking tokens) on the GREEN run: duplicateIdValues and
// duplicateEntityPairs walk TOP-LEVEL arrays only, and the hovercard id
// values live in link paths and kv.* — not id-named fields.
//
// Fixes under test:
//   F1. COUNT_SHORTFALL_ASSEMBLY veto — severe + uncetified + the run own
//       container census >= requested => RED with the exits (fix the merge
//       by a strong per-record key / prove the surplus containers are
//       non-records and renegotiate the count via io.confirm / certify
//       exhaustion with $collectUntil).
//   F2. detectDuplicateNestedEntries — within-parent-record identity
//       grouping of nested array-of-object entries (type/role + id-bearing
//       strings + object-leaf ids, tracking tokens stripped). FULLY
//       identical duplicates veto (DUPLICATE_NESTED_ENTRIES); identity-equal
//       but enrichment-divergent ones report as merge candidates.
//   F3. The ad-marker POLARITY note gains the design-system caveat —
//       data-ad-* attribute NAMES can be rendering roles used by ORGANIC
//       posts too (the incident: every shipped organic post carries
//       data-ad-rendering-role="story_message" while the note told the
//       model to treat the marker as an ad signal).
//
// No site tokens.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const WU = require('../lib/wizard-utils');
const VR_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'verify-runner.js'), 'utf8');

const SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object',
  required: ['postId', 'content', 'likeCount'],
  properties: {
    postId: { type: 'string' }, content: { type: 'string' }, likeCount: { type: 'string' },
    hovercards: { type: 'array', items: { type: 'object', properties: {
      link: { type: 'string' }, htmlSnippet: { type: 'string' },
      type: { type: 'string' }, role: { type: 'string' }, kv: { type: 'object' } } } }
  } } } } };

const mk = (i, pid) => ({ postId: pid, content: 'content of post ' + i, likeCount: String(i),
  hovercards: [
    { link: '/groups/366863238003058/?__cft__[0]=TOKEN_A', htmlSnippet: '', type: 'group', role: 'group', kv: { groupId: '366863238003058', bio: 'Public group for sharing beautiful photography with 343.3K members worldwide' } },
    { link: '/groups/366863238003058/user/61593749967739/?__cft__[0]=TOKEN_B', htmlSnippet: '', type: 'account', role: 'author', kv: { userId: '61593749967739', bio: 'Verified account · Photographer with many beautiful travel photos and stories' } },
    { link: '/groups/366863238003058/?__cft__[0]=TOKEN_C', htmlSnippet: '', type: 'group', role: 'group', kv: { groupId: '366863238003058', members: '343.3K members', bio: 'Public group for sharing beautiful photography worldwide and connecting' } },
    { link: '/groups/366863238003058/user/61593749967739/?__cft__[0]=TOKEN_D', htmlSnippet: '', type: 'account', role: 'author', kv: { userId: '61593749967739', bio: 'Verified account · Photographer with many beautiful travel photos and stories' } }
  ] });

const fourPosts = () => [mk(1, '122111955693458332'), mk(2, '1447646503897604'), mk(3, '1092322230156268'), mk(4, '29090421683897250')];

// F1 cases exercise the countShortfall veto alone — strip the duplicated
// hovercards so DUPLICATE_NESTED_ENTRIES cannot mask the lane under test.
const fourPostsClean = () => fourPosts().map((p) => ({ ...p, hovercards: [p.hovercards[0]] }));

describe('154th log F1 — COUNT_SHORTFALL_ASSEMBLY veto', () => {
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

  function orchWith(finalData, evs) {
    return async (svc, input, d, opts) => {
      await d.createTab(svc.targetUrl);
      opts.onEvent({ type: 'EXECUTION_START' });
      for (const e of evs || []) opts.onEvent(e);
      return { finalResult: finalData, steps: [], pages: [], pagesTruncated: false };
    };
  }

  it('severe uncetified shortfall with containers >= requested goes RED', async () => {
    const out = await makeRunner(orchWith({ posts: fourPostsClean() }, [
      { type: 'STEP_ITERATION', stepId: 's1', iteration: 1, resultPreview: '{"cards":14}',
        selectorDiagnostics: [{ containerMatches: 14 }] }
    ]))({ service: { targetUrl: 'https://e.com', steps: [{ id: 's1', name: 'x', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }, input: { count: 10 }, outputSchema: SCHEMA });
    assert.equal(out.report.ok, false, '4 of 10 with 14 containers matched is not green');
    assert.match(out.report.error.message, /COUNT_SHORTFALL_(SUPPLY|ASSEMBLY)/);
    assert.match(out.report.error.message, /SUPPLY|ASSEMBLY/i);
    assert.match(out.report.error.message, /Narrow the container selector|distinct/i);
    assert.ok(/io\.confirm|renegotiate/.test(out.report.error.message) || /SUPPLY/.test(out.report.error.message), 'exits present');
    assert.match(out.report.error.message, /\$collectUntil/);
  });

  it('a CERTIFIED exhaustion receipt exempts the same numbers', async () => {
    const out = await makeRunner(orchWith({ posts: fourPostsClean() }, [
      { type: 'STEP_ITERATION', stepId: 's1', iteration: 1, resultPreview: '{"satisfied":false,"certifiedExhaustion":true}',
        selectorDiagnostics: [{ containerMatches: 14 }] }
    ]))({ service: { targetUrl: 'https://e.com', steps: [{ id: 's1', name: 'x', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }, input: { count: 10 }, outputSchema: SCHEMA });
    assert.equal(out.report.ok, true, 'certified supply ships disclosed');
    assert.equal(out.report.detectors.countShortfall.exhaustionCertified, true);
  });

  it('162nd round: a mild shortfall WITH the census proving supply is RED (the 0.6 gap closed)', async () => {
    // The 162nd incident shipped 6 of a user-confirmed 10 as GREEN at
    // ratio 0.6 — above the old severe bar (0.5) while the run itself
    // matched 21 containers. When the census proves the population, ANY
    // uncertified shortfall is an assembly loss; the severe flag no
    // longer gates this branch. Exits unchanged: certify / narrow the
    // selector to the record population / renegotiate the count.
    const extras = [5, 6, 7, 8, 9].map((i) => ({ ...mk(i, String(i)), hovercards: [mk(i, String(i)).hovercards[0]] }));
    const posts = fourPostsClean().concat(extras);
    const out = await makeRunner(orchWith({ posts }, [
      { type: 'STEP_ITERATION', stepId: 's1', iteration: 1, resultPreview: '{"cards":14}',
        selectorDiagnostics: [{ containerMatches: 14 }] }
    ]))({ service: { targetUrl: 'https://e.com', steps: [{ id: 's1', name: 'x', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }, input: { count: 10 }, outputSchema: SCHEMA });
    assert.equal(out.report.ok, false, '9/10 with 14 containers matched is a shortfall at any ratio');
    assert.match(out.report.error.message, /COUNT_SHORTFALL_(SUPPLY|ASSEMBLY)/);
  });

  it('containers BELOW the requested count keeps the population-divergence lane (no assembly veto)', async () => {
    const out = await makeRunner(orchWith({ posts: fourPostsClean() }, [
      { type: 'STEP_ITERATION', stepId: 's1', iteration: 1, resultPreview: '{"cards":4}',
        selectorDiagnostics: [{ containerMatches: 4 }] }
    ]))({ service: { targetUrl: 'https://e.com', steps: [{ id: 's1', name: 'x', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }, input: { count: 10 }, outputSchema: SCHEMA });
    assert.equal(out.report.ok, true);
    assert.match(out.report.detectors.countShortfall.note, /population divergence|genuine scarcity/i);
  });
});

describe('154th log F2 — nested duplicate entries', () => {
  it('groups within-parent entries by identity: identical-pair fullyIdentical, enriched pair near-dupe', () => {
    const d = { posts: fourPosts() };
    const out = WU.detectDuplicateNestedEntries(d, SCHEMA);
    assert.ok(Array.isArray(out) && out.length >= 2, 'two duplicate groups per post are detected');
    const acct = out.find((e) => /account|user/.test(JSON.stringify(e.identity || e.sample || '')));
    const grp = out.find((e) => !acct || e !== acct);
    const anyFull = out.some((e) => e.fullyIdentical === true);
    const anyNear = out.some((e) => e.fullyIdentical === false);
    assert.ok(anyFull, 'the author pair (identical modulo __cft__ tokens) is fullyIdentical');
    assert.ok(anyNear, 'the group pair (one bare, one members-enriched) is a near-dupe merge candidate');
    const first = out[0];
    assert.equal(first.path, 'posts.hovercards', 'path names the nested array');
    assert.equal(first.parentIndex, 1, 'the parent record ordinal rides along');
    assert.deepEqual(first.indices, [1, 3], 'the group pair sits at hovercard ordinals 1 and 3');
  });

  it('string arrays and identity-less entries are never flagged', () => {
    const d = { posts: [
      { postId: 'a', content: 'x', likeCount: '1', mediaUrls: ['u1', 'u1', 'u1'] },
      { postId: 'b', content: 'y', likeCount: '2', tags: [{ type: 'tag' }, { type: 'tag' }] }
    ] };
    const out = WU.detectDuplicateNestedEntries(d, SCHEMA);
    assert.equal(out.length, 0, 'no id-bearing strings in entries -> no identity basis -> never flagged');
  });

  it('the runner vetoes fully-identical nested duplicates; near-dupes alone stay report-only', async () => {
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
    const orch = async (svc, input, d, opts) => {
      await d.createTab(svc.targetUrl);
      opts.onEvent({ type: 'EXECUTION_START' });
      return { finalResult: { posts: fourPosts() }, steps: [], pages: [], pagesTruncated: false };
    };
    const svc = { targetUrl: 'https://e.com', steps: [{ id: 's1', name: 'x', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} };
    const out = await makeRunner(orch)({ service: svc, input: { count: 4 }, outputSchema: SCHEMA });
    assert.equal(out.report.ok, false, 'the identical author-hovercard pair vetoes');
    assert.match(out.report.error.message, /DUPLICATE_NESTED_ENTRIES/);
    assert.match(out.report.error.message, /posts\.hovercards/);

    // near-dupes only: drop the identical account pair, keep group + enriched group
    const nearOnly = fourPosts().map((p) => ({ ...p, hovercards: p.hovercards.slice(0, 1).concat(p.hovercards.slice(2, 3)) }));
    const orch2 = async (svc2, input, d, opts) => {
      await d.createTab(svc2.targetUrl);
      opts.onEvent({ type: 'EXECUTION_START' });
      return { finalResult: { posts: nearOnly }, steps: [], pages: [], pagesTruncated: false };
    };
    const out2 = await makeRunner(orch2)({ service: svc, input: { count: 4 }, outputSchema: SCHEMA });
    // 164th round: near-dupes (same identity, enrichment divergent) veto
    // too — the same entity twice is wrong data at any enrichment level
    // (the user rejected the shipped near-dupes); the message keeps the
    // MERGE teaching.
    assert.equal(out2.report.ok, false, 'near-dupes veto since the 164th round');
    assert.match(out2.report.error.message, /MERGE|keep the enriched/i);
    assert.ok(out2.report.detectors.nestedDuplicates && out2.report.detectors.nestedDuplicates.length >= 1,
      'the advisory census entry is present');
  });
});

describe('154th log F3 — polarity note names the design-system trap', () => {
  it('the ad-marker note warns that ad-prefixed attribute names can be rendering roles on organic posts', () => {
    const i = VR_SRC.indexOf('step selector(s) reference ad/sponsored markers');
    const region = VR_SRC.slice(i, i + 2400);
    assert.match(region, /rendering role|design-system/i,
      'the caveat must tell the model that data-ad-* names can mark ORGANIC content too');
  });
});
