const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// llm-client.js attaches LLMClient to window when present; under Node it falls
// back to module.exports. Load it in a Node module shape.
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

const originalFetch = global.fetch;

describe('LLMClient.chat empty-content handling', () => {
  let consoleStub;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;

  beforeEach(() => {
    consoleStub = [];
    console.log = (...args) => consoleStub.push(['log', ...args]);
    console.error = (...args) => consoleStub.push(['error', ...args]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  function makeClient() {
    return new LLMClient({
      provider: 'openai',
      model: 'test-model',
      apiKey: 'test-key',
      apiBaseUrl: 'http://test.local/v1'
    });
  }

  it('throws a clear error when choices[0].message.content is empty', async () => {
    global.fetch = async () => mockResponse({
      body: {
        id: 'x', model: 'test-model', object: 'chat.completion', created: 1,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '' },
          finish_reason: 'length'
        }],
        usage: { prompt_tokens: 5000, completion_tokens: 0, total_tokens: 5000 }
      }
    });

    const client = makeClient();
    await assert.rejects(
      () => client.chat([{ role: 'user', content: 'hi' }], { jsonMode: true }),
      (err) => {
        assert.ok(err.message.includes('empty'), 'error should mention empty: ' + err.message);
        assert.ok(err.message.includes('length'), 'error should include finish_reason: ' + err.message);
        return true;
      }
    );
  });

  it('throws a clear error when content is whitespace-only', async () => {
    global.fetch = async () => mockResponse({
      body: {
        choices: [{ message: { role: 'assistant', content: '   \n  ' }, finish_reason: 'content_filter' }],
        usage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 }
      }
    });

    const client = makeClient();
    await assert.rejects(
      () => client.chat([{ role: 'user', content: 'hi' }]),
      (err) => {
        assert.ok(err.message.includes('empty'), 'error should mention empty: ' + err.message);
        assert.ok(err.message.includes('content_filter'), 'error should include finish_reason: ' + err.message);
        return true;
      }
    );
  });

  it('logs finish_reason and usage on every response', async () => {
    global.fetch = async () => mockResponse({
      body: {
        choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
      }
    });

    const client = makeClient();
    await client.chat([{ role: 'user', content: 'hi' }]);

    const flat = JSON.stringify(consoleStub);
    assert.match(flat, /finish_reason/, 'should log finish_reason');
    assert.match(flat, /usage/, 'should log usage');
  });

  it('returns content unchanged when non-empty', async () => {
    global.fetch = async () => mockResponse({
      body: {
        choices: [{ message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }
      }
    });

    const client = makeClient();
    const content = await client.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(content, '{"ok":true}');
  });
});
