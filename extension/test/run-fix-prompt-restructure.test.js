const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildFeedbackSection } = require('../lib/wizard-utils');

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
