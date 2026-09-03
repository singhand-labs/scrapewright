// Regression for console.log 2026-09-03 10:28-10:48 (thirteenth session).
// Five consecutive RED verifies, all EMPTY_EXTRACTION, while the page was
// perfectly fine: verify ran input {keyword:"cat"} but every selector was
// grounded on the q=news research page. The q=cat result cards matched the
// container selector (19 h3 cards) but carried ZERO a[href*="/posts/"]
// permalinks — and the collect step's own dedup filter
// (.filter(p => p.postId && !seen.has(p.postId))) silently dropped all 19
// extracted records, returning {done:true, posts:[]}. The per-field
// matchCount census (postId 0/19, author 19/19) existed in
// selectorDiagnostics the whole time — but nothing surfaced it on the
// failure path and the LLM never called diag.read (rule 5 ignored five
// times), so it guess-hardened waits/selectors for three artifact versions
// and finally shipped a false-green 'completed' blaming "login/redirect
// variance". This detector moves the census INTO the failure signal.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectFieldMatchZero, detectContainerMatchZero } = require('../lib/wizard-utils');

function itEvt(stepId, iteration, diags) {
  return { type: 'STEP_ITERATION', stepId, iteration, selectorDiagnostics: diags };
}
function elDiag(over) {
  return Object.assign({
    api: 'extractList',
    containerSelector: 'div[role="feed"] > div:has(h3)',
    containerMatches: 19,
    perField: [
      { field: 'author', subSelector: 'h3', attr: null, matchCount: 19, sampleTexts: ['A'], sampleHrefs: [], sampleValues: ['A'] },
      { field: 'postId', subSelector: 'a[href*="/posts/"]', attr: 'href', matchCount: 0, sampleTexts: [], sampleHrefs: [], sampleValues: [] }
    ]
  }, over || {});
}

describe('detectFieldMatchZero — unit', () => {
  it('fires when a field matched 0 containers while containers themselves matched, on every call', () => {
    const events = [
      itEvt('collect', 1, [elDiag({ containerMatches: 7, perField: elDiag().perField.map((f) => Object.assign({}, f, { matchCount: f.field === 'author' ? 7 : 0 })) })]),
      itEvt('collect', 2, [elDiag()])
    ];
    const hits = detectFieldMatchZero(events);
    assert.ok(Array.isArray(hits) && hits.length === 1, 'one zero-match field');
    const hit = hits[0];
    assert.equal(hit.stepId, 'collect');
    assert.equal(hit.field, 'postId');
    assert.equal(hit.subSelector, 'a[href*="/posts/"]');
    assert.equal(hit.calls, 2);
    assert.equal(hit.containerMatches, 19, 'keeps the LARGEST container census across calls');
  });

  it('stays silent when the field matched on any later call (transient cold-load zero is healthy)', () => {
    const events = [
      itEvt('collect', 1, [elDiag({ containerMatches: 7 })]),
      itEvt('collect', 2, [elDiag({ perField: elDiag().perField.map((f) => Object.assign({}, f, { matchCount: f.field === 'author' ? 19 : 6 })) })])
    ];
    assert.equal(detectFieldMatchZero(events), null);
  });

  it('stays silent when containers matched 0 (container-blind is a different failure class)', () => {
    const events = [itEvt('collect', 1, [elDiag({ containerMatches: 0 })])];
    assert.equal(detectFieldMatchZero(events), null);
  });

  it('skips perField entries whose subSelector is null (self-read of the container)', () => {
    const events = [itEvt('collect', 1, [elDiag({
      perField: [{ field: 'author', subSelector: null, attr: null, matchCount: 0, sampleTexts: [], sampleHrefs: [], sampleValues: [] }]
    })])];
    assert.equal(detectFieldMatchZero(events), null);
  });

  it('covers extractWithHover diagnostics too (same perField shape)', () => {
    const events = [itEvt('popovers', 1, [elDiag({ api: 'extractWithHover' })])];
    const hits = detectFieldMatchZero(events);
    assert.ok(hits && hits.length === 1);
    assert.equal(hits[0].stepId, 'popovers');
    assert.equal(hits[0].api, 'extractWithHover');
  });

  it('aggregates multiple steps and multiple zero fields', () => {
    const events = [
      itEvt('collect', 1, [elDiag()]),
      itEvt('popovers', 1, [elDiag({
        api: 'extractWithHover',
        perField: [
          { field: 'authorHref', subSelector: 'h3 a[role="link"]', attr: 'href', matchCount: 0, sampleTexts: [], sampleHrefs: [], sampleValues: [] }
        ]
      })])
    ];
    const hits = detectFieldMatchZero(events);
    assert.equal(hits.length, 2);
    assert.deepEqual(hits.map((h) => h.stepId + ':' + h.field).sort(), ['collect:postId', 'popovers:authorHref']);
  });
});

// Fourteenth-log follow-up (user request): an input VALUE can leave the site
// with nothing to extract (an obscure keyword, an over-specific filter) — the
// page then shows ZERO result items, containers match 0. That is not a
// selector bug, yet the generic EMPTY_EXTRACTION message says "the field
// selectors are wrong", steering the model into selector hardening. This
// detector names the fingerprint so verify can teach re-testing with a
// different, more common input value first.
describe('detectContainerMatchZero — unit (inverse sibling of detectFieldMatchZero)', () => {
  it('fires when every list call for a step+container saw containerMatches 0', () => {
    const events = [
      itEvt('search', 1, [elDiag({ containerMatches: 0 })]),
      itEvt('search', 2, [elDiag({ containerMatches: 0, api: 'extractList' })])
    ];
    const hits = detectContainerMatchZero(events);
    assert.ok(Array.isArray(hits) && hits.length === 1);
    const hit = hits[0];
    assert.equal(hit.stepId, 'search');
    assert.equal(hit.api, 'extractList');
    assert.equal(hit.containerSelector, elDiag().containerSelector);
    assert.equal(hit.calls, 2);
  });

  it('stays silent when any call saw populated containers (transient cold-load zero is healthy)', () => {
    const events = [
      itEvt('search', 1, [elDiag({ containerMatches: 0 })]),
      itEvt('search', 2, [elDiag({ containerMatches: 5 })])
    ];
    assert.equal(detectContainerMatchZero(events), null);
  });

  it('a step with populated containers does not silence a DIFFERENT zero-container step', () => {
    const events = [
      itEvt('feed', 1, [elDiag({ containerMatches: 12 })]),
      itEvt('related', 1, [elDiag({ containerMatches: 0, containerSelector: 'div.related-list > div' })])
    ];
    const hits = detectContainerMatchZero(events);
    assert.ok(hits && hits.length === 1);
    assert.equal(hits[0].stepId, 'related');
  });

  it('tolerates empty perField (container census exists before field matching)', () => {
    const events = [itEvt('search', 1, [{ api: 'extractList', containerSelector: 'div.card', containerMatches: 0, perField: [] }])];
    const hits = detectContainerMatchZero(events);
    assert.ok(hits && hits.length === 1);
  });

  it('returns null for null/empty events', () => {
    assert.equal(detectContainerMatchZero(null), null);
    assert.equal(detectContainerMatchZero([]), null);
    assert.equal(detectContainerMatchZero([{ type: 'EXECUTION_START' }]), null);
  });
});
