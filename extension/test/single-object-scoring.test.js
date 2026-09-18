// extension/test/single-object-scoring.test.js
// Seventy-eighth log: a single-object output contract ({answer,question,...},
// no top-level array) verified ok:true with score 0 / requiredCoverage 0 /
// listItemCount 0 on real data — the scoring + census machinery was
// list-oriented and went blind on the single-record shape.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createVerifyRunner } = require('../lib/verify-runner');

function makeRunner(orchestrate) {
  const deps = {
    orchestrate,
    ensureLock: async () => {},
    getSignal: () => null,
    log: () => {},
    onEvent: () => {},
    createTab: async (url) => ({ id: 11, url }),
    removeTab: async () => {},
    waitForTabLoad: async () => {},
    sendMessage: async () => ({ pong: true }),
    executeScript: async () => ({ result: 'ok', selectorDiagnostics: [] }),
    captureSnapshot: async () => ({ html: '<html></html>' }),
    evaluateCondition: async () => true
  };
  return createVerifyRunner(deps);
}

const SERVICE = { targetUrl: 'https://example.com/q', steps: [{ id: 's1', name: 'one', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} };
const SCHEMA = {
  type: 'object',
  required: ['answer', 'question', 'thinking'],
  properties: {
    answer: { type: 'string' },
    question: { type: 'string' },
    thinking: { type: 'string' },
    timestamp: { type: 'string' }
  }
};

function runFor(finalResult) {
  const orch = async (svc, input, d, opts) => {
    opts.onEvent({ type: 'STEP_ITERATION', stepId: 's1', iteration: 1, resultPreview: JSON.stringify(finalResult).slice(0, 120) });
    return { finalResult, steps: [{ stepId: 's1', stepName: 'one', result: { done: true }, snapshot: null }], pages: [], pagesTruncated: false };
  };
  return makeRunner(orch)({ service: SERVICE, input: {}, outputSchema: SCHEMA });
}

describe('single-object output scoring (seventy-eighth log)', () => {
  it('populated single object: score > 0, requiredCoverage 1, listItemCount 1, isData true, ok green', async () => {
    const out = await runFor({ answer: 'a real answer', question: 'the question', thinking: 'chain', timestamp: '' });
    const r = out.report;
    assert.equal(r.ok, true, 'green: required keys all non-empty');
    assert.equal(r.error, null);
    assert.equal(r.score.isData, true);
    assert.ok(r.score.score > 0, 'score reflects present data, got ' + r.score.score);
    assert.equal(r.score.breakdown.requiredCoverage, 1, '3/3 required keys non-empty');
    assert.equal(r.score.breakdown.listItemCount, 1, 'the object itself is the one record');
    assert.ok(!r.events.includes('REQUIRED_FIELD_EMPTY'));
  });

  it('missing required key: REQUIRED_FIELD_EMPTY red naming the key, requiredCoverage < 1', async () => {
    const out = await runFor({ answer: '', question: 'q', thinking: 't', timestamp: '' });
    const r = out.report;
    assert.equal(r.ok, false, 'empty required key flips the run red');
    assert.match(String(r.error && r.error.message), /REQUIRED_FIELD_EMPTY/);
    assert.match(String(r.error && r.error.message), /answer/, 'error names the empty required key');
    assert.ok(r.score.breakdown.requiredCoverage < 1, 'coverage 2/3 not 1');
    assert.ok(r.events.includes('REQUIRED_FIELD_EMPTY'));
  });

  it('array-based scoring unchanged: list service still scores via list metrics', async () => {
    const WU = require('../lib/wizard-utils');
    const score = WU.scoreAttemptResult(
      { posts: [{ a: 1 }, { a: 2 }] },
      { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { properties: { a: {} } } } } }
    );
    assert.equal(score.breakdown.listItemCount, 2);
    assert.equal(score.breakdown.requiredCoverage, 1);
    assert.ok(score.score >= 120);
  });

  it('scoreAttemptResult pure-function: single-object contract scores data-present result', () => {
    const WU = require('../lib/wizard-utils');
    const score = WU.scoreAttemptResult({ answer: 'x', question: 'q', thinking: 't', timestamp: '' }, SCHEMA);
    assert.equal(score.isData, true);
    assert.equal(score.breakdown.requiredCoverage, 1);
    assert.equal(score.breakdown.listItemCount, 1);
    assert.ok(score.score >= 100 + 10, 'coverage*100 + count*10 at minimum');
    // fully-empty object: no list credit, coverage 0
    const empty = WU.scoreAttemptResult({ answer: '', question: '', thinking: '', timestamp: '' }, SCHEMA);
    assert.equal(empty.breakdown.requiredCoverage, 0);
    assert.equal(empty.breakdown.listItemCount, 0);
  });

  it('detectEmptyOutputFieldsByRatio censuses single-object shape (was: zero entries)', () => {
    const WU = require('../lib/wizard-utils');
    const pe = WU.detectEmptyOutputFieldsByRatio({ answer: '', question: 'q', thinking: 't' }, SCHEMA);
    const fields = pe.map((e) => e.field);
    assert.ok(fields.includes('answer'), 'empty key censused, got ' + JSON.stringify(fields));
    assert.ok(!fields.includes('question'), 'non-empty key not censused');
    const answerEntry = pe.filter((e) => e.field === 'answer')[0];
    assert.equal(answerEntry.path, 'answer');
    assert.equal(answerEntry.totalCount, 1);
  });

  it('schemaItemRequiredForPath resolves a single-segment path against the root required array', () => {
    const WU = require('../lib/wizard-utils');
    const req = WU.schemaItemRequiredForPath(SCHEMA, 'answer');
    assert.deepEqual(req, ['answer', 'question', 'thinking']);
    // array-typed key with a single-segment path keeps the old null
    const listSchema = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { required: ['a'], properties: { a: {} } } } } };
    assert.equal(WU.schemaItemRequiredForPath(listSchema, 'posts'), null);
  });
});
