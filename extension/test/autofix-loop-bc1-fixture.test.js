const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { scoreAttemptResult } = require('../lib/wizard-utils');
// classifyIntervention / planRestoreBestAttempt were removed with the
// wizard-time autoFix flow (ResearchSession migration); only the scoring
// fixture half of this regression survives.

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

  
  
  });
