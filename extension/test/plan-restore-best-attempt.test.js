// Regression tests for planRestoreBestAttempt.
//
// RC11 (console.log 2026-07-26 14:49:08): the previous gate on
// wizardState.lastErrorStepId broke bestAttempt tracking on the user-feedback
// path. The fix snapshots ALL steps so multi-step RETURN_FORMAT_FEEDBACK
// patches can be rolled back atomically. The function now always returns
// { stepPatches: [...], truncatedHistory, logMessage } regardless of input
// shape — single-step legacy inputs produce a 1-element stepPatches array.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { planRestoreBestAttempt } = require('../lib/wizard-utils');

describe('planRestoreBestAttempt (legacy single-step shape)', () => {
  const best = {
    stepId: '2',
    script: 'return { posts: await $extractList("div[role=article]", {title:".t"}); }',
    onSuccess: 'TERMINATE',
    onFailure: 'TERMINATE',
    maxIterations: 3,
    score: 125,
    attemptNum: 1
  };

  it('returns null when target step no longer exists', () => {
    const steps = [{ id: '1', name: 'other' }];
    const r = planRestoreBestAttempt(best, steps, []);
    assert.equal(r, null);
  });

  it('returns stepPatches[0] with script + flow fields', () => {
    const steps = [{ id: '2', name: 'extract', script: 'current-bad-script', onSuccess: '3', onFailure: 'TERMINATE', maxIterations: 1 }];
    const r = planRestoreBestAttempt(best, steps, []);
    assert.ok(Array.isArray(r.stepPatches));
    assert.equal(r.stepPatches.length, 1);
    assert.equal(r.stepPatches[0].id, '2');
    assert.equal(r.stepPatches[0].stepPatch.script, best.script);
    assert.equal(r.stepPatches[0].stepPatch.onSuccess, 'TERMINATE');
    assert.equal(r.stepPatches[0].stepPatch.onFailure, 'TERMINATE');
    assert.equal(r.stepPatches[0].stepPatch.maxIterations, 3);
  });

  it('truncates llmHistory to best attempt boundary', () => {
    const steps = [{ id: '2', name: 'extract', script: 'x', onSuccess: 'TERMINATE', onFailure: 'TERMINATE', maxIterations: 1 }];
    const llmHistory = [
      { role: 'user', content: '[Attempt — step "2" ("extract")]\nScript tried:\nbest' },
      { role: 'assistant', content: '// ACK\nbest-script' },
      { role: 'user', content: '[Attempt — step "2" ("extract")]\nScript tried:\nbad1' },
      { role: 'assistant', content: 'bad1-script' },
      { role: 'user', content: '[Attempt — step "2" ("extract")]\nScript tried:\nbad2' },
      { role: 'assistant', content: 'bad2-script' }
    ];
    const r = planRestoreBestAttempt(best, steps, llmHistory);
    assert.equal(r.truncatedHistory.length, 2);
    assert.equal(r.truncatedHistory[0].content, llmHistory[0].content);
    assert.equal(r.truncatedHistory[1].content, llmHistory[1].content);
  });

  it('leaves llmHistory unchanged when best attempt marker not found', () => {
    const steps = [{ id: '2', name: 'extract', script: 'x', onSuccess: 'TERMINATE', onFailure: 'TERMINATE', maxIterations: 1 }];
    const llmHistory = [
      { role: 'user', content: 'unrelated' },
      { role: 'assistant', content: 'unrelated reply' }
    ];
    const r = planRestoreBestAttempt(best, steps, llmHistory);
    assert.equal(r.truncatedHistory.length, 2);
    assert.equal(r.truncatedHistory, llmHistory);
  });

  it('includes restore log message', () => {
    const steps = [{ id: '2', name: 'extract', script: 'x', onSuccess: 'TERMINATE', onFailure: 'TERMINATE', maxIterations: 1 }];
    const r = planRestoreBestAttempt(best, steps, []);
    assert.match(r.logMessage, /Restored attempt #1/);
    assert.match(r.logMessage, /125/);
  });
});

describe('planRestoreBestAttempt (RC11 multi-step shape — user-feedback path)', () => {
  // The user-feedback path emits historyMarker `[Attempt — step "null"]`
  // because runFixIteration calls summarizeFixIteration with stepId=null
  // (targetStep is null when lastErrorStepId is null). The legacy
  // marker-matching would look for the literal "null" and miss; the new
  // bestAttempt.historyMarker captures the exact string to match.
  const bestMulti = {
    stepsSnapshot: [
      { id: '2', name: 'scroll', script: 'return await $scrollToBottom();', onSuccess: '3', onFailure: 'TERMINATE', maxIterations: 10 },
      { id: '3', name: 'extract', script: 'return await $extractList(\'div.post\', {title:\'h2\'});', onSuccess: '4', onFailure: 'TERMINATE', maxIterations: 1 },
      { id: '4', name: 'finalize', script: 'return {posts: __lastResult__};', onSuccess: 'TERMINATE', onFailure: 'TERMINATE', maxIterations: 1 }
    ],
    historyMarker: '[Attempt — step "null"',
    score: 380,
    attemptNum: 1,
    breakdown: { requiredCoverage: 1, listItemCount: 8, avgFieldsPerItem: 4 }
  };

  it('returns patches for ALL snapshotted steps that still exist', () => {
    const steps = [
      { id: '2', name: 'scroll', script: 'BAD-SCROLL', onSuccess: 'X', onFailure: 'TERMINATE', maxIterations: 1 },
      { id: '3', name: 'extract', script: 'BAD-EXTRACT', onSuccess: 'X', onFailure: 'TERMINATE', maxIterations: 1 },
      { id: '4', name: 'finalize', script: 'BAD-FINALIZE', onSuccess: 'X', onFailure: 'TERMINATE', maxIterations: 1 }
    ];
    const r = planRestoreBestAttempt(bestMulti, steps, []);
    assert.ok(Array.isArray(r.stepPatches));
    assert.equal(r.stepPatches.length, 3);
    const byId = Object.fromEntries(r.stepPatches.map(p => [p.id, p.stepPatch]));
    assert.equal(byId['2'].script, 'return await $scrollToBottom();');
    assert.equal(byId['3'].script, 'return await $extractList(\'div.post\', {title:\'h2\'});');
    assert.equal(byId['4'].script, 'return {posts: __lastResult__};');
    // Flow fields restored too
    assert.equal(byId['2'].maxIterations, 10);
    assert.equal(byId['3'].onSuccess, '4');
  });

  it('skips snapshots for steps removed from the current workflow without failing', () => {
    // Topology changes (step 4 removed) must not block restore — the surviving
    // steps still need to be rolled back. (Topology changes route through
    // removeStepWithRelink / appendStepWithChainLink, so the snapshot's edge
    // data is already stale; the restore just reverts the surviving scripts.)
    const steps = [
      { id: '2', name: 'scroll', script: 'BAD', onSuccess: '3', onFailure: 'TERMINATE', maxIterations: 1 },
      { id: '3', name: 'extract', script: 'BAD', onSuccess: 'TERMINATE', onFailure: 'TERMINATE', maxIterations: 1 }
      // step '4' deliberately missing — finalize was removed
    ];
    const r = planRestoreBestAttempt(bestMulti, steps, []);
    assert.ok(r);
    assert.equal(r.stepPatches.length, 2);
    const ids = r.stepPatches.map(p => p.id).sort();
    assert.deepEqual(ids, ['2', '3']);
  });

  it('returns null when no snapshot ids match current steps', () => {
    const steps = [
      { id: 'X', name: 'unrelated', script: '', onSuccess: 'TERMINATE', onFailure: 'TERMINATE', maxIterations: 1 }
    ];
    const r = planRestoreBestAttempt(bestMulti, steps, []);
    assert.equal(r, null);
  });

  it('truncates llmHistory using the explicit historyMarker (handles "null" stepId)', () => {
    // RC11: the user-feedback path emits markers like `[Attempt — step "null" ("(user feedback — no single target step)")]`.
    // The legacy path that constructed markers from bestAttempt.stepId would
    // produce `[Attempt — step "2"` or `[Attempt — step "undefined"` — neither
    // matches the real marker. bestAttempt.historyMarker must be honored.
    const steps = [
      { id: '2', name: 'scroll', script: 'x', onSuccess: '3', onFailure: 'TERMINATE', maxIterations: 1 }
    ];
    const llmHistory = [
      { role: 'user', content: '[Attempt — step "null" ("(user feedback — no single target step)")]\nScript tried:\nbest-multi-step-fix' },
      { role: 'assistant', content: 'best-multi-step-fix-output' },
      { role: 'user', content: '[Attempt — step "null" ("(user feedback — no single target step)")]\nScript tried:\nregression' },
      { role: 'assistant', content: 'regression-output' }
    ];
    const r = planRestoreBestAttempt(bestMulti, steps, llmHistory);
    assert.equal(r.truncatedHistory.length, 2);
    assert.equal(r.truncatedHistory[0].content, llmHistory[0].content);
    assert.equal(r.truncatedHistory[1].content, llmHistory[1].content);
  });

  it('includes score in log message', () => {
    const steps = [
      { id: '2', name: 'scroll', script: 'x', onSuccess: '3', onFailure: 'TERMINATE', maxIterations: 1 }
    ];
    const r = planRestoreBestAttempt(bestMulti, steps, []);
    assert.match(r.logMessage, /380/);
  });
});
