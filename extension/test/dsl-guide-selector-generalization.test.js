// Regression for bugx.log 2026-07-24 — three LLM-generation gaps that the
// DSL guide did not previously call out:
//   1. publishTime annotation a[role="link"][aria-label="3天"] only matches
//      one post (the one whose aria-label is literally "3天"). Other posts
//      have aria-label="4月27日" etc. and never match.
//   2. posts.images had no annotation; the LLM guessed with single $extract
//      instead of $list, so only one image URL per post came back.
//   3. The DSL guide did not warn against these patterns.
// These tests verify the new SELECTOR GENERALIZATION and MULTI-VALUE FIELDS
// sections are present in SCRIPT_DSL_GUIDE so the LLM sees them.
//
// RC24 B (2026-08-03): the example text in the rule was de-specialized away
// from the original FB-specific Chinese-date tokens. The audit now anchors on
// the rule structure ("literal aria-label value only matches one item"),
// not on the specific example value, so future re-de-specialization doesn't
// silently break the guard.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SCRIPT_DSL_GUIDE } = require('../lib/wizard-utils');

describe('SCRIPT_DSL_GUIDE — selector generalization + multi-value fields', () => {
  it('has a SELECTOR GENERALIZATION section', () => {
    assert.match(SCRIPT_DSL_GUIDE, /SELECTOR GENERALIZATION/);
  });

  it('warns that aria-label="literal" only matches one element', () => {
    // RC24 B: de-specialized the example from `aria-label="3天"` (Chinese date)
    // to `aria-label="John Doe"` (person name). The audit should anchor on the
    // rule ("a literal aria-label value only matches one item") not on the
    // specific example text — otherwise re-de-specialization breaks the guard.
    assert.match(SCRIPT_DSL_GUIDE, /aria-label="[^"]+"/);  // some literal value
    assert.match(SCRIPT_DSL_GUIDE, /matches only the .* whose aria-label is literally/i);
  });

  it('shows the generalized form (attribute presence, no value)', () => {
    assert.match(SCRIPT_DSL_GUIDE, /\[aria-label\]/);  // bare attribute, no =value
    assert.match(SCRIPT_DSL_GUIDE, /attribute presence/i);
  });

  it('lists multiple generalization traps (aria-label, text-equality, nth-child)', () => {
    assert.match(SCRIPT_DSL_GUIDE, /text-equality/i);
    assert.match(SCRIPT_DSL_GUIDE, /nth-child/i);
  });

  it('has a MULTI-VALUE FIELDS section', () => {
    assert.match(SCRIPT_DSL_GUIDE, /MULTI-VALUE FIELDS/);
  });

  it('explicitly forbids $extract for multi-value fields', () => {
    // The buggy pattern: $extract('img', 'src') returns ONE src, not all
    assert.match(SCRIPT_DSL_GUIDE, /\$extract\(['"]img['"],\s*['"]src['"]\)/);
    assert.match(SCRIPT_DSL_GUIDE, /returns ONE/i);
  });

  it('recommends $list for multi-value fields', () => {
    assert.match(SCRIPT_DSL_GUIDE, /\$list\(['"]img['"]\)/);
  });

  it('ties multi-value guidance to schema array fields', () => {
    // The contract: when outputSchema declares an array field, use the
    // multi-value pattern. This is the user-facing signal.
    assert.match(SCRIPT_DSL_GUIDE, /array field/i);
    assert.match(SCRIPT_DSL_GUIDE, /images\[\]/);
  });
});
