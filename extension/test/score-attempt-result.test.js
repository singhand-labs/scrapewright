const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { scoreAttemptResult } = require('../lib/wizard-utils');

describe('scoreAttemptResult', () => {
  it('returns score=0 isData=false for null result', () => {
    const r = scoreAttemptResult(null, { required: ['posts'] });
    assert.equal(r.score, 0);
    assert.equal(r.isData, false);
  });

  it('returns score=0 isData=false when outputSchema is missing', () => {
    const r = scoreAttemptResult({ posts: [] }, null);
    assert.equal(r.score, 0);
    assert.equal(r.isData, false);
  });

  it('scores full list extraction at 125 (1 required array + 3 inner fields)', () => {
    const schema = {
      required: ['posts'],
      properties: { posts: { type: 'array', items: { type: 'object', properties: {
        title: { type: 'string' }, author: { type: 'string' }, date: { type: 'string' }
      } } } }
    };
    const result = { posts: [
      { title: 'A', author: 'Bob', date: '2024' },
      { title: 'B', author: 'Cara', date: '2024' }
    ] };
    const r = scoreAttemptResult(result, schema);
    // requiredCoverage=1 (100) + listItemCount=2 (20) + avgFieldsPerItem=1.0 (5) = 125
    assert.equal(r.score, 125);
    assert.equal(r.isData, true);
    assert.equal(r.breakdown.requiredCoverage, 1);
    assert.equal(r.breakdown.listItemCount, 2);
    assert.equal(r.breakdown.avgFieldsPerItem, 1);
  });

  it('scores partial fill proportionally', () => {
    const schema = {
      required: ['posts'],
      properties: { posts: { type: 'array', items: { type: 'object', properties: {
        title: { type: 'string' }, author: { type: 'string' }, date: { type: 'string' }
      } } } }
    };
    const result = { posts: [{ title: 'A', author: '', date: '' }] };
    const r = scoreAttemptResult(result, schema);
    // requiredCoverage=1 (array non-empty) → 100, listItemCount=1 → 10, avgFieldsPerItem=1/3 → 1.67
    assert.equal(r.breakdown.requiredCoverage, 1);
    assert.equal(r.breakdown.listItemCount, 1);
    assert.ok(Math.abs(r.breakdown.avgFieldsPerItem - 1/3) < 0.01);
    assert.ok(Math.abs(r.score - (100 + 10 + 5/3)) < 0.1);
  });

  it('scores empty list extraction at 0', () => {
    const schema = { required: ['posts'], properties: { posts: { type: 'array' } } };
    const r = scoreAttemptResult({ posts: [] }, schema);
    assert.equal(r.score, 0);
    assert.equal(r.isData, true);
  });

  it('handles scalar required field (no array)', () => {
    const schema = { required: ['title'], properties: { title: { type: 'string' } } };
    const r = scoreAttemptResult({ title: 'hello' }, schema);
    // requiredCoverage=1 → 100, no array → listItemCount=0, avgFieldsPerItem=0
    assert.equal(r.score, 100);
    assert.equal(r.isData, true);
  });

  it('handles missing required field', () => {
    const schema = { required: ['title'], properties: { title: { type: 'string' } } };
    const r = scoreAttemptResult({}, schema);
    assert.equal(r.score, 0);
    assert.equal(r.breakdown.requiredCoverage, 0);
  });

  it('treats empty array as not-satisfying required', () => {
    const schema = { required: ['posts'], properties: { posts: { type: 'array' } } };
    const r = scoreAttemptResult({ posts: [] }, schema);
    assert.equal(r.breakdown.requiredCoverage, 0);
  });

  it('returns score=0 isData=false on circular reference (no throw)', () => {
    const circular = {};
    circular.self = circular;
    const r = scoreAttemptResult(circular, { required: ['x'] });
    assert.equal(r.score, 0);
    assert.equal(r.isData, false);
  });

  it('handles outputSchema.required empty array', () => {
    const schema = { required: [], properties: {} };
    const r = scoreAttemptResult({ foo: 'bar' }, schema);
    assert.equal(r.isData, true);
    assert.equal(r.breakdown.requiredCoverage, 0);
  });

  it('handles result that is a primitive string', () => {
    const r = scoreAttemptResult('hello', { required: ['title'] });
    assert.equal(r.score, 0);
    assert.equal(r.isData, false);
  });
});
