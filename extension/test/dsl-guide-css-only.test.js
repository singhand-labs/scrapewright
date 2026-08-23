// Regression for console.log 2026-08-23 14:44 (second session): step 2 died
// instantly because the LLM wrote 'span:has-text("Related searches")' — a
// Playwright pseudo-class that is NOT valid CSS. document.querySelector threw
// "is not a valid selector" and killed the whole step before anything ran.
// The DSL guide must teach STANDARD CSS ONLY and the correct by-text pattern.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SCRIPT_DSL_GUIDE } = require('../lib/wizard-utils');

describe('SCRIPT_DSL_GUIDE — standard CSS only', () => {
  it('has a STANDARD CSS ONLY warning near the CSS TRAP section', () => {
    assert.match(SCRIPT_DSL_GUIDE, /STANDARD CSS ONLY/i);
  });

  it('names the Playwright-only pseudo-classes the LLM actually invents', () => {
    assert.match(SCRIPT_DSL_GUIDE, /:has-text\(/);
    assert.match(SCRIPT_DSL_GUIDE, /:text=|:contains\(/);
  });

  it('says these throw "not a valid selector" instantly and kill the step', () => {
    assert.match(SCRIPT_DSL_GUIDE, /not a valid selector/i);
  });

  it('teaches the by-text pattern: $list then filter by textContent regex in JS', () => {
    assert.match(SCRIPT_DSL_GUIDE, /\$list\([^)]*\)[\s\S]{0,220}\.find\(/);
    assert.match(SCRIPT_DSL_GUIDE, /\.test\(\s*\w+\.textContent/);
  });

  it('keeps the guide free of site-specific names', () => {
    const forbidden = ['facebook', 'twitter', 'linkedin', 'tiktok', 'reddit', 'fb'];
    for (const term of forbidden) {
      assert.ok(!new RegExp(term, 'i').test(SCRIPT_DSL_GUIDE), `site-specific term "${term}" in guide`);
    }
  });
});
