const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { scoreAttemptResult, classifyIntervention, planRestoreBestAttempt } = require('../lib/wizard-utils');

// Reproduces the bc1.log scenario: 3 autoFix iterations on a Facebook search
// extraction, annotations present with :nth-of-type, scores regress across attempts.

const schema = {
  required: ['posts'],
  properties: { posts: { type: 'array', items: { type: 'object', properties: {
    title: { type: 'string' }, author: { type: 'string' }, date: { type: 'string' }
  } } } }
};

const bc1Annotations = [
  // Real bc1.log shape — annotation on the first post with nth-of-type path
  { selector: 'div[role="article"]:nth-of-type(1) h3.html-h3 a', outputField: 'posts.title' },
  { selector: 'div[role="article"]:nth-of-type(1) a[role="link"].xjp7ctv', outputField: 'posts.author' }
];

describe('bc1.log regression fixture', () => {
  it('attempt 1 (user-feedback path) scored higher than attempt 3 (silent retry)', () => {
    // bc1.log iteration 1: LLM followed user hint, got 3 posts with partial fields
    const attempt1 = scoreAttemptResult({
      posts: [
        { title: 'Post A', author: 'User1', date: '' },
        { title: 'Post B', author: 'User2', date: '' },
        { title: 'Post C', author: 'User3', date: '' }
      ]
    }, schema);
    // bc1.log iteration 2: LLM rewrote selector too aggressively, lost list
    const attempt2 = scoreAttemptResult({ posts: [] }, schema);
    // bc1.log iteration 3: LLM half-recovered, got 1 post with title only
    const attempt3 = scoreAttemptResult({
      posts: [{ title: 'Post A', author: '', date: '' }]
    }, schema);

    assert.ok(attempt1.score > attempt3.score, `attempt 1 (${attempt1.score}) should beat attempt 3 (${attempt3.score})`);
    assert.ok(attempt1.score > attempt2.score);
    assert.ok(attempt3.score > attempt2.score);
  });

  it('classifier fires needs_annotation_relax when annotations present but listCount=0', () => {
    const intervention = classifyIntervention({
      error: 'EMPTY_EXTRACTION',
      result: { posts: [] },
      outputSchema: schema,
      annotations: bc1Annotations,
      attemptCount: 1,
      lastError: 'EMPTY_EXTRACTION'
    });
    assert.equal(intervention.type, 'needs_annotation_relax');
    assert.equal(intervention.uiAction, 'annotate_step');
  });

  it('planRestoreBestAttempt restores attempt 1 + truncates history to attempt 1 boundary', () => {
    const best = {
      stepId: '4', script: 'attempt1-script', onSuccess: 'TERMINATE', onFailure: 'TERMINATE',
      maxIterations: 3, score: 100, attemptNum: 1
    };
    const steps = [{ id: '4', name: 'extract_posts', script: 'attempt3-script', onSuccess: 'TERMINATE', onFailure: 'TERMINATE', maxIterations: 3 }];
    const history = [
      { role: 'user', content: '[Attempt — step "4" ("extract_posts")]\nScript tried:\nattempt1' },
      { role: 'assistant', content: '// ACK: use role=article\nattempt1-script' },
      { role: 'user', content: '[Attempt — step "4" ("extract_posts")]\nScript tried:\nattempt2' },
      { role: 'assistant', content: 'attempt2-script' },
      { role: 'user', content: '[Attempt — step "4" ("extract_posts")]\nScript tried:\nattempt3' },
      { role: 'assistant', content: 'attempt3-script' }
    ];
    const plan = planRestoreBestAttempt(best, steps, history);
    assert.equal(plan.stepPatch.script, 'attempt1-script');
    assert.equal(plan.truncatedHistory.length, 2);
    assert.equal(plan.truncatedHistory[0].content, history[0].content);
  });

  it('classifier does NOT fire needs_annotation_relax when score > 0 (annotations working)', () => {
    const intervention = classifyIntervention({
      error: null,
      result: { posts: [{ title: 'A', author: 'B', date: 'C' }] },
      outputSchema: schema,
      annotations: bc1Annotations,
      attemptCount: 1,
      lastError: null
    });
    assert.equal(intervention, null);
  });
});
