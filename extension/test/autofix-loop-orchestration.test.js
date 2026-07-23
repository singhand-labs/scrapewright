const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { scoreAttemptResult, classifyIntervention, planRestoreBestAttempt } = require('../lib/wizard-utils');

// Orchestration inside autoFix() is not directly testable (wizard.js isn't a module,
// and the function calls chrome APIs). Verify the orchestration DECISIONS by feeding
// the same pure helpers the orchestration uses.

const schema = {
  required: ['posts'],
  properties: { posts: { type: 'array', items: { type: 'object', properties: {
    title: { type: 'string' }, author: { type: 'string' }
  } } } }
};

describe('autoFix orchestration decisions (via pure helpers)', () => {
  it('regression scenario: attempt 1 best, attempt 2 zero, attempt 3 partial → restore attempt 1', () => {
    // Simulate the bc1.log regression pattern via scores
    const scores = [
      scoreAttemptResult({ posts: [{ title: 'A', author: 'B' }] }, schema).score,        // attempt 1 (best)
      scoreAttemptResult({ posts: [] }, schema).score,                                  // attempt 2 (broke)
      scoreAttemptResult({ posts: [{ title: 'A' }] }, schema).score                      // attempt 3 (partial)
    ];
    const bestIdx = scores.indexOf(Math.max(...scores));
    assert.equal(bestIdx, 0);  // attempt 1 had highest score
    assert.ok(scores[0] > scores[2]);  // attempt 1 beat attempt 3
  });

  it('classifier breaks early on needs_annotation_relax', () => {
    const intervention = classifyIntervention({
      error: 'EMPTY_EXTRACTION',
      result: { posts: [] },
      outputSchema: schema,
      annotations: [{ selector: 'div[role="article"]:nth-of-type(1) h3' }],
      attemptCount: 1,
      lastError: 'EMPTY_EXTRACTION'
    });
    assert.equal(intervention.type, 'needs_annotation_relax');
    // Orchestration breaks the loop on first hit
  });

  it('planRestoreBestAttempt truncates history correctly on restore', () => {
    const best = { stepId: '2', script: 'best', onSuccess: 'TERMINATE', onFailure: 'TERMINATE', maxIterations: 3, score: 100, attemptNum: 1 };
    const steps = [{ id: '2', name: 'extract', script: 'worst', onSuccess: 'TERMINATE', onFailure: 'TERMINATE', maxIterations: 3 }];
    const history = [
      { role: 'user', content: '[Attempt — step "2" ("extract")]\nbest' },
      { role: 'assistant', content: 'best-script' },
      { role: 'user', content: '[Attempt — step "2" ("extract")]\nbad' },
      { role: 'assistant', content: 'bad-script' }
    ];
    const plan = planRestoreBestAttempt(best, steps, history);
    assert.equal(plan.truncatedHistory.length, 2);
    assert.equal(plan.stepPatch.script, 'best');
  });

  it('happy path: attempt 2 score > attempt 1, no restore needed', () => {
    const score1 = scoreAttemptResult({ posts: [] }, schema).score;
    const score2 = scoreAttemptResult({ posts: [{ title: 'A', author: 'B' }] }, schema).score;
    assert.ok(score2 > score1);
    // Orchestration updates bestAttempt to attempt 2; on exit, currentScore === bestAttempt.score, no restore
  });
});
