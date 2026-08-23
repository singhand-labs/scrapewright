// Regression for console.log 2026-08-23 14:44-14:48 (second session): step 2
// polled 20 iterations, every iteration returned {done:false, uniqueCount:0},
// and the $list counting selector matched 0 elements on EVERY iteration — yet
// the only signal that reached autoFix was the generic POLL_EXHAUSTED. The
// user watched the tab scroll for 4 minutes loading posts the script could
// not see. These tests pin detectCountSelectorBlind: fire when a poll step's
// ENTIRE selector history is 0-match AND it never recovered; stay silent on
// slow-render pages where a later iteration started matching.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectCountSelectorBlind } = require('../lib/wizard-utils');

function itEvt(stepId, iteration, diags, preview) {
  return {
    type: 'STEP_ITERATION',
    stepId,
    iteration,
    maxIterations: 20,
    domActivity: [],
    resultPreview: preview,
    selectorDiagnostics: diags
  };
}

const RIGID = 'div[role="feed"] > div > div[role="article"]';
const listDiag0 = { api: 'list', selector: RIGID, matchCount: 0, sampleTexts: [], sampleHrefs: [] };
const listDiag2 = { api: 'list', selector: RIGID, matchCount: 2, sampleTexts: ['a', 'b'], sampleHrefs: [] };
const notReady = '{"done":false,"uniqueCount":0,"noGrowth":1,"seenSignatures":[]}';

describe('detectCountSelectorBlind', () => {
  it('fires when a poll step iterates >=3 times, every selector matched 0, and it never recovered', () => {
    const events = [];
    for (let i = 1; i <= 20; i++) {
      events.push(itEvt('2', i, [listDiag0], notReady));
    }
    const r = detectCountSelectorBlind(events);
    assert.ok(r, 'should fire');
    assert.equal(r.stepId, '2');
    assert.ok(r.blindIterations >= 3, 'blindIterations >= 3, got ' + (r && r.blindIterations));
    assert.ok(r.iterations >= 20);
    assert.ok(r.selectors.includes(RIGID), 'selectors list includes the blind selector');
  });

  it('does NOT fire when a later iteration recovered (slow-render is legitimate, log run 3)', () => {
    // Real sequence from the log: 4 blind iterations, then iteration 5
    // matched 2 articles and the step converged normally.
    const events = [
      itEvt('2', 1, [listDiag0], notReady),
      itEvt('2', 2, [listDiag0], notReady),
      itEvt('2', 3, [listDiag0], notReady),
      itEvt('2', 4, [listDiag0], notReady),
      itEvt('2', 5, [listDiag2], '{"done":false,"uniqueCount":2,"noGrowth":0}')
    ];
    assert.equal(detectCountSelectorBlind(events), null);
  });

  it('does NOT fire when selectors matched from the first iteration', () => {
    const events = [
      itEvt('2', 1, [listDiag2], '{"done":false,"uniqueCount":2}'),
      itEvt('2', 2, [listDiag2], '{"done":false,"uniqueCount":4}'),
      itEvt('2', 3, [listDiag2], '{"done":false,"uniqueCount":5}')
    ];
    assert.equal(detectCountSelectorBlind(events), null);
  });

  it('does NOT fire when iterations carried no selector diagnostics', () => {
    // A step that polls purely on its own state (no $ calls) must never be
    // flagged — there is no selector evidence to judge.
    const events = [
      itEvt('3', 1, [], notReady),
      itEvt('3', 2, [], notReady),
      itEvt('3', 3, [], notReady)
    ];
    assert.equal(detectCountSelectorBlind(events), null);
  });

  it('ignores zero-match iterations whose result was done:true (not polling)', () => {
    // done:true with 0 matches is EMPTY_EXTRACTION's domain, not blindness
    // while polling. Only done:false iterations count toward blindness.
    const events = [
      itEvt('2', 1, [listDiag0], '{"done":true,"uniqueCount":0}'),
      itEvt('2', 2, [listDiag0], '{"done":true,"uniqueCount":0}'),
      itEvt('2', 3, [listDiag0], '{"done":true,"uniqueCount":0}')
    ];
    assert.equal(detectCountSelectorBlind(events), null);
  });

  it('treats a mixed batch of selectors as blind only when ALL matched 0', () => {
    // Step queries the container ($exists-style count) AND the item selector;
    // container matched >0 while item matched 0 → NOT blind overall — the
    // step CAN see the page, only its item selector is wrong. (That case is
    // surfaced by per-selector diagnostics, not this guard.)
    const containerDiag1 = { api: 'count', selector: 'div[role="feed"]', matchCount: 1 };
    const events = [
      itEvt('2', 1, [containerDiag1, listDiag0], notReady),
      itEvt('2', 2, [containerDiag1, listDiag0], notReady),
      itEvt('2', 3, [containerDiag1, listDiag0], notReady)
    ];
    assert.equal(detectCountSelectorBlind(events), null);
  });

  it('returns null on null / empty / non-array input', () => {
    assert.equal(detectCountSelectorBlind(null), null);
    assert.equal(detectCountSelectorBlind([]), null);
    assert.equal(detectCountSelectorBlind('nope'), null);
  });
});
