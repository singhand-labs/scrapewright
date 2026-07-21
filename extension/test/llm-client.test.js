const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// llm-client.js attaches LLMClient to window when present; under Node it falls
// back to module.exports. Load it in a Node module shape.
const { LLMClient, LLMError, LLMContextOverflow } = require('../lib/llm-client');

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

function successBody(content = 'hello') {
  return {
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
  };
}

const originalFetch = global.fetch;

describe('LLMClient.chat empty-content handling', () => {
  let consoleStub;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;

  beforeEach(() => {
    consoleStub = [];
    console.log = (...args) => consoleStub.push(['log', ...args]);
    console.error = (...args) => consoleStub.push(['error', ...args]);
    console.warn = (...args) => consoleStub.push(['warn', ...args]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
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
      () => client.chat([{ role: 'user', content: 'hi' }], { jsonMode: true, maxRetries: 0 }),
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
      () => client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 0 }),
      (err) => {
        assert.ok(err.message.includes('empty'), 'error should mention empty: ' + err.message);
        assert.ok(err.message.includes('content_filter'), 'error should include finish_reason: ' + err.message);
        return true;
      }
    );
  });

  it('logs finish_reason and usage on every response', async () => {
    global.fetch = async () => mockResponse({ body: successBody('hello') });

    const client = makeClient();
    await client.chat([{ role: 'user', content: 'hi' }]);

    const flat = JSON.stringify(consoleStub);
    assert.match(flat, /finish_reason/, 'should log finish_reason');
    assert.match(flat, /usage/, 'should log usage');
  });

  it('returns content unchanged when non-empty', async () => {
    global.fetch = async () => mockResponse({ body: successBody('{"ok":true}') });

    const client = makeClient();
    const content = await client.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(content, '{"ok":true}');
  });
});

describe('LLMClient.chat context-window overflow', () => {
  let consoleStub;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;

  beforeEach(() => {
    consoleStub = [];
    console.log = (...args) => consoleStub.push(['log', ...args]);
    console.error = (...args) => consoleStub.push(['error', ...args]);
    console.warn = (...args) => consoleStub.push(['warn', ...args]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  });

  function makeClient() {
    return new LLMClient({
      provider: 'glm',
      model: 'glm-5.1',
      apiKey: 'test-key',
      apiBaseUrl: 'http://test.local/v1'
    });
  }

  function overflowBody(finishReason = 'model_context_window_exceeded') {
    return {
      choices: [{ message: { role: 'assistant', content: '' }, finish_reason: finishReason }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };
  }

  it('throws LLMContextOverflow on model_context_window_exceeded', async () => {
    global.fetch = async () => mockResponse({ body: overflowBody() });

    const client = makeClient();
    await assert.rejects(
      () => client.chat([{ role: 'user', content: 'x'.repeat(200000) }], { maxRetries: 3, backoffMs: () => 1 }),
      (err) => {
        assert.equal(err.name, 'LLMContextOverflow', 'should be LLMContextOverflow, got: ' + err.name);
        assert.equal(err.retryable, false, 'overflow must be non-retryable');
        assert.match(err.message, /context window/i, 'message should mention context window');
        return true;
      }
    );
  });

  it('does NOT retry on context overflow (single fetch call)', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return mockResponse({ body: overflowBody() });
    };

    const client = makeClient();
    await assert.rejects(
      () => client.chat([{ role: 'user', content: 'big' }], { maxRetries: 3, backoffMs: () => 1 }),
      (err) => err.name === 'LLMContextOverflow'
    );
    assert.equal(calls, 1, 'should not retry overflow — got ' + calls + ' fetch calls');
  });

  it('also treats context_length_exceeded (OpenAI spelling) as overflow', async () => {
    global.fetch = async () => mockResponse({ body: overflowBody('context_length_exceeded') });

    const client = makeClient();
    await assert.rejects(
      () => client.chat([{ role: 'user', content: 'big' }], { maxRetries: 3, backoffMs: () => 1 }),
      (err) => {
        assert.equal(err.name, 'LLMContextOverflow');
        return true;
      }
    );
  });

  it('attaches detail with finish_reason and usage on overflow', async () => {
    global.fetch = async () => mockResponse({ body: overflowBody() });

    const client = makeClient();
    await assert.rejects(
      () => client.chat([{ role: 'user', content: 'big' }], { maxRetries: 0 }),
      (err) => {
        assert.ok(err.detail, 'detail should be attached');
        assert.equal(err.detail.finish_reason, 'model_context_window_exceeded');
        assert.ok(err.detail.usage, 'usage should be in detail');
        return true;
      }
    );
  });
});

describe('LLMClient.chat retry behavior', () => {
  let consoleStub;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;

  beforeEach(() => {
    consoleStub = [];
    console.log = (...args) => consoleStub.push(['log', ...args]);
    console.error = (...args) => consoleStub.push(['error', ...args]);
    console.warn = (...args) => consoleStub.push(['warn', ...args]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  });

  function makeClient() {
    return new LLMClient({
      provider: 'openai',
      model: 'test-model',
      apiKey: 'test-key',
      apiBaseUrl: 'http://test.local/v1'
    });
  }

  // Fast backoff so retry tests don't actually wait.
  const fastBackoff = () => 1;

  it('retries on HTTP 429 then succeeds', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls < 2) return mockResponse({ status: 429, body: { error: { message: 'Rate limit' } } });
      return mockResponse({ body: successBody('{"ok":true}') });
    };

    const client = makeClient();
    const content = await client.chat(
      [{ role: 'user', content: 'hi' }],
      { maxRetries: 3, backoffMs: fastBackoff }
    );
    assert.equal(content, '{"ok":true}');
    assert.equal(calls, 2, 'should have retried once');
  });

  it('retries on HTTP 503 then succeeds', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls < 2) return mockResponse({ status: 503, body: { error: { message: 'Service unavailable' } } });
      return mockResponse({ body: successBody('ok') });
    };

    const client = makeClient();
    const content = await client.chat(
      [{ role: 'user', content: 'hi' }],
      { maxRetries: 3, backoffMs: fastBackoff }
    );
    assert.equal(content, 'ok');
    assert.equal(calls, 2);
  });

  it('retries on network error then succeeds', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls < 2) throw new Error('ECONNRESET');
      return mockResponse({ body: successBody('ok') });
    };

    const client = makeClient();
    const content = await client.chat(
      [{ role: 'user', content: 'hi' }],
      { maxRetries: 3, backoffMs: fastBackoff }
    );
    assert.equal(content, 'ok');
    assert.equal(calls, 2);
  });

  it('retries on empty content then succeeds', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls < 2) return mockResponse({
        body: {
          choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 }
        }
      });
      return mockResponse({ body: successBody('ok') });
    };

    const client = makeClient();
    const content = await client.chat(
      [{ role: 'user', content: 'hi' }],
      { maxRetries: 3, backoffMs: fastBackoff }
    );
    assert.equal(content, 'ok');
    assert.equal(calls, 2);
  });

  it('does NOT retry on HTTP 401 (auth error)', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return mockResponse({ status: 401, body: { error: { message: 'Invalid API key' } } });
    };

    const client = makeClient();
    await assert.rejects(
      () => client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 3, backoffMs: fastBackoff }),
      (err) => err.message.includes('auth failed') || err.message.includes('401')
    );
    assert.equal(calls, 1, 'should not retry auth errors');
  });

  it('does NOT retry on HTTP 400 (bad request)', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return mockResponse({ status: 400, body: { error: { message: 'Bad model' } } });
    };

    const client = makeClient();
    await assert.rejects(
      () => client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 3, backoffMs: fastBackoff })
    );
    assert.equal(calls, 1, 'should not retry 400 errors');
  });

  it('exhausts retries on persistent 429 then throws summary error', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return mockResponse({ status: 429, body: { error: { message: 'Rate limit' } } });
    };

    const client = makeClient();
    await assert.rejects(
      () => client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 3, backoffMs: fastBackoff }),
      (err) => {
        assert.match(err.message, /4 attempts/, 'should mention attempt count: ' + err.message);
        assert.match(err.message, /Rate limit|429/, 'should include underlying error: ' + err.message);
        return true;
      }
    );
    assert.equal(calls, 4, 'should have attempted 1 + 3 retries');
  });

  it('respects custom maxRetries option', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return mockResponse({ status: 503, body: { error: { message: 'down' } } });
    };

    const client = makeClient();
    await assert.rejects(
      () => client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 1, backoffMs: fastBackoff })
    );
    assert.equal(calls, 2, 'should attempt initial + 1 retry');
  });

  it('uses exponential backoff between retries', async () => {
    const delays = [];
    const originalSetTimeout = setTimeout;
    global.setTimeout = (fn, ms) => {
      delays.push(ms);
      return originalSetTimeout(fn, 0); // don't actually wait
    };
    try {
      global.fetch = async () => mockResponse({ status: 429, body: { error: { message: 'Rate limit' } } });
      const client = makeClient();
      await assert.rejects(
        () => client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 3 })
      );
      // Filter out the AbortController timer (timeoutMs defaults to 60000).
      const backoffDelays = delays.filter(d => d < 10000);
      assert.equal(backoffDelays.length, 3, 'should back off 3 times (before each retry); raw delays: ' + JSON.stringify(delays));
      // Default backoff: 1000, 2000, 4000 (each + 0-499 jitter)
      assert.ok(backoffDelays[0] >= 1000 && backoffDelays[0] < 1500, 'first backoff ~1000ms: ' + backoffDelays[0]);
      assert.ok(backoffDelays[1] >= 2000 && backoffDelays[1] < 2500, 'second backoff ~2000ms: ' + backoffDelays[1]);
      assert.ok(backoffDelays[2] >= 4000 && backoffDelays[2] < 4500, 'third backoff ~4000ms: ' + backoffDelays[2]);
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  it('logs retry warnings during retries', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls < 2) return mockResponse({ status: 429, body: { error: { message: 'Rate limit' } } });
      return mockResponse({ body: successBody('ok') });
    };

    const client = makeClient();
    await client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 3, backoffMs: fastBackoff });

    const flat = JSON.stringify(consoleStub);
    assert.match(flat, /Attempt 1 failed/, 'should log first attempt failure');
    assert.match(flat, /retrying/i, 'should log retry intent');
  });
});
