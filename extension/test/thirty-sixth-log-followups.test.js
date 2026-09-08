// Thirty-sixth console.log survey (2026-09-08, glm-5.1 via the Anthropic
// lane; FB search logged-out). Session health: anthropic protocol live
// (35th-log build verified in-log), truncation auto-recovery, honest
// maxTurns disclosure. Three dominant defects:
//
//   B1 budget-killer: io.confirm CONFIRMED the amendment (postingTime/
//      location → optional) but did not apply it to the artifact — verify
//      prefers the artifact-attached schema, judged the STALE required
//      contract, and told the model "the confirmed contract lists it as
//      REQUIRED" about fields the user had just waived. Fix: confirmation
//      attaches the confirmed schemas to the existing artifact immediately
//      (tested in session-tools.test.js).
//   B2 harvest gate: observedPopover rode ONLY failures while htmlSnippet
//      rode ONLY successes — the model's natural gate
//      `h.observedPopover && h.htmlSnippet` was structurally impossible and
//      hoverCards shipped [] with the hover layer working end to end
//      (tested in sixth-log-followups.test.js).
//   RC-C (user directive): anchors were typed a[href^='http'] — one broad
//      selector capped at 12, header links first in document order. The
//      TIME element was never hovered. Any element can carry a hover/click
//      handler; anchors must be chosen by requirement semantics.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WIZARD_UTILS_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wizard-utils.js'), 'utf8');
const SESSION_TOOLS_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session-tools.js'), 'utf8');
const { detectJunkValues } = require('../lib/verify-runner');

describe('RC-C: anchor-by-semantics teaching (user directive)', () => {
  it('HOVER ENRICHMENT carries the ANCHOR BY REQUIREMENT SEMANTICS rule', () => {
    const idx = WIZARD_UTILS_SRC.indexOf('HOVER ENRICHMENT (hovercard');
    assert.ok(idx > -1, 'HOVER ENRICHMENT chunk present');
    const chunk = WIZARD_UTILS_SRC.slice(idx, idx + 16000);
    const ruleIdx = chunk.indexOf('ANCHOR BY REQUIREMENT SEMANTICS');
    assert.ok(ruleIdx > -1, 'the rule exists by name inside HOVER ENRICHMENT');
    const rule = chunk.slice(ruleIdx, ruleIdx + 1600);
    assert.ok(/not just/i.test(rule), 'names that anchors are not just links');
    assert.ok(/timestamp/i.test(rule), 'uses the timestamp-tooltip example (the field that never triggered)');
    assert.ok(/a\[href/i.test(rule), 'names the a[href]-typed anchor anti-pattern');
  });

  it('session methodology rule 6 teaches anchor-by-semantics for probe.hover', () => {
    const m = SESSION_TOOLS_SRC.match(/'6\. To observe a hover popover[\s\S]*?',/);
    assert.ok(m, 'rule 6 present');
    assert.match(m[0], /semantics/i);
    assert.match(m[0], /any element/i);
    assert.match(m[0], /timestamp/i);
  });

  it('teaching carries no site tokens (universality)', () => {
    const idx = WIZARD_UTILS_SRC.indexOf('ANCHOR BY REQUIREMENT SEMANTICS');
    const chunk = WIZARD_UTILS_SRC.slice(idx, idx + 1600);
    assert.ok(idx > -1, 'rule present');
    assert.ok(!/facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i.test(chunk), 'no site tokens');
  });
});

describe('RC-D: count-typed fields holding the control label (detectJunkValues controlLabel kind)', () => {
  // Thirty-sixth log: likeCount shipped as "Like" — the aria-label of the
  // Like button with no count digit. Structurally non-empty, so no empty/
  // partial detector fired and the value passed as data.

  it('flags likeCount:"Like" with kind controlLabel + teaching note', () => {
    const data = { posts: [
      { content: 'real text', likeCount: 'Like', commentCount: 'Comment' },
      { content: 'more text', likeCount: 'Like', commentCount: 'Comment' }
    ] };
    const r = detectJunkValues(data, { type: 'object' });
    assert.ok(r, 'detector fires');
    const f = r.fields.find((x) => x.kind === 'controlLabel' && x.field === 'posts.likeCount');
    assert.ok(f, 'controlLabel entry for likeCount: ' + JSON.stringify(r.fields));
    assert.equal(f.count, 2);
    assert.equal(f.sample, 'Like');
    assert.ok(r.fields.some((x) => x.kind === 'controlLabel' && x.field === 'posts.commentCount'),
      'commentCount flagged too');
    assert.ok(/control label|aria-label of the/i.test(r.note),
      'note explains the control-label mechanism');
  });

  it('flags CJK control labels', () => {
    const data = { posts: [{ content: 'x', likeCount: '赞' }] };
    const r = detectJunkValues(data, { type: 'object' });
    assert.ok(r && r.fields.some((x) => x.kind === 'controlLabel'), 'CJK label flagged');
  });

  it('teaching: session methodology names page.settle and the ready≠hydrated trap', () => {
    assert.match(SESSION_TOOLS_SRC, /page\.settle/, 'page.settle taught in the prompt');
    assert.match(SESSION_TOOLS_SRC, /ready/i);
    assert.match(SESSION_TOOLS_SRC, /hydrat|shell/i);
  });

  it('does not flag digit-bearing counts, numeric types, or non-count fields holding alpha', () => {
    const data = { posts: [
      { likeCount: '1.2K', shares: '3 shares', replyCount: 7, authorName: 'Like Mi' },
      { likeCount: '12', shares: '0', replyCount: 0, authorName: 'Li Ke' }
    ] };
    const r = detectJunkValues(data, { type: 'object' });
    const labels = r ? r.fields.filter((x) => x.kind === 'controlLabel') : [];
    assert.deepEqual(labels, [], 'no controlLabel false positives');
  });
});
