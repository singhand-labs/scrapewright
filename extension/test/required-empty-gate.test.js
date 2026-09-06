// Twenty-sixth log: verifies 1-4 all returned ok:true (score 133) while
// posts.postId — an items.required field — was empty in 2/3 records. The ok
// gate was purely !error, so the model's finish summary read "Verified
// green (score 133)" and the user had to resume with feedback to get the
// field fixed. An item-REQUIRED field empty at the same ratio the
// partial-empty detector censuses (>=0.5 of >=2 records) is a contract
// violation, not an advisory: verify must go red and teach both exits
// (fix the extraction, or renegotiate the contract via io.confirm when the
// field genuinely never exists).

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

const SERVICE = { targetUrl: 'https://example.com', steps: [{ id: 's1', name: 'one', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} };

const SCHEMA_REQ_ITEM = {
  type: 'object', required: ['posts'],
  properties: {
    posts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['serialNumber', 'postId', 'content'],
        properties: {
          serialNumber: { type: 'number' },
          postId: { type: 'string' },
          content: { type: 'string' },
          postingTime: { type: 'string' }
        }
      }
    }
  }
};

function orchReturning(posts) {
  return async () => ({
    finalResult: { posts },
    steps: [{ stepId: 's1', stepName: 'one', result: { done: true } }],
    pages: []
  });
}

describe('REQUIRED_FIELD_EMPTY gate (twenty-sixth log)', () => {
  it('items.required field empty in 2/3 records flips ok:false with both-exit teaching', async () => {
    const runner = makeRunner(orchReturning([
      { serialNumber: 1, postId: '123', content: 'a', postingTime: '' },
      { serialNumber: 2, postId: '', content: 'b', postingTime: '' },
      { serialNumber: 3, postId: '', content: 'c', postingTime: '' }
    ]));
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA_REQ_ITEM });
    assert.equal(out.report.ok, false, 'required item field 2/3 empty must not read green');
    assert.match(out.report.error.message, /REQUIRED_FIELD_EMPTY/);
    assert.match(out.report.error.message, /posts\.postId/);
    assert.match(out.report.error.message, /2\/3/);
    assert.match(out.report.error.message, /io\.confirm/, 'must teach the contract-renegotiation exit');
    assert.match(out.report.error.message, /steps\[\]\.resultPreview/, 'twenty-eighth log: point at the pipeline evidence in the report itself');
    assert.ok(out.report.events.includes('PARTIAL_EMPTY_FIELDS'), 'the advisory tag still fires');
    assert.equal(out.report.aborted, false);
  });

  it('OPTIONAL field empty at the same ratio stays advisory-only (ok:true)', async () => {
    const runner = makeRunner(orchReturning([
      { serialNumber: 1, postId: '123', content: 'a', postingTime: 'Jan 8' },
      { serialNumber: 2, postId: '456', content: 'b', postingTime: '' },
      { serialNumber: 3, postId: '789', content: 'c', postingTime: '' }
    ]));
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA_REQ_ITEM });
    assert.equal(out.report.ok, true, 'optional emptiness is disclosed, not fatal');
    assert.equal(out.report.error, null);
    assert.ok(out.report.events.includes('PARTIAL_EMPTY_FIELDS'));
  });

  it('schema without items.required never trips the gate', async () => {
    const schema = {
      type: 'object', required: ['posts'],
      properties: { posts: { type: 'array', items: { type: 'object', properties: { postId: { type: 'string' }, content: { type: 'string' } } } } }
    };
    const runner = makeRunner(orchReturning([
      { postId: '', content: 'a' }, { postId: '', content: 'b' }, { postId: '', content: 'c' }
    ]));
    const out = await runner({ service: SERVICE, input: {}, outputSchema: schema });
    assert.equal(out.report.ok, true, 'no item-level requirement → advisory only');
    assert.equal(out.report.error, null);
  });

  it('empty ratio below the detector threshold keeps ok:true', async () => {
    const runner = makeRunner(orchReturning([
      { serialNumber: 1, postId: '123', content: 'a' },
      { serialNumber: 2, postId: '456', content: 'b' },
      { serialNumber: 3, postId: '', content: 'c' }
    ]));
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA_REQ_ITEM });
    assert.equal(out.report.ok, true, '1/3 empty is under the 0.5 census threshold');
  });

  it('a real orchestration error keeps its own message (no REQUIRED_FIELD_EMPTY overlay)', async () => {
    const orch = async () => { const e = new Error('Step failed: POLL_EXHAUSTED step s1 gave up'); e.stepId = 's1'; throw e; };
    const runner = makeRunner(orch);
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA_REQ_ITEM });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /POLL_EXHAUSTED/);
    assert.doesNotMatch(out.report.error.message, /REQUIRED_FIELD_EMPTY/);
  });

  it('twenty-seventh log: a SINGLE record with a required field empty flips ok:false (no >=2 floor)', async () => {
    // The cold verify tab hydrated one loading-skeleton container; posts had
    // exactly one record with content "" (required) and only postHtml-ish
    // fields populated. The detector's old >=2-record floor made both the
    // advisory signal and this gate blind — verify read GREEN at score 111.
    const runner = makeRunner(orchReturning([
      { serialNumber: 1, postId: '', content: '', postingTime: '' }
    ]));
    const out = await runner({ service: SERVICE, input: {}, outputSchema: SCHEMA_REQ_ITEM });
    assert.equal(out.report.ok, false, 'required field empty in the ONLY record is a contract violation');
    assert.match(out.report.error.message, /REQUIRED_FIELD_EMPTY/);
    assert.match(out.report.error.message, /posts\.(content|postId) is empty in 1\/1/);
    assert.match(out.report.error.message, /io\.confirm/);
  });
});
