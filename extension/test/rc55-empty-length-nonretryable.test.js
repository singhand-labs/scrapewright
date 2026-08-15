// RC55: empty content with finish_reason=length must be NON-RETRYABLE.
//
// FOLLOWUP to RC54 (console.log 2026-08-15 07:35-07:38). The user tested
// maxOutputTokens 8192 AND 16000 — both failed identically on the Round 3
// generateStepsWithSelectors call: HTTP 200, completion_tokens EXACTLY equal
// to the configured cap (8192, then 16000), content length 0,
// finish_reason=length. glm-5.1 (via the Anthropic-compatible proxy,
// claude_messages semantics) consumed the ENTIRE completion budget before
// emitting a single content character — invisible reasoning whose demand
// exceeds the cap. Raising the knob did not help because the burn tracks
// the cap: the task's reasoning demand is above both values.
//
// The signature is deterministic under fixed (prompt, cap):
//   RC52: 4/4 identical empty-length burns at 4096
//   RC54 log: the completed Round 3 attempt burned 8192 identically
//   RC55 log: 2/2 identical empty-length burns at 16000
// Retrying the identical request can never succeed — each retry burns
// another full completion budget (3 x 16000 wasted tokens + minutes of
// wall time in this log alone). The llm-client retry loop kept this class
// retryable since RC52 first documented the determinism; fix that now.
//
// Empty content with OTHER finish reasons (content_filter, stop-with-empty)
// stays retryable — those genuinely are transient under load. And the error
// message must state the effective budget so the user knows which knob
// (Settings maxOutputTokens) to raise.
//
// Context-overflow spellings (model_context_window_exceeded /
// context_length_exceeded) already throw non-retryable LLMContextOverflow —
// this change covers the OTHER length failure: budget exhausted BEFORE any
// content, i.e. finish_reason === 'length' exactly.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { LLMClient } = require('../lib/llm-client');

function mockResponse({ status = 200, body = {}, contentType = 'application/json' }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => name.toLowerCase() === 'content-type' ? contentType : null
    },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function emptyLengthBody(cap) {
  // completion_tokens === cap exactly — the observable burn-to-cap signature
  return {
    choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 20217, completion_tokens: cap, total_tokens: 20217 + cap }
  };
}

function successBody(content = 'ok') {
  return {
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
  };
}

const originalFetch = global.fetch;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

function makeClient(extraConfig = {}) {
  return new LLMClient(Object.assign({
    provider: 'glm',
    model: 'test-model',
    apiKey: 'test-key',
    apiBaseUrl: 'http://test.local/v1'
  }, extraConfig));
}

describe('RC55: empty content + finish_reason=length is non-retryable', () => {
  let calls;

  beforeEach(() => {
    calls = 0;
    global.fetch = async () => {
      calls++;
      return mockResponse({ body: emptyLengthBody(16000) });
    };
    console.log = () => {};
    console.error = () => {};
    console.warn = () => {};
  });

  afterEach(() => {
    global.fetch = originalFetch;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  });

  it('rejects after ONE fetch call (no identical retries)', async () => {
    const client = makeClient({ maxOutputTokens: 16000 });
    await assert.rejects(
      () => client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 3, backoffMs: () => 1 })
    );
    assert.equal(calls, 1,
      'deterministic budget-burn must not be retried — each retry burns another ' +
      'full completion budget (RC55 log: 2x16000 + RC52 log: 4x4096 wasted). Got ' + calls + ' calls');
  });

  it('error is non-retryable and names the effective budget + the Settings knob', async () => {
    const client = makeClient({ maxOutputTokens: 16000 });
    await assert.rejects(
      () => client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 3, backoffMs: () => 1 }),
      (err) => {
        assert.equal(err.retryable, false, 'must be non-retryable');
        assert.ok(err.message.includes('16000'),
          'message must state the effective budget that was burned: ' + err.message);
        assert.match(err.message, /maxOutputTokens/i,
          'message must point at the Settings knob: ' + err.message);
        assert.match(err.message, /deterministic|cannot succeed/i,
          'message must say why retries are skipped: ' + err.message);
        return true;
      }
    );
  });

  it('includes the per-call maxTokens override in the message when used', async () => {
    const client = makeClient({ maxOutputTokens: 16000 });
    await assert.rejects(
      () => client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 0, maxTokens: 12000 }),
      (err) => {
        assert.ok(err.message.includes('12000'),
          'per-call override wins the chain — message must report 12000: ' + err.message);
        return true;
      }
    );
  });

  it('reports the 8192 fallback when no config is set', async () => {
    const client = makeClient();
    await assert.rejects(
      () => client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 0 }),
      (err) => err.message.includes('8192')
    );
  });
});

describe('RC55: other empty-content failures stay retryable', () => {
  let calls;

  beforeEach(() => {
    calls = 0;
    console.log = () => {};
    console.error = () => {};
    console.warn = () => {};
  });

  afterEach(() => {
    global.fetch = originalFetch;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  });

  it('empty content WITHOUT finish_reason=length retries and can succeed', async () => {
    // Transient empty under load (e.g. content_filter or missing finish_reason)
    // is a different class from the deterministic budget burn — keep retrying.
    global.fetch = async () => {
      calls++;
      if (calls < 2) {
        return mockResponse({
          body: {
            choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'content_filter' }],
            usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 }
          }
        });
      }
      return mockResponse({ body: successBody('recovered') });
    };
    const client = makeClient();
    const content = await client.chat(
      [{ role: 'user', content: 'hi' }],
      { maxRetries: 3, backoffMs: () => 1 }
    );
    assert.equal(content, 'recovered');
    assert.equal(calls, 2, 'transient empty must be retried');
  });
});
