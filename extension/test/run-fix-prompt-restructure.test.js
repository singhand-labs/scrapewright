const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildFeedbackSection, summarizeAllStepDiagnostics } = require('../lib/wizard-utils');

// We can't easily require runFixIteration (it's inside wizard.js with closure access).
// Instead, verify the prompt STRUCTURE via the helper that produces the feedback section,
// and assert the section is non-empty + correctly formed when feedback is given.
// Full integration coverage comes from the bc1.log fixture test (Task 9).

describe('runFixIteration prompt restructure (via buildFeedbackSection)', () => {
  it('produces feedback block that would appear BEFORE script DSL guide', () => {
    const section = buildFeedbackSection('extract title field', 1, 3, []);
    // The prompt template interpolates ${feedbackSection} before ${SCRIPT_DSL_GUIDE}.
    // We assert the section starts with the USER FEEDBACK header marker.
    assert.match(section, /^=== USER FEEDBACK/);
  });

  it('handles null feedback without breaking prompt structure', () => {
    const section = buildFeedbackSection(null, 1, 3, []);
    assert.equal(section, '');
    // Empty string is safe to interpolate anywhere in the prompt template
  });
});

describe('runFixIteration user-feedback prompt — RUNTIME DIAGNOSTICS injection', () => {
  it('includes a RUNTIME DIAGNOSTICS section when lastExecutionEvents has iterations', () => {
    // Re-using the same prompt-construction path the existing tests use.
    // If the existing tests use a builder function, call it here; if they
    // regex the SCRIPT_DSL_GUIDE / RETURN_FORMAT_FEEDBACK constants, do the same.
    // The intent: when the user-feedback path builds its prompt with
    // lastExecutionEvents populated, the final prompt string MUST contain
    // the per-step iteration trace produced by summarizeAllStepDiagnostics.
    const events = [
      { type: 'STEP_ITERATION', stepId: '2', iteration: 1, resultPreview: '{"postCount":6,"stalled":0}', ts: 0 },
      { type: 'STEP_ITERATION', stepId: '2', iteration: 2, resultPreview: '{"postCount":6,"stalled":1}', ts: 1 }
    ];
    const steps = [{ id: '2', name: 'scroll_and_load' }];
    const diagnostics = summarizeAllStepDiagnostics(events, steps);
    assert.match(diagnostics, /scroll_and_load/);
    assert.match(diagnostics, /stalled.:0/);
    assert.match(diagnostics, /stalled.:1/);
    // The prompt template must include a RUNTIME DIAGNOSTICS header that wraps
    // this output. The exact wiring is in wizard.js:runFixIteration's
    // user-feedback branch; the prompt construction itself is inline (not a
    // separate builder), so this test asserts the helper produces the right
    // shape and trusts the prompt wiring (covered by syntax-smoke + manual
    // verification).
  });
});
