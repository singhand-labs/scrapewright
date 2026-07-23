const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { planRestoreBestAttempt } = require('../lib/wizard-utils');

describe('planRestoreBestAttempt', () => {
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

  it('returns stepPatch with script + flow fields', () => {
    const steps = [{ id: '2', name: 'extract', script: 'current-bad-script', onSuccess: '3', onFailure: 'TERMINATE', maxIterations: 1 }];
    const r = planRestoreBestAttempt(best, steps, []);
    assert.equal(r.stepId, '2');
    assert.equal(r.stepPatch.script, best.script);
    assert.equal(r.stepPatch.onSuccess, 'TERMINATE');
    assert.equal(r.stepPatch.onFailure, 'TERMINATE');
    assert.equal(r.stepPatch.maxIterations, 3);
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
