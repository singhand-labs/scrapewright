// Final-review follow-up (Plan 2): STEP_FAILED now carries the thrown
// step's selectorDiagnostics, and those flow into LLM prompts via
// formatSelectorDiagnosticsForPrompt + the two summarize folds.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const _dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/' });
global.DOMParser = _dom.window.DOMParser;
global.NodeFilter = _dom.window.NodeFilter;
global.Node = _dom.window.Node;
const {
  formatSelectorDiagnosticsForPrompt,
  summarizeAllStepDiagnostics,
  summarizeExecutionDiagnostics,
  SCRIPT_DSL_GUIDE
} = require('../lib/wizard-utils');

describe('formatSelectorDiagnosticsForPrompt', () => {
  it('returns empty string for null/undefined/empty-array input', () => {
    assert.equal(formatSelectorDiagnosticsForPrompt(null), '');
    assert.equal(formatSelectorDiagnosticsForPrompt(undefined), '');
    assert.equal(formatSelectorDiagnosticsForPrompt([]), '');
    assert.equal(formatSelectorDiagnosticsForPrompt('not-an-array'), '');
  });

  it('renders a single small entry with the header and JSON body', () => {
    const out = formatSelectorDiagnosticsForPrompt([{ api: 'extractWithHover', containerMatches: 0 }]);
    assert.match(out, /Selector diagnostics \(empirical/);
    assert.match(out, /extractWithHover/);
    assert.match(out, /containerMatches/);
  });

  it('caps rendering at 10 entries', () => {
    const diags = Array.from({ length: 12 }, (_, i) => ({ api: 'list', idx: i }));
    const out = formatSelectorDiagnosticsForPrompt(diags);
    const lines = out.split('\n').filter((l) => l.trim().startsWith('- '));
    assert.equal(lines.length, 10);
  });

  it('truncates entries beyond 400 chars', () => {
    const diags = [{ api: 'extractList', html: 'x'.repeat(5000) }];
    const out = formatSelectorDiagnosticsForPrompt(diags);
    assert.match(out, /…\[truncated\]/);
    const entryLine = out.split('\n').find((l) => l.includes('extractList'));
    assert.ok(entryLine.length <= 420, 'entry capped near 400 chars, got ' + entryLine.length);
  });

  it('falls back to String() for non-JSON-safe entries without throwing', () => {
    const circular = { api: 'list' };
    circular.self = circular;
    const out = formatSelectorDiagnosticsForPrompt([circular]);
    assert.ok(out.includes('- [object Object]') || out.includes('api'));
  });
});

describe('summarizeAllStepDiagnostics STEP_FAILED fold', () => {
  it('renders a step that THREW before completing an iteration', () => {
    const events = [{
      type: 'STEP_FAILED',
      stepId: 's1',
      error: 'no containers',
      selectorDiagnostics: [{ api: 'extractWithHover', containerMatches: 0 }]
    }];
    const steps = [{ id: 's1', name: 'hover', script: 'x', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }];
    const out = summarizeAllStepDiagnostics(events, steps);
    assert.match(out, /THREW before completing an iteration/);
    assert.match(out, /no containers/);
    assert.match(out, /extractWithHover/);
  });

  it('still returns empty string when no STEP_FAILED diagnostics and no iterations', () => {
    const events = [{ type: 'STEP_FAILED', stepId: 's1', error: 'boom' }];
    const steps = [{ id: 's1', name: 'one', script: 'x', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }];
    assert.equal(summarizeAllStepDiagnostics(events, steps), '');
  });
});

describe('summarizeExecutionDiagnostics STEP_FAILED fold', () => {
  it('includes selectorDiagnostics from the STEP_FAILED event', () => {
    const events = [{
      type: 'STEP_FAILED',
      stepId: 's1',
      error: 'zero containers',
      selectorDiagnostics: [{ api: 'extractWithHover', containerMatches: 0 }]
    }];
    const out = summarizeExecutionDiagnostics(events, 's1');
    assert.match(out, /zero containers/);
    assert.match(out, /extractWithHover/);
    assert.match(out, /containerMatches/);
  });
});

describe('SCRIPT_DSL_GUIDE timeoutMs rows', () => {
  it('documents $click/$type timeoutMs and $exists timeoutMs=0 semantics', () => {
    assert.ok(SCRIPT_DSL_GUIDE.includes('$click(selector, timeoutMs?)'), '$click row carries timeoutMs');
    assert.ok(SCRIPT_DSL_GUIDE.includes('$type(selector, text, timeoutMs?)'), '$type row carries timeoutMs');
    assert.ok(SCRIPT_DSL_GUIDE.includes('timeoutMs=0 for a single immediate query'), '$exists(0) semantics documented');
    assert.match(SCRIPT_DSL_GUIDE, /default 10000ms/, '10s element-wait default documented');
  });
});
