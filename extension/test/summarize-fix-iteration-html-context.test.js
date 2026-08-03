const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const wizardUtils = (typeof window !== 'undefined' && window.wizardUtils)
  || require('../lib/wizard-utils.js');
const summarizeFixIteration = wizardUtils.summarizeFixIteration || (typeof window !== 'undefined' && window.summarizeFixIteration);

describe('summarizeFixIteration htmlContext param', () => {
  it('includes htmlContext block when provided', () => {
    const out = summarizeFixIteration({
      stepId: '4',
      stepName: 'extract',
      script: 'return 1;',
      annotations: [],
      userFeedback: null,
      error: 'ELEMENT_NOT_FOUND',
      result: null,
      htmlContext: '[Page HTML fingerprint: abc12345]\n<html>...</html>'
    });
    assert.match(out, /Page context:/);
    assert.match(out, /abc12345/);
    assert.match(out, /html>.*<\/html>/s);
  });

  it('omits Page context block when htmlContext is not provided (backward compat)', () => {
    const out = summarizeFixIteration({
      stepId: '4',
      stepName: 'extract',
      script: 'return 1;',
      annotations: [],
      userFeedback: null,
      error: 'ELEMENT_NOT_FOUND',
      result: null
    });
    assert.doesNotMatch(out, /Page context:/);
  });

  it('omits Page context block when htmlContext is empty string', () => {
    const out = summarizeFixIteration({
      stepId: '4',
      stepName: 'extract',
      script: 'return 1;',
      annotations: [],
      userFeedback: null,
      error: null,
      result: null,
      htmlContext: ''
    });
    assert.doesNotMatch(out, /Page context:/);
  });
});
