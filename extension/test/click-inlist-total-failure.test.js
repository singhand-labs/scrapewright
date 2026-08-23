// Regression for console.log 2026-08-23 (FB search wizard session): step 3
// ($clickInList See-more expander) clicked 0, errored on all 10 containers
// ('subSel not found'), and returned { done: true } — the requirement's
// expand action silently no-opped. $click throws ELEMENT_NOT_FOUND on a
// miss; $clickInList aggregated every miss into errors[] and the framework
// swallowed the total failure (RC48/RC50 asymmetry class: same operation
// shape, different failure semantics).
//
// Fix: instrument $clickInList with _diagnostics (like $extractList et al)
// and detect total failure at wizard test time from STEP_ITERATION events —
// framework-level truth, independent of which fields the LLM chose to
// return from the raw { clicked, errors } result.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  clickInListItems,
  computeClickInListDiagnostics
} = require('../lib/list-extract-ops');
const {
  detectClickInListTotalFailure,
  summarizeAllStepDiagnostics
} = require('../lib/wizard-utils');

function setupDOM() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://example.com/page' });
  global.document = dom.window.document;
  global.window = dom.window;
  global.Node = dom.window.Node;
  return dom;
}

function feedArticles() {
  document.body.innerHTML = `
    <div role="feed">
      <div role="article">Post one <div>See more</div></div>
      <div role="article">Post two <div>See more</div></div>
    </div>`;
  return Array.from(document.querySelectorAll('div[role="article"]'));
}

describe('computeClickInListDiagnostics', () => {
  beforeEach(setupDOM);

  it('reports total subSel miss with notFoundCount == errorCount', () => {
    const containers = feedArticles();
    const result = clickInListItems(containers, 'div[role="button"][aria-label*="See more" i]', () => {}, 0);
    assert.equal(result.clicked, 0);
    assert.equal(result.errors.length, 2);
    const d = computeClickInListDiagnostics(containers, 'div[role="button"][aria-label*="See more" i]', 'div[role="article"]', result);
    assert.equal(d.api, 'clickInList');
    assert.equal(d.containerMatches, 2);
    assert.equal(d.clicked, 0);
    assert.equal(d.errorCount, 2);
    assert.equal(d.notFoundCount, 2);
    assert.ok(Array.isArray(d.sampleTexts) && d.sampleTexts.length > 0);
    assert.ok(typeof d.firstContainerHtml === 'string' && d.firstContainerHtml.includes('Post one'));
  });

  it('records partial clicks without notFound/error equality', () => {
    const containers = feedArticles();
    const result = clickInListItems(containers, 'div', (el) => { el.click && el.click(); }, 0);
    assert.equal(result.clicked, 2);
    const d = computeClickInListDiagnostics(containers, 'div', 'div[role="article"]', result);
    assert.equal(d.clicked, 2);
    assert.equal(d.errorCount, 0);
    assert.equal(d.notFoundCount, 0);
  });
});

describe('detectClickInListTotalFailure', () => {
  it('fires when every container matched but nothing was clicked', () => {
    const events = [{
      type: 'STEP_ITERATION',
      stepId: '3',
      iteration: 1,
      selectorDiagnostics: [{
        api: 'clickInList', containerSelector: 'div[role="article"]',
        containerMatches: 10, subSelector: 'div[role="button"][aria-label*="See more" i]',
        clicked: 0, errorCount: 10, notFoundCount: 10
      }]
    }];
    const hit = detectClickInListTotalFailure(events);
    assert.ok(hit);
    assert.equal(hit.stepId, '3');
    assert.equal(hit.containerMatches, 10);
    assert.equal(hit.subSelector, 'div[role="button"][aria-label*="See more" i]');
  });

  it('does not fire on partial failure (some clicks succeeded)', () => {
    const events = [{
      type: 'STEP_ITERATION',
      stepId: '3',
      iteration: 1,
      selectorDiagnostics: [{
        api: 'clickInList', containerMatches: 10, subSelector: 'a.more',
        clicked: 7, errorCount: 3, notFoundCount: 3
      }]
    }];
    assert.equal(detectClickInListTotalFailure(events), null);
  });

  it('does not fire when a later iteration of the same step clicked successfully', () => {
    const events = [
      { type: 'STEP_ITERATION', stepId: '3', iteration: 1, selectorDiagnostics: [{ api: 'clickInList', containerMatches: 5, subSelector: 'a.more', clicked: 0, errorCount: 5, notFoundCount: 5 }] },
      { type: 'STEP_ITERATION', stepId: '3', iteration: 2, selectorDiagnostics: [{ api: 'clickInList', containerMatches: 5, subSelector: 'a.more', clicked: 4, errorCount: 1, notFoundCount: 1 }] }
    ];
    assert.equal(detectClickInListTotalFailure(events), null);
  });

  it('ignores zero-container calls and non-clickInList diagnostics', () => {
    assert.equal(detectClickInListTotalFailure([{
      type: 'STEP_ITERATION', stepId: '2', iteration: 1,
      selectorDiagnostics: [{ api: 'clickInList', containerMatches: 0, clicked: 0, errorCount: 0, notFoundCount: 0 }]
    }]), null);
    assert.equal(detectClickInListTotalFailure([{
      type: 'STEP_ITERATION', stepId: '2', iteration: 1,
      selectorDiagnostics: [{ api: 'extractList', containerMatches: 4, clicked: 0 }]
    }]), null);
    assert.equal(detectClickInListTotalFailure([]), null);
    assert.equal(detectClickInListTotalFailure(null), null);
  });
});

describe('summarizeAllStepDiagnostics renders clickInList evidence', () => {
  it('shows clicked/error counts, the dead sub-selector, and container HTML', () => {
    const events = [{
      type: 'STEP_ITERATION', stepId: '3', iteration: 1,
      selectorDiagnostics: [{
        api: 'clickInList', containerSelector: 'div[role="article"]', containerMatches: 10,
        subSelector: 'div[role="button"][aria-label*="See more" i]',
        clicked: 0, errorCount: 10, notFoundCount: 10,
        sampleTexts: ['Post one content'],
        firstContainerHtml: '<div role="article">Post one <div>See more</div></div>'
      }]
    }];
    const steps = [{ id: '3', name: 'expand_see_more' }];
    const out = summarizeAllStepDiagnostics(events, steps);
    assert.match(out, /\$clickInList\('div\[role="article"\]'\)/);
    assert.match(out, /clicked 0/);
    assert.match(out, /matched NOTHING/);
    assert.match(out, /See more/);
  });
});
