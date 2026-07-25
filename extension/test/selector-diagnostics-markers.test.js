// Regression for bugx.log 2026-07-25: even with selector diagnostics flowing,
// glm-5.1 still couldn't converge on FB publishTime. Root cause: two failure
// modes the existing markers don't surface —
//   (a) EMPTY-EXTRACTIONS: selector matched N elements but every extracted
//       text is empty (e.g., attr missing, wrong element). matchCount=N
//       looks healthy so no OVER-CONSTRAINED fired; the LLM saw "10 matches"
//       and assumed the selector was fine.
//   (b) FIELD-COLLISION: two fields' selectors grab the SAME elements (e.g.,
//       author and publishTime both matching `a[aria-label]`). The samples
//       were right there in the prompt but the LLM never noticed they were
//       identical across fields.
// Both markers are GENERIC — no FB-specific knowledge. They trigger on the
// structural pattern (empty samples / identical samples), not on field names.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeAllStepDiagnostics } = require('../lib/wizard-utils');

function extEvent(perField, containerMatches = 3, containerSelector = 'c') {
  return {
    type: 'STEP_ITERATION',
    stepId: '4',
    iteration: 1,
    resultPreview: '{}',
    selectorDiagnostics: [{
      api: 'extractList',
      containerSelector,
      containerMatches,
      perField
    }]
  };
}

describe('EMPTY-EXTRACTIONS marker', () => {
  it('fires when matchCount > 0 but all sample texts are empty strings', () => {
    const events = [extEvent([
      { field: 'publishTime', subSelector: 'a.time', attr: null, matchCount: 3, sampleTexts: ['', '', ''], sampleHrefs: [] }
    ])];
    const out = summarizeAllStepDiagnostics(events, [{ id: '4', name: 'extract' }]);
    assert.match(out, /publishTime[\s\S]*EMPTY-EXTRACTIONS/);
  });

  it('does NOT fire when samples are non-empty', () => {
    const events = [extEvent([
      { field: 'author', subSelector: 'h3 a', attr: null, matchCount: 3, sampleTexts: ['Alice', 'Bob', 'Carol'], sampleHrefs: [] }
    ])];
    const out = summarizeAllStepDiagnostics(events, [{ id: '4', name: 'extract' }]);
    assert.doesNotMatch(out, /EMPTY-EXTRACTIONS/);
  });

  it('fires when samples are all whitespace-only', () => {
    const events = [extEvent([
      { field: 'title', subSelector: 'h2', attr: null, matchCount: 2, sampleTexts: ['  ', '\n'], sampleHrefs: [] }
    ])];
    const out = summarizeAllStepDiagnostics(events, [{ id: '4', name: 'extract' }]);
    assert.match(out, /title[\s\S]*EMPTY-EXTRACTIONS/);
  });

  it('does NOT fire for attr-based extracts (samples empty by design)', () => {
    const events = [extEvent([
      { field: 'id', subSelector: 'a.x', attr: 'data-id', matchCount: 3, sampleTexts: [], sampleHrefs: [] }
    ])];
    const out = summarizeAllStepDiagnostics(events, [{ id: '4', name: 'extract' }]);
    assert.doesNotMatch(out, /EMPTY-EXTRACTIONS/);
  });

  it('does NOT fire when matchCount is 0 (OVER-CONSTRAINED handles that case)', () => {
    const events = [extEvent([
      { field: 'publishTime', subSelector: 'a.time', attr: null, matchCount: 0, sampleTexts: [], sampleHrefs: [] }
    ])];
    const out = summarizeAllStepDiagnostics(events, [{ id: '4', name: 'extract' }]);
    assert.doesNotMatch(out, /EMPTY-EXTRACTIONS/);
    assert.match(out, /OVER-CONSTRAINED/);
  });

  it('does NOT fire when samples array is missing (defensive)', () => {
    const events = [extEvent([
      { field: 'publishTime', subSelector: 'a.time', attr: null, matchCount: 3 }
    ])];
    const out = summarizeAllStepDiagnostics(events, [{ id: '4', name: 'extract' }]);
    // matchCount=3 but no sampleTexts field — treat like attr-extract (no marker).
    assert.doesNotMatch(out, /EMPTY-EXTRACTIONS/);
  });
});

describe('FIELD-COLLISION marker', () => {
  it('fires when two fields have identical non-empty sampleTexts', () => {
    const events = [extEvent([
      { field: 'author', subSelector: 'h3 a', attr: null, matchCount: 2, sampleTexts: ['Alice', 'Bob'], sampleHrefs: [] },
      { field: 'publishTime', subSelector: 'a[aria-label]', attr: null, matchCount: 2, sampleTexts: ['Alice', 'Bob'], sampleHrefs: [] }
    ])];
    const out = summarizeAllStepDiagnostics(events, [{ id: '4', name: 'extract' }]);
    assert.match(out, /FIELD COLLISION/);
    // Both fields should mention the other as a peer
    assert.match(out, /author[\s\S]*publishTime/);
    assert.match(out, /publishTime[\s\S]*author/);
  });

  it('does NOT fire when samples are non-overlapping', () => {
    const events = [extEvent([
      { field: 'author', subSelector: 'h3 a', attr: null, matchCount: 2, sampleTexts: ['Alice', 'Bob'], sampleHrefs: [] },
      { field: 'time', subSelector: 'a.time', attr: null, matchCount: 2, sampleTexts: ['5m', '6m'], sampleHrefs: [] }
    ])];
    const out = summarizeAllStepDiagnostics(events, [{ id: '4', name: 'extract' }]);
    assert.doesNotMatch(out, /FIELD COLLISION/);
  });

  it('does NOT fire when one field has all-empty samples', () => {
    const events = [extEvent([
      { field: 'author', subSelector: 'h3 a', attr: null, matchCount: 2, sampleTexts: ['Alice', 'Bob'], sampleHrefs: [] },
      { field: 'time', subSelector: 'a.time', attr: null, matchCount: 2, sampleTexts: ['', ''], sampleHrefs: [] }
    ])];
    const out = summarizeAllStepDiagnostics(events, [{ id: '4', name: 'extract' }]);
    assert.doesNotMatch(out, /FIELD COLLISION/);
  });

  it('detects collision when sample order differs (sets, not sequences)', () => {
    const events = [extEvent([
      { field: 'a', subSelector: 'h3', attr: null, matchCount: 2, sampleTexts: ['Alice', 'Bob'], sampleHrefs: [] },
      { field: 'b', subSelector: 'h4', attr: null, matchCount: 2, sampleTexts: ['Bob', 'Alice'], sampleHrefs: [] }
    ])];
    const out = summarizeAllStepDiagnostics(events, [{ id: '4', name: 'extract' }]);
    assert.match(out, /FIELD COLLISION/);
  });

  it('does NOT fire across different containerSelector calls (only within same call)', () => {
    const events = [{
      type: 'STEP_ITERATION',
      stepId: '4',
      iteration: 1,
      resultPreview: '{}',
      selectorDiagnostics: [
        {
          api: 'extractList',
          containerSelector: 'div.posts',
          containerMatches: 2,
          perField: [{ field: 'a', subSelector: 'h3', attr: null, matchCount: 2, sampleTexts: ['X', 'Y'], sampleHrefs: [] }]
        },
        {
          api: 'extractList',
          containerSelector: 'div.comments',
          containerMatches: 2,
          perField: [{ field: 'b', subSelector: 'h3', attr: null, matchCount: 2, sampleTexts: ['X', 'Y'], sampleHrefs: [] }]
        }
      ]
    }];
    const out = summarizeAllStepDiagnostics(events, [{ id: '4', name: 'extract' }]);
    assert.doesNotMatch(out, /FIELD COLLISION/);
  });

  it('does NOT false-positive when three samples share one value out of many', () => {
    // author has [Alice, Bob, Carol], publishTime has [Alice, Dave, Eve]
    // Only one sample overlaps — not a collision.
    const events = [extEvent([
      { field: 'author', subSelector: 'h3 a', attr: null, matchCount: 3, sampleTexts: ['Alice', 'Bob', 'Carol'], sampleHrefs: [] },
      { field: 'publishTime', subSelector: 'a.x', attr: null, matchCount: 3, sampleTexts: ['Alice', 'Dave', 'Eve'], sampleHrefs: [] }
    ], 3)];
    const out = summarizeAllStepDiagnostics(events, [{ id: '4', name: 'extract' }]);
    assert.doesNotMatch(out, /FIELD COLLISION/);
  });
});
