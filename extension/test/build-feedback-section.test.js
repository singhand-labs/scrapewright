const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildFeedbackSection } = require('../lib/wizard-utils');

describe('buildFeedbackSection', () => {
  it('returns empty string when feedback is null', () => {
    assert.equal(buildFeedbackSection(null, 1, 3, []), '');
  });

  it('returns empty string when feedback is whitespace only', () => {
    assert.equal(buildFeedbackSection('   ', 1, 3, []), '');
  });

  it('includes ACK/NACK protocol explanation', () => {
    const s = buildFeedbackSection('extract the date field', 1, 3, []);
    assert.match(s, /ACK/);
    assert.match(s, /NACK/);
    assert.match(s, /extract the date field/);
  });

  it('includes attempt count in header', () => {
    const s = buildFeedbackSection('hint', 2, 3, []);
    assert.match(s, /attempt 2\/3/);
  });

  it('appends NACK-twice note when history shows 2 prior NACKs for same hint', () => {
    const llmHistory = [
      { role: 'user', content: '=== USER FEEDBACK (attempt 1/3) ===\nhint' },
      { role: 'assistant', content: '// NACK: cannot because reasons' },
      { role: 'user', content: '=== USER FEEDBACK (attempt 2/3) ===\nhint' },
      { role: 'assistant', content: '// NACK: still cannot' }
    ];
    const s = buildFeedbackSection('hint', 3, 3, llmHistory);
    assert.match(s, /NACKed .* 2 times/i);
  });

  it('does NOT append NACK note on first attempt', () => {
    const s = buildFeedbackSection('hint', 1, 3, []);
    assert.doesNotMatch(s, /NACKed/i);
  });

  it('escapes backticks and ${} in feedback to preserve prompt structure', () => {
    const s = buildFeedbackSection('use `${foo}` in the `script`', 1, 3, []);
    // Should not contain raw ${} or unescaped backticks that would break the surrounding template
    assert.ok(!s.includes('`${foo'));
    assert.match(s, /\\\$\{foo\}/);  // ${ got escaped
  });
});
