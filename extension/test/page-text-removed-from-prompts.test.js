const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WIZARD_PATH = path.join(__dirname, '..', 'wizard.js');
const WIZARD_UTILS_PATH = path.join(__dirname, '..', 'lib', 'wizard-utils.js');

describe('Page text sections removed from LLM prompts', () => {
  it('wizard.js does not render "Page text content:" or "Page text:" or "Page text (initial state):" into prompts', () => {
    const src = fs.readFileSync(WIZARD_PATH, 'utf8');
    // These are the section headers that preceded the now-removed textContent/textSummary lines.
    // They may still appear in comments explaining the removal — that's fine. But they must not
    // appear in template-literal prompt strings (i.e., inside backticks).
    // Quick heuristic: count occurrences outside comments.
    const withoutComments = src.replace(/\/\/[^\n]*\n/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(withoutComments, /Page text content:/,
      'wizard.js must not render "Page text content:" into prompts — it duplicates the cleaned HTML');
    assert.doesNotMatch(withoutComments, /Page text \(initial state\):/,
      'wizard.js must not render "Page text (initial state):" into prompts');
    assert.doesNotMatch(withoutComments, /Page text \(after interaction\):/,
      'wizard.js must not render "Page text (after interaction):" into prompts');
  });

  it('wizard-utils.js does not include "Page text:" in any prompt builder', () => {
    const src = fs.readFileSync(WIZARD_UTILS_PATH, 'utf8');
    const withoutComments = src.replace(/\/\/[^\n]*\n/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(withoutComments, /Page text:/,
      'wizard-utils.js must not include "Page text:" sections — they duplicate the cleaned HTML');
  });
});
