const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { classifyIntervention } = require('../lib/wizard-utils');

const schema = {
  required: ['posts'],
  properties: { posts: { type: 'array', items: { type: 'object', properties: {
    title: { type: 'string' }, author: { type: 'string' }
  } } } }
};

describe('classifyIntervention — needs_annotation', () => {
  it('fires when score=0 + no annotations + extraction step', () => {
    const r = classifyIntervention({
      error: 'EMPTY_EXTRACTION', result: { posts: [] }, outputSchema: schema,
      annotations: [], attemptCount: 1, lastError: 'EMPTY_EXTRACTION'
    });
    assert.equal(r.type, 'needs_annotation');
    assert.equal(r.uiAction, 'annotate_step');
  });

  it('does NOT fire when annotations exist (different type)', () => {
    const r = classifyIntervention({
      error: 'EMPTY_EXTRACTION', result: { posts: [] }, outputSchema: schema,
      annotations: [{ selector: 'div' }], attemptCount: 1, lastError: 'EMPTY_EXTRACTION'
    });
    assert.notEqual(r?.type, 'needs_annotation');
  });
});

describe('classifyIntervention — needs_annotation_relax', () => {
  it('fires when annotations exist but score=0 and selector has :nth-of-type', () => {
    const r = classifyIntervention({
      error: 'EMPTY_EXTRACTION', result: { posts: [] }, outputSchema: schema,
      annotations: [{ selector: 'div[role="article"]:nth-of-type(1) h3' }],
      attemptCount: 1, lastError: 'EMPTY_EXTRACTION'
    });
    assert.equal(r.type, 'needs_annotation_relax');
    assert.equal(r.uiAction, 'annotate_step');
  });

  it('does NOT fire when annotations exist but score > 0', () => {
    const r = classifyIntervention({
      error: null, result: { posts: [{ title: 'A', author: 'B' }] }, outputSchema: schema,
      annotations: [{ selector: 'div[role="article"]:nth-of-type(1) h3' }],
      attemptCount: 1, lastError: null
    });
    assert.equal(r, null);
  });
});

describe('classifyIntervention — needs_login', () => {
  it('fires on LOGIN_REQUIRED error', () => {
    const r = classifyIntervention({
      error: 'LOGIN_REQUIRED: please log in', result: null, outputSchema: schema,
      annotations: [], attemptCount: 1, lastError: 'LOGIN_REQUIRED'
    });
    assert.equal(r.type, 'needs_login');
    assert.equal(r.severity, 'error');
  });

  it('does NOT fire on generic error', () => {
    const r = classifyIntervention({
      error: 'ELEMENT_NOT_FOUND', result: null, outputSchema: schema,
      annotations: [], attemptCount: 1, lastError: 'ELEMENT_NOT_FOUND'
    });
    assert.equal(r, null);
  });
});

describe('classifyIntervention — rate_limited', () => {
  it('fires on LLMRetryExhausted with 429 in lastError', () => {
    const r = classifyIntervention({
      error: 'LLMRetryExhausted: failed after 4 attempts', result: null, outputSchema: schema,
      annotations: [], attemptCount: 1,
      lastError: 'LLM API error (429): quota exceeded'
    });
    assert.equal(r.type, 'rate_limited');
    assert.equal(r.uiAction, 'open_settings');
  });

  it('does NOT fire on LLMRetryExhausted without 429', () => {
    const r = classifyIntervention({
      error: 'LLMRetryExhausted: failed after 4 attempts', result: null, outputSchema: schema,
      annotations: [], attemptCount: 1,
      lastError: 'LLM API error (500): internal server error'
    });
    assert.equal(r, null);
  });
});

describe('classifyIntervention — page_state_stale', () => {
  it('fires on attemptCount>=2 + repeated error + old snapshot', () => {
    const r = classifyIntervention({
      error: 'EMPTY_EXTRACTION', result: { posts: [] }, outputSchema: schema,
      annotations: [{ selector: '.post' }],
      attemptCount: 2, lastError: 'EMPTY_EXTRACTION',
      snapshotAgeMs: 120000
    });
    assert.equal(r.type, 'page_state_stale');
    assert.equal(r.uiAction, 'refresh_tab');
  });

  it('does NOT fire on first attempt regardless of staleness', () => {
    const r = classifyIntervention({
      error: 'EMPTY_EXTRACTION', result: { posts: [] }, outputSchema: schema,
      annotations: [{ selector: '.post' }],
      attemptCount: 1, lastError: 'EMPTY_EXTRACTION',
      snapshotAgeMs: 120000
    });
    assert.equal(r, null);
  });
});

describe('classifyIntervention — precedence + safety', () => {
  it('returns null on missing ctx fields', () => {
    assert.equal(classifyIntervention(null), null);
    assert.equal(classifyIntervention({}), null);
    assert.equal(classifyIntervention({ error: 42, result: 'x' }), null);
  });

  it('respects dismissed set', () => {
    const ctx = {
      error: 'LOGIN_REQUIRED', result: null, outputSchema: schema,
      annotations: [], attemptCount: 1, lastError: 'LOGIN_REQUIRED',
      dismissed: new Set(['needs_login'])
    };
    assert.equal(classifyIntervention(ctx), null);
  });

  it('uses bc1.log fixture (nth-of-type annotation, empty extraction)', () => {
    // Real bc1.log annotation shape: user annotated inside one post, selector includes :nth-of-type
    const r = classifyIntervention({
      error: 'EMPTY_EXTRACTION', result: { posts: [] }, outputSchema: schema,
      annotations: [
        { selector: 'div[role="article"]:nth-of-type(1) h3.html-h3 a', outputField: 'posts.title' }
      ],
      attemptCount: 1, lastError: 'EMPTY_EXTRACTION'
    });
    assert.equal(r.type, 'needs_annotation_relax');
  });
});
