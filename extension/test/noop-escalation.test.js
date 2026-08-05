// Regression test for the 2026-08-05 no-op escalation fix.
//
// console.log 2026-08-05 07:13–07:22 shows autoFix stuck in a no-op loop:
// user submitted "第二篇帖子的group和author还是没搞对" TWICE. Both times the
// LLM returned a byte-identical 3785-char response. isNoOpAutoFixPatch
// correctly detected and rejected the no-op. But the [NO-OP DETECTED] message
// was pushed to llmHistory only — the LLM ignored it (likely proxy caching
// or attention anchored on the current script, not on history).
//
// Fix: inject the no-op warning into the CURRENT prompt (not just history),
// with a unique iteration counter that busts any upstream cache and tells
// the LLM explicitly to produce a DIFFERENT script.
//
// These tests cover the pure helper buildNoOpEscalationSection. The
// integration with wizardState.consecutiveNoOpCount is covered by source-text
// audits in test/wizard-noop-escalation-audit.test.js.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildNoOpEscalationSection,
  resetNoOpEscalation,
  registerNoOpForFeedback
} = require('../lib/wizard-utils');

describe('buildNoOpEscalationSection', () => {
  it('returns empty string when consecutiveNoOpCount is 0', () => {
    // First-time feedback — no escalation signal needed.
    assert.equal(buildNoOpEscalationSection(0), '');
  });

  it('returns empty string for negative inputs (defensive)', () => {
    assert.equal(buildNoOpEscalationSection(-1), '');
  });

  it('returns non-empty warning when consecutiveNoOpCount >= 1', () => {
    // User has submitted this feedback before and the prior response was
    // rejected as a no-op. The current iteration MUST warn the LLM.
    const s = buildNoOpEscalationSection(1);
    assert.ok(s.length > 0, 'expected non-empty warning for count=1');
    assert.match(s, /PREVIOUS FIX REJECTED/i);
    assert.match(s, /no-op|NO-OP/i);
  });

  it('includes the iteration count to bust upstream LLM caches', () => {
    // The iteration counter is the cache-busting mechanism. Without it,
    // identical prompts to a caching proxy produce identical responses.
    const s1 = buildNoOpEscalationSection(1);
    const s2 = buildNoOpEscalationSection(2);
    const s3 = buildNoOpEscalationSection(3);
    assert.match(s1, /1/);
    assert.match(s2, /2/);
    assert.match(s3, /3/);
    // Each call must produce distinct text — proves the counter is interpolated.
    assert.notEqual(s1, s2);
    assert.notEqual(s2, s3);
  });

  it('tells the LLM to produce a DIFFERENT script', () => {
    // Critical directive: the LLM must not return the same script. The word
    // "different" (or equivalent) must appear so the LLM cannot mistake the
    // warning for routine feedback.
    const s = buildNoOpEscalationSection(2);
    assert.match(s, /different/i);
  });

  it('offers concrete alternative strategies', () => {
    // Generic prompts for the LLM to break out of its anchor:
    // - read per-record data carefully
    // - try a different selector anchor
    // - NACK with specifics instead of faking a fix
    const s = buildNoOpEscalationSection(2);
    assert.match(s, /record/i);           // diagnostic reading
    assert.match(s, /selector|anchor/i);   // technical strategy
    assert.match(s, /NACK/i);              // escape hatch
  });

  it('does NOT mention facebook, post, group, or author (universality)', () => {
    // Per CLAUDE.md: don't hardcode FB-specific terms into prompts. The
    // escalation must be generic — works for any site/service.
    const s = buildNoOpEscalationSection(2);
    assert.ok(!/facebook/i.test(s), 'escalation must not mention facebook');
    assert.ok(!/\bpost(s)?\b/i.test(s), 'escalation must not mention post(s)');
    assert.ok(!/\bgroup(s)?\b/i.test(s), 'escalation must not mention group(s)');
    assert.ok(!/\bauthor(s)?\b/i.test(s), 'escalation must not mention author(s)');
  });
});

describe('registerNoOpForFeedback / resetNoOpEscalation state helpers', () => {
  // The state helpers wrap a plain state object so wizard.js doesn't have to
  // inline the bookkeeping. This makes the logic testable without importing
  // wizard.js (which depends on chrome.* APIs).

  it('registerNoOpForFeedback increments count when same feedback is registered twice', () => {
    const state = { consecutiveNoOpCount: 0, lastNoOpFeedback: null };
    registerNoOpForFeedback(state, 'hint A');
    assert.equal(state.lastNoOpFeedback, 'hint A');
    assert.equal(state.consecutiveNoOpCount, 1);

    registerNoOpForFeedback(state, 'hint A');
    assert.equal(state.consecutiveNoOpCount, 2);

    registerNoOpForFeedback(state, 'hint A');
    assert.equal(state.consecutiveNoOpCount, 3);
  });

  it('registerNoOpForFeedback resets count when feedback text changes', () => {
    // Different feedback = different problem. Don't carry over the escalation.
    const state = { consecutiveNoOpCount: 2, lastNoOpFeedback: 'hint A' };
    registerNoOpForFeedback(state, 'hint B');
    assert.equal(state.lastNoOpFeedback, 'hint B');
    assert.equal(state.consecutiveNoOpCount, 1);
  });

  it('resetNoOpEscalation clears state', () => {
    // Called on successful fix — clears the escalation signal so the next
    // feedback starts fresh.
    const state = { consecutiveNoOpCount: 5, lastNoOpFeedback: 'hint A' };
    resetNoOpEscalation(state);
    assert.equal(state.consecutiveNoOpCount, 0);
    assert.equal(state.lastNoOpFeedback, null);
  });

  it('registerNoOpForFeedback trims feedback before comparison (defensive)', () => {
    // "  hint A  " and "hint A" should be treated as the same feedback —
    // otherwise whitespace differences would silently reset the counter.
    const state = { consecutiveNoOpCount: 0, lastNoOpFeedback: null };
    registerNoOpForFeedback(state, 'hint A');
    registerNoOpForFeedback(state, '  hint A  ');
    assert.equal(state.consecutiveNoOpCount, 2,
      'whitespace-only differences must not reset the counter');
  });
});
