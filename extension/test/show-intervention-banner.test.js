const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { renderInterventionBanner } = require('../lib/wizard-utils');

describe('renderInterventionBanner', () => {
  it('renders warn-severity banner with annotate_step action', () => {
    const html = renderInterventionBanner({
      type: 'needs_annotation',
      severity: 'warn',
      message: "Extraction returns empty. Click 'Start Annotating'.",
      uiAction: 'annotate_step'
    });
    assert.match(html, /Extraction returns empty/);
    assert.match(html, /Start Annotating/i);
    assert.match(html, /class="[^"]*warn/i);
  });

  it('renders open_settings button for rate_limited', () => {
    const html = renderInterventionBanner({
      type: 'rate_limited',
      severity: 'error',
      message: 'LLM provider rate-limited.',
      uiAction: 'open_settings'
    });
    assert.match(html, /rate-limited/i);
    assert.match(html, /error/i);
    assert.match(html, /data-action="open_settings"/);
  });

  it('includes Ignore and continue button', () => {
    const html = renderInterventionBanner({
      type: 'needs_login', severity: 'error', message: 'Login required.', uiAction: 'open_tab'
    });
    assert.match(html, /Ignore and continue/i);
    assert.match(html, /data-action="dismiss"/);
  });

  it('returns empty string for null input', () => {
    assert.equal(renderInterventionBanner(null), '');
  });
});
