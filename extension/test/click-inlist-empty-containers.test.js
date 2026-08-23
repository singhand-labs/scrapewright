// Regression for console.log 2026-08-23 14:51:59 (second session): step 3
// ($clickInList with the never-fixed rigid container selector) returned
// {done:true, expanded:0, errors:0} because the CONTAINER selector matched 0
// elements — clickInListItems got an empty array, so neither clicked nor
// errors accumulated. CLICK_TARGET_NOT_FOUND (subSel dead) requires
// containerMatches>0 and stayed silent, correctly — but the 0-container case
// itself is the same class of silent no-op and needs its own signal.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectClickInListEmptyContainers } = require('../lib/wizard-utils');

function itEvt(stepId, diags) {
  return { type: 'STEP_ITERATION', stepId, iteration: 1, selectorDiagnostics: diags };
}

const RIGID = 'div[role="feed"] > div > div[role="article"]';

describe('detectClickInListEmptyContainers', () => {
  it('fires when every clickInList call had containerMatches === 0', () => {
    const events = [
      itEvt('3', [{ api: 'clickInList', containerSelector: RIGID, containerMatches: 0, subSelector: 'div[role="button"]', clicked: 0, errorCount: 0, notFoundCount: 0, sampleTexts: [], firstContainerHtml: null }])
    ];
    const r = detectClickInListEmptyContainers(events);
    assert.ok(r, 'should fire on a single all-empty call');
    assert.equal(r.stepId, '3');
    assert.equal(r.containerSelector, RIGID);
    assert.equal(r.calls, 1);
    assert.equal(r.nonEmptyCalls, 0);
  });

  it('fires across multiple iterations all matching 0 containers', () => {
    const d = { api: 'clickInList', containerSelector: RIGID, containerMatches: 0, clicked: 0, errorCount: 0, notFoundCount: 0 };
    const events = [itEvt('3', [d]), itEvt('3', [d])];
    const r = detectClickInListEmptyContainers(events);
    assert.ok(r);
    assert.equal(r.calls, 2);
    assert.equal(r.nonEmptyCalls, 0);
  });

  it('returns null when any call matched containers (subSel failures are CLICK_TARGET_NOT_FOUND territory)', () => {
    const events = [
      itEvt('3', [{ api: 'clickInList', containerSelector: RIGID, containerMatches: 10, subSelector: 'div[role="button"]', clicked: 0, errorCount: 10, notFoundCount: 10 }])
    ];
    assert.equal(detectClickInListEmptyContainers(events), null);
  });

  it('returns null when a later iteration recovered containers', () => {
    const events = [
      itEvt('3', [{ api: 'clickInList', containerSelector: RIGID, containerMatches: 0, clicked: 0, errorCount: 0, notFoundCount: 0 }]),
      itEvt('3', [{ api: 'clickInList', containerSelector: RIGID, containerMatches: 4, clicked: 4, errorCount: 0, notFoundCount: 0 }])
    ];
    assert.equal(detectClickInListEmptyContainers(events), null);
  });

  it('returns null with no clickInList diagnostics / empty / null input', () => {
    assert.equal(detectClickInListEmptyContainers(null), null);
    assert.equal(detectClickInListEmptyContainers([]), null);
    assert.equal(detectClickInListEmptyContainers([itEvt('2', [{ api: 'list', selector: 'x', matchCount: 0 }])]), null);
  });
});
