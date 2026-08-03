const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WIZARD_PATH = path.join(__dirname, '..', 'wizard.js');

describe('autoFix history is not artificially truncated', () => {
  const src = fs.readFileSync(WIZARD_PATH, 'utf8');

  it('does not use .slice(-2) to trim autoFix history (C1)', () => {
    // The banned pattern: historyForPrompt = ...slice(-2)
    // Find any occurrence of slice(-2) near llmHistory.
    const withoutComments = src.replace(/\/\/[^\n]*\n/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(withoutComments, /llmHistory\.slice\(-2\)/,
      'user-feedback path must not use llmHistory.slice(-2) — that causes amnesia');
    assert.doesNotMatch(withoutComments, /historyForPrompt\s*=\s*[^;]*slice\(-2\)/,
      'historyForPrompt must not be slice(-2)');
  });

  it('does not truncate step-generation history to 2000 chars (C2)', () => {
    const withoutComments = src.replace(/\/\/[^\n]*\n/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(withoutComments, /\.substring\(0,\s*2000\)/,
      'step-generation history must not be substring(0, 2000) — that loses structure');
  });
});
