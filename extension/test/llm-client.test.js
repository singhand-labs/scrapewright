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

  // Thirty-fourth log: Zhipu reports a PERMANENT billing condition via 429
  // ("Insufficient balance or no resource package. Please recharge." — four
  // identical attempts in the live log). Status-only classification burned the
  // full 10-retry budget (~63s) on every call, and the restate modal's retry
  // notes made a terminal condition read like a transient hiccup.
  it('balance-class 429 fails fast: non-retryable, actionable, exactly one request', async () => {
    let calls = 0;
    let onRetryCalls = 0;
    global.fetch = async () => {
      calls++;
      return mockResponse({
        status: 429,
        body: { error: { message: 'Insufficient balance or no resource package. Please recharge.' } }
      });
    };

    const client = makeClient();
    await assert.rejects(
      client.chat(
        [{ role: 'user', content: 'hi' }],
        { maxRetries: 3, backoffMs: fastBackoff, onRetry: () => { onRetryCalls++; } }
      ),
      (err) => {
        assert.equal(err.name, 'LLMError', 'not wrapped in LLMRetryExhausted');
        assert.equal(err.retryable, false, 'billing condition is deterministic');
        assert.match(err.message, /Insufficient balance or no resource package/, 'provider detail preserved');
        assert.match(err.message, /recharge|resource package/i, 'actionable: name the remedy');
        assert.match(err.message, /no retry was attempted|deterministic|cannot fix/i, 'says why there was no retry');
        return true;
      }
    );
    assert.equal(calls, 1, 'must not retry a deterministic billing failure');
    assert.equal(onRetryCalls, 0, 'onRetry never fires');
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
          // RC55: finish_reason='length' + empty is now NON-retryable
          // (deterministic budget burn). This test covers TRANSIENT empty —
          // no finish_reason — which must keep retrying.
          choices: [{ message: { role: 'assistant', content: '' } }],
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

  it('nineteenth log: DEFAULT_MAX_RETRIES is 10 (429 storms must not kill a session in 4 attempts)', async () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'llm-client.js'), 'utf8');
    assert.match(src, /const DEFAULT_MAX_RETRIES = 10;/,
      'user directive: LLM call failures retry up to 10 times with intervals');
  });

  it('nineteenth log: onRetry fires before each backoff sleep with attempt/maxRetries/wait/error', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls < 3) return mockResponse({ status: 429, body: { error: { message: 'Rate limit' } } });
      return mockResponse({ body: successBody('ok') });
    };

    const seen = [];
    const client = makeClient();
    const content = await client.chat(
      [{ role: 'user', content: 'hi' }],
      {
        maxRetries: 5, backoffMs: () => 777,
        onRetry: (info) => seen.push(info)
      }
    );
    assert.equal(content, 'ok');
    assert.equal(calls, 3);
    assert.equal(seen.length, 2, 'one notification per failed attempt that will be retried');
    assert.equal(seen[0].attempt, 1);
    assert.equal(seen[0].maxRetries, 5);
    assert.equal(seen[0].wait, 777);
    assert.match(seen[0].error, /Rate limit|429/);
    assert.equal(seen[1].attempt, 2);
  });

  it('a throwing onRetry callback never breaks the call', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls < 2) return mockResponse({ status: 429, body: { error: { message: 'Rate limit' } } });
      return mockResponse({ body: successBody('ok') });
    };

    const client = makeClient();
    const content = await client.chat(
      [{ role: 'user', content: 'hi' }],
      { maxRetries: 3, backoffMs: fastBackoff, onRetry: () => { throw new Error('UI exploded'); } }
    );
    assert.equal(content, 'ok', 'the call succeeds despite the observer throwing');
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
      assert.ok(delays.includes(300000),
        'unconfigured requests must use the 300-second default timeout');
      // Filter out the AbortController timer (timeoutMs defaults to 300000).
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

// 2026-08-24 (max_tokens default discussion): finish_reason=length WITH
// partial content was returned silently — a clipped JSON payload that then
// failed parsing downstream with no hint that the CAUSE was the completion
// cap, not the model. RC55 only covers the empty+length burn. This warning
// makes real output truncation visible in the log capture.
describe('LLMClient.chat partial-content length truncation warning', () => {
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

  it('returns the partial content but warns with the effective budget', async () => {
    global.fetch = async () => mockResponse({
      body: {
        choices: [{ message: { role: 'assistant', content: '{"steps": [{"id": "1", "scr' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 100, completion_tokens: 8192, total_tokens: 8292 }
      }
    });

    const client = makeClient();
    const content = await client.chat([{ role: 'user', content: 'hi' }], { maxTokens: 8192 });

    assert.equal(content, '{"steps": [{"id": "1", "scr', 'partial content must be returned as-is');
    const warns = consoleStub.filter(e => e[0] === 'warn');
    assert.equal(warns.length, 1, 'exactly one truncation warning');
    const flat = JSON.stringify(warns[0]);
    assert.match(flat, /TRUNCATED/i, 'warning must say the output was truncated');
    assert.match(flat, /8192/, 'warning must disclose the effective completion budget');
    assert.match(flat, /maxOutputTokens/, 'warning must point at the Settings knob');
    assert.match(flat, /finish_reason=length/, 'warning must name the finish reason');
  });

  it('does NOT warn on normal stop responses', async () => {
    global.fetch = async () => mockResponse({ body: successBody('{"ok":true}') });
    const client = makeClient();
    const content = await client.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(content, '{"ok":true}');
    const warns = consoleStub.filter(e => e[0] === 'warn' && /TRUNCATED/i.test(String(e[1])));
    assert.equal(warns.length, 0, 'no truncation warning on finish_reason=stop');
  });
});

describe('LLMClient timeout configuration', () => {
  it('defaults to 300s when no timeoutMs configured', () => {
    const client = new LLMClient({
      provider: 'glm', model: 'glm-5.1', apiKey: 'k', apiBaseUrl: 'http://test.local/v1'
    });
    assert.equal(client.timeoutMs, undefined);
    // The use-site fallback lives in _chatOnce — verified by inspecting that
    // The request-timer behavior is asserted in the retry test above, where
    // options.timeoutMs ?? this.timeoutMs ?? DEFAULT_TIMEOUT_MS resolves to 300000.
  });

  it('honors config.timeoutMs from constructor (ms)', () => {
    const client = new LLMClient({
      provider: 'glm', model: 'glm-5.1', apiKey: 'k', apiBaseUrl: 'http://test.local/v1',
      timeoutMs: 30000
    });
    assert.equal(client.timeoutMs, 30000);
  });

  it('rejects non-finite or non-positive timeoutMs (falls back to default at use site)', () => {
    const nan = new LLMClient({
      provider: 'glm', model: 'glm-5.1', apiKey: 'k', apiBaseUrl: 'http://test.local/v1',
      timeoutMs: NaN
    });
    const negative = new LLMClient({
      provider: 'glm', model: 'glm-5.1', apiKey: 'k', apiBaseUrl: 'http://test.local/v1',
      timeoutMs: -5
    });
    const string = new LLMClient({
      provider: 'glm', model: 'glm-5.1', apiKey: 'k', apiBaseUrl: 'http://test.local/v1',
      timeoutMs: '60000'
    });
    assert.equal(nan.timeoutMs, undefined);
    assert.equal(negative.timeoutMs, undefined);
    // Number('60000') === 60000 — numeric strings are accepted (Number() coerces)
    assert.equal(string.timeoutMs, 60000);
  });
});

// Thirty-second log (user directive): the 300-char response preview hid the
// model's think + tool-call from exported console logs — chunk the FULL
// content across multiple console lines (i/N parts), capped at 32000 with a
// disclosed elision.
describe('LLMClient.chat response content chunked logging', () => {
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
      provider: 'openai', model: 'test-model', apiKey: 'test-key', apiBaseUrl: 'http://test.local/v1'
    });
  }

  it('a long response logs in (i/N) parts that concatenate to the whole', async () => {
    const content = JSON.stringify({ think: 't'.repeat(4000), tool: 'service.update', args: { steps: 's'.repeat(2000) } });
    global.fetch = async () => mockResponse({ body: successBody(content) });
    const client = makeClient();
    await client.chat([{ role: 'user', content: 'go' }]);
    const parts = consoleStub.filter((l) => l[0] === 'log' && /^\[LLMClient\] Response content \(\d+\/\d+\):$/.test(l[1]));
    assert.ok(parts.length >= 3, 'content split across lines, got ' + parts.length);
    const n = parseInt(/^\[LLMClient\] Response content \(\d+\/(\d+)\):$/.exec(parts[0][1])[1], 10);
    assert.equal(parts.length, n, 'exactly N parts');
    assert.equal(parts.map((l) => l[2]).join(''), content, 'chunks concatenate losslessly');
  });

  it('beyond 32000 chars the tail elision is disclosed with a count', async () => {
    const content = 'z'.repeat(40000);
    global.fetch = async () => mockResponse({ body: successBody(content) });
    const client = makeClient();
    await client.chat([{ role: 'user', content: 'go' }]);
    const elided = consoleStub.filter((l) => l[0] === 'log' && l[1] === '[LLMClient] Response content (tail elided):');
    assert.equal(elided.length, 1, 'elision disclosure line present');
    assert.match(elided[0][2], /\[\+8000 chars not shown\]/);
  });

  it('a short response logs in one part with no preview cut', async () => {
    global.fetch = async () => mockResponse({ body: successBody('{"tool":"probe.count","args":{"sel":"div"}}') });
    const client = makeClient();
    await client.chat([{ role: 'user', content: 'go' }]);
    const parts = consoleStub.filter((l) => l[0] === 'log' && /^\[LLMClient\] Response content \(|^Response content \(/.test(l[1]) && /\(\d+\/\d+\):$/.test(l[1]));
    assert.equal(parts.length, 1);
    assert.equal(parts[0][1], '[LLMClient] Response content (1/1):');
    assert.equal(parts[0][2], '{"tool":"probe.count","args":{"sel":"div"}}');
  });
});

// Thirty-third log D4: every "[LLMClient] Request body:" line in the
// exported console capture was EMPTY — the pretty-printed multi-line
// JSON.stringify(body, null, 2) single argument does not survive DevTools
// "Save as…". The response path proved chunked one-line strings DO survive
// (32nd-log RC-B); mirror it for the request body at a tighter cap (the
// transcript is already mirrored at the wizard layer).
describe('LLMClient request body chunked logging', () => {
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
    global.fetch = undefined;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  });

  function makeClient() {
    return new LLMClient({
      provider: 'openai', model: 'test-model', apiKey: 'test-key', apiBaseUrl: 'http://test.local/v1'
    });
  }

  it('logs the request body as (i/N) one-line JSON chunks, never a pretty-printed object', async () => {
    // Payload must stay under the 8000-char mirror cap so the losslessness
    // assertion (a full uninterrupted q-run in the joined chunks) can hold.
    const bigMsg = 'q'.repeat(6000);
    global.fetch = async () => mockResponse({ body: successBody('{"tool":"probe.count","args":{}}') });
    const client = makeClient();
    await client.chat([{ role: 'user', content: bigMsg }]);
    const parts = consoleStub.filter((l) => l[0] === 'log' && /^\[LLMClient\] Request body \(\d+\/\d+\):$/.test(l[1]));
    assert.ok(parts.length >= 2, 'request split across lines, got ' + parts.length);
    const n = parseInt(/^\[LLMClient\] Request body \((\d+)\/(\d+)\):$/.exec(parts[0][1])[2], 10);
    assert.equal(parts.length, n, 'exactly N parts');
    for (const p of parts) {
      assert.equal(typeof p[2], 'string', 'chunk is a single-line string arg');
      assert.ok(p[2].indexOf('\n') === -1, 'no embedded newlines (capture-safe)');
    }
    const joined = parts.map((l) => l[2]).join('');
    assert.match(joined, /"model":"test-model"/);
    assert.match(joined, /q{6000}/);
  });

  it('caps the request mirror at 8000 chars with a disclosed elision count', async () => {
    const bigMsg = 'w'.repeat(30000);
    global.fetch = async () => mockResponse({ body: successBody('{"tool":"probe.count","args":{}}') });
    const client = makeClient();
    await client.chat([{ role: 'user', content: bigMsg }]);
    const parts = consoleStub.filter((l) => l[0] === 'log' && /^\[LLMClient\] Request body \(\d+\/\d+\):$/.test(l[1]));
    const shown = parts.map((l) => l[2]).join('');
    assert.ok(shown.length <= 8000, 'mirror respects the cap, got ' + shown.length);
    const elided = consoleStub.filter((l) => l[0] === 'log' && l[1] === '[LLMClient] Request body (tail elided):');
    assert.equal(elided.length, 1, 'elision disclosure line present');
    assert.match(elided[0][2], /\[\+\d+ chars not shown\]/);
  });
});

// Thirty-fourth log followup (user directive): support the Anthropic
// Messages protocol natively, PREFER it by default when the server speaks it
// (Zhipu coding plans, Moonshot, ... expose /v1/messages), fall back to
// OpenAI chat/completions when it does not, and identify as the Claude Code
// agent client on that path so coding-plan lanes classify us into the agent
// lane. Distinct base URLs per test — the protocol capability cache is
// module-level and keyed by base.
describe('Anthropic Messages protocol (auto-prefer + fallback + agent identity)', () => {
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

  function anthropicBody({ text = 'ok', stop_reason = 'end_turn', input_tokens = 5, output_tokens = 2 } = {}) {
    return {
      id: 'msg_1', type: 'message', role: 'assistant', model: 'test-model',
      content: [{ type: 'text', text }],
      stop_reason, stop_sequence: null,
      usage: { input_tokens, output_tokens }
    };
  }
  function anthropicEmpty(stop_reason, output_tokens) {
    return {
      id: 'msg_2', type: 'message', role: 'assistant', model: 'test-model',
      content: [], stop_reason, stop_sequence: null,
      usage: { input_tokens: 100, output_tokens }
    };
  }
  function clientAt(base, extraConfig = {}) {
    return new LLMClient(Object.assign({
      provider: 'glm', model: 'test-model', apiKey: 'test-key', apiBaseUrl: base
    }, extraConfig));
  }

  it('auto prefers Anthropic Messages: native URL, agent headers, system extraction, content-block parsing', async () => {
    const seen = [];
    global.fetch = async (url, init) => {
      seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return mockResponse({ body: anthropicBody({ text: 'hello world' }) });
    };
    const client = clientAt('http://a.test/v1');
    const out = await client.chat([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello?' },
      { role: 'user', content: 'again' }
    ], { maxRetries: 1 });
    assert.equal(out, 'hello world');
    assert.equal(seen.length, 1, 'exactly one request');
    assert.equal(seen[0].url, 'http://a.test/v1/messages');
    assert.equal(seen[0].headers['x-api-key'], 'test-key', 'x-api-key header');
    assert.equal(seen[0].headers['Authorization'], 'Bearer test-key', 'Bearer also sent for bridges');
    assert.equal(seen[0].headers['anthropic-version'], '2023-06-01');
    assert.match(seen[0].headers['user-agent'] || '', /^claude-cli\/.+ \(external, cli\)$/, 'Claude Code client signature');
    assert.equal(seen[0].body.system, 'be brief', 'leading system message extracted top-level');
    assert.deepEqual(seen[0].body.messages.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.equal(seen[0].body.max_tokens, 16384, 'max_tokens preserved (default chain)');
    assert.ok(!('response_format' in seen[0].body), 'no OpenAI response_format on the Messages path');
  });

  it('base without /v1 (custom bridge) appends /v1/messages', async () => {
    let url = '';
    global.fetch = async (u) => { url = String(u); return mockResponse({ body: anthropicBody() }); };
    await clientAt('https://bridge.example/api/anthropic').chat([{ role: 'user', content: 'hi' }], { maxRetries: 1 });
    assert.equal(url, 'https://bridge.example/api/anthropic/v1/messages');
  });

  it('empty content + stop_reason max_tokens maps to the RC55 non-retryable length error with the budget', async () => {
    global.fetch = async () => mockResponse({ body: anthropicEmpty('max_tokens', 4096) });
    const client = clientAt('http://c.test/v1', { maxOutputTokens: 4096 });
    await assert.rejects(
      client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 3 }),
      (err) => {
        assert.equal(err.retryable, false, 'deterministic budget burn');
        assert.match(err.message, /finish_reason=length/, 'stop_reason=max_tokens mapped to length semantics');
        assert.match(err.message, /4096/, 'effective budget named');
        return true;
      }
    );
  });

  it('partial content + stop_reason max_tokens warns TRUNCATED and still returns the text', async () => {
    global.fetch = async () => mockResponse({ body: anthropicBody({ text: 'partial answer', stop_reason: 'max_tokens' }) });
    const out = await clientAt('http://d.test/v1', { maxOutputTokens: 4096 }).chat([{ role: 'user', content: 'hi' }], { maxRetries: 1 });
    assert.equal(out, 'partial answer');
    const warns = consoleStub.filter((l) => l[0] === 'warn' && /TRUNCATED/.test(l[1]));
    assert.equal(warns.length, 1, 'truncation warning present');
  });

  it('404 on the Messages URL (auto) falls back to chat/completions and pins the base', async () => {
    const urls = [];
    global.fetch = async (u) => {
      urls.push(String(u));
      if (String(u).endsWith('/messages')) return mockResponse({ status: 404, body: {}, contentType: 'text/html' });
      return mockResponse({ body: successBody('{"ok":true}') });
    };
    const client = clientAt('http://e.test/v1');
    assert.equal(await client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 1 }), '{"ok":true}');
    assert.deepEqual(urls, ['http://e.test/v1/messages', 'http://e.test/v1/chat/completions']);
    assert.equal(await client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 1 }), '{"ok":true}');
    assert.equal(urls.length, 3, 'second call skips the probe');
    assert.equal(urls[2], 'http://e.test/v1/chat/completions', 'sticky openai for this base');
  });

  it('200 with an OpenAI-shaped body on the Messages URL parses in place — no second request', async () => {
    let calls = 0;
    const urls = [];
    global.fetch = async (u) => { calls++; urls.push(String(u)); return mockResponse({ body: successBody('bridge-ok') }); };
    const client = clientAt('http://f.test/v1');
    assert.equal(await client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 1 }), 'bridge-ok');
    assert.equal(calls, 1, 'the response we already hold is parsed, not refetched');
    await client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 1 });
    assert.equal(urls[1], 'http://f.test/v1/chat/completions', 'base pinned openai after the shape sniff');
  });

  it('protocol pinned anthropic + 404 throws (no silent openai fallback)', async () => {
    const urls = [];
    global.fetch = async (u) => { urls.push(String(u)); return mockResponse({ status: 404, body: {}, contentType: 'text/html' }); };
    await assert.rejects(
      clientAt('http://g.test/v1', { apiProtocol: 'anthropic' }).chat([{ role: 'user', content: 'hi' }], { maxRetries: 1 }),
      (err) => /404/.test(err.message)
    );
    assert.equal(urls.length, 1, 'pinned protocol never silently switches');
  });

  it('protocol pinned openai never touches the Messages URL', async () => {
    const urls = [];
    global.fetch = async (u) => { urls.push(String(u)); return mockResponse({ body: successBody('ok') }); };
    await clientAt('http://h.test/v1', { apiProtocol: 'openai' }).chat([{ role: 'user', content: 'hi' }], { maxRetries: 1 });
    assert.deepEqual(urls, ['http://h.test/v1/chat/completions']);
  });

  it('balance-class 429 on the Messages path fails fast AND names the coding-plan base URL remedy', async () => {
    const urls = [];
    global.fetch = async (u) => {
      urls.push(String(u));
      if (String(u).endsWith('/messages')) {
        return mockResponse({ status: 429, body: { error: { message: 'Insufficient balance or no resource package. Please recharge.' } } });
      }
      return mockResponse({ body: successBody('should-not-be-reached') });
    };
    await assert.rejects(
      clientAt('http://i.test/v1').chat([{ role: 'user', content: 'hi' }], { maxRetries: 3 }),
      (err) => {
        assert.equal(err.retryable, false);
        assert.match(err.message, /recharge|resource package/i);
        assert.match(err.message, /coding-plan/i, 'mentions the coding-plan pattern');
        assert.match(err.message, /coding\/paas\/v4/, 'names the dedicated base URL example');
        return true;
      }
    );
    assert.equal(urls.length, 1, 'no fallback attempt — the server speaks Messages; the wall is billing');
  });

  it('Anthropic error envelope detail flows through the auth-error message', async () => {
    global.fetch = async () => mockResponse({
      status: 401,
      body: { type: 'error', error: { type: 'authentication_error', message: 'invalid api key supplied' } }
    });
    await assert.rejects(
      clientAt('http://j.test/v1', { apiProtocol: 'anthropic' }).chat([{ role: 'user', content: 'hi' }], { maxRetries: 1 }),
      (err) => {
        assert.match(err.message, /invalid api key supplied/);
        assert.match(err.message, /API key/);
        return true;
      }
    );
  });
});

describe('Documented sibling lanes + Messages URL hygiene (thirty-seventh + thirty-eighth log)', () => {
  // Thirty-seventh log: auto + the GLM Coding Plan preset assembled
  // https://open.bigmodel.cn/api/coding/paas/v4/v1/messages — nonexistent.
  // Thirty-eighth log (user report): auto preferring Anthropic Messages must
  // not silently degrade to chat/completions either — Zhipu's official doc
  // provisions BOTH endpoints under one coding plan, with the
  // Anthropic-compatible lane on a DIFFERENT base (.../api/anthropic). So
  // Messages calls ROUTE to the documented sibling lane while
  // chat/completions stays on the configured base; if the sibling lane
  // answers a capability miss, auto falls back to the configured lane's
  // chat/completions exactly like any probe failure.
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

  function anthropicBody({ text = 'ok', stop_reason = 'end_turn' } = {}) {
    return {
      id: 'msg_1', type: 'message', role: 'assistant', model: 'test-model',
      content: [{ type: 'text', text }],
      stop_reason, stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 2 }
    };
  }
  function clientAt(base, extraConfig = {}) {
    return new LLMClient(Object.assign({
      provider: 'glm', model: 'test-model', apiKey: 'test-key', apiBaseUrl: base
    }, extraConfig));
  }

  it('auto + the documented coding lane routes Messages to the sibling Anthropic lane', async () => {
    const urls = [];
    global.fetch = async (u) => { urls.push(String(u)); return mockResponse({ body: anthropicBody({ text: 'sibling-ok' }) }); };
    const client = clientAt('https://open.bigmodel.cn/api/coding/paas/v4');
    assert.equal(await client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 1 }), 'sibling-ok');
    assert.deepEqual(urls, ['https://open.bigmodel.cn/api/anthropic/v1/messages'],
      'the doomed .../v4/v1/messages is never assembled; Messages goes to the documented sibling lane');
    await client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 1 });
    assert.equal(urls.length, 2, 'second call stays on the sibling lane (capability cached)');
    assert.equal(urls[1], 'https://open.bigmodel.cn/api/anthropic/v1/messages');
    assert.ok(consoleStub.some((l) => l[0] === 'log' && /routed to the provider's Anthropic-compatible lane/.test(String(l[1]))),
      'the lane routing is visible in the console log');
  });

  it('sibling lane capability miss (auto) falls back to the configured coding lane chat/completions', async () => {
    const urls = [];
    global.fetch = async (u) => {
      urls.push(String(u));
      if (String(u).endsWith('/messages')) return mockResponse({ status: 404, body: {}, contentType: 'text/html' });
      return mockResponse({ body: successBody('coding-lane-ok') });
    };
    const client = clientAt('https://open.bigmodel.cn/api/coding/paas/v4');
    assert.equal(await client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 1 }), 'coding-lane-ok');
    assert.deepEqual(urls, ['https://open.bigmodel.cn/api/anthropic/v1/messages', 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions'],
      'probe the sibling lane, then fall back to the CONFIGURED base');
    await client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 1 });
    assert.equal(urls.length, 3, 'second call skips the probe');
    assert.equal(urls[2], 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', 'sticky openai for this base');
  });

  it('pinned anthropic + the documented coding lane routes to the sibling lane (no fail-fast, no doomed path)', async () => {
    const urls = [];
    global.fetch = async (u) => { urls.push(String(u)); return mockResponse({ body: anthropicBody({ text: 'pinned-sibling-ok' }) }); };
    const client = clientAt('https://open.bigmodel.cn/api/coding/paas/v4', { apiProtocol: 'anthropic' });
    assert.equal(await client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 1 }), 'pinned-sibling-ok');
    assert.deepEqual(urls, ['https://open.bigmodel.cn/api/anthropic/v1/messages'],
      'pinned Messages protocol uses the documented Anthropic-compatible lane, never .../v4/v1/messages');
  });

  it('a custom base is never sibling-routed (map keyed by the exact documented chat lane)', async () => {
    const urls = [];
    global.fetch = async (u) => { urls.push(String(u)); return mockResponse({ body: anthropicBody({ text: 'custom-ok' }) }); };
    const client = clientAt('https://open.bigmodel.cn/api/coding/paas/v4/proxy');
    assert.equal(await client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 1 }), 'custom-ok');
    assert.deepEqual(urls, ['https://open.bigmodel.cn/api/coding/paas/v4/proxy/v1/messages'],
      'an overridden/extended base keeps normal append-path derivation');
  });

  it('Base URL already ending in /v1/messages is used as-is (no double append)', async () => {
    const urls = [];
    global.fetch = async (u) => { urls.push(String(u)); return mockResponse({ body: anthropicBody({ text: 'full-endpoint-ok' }) }); };
    const client = clientAt('https://full.example/v1/messages');
    assert.equal(await client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 1 }), 'full-endpoint-ok');
    assert.deepEqual(urls, ['https://full.example/v1/messages'],
      'pasting the full endpoint into Base URL must not become .../v1/messages/v1/messages');
  });

  it('pinned anthropic + a custom bridge base still works through the append path', async () => {
    const urls = [];
    global.fetch = async (u) => { urls.push(String(u)); return mockResponse({ body: anthropicBody({ text: 'bridge-pin-ok' }) }); };
    const client = clientAt('https://bridge.example/api', { apiProtocol: 'anthropic' });
    assert.equal(await client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 1 }), 'bridge-pin-ok');
    assert.deepEqual(urls, ['https://bridge.example/api/v1/messages']);
  });
});

describe('Gateway error envelopes on HTTP 200 (thirty-fifth log)', () => {
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

  // The exact shape bigmodel.cn returned live: HTTP 200 wrapping
  // {"code": 500, "msg": "404 NOT_FOUND", "success": false} — the requested
  // OpenAI path does not exist on that base URL.
  function envelopeBody(code, msg) {
    return { code, msg, success: false };
  }
  function clientAt(base, extraConfig = {}) {
    return new LLMClient(Object.assign({
      provider: 'glm', model: 'test-model', apiKey: 'test-key', apiBaseUrl: base
    }, extraConfig));
  }

  it('OpenAI path: 200-wrapped {code,msg} envelope decodes to a non-retryable endpoint-missing error with Base URL guidance', async () => {
    const urls = [];
    global.fetch = async (u) => {
      urls.push(String(u));
      return mockResponse({ body: envelopeBody(500, '404 NOT_FOUND') });
    };
    await assert.rejects(
      clientAt('http://gw1.test/v1', { apiProtocol: 'openai' }).chat([{ role: 'user', content: 'hi' }], { maxRetries: 3 }),
      (err) => {
        assert.equal(err.retryable, false, 'endpoint-missing is deterministic');
        assert.match(err.message, /404 NOT_FOUND/, 'the gateway msg is surfaced verbatim');
        assert.match(err.message, /Base URL/, 'Base URL guidance');
        return true;
      }
    );
    assert.equal(urls.length, 1, 'non-retryable — exactly one request, no retry burn');
  });

  it('auto: a 404 envelope on the Messages probe is a capability miss — falls back to OpenAI; the final error still names the gateway msg', async () => {
    const urls = [];
    global.fetch = async (u) => {
      urls.push(String(u));
      return mockResponse({ body: envelopeBody(500, '404 NOT_FOUND') });
    };
    await assert.rejects(
      clientAt('http://gw2.test/v1').chat([{ role: 'user', content: 'hi' }], { maxRetries: 3 }),
      (err) => {
        assert.equal(err.retryable, false);
        assert.match(err.message, /404 NOT_FOUND/);
        return true;
      }
    );
    assert.deepEqual(urls, ['http://gw2.test/v1/messages', 'http://gw2.test/v1/chat/completions'], 'probe, then fallback');
  });

  it('pinned anthropic: non-404 gateway envelope on 200 throws the decoded error, stays on the Messages path', async () => {
    const urls = [];
    global.fetch = async (u) => {
      urls.push(String(u));
      return mockResponse({ body: envelopeBody(500, 'internal gateway error') });
    };
    await assert.rejects(
      clientAt('http://gw3.test/v1', { apiProtocol: 'anthropic' }).chat([{ role: 'user', content: 'hi' }], { maxRetries: 0 }),
      (err) => {
        assert.equal(err.retryable, true, 'code 500 stays retryable');
        assert.match(err.message, /internal gateway error/);
        assert.match(err.message, /code 500/);
        return true;
      }
    );
    assert.deepEqual(urls, ['http://gw3.test/v1/messages'], 'no silent protocol switch');
  });

  it('balance-semantics envelope on HTTP 200 routes to the balance remedy (coding-plan Base URL)', async () => {
    const urls = [];
    global.fetch = async (u) => {
      urls.push(String(u));
      return mockResponse({ body: envelopeBody(1113, 'Insufficient balance or no resource package. Please recharge.') });
    };
    await assert.rejects(
      clientAt('http://gw4.test/v1', { apiProtocol: 'openai' }).chat([{ role: 'user', content: 'hi' }], { maxRetries: 3 }),
      (err) => {
        assert.equal(err.retryable, false);
        assert.match(err.message, /coding\/paas\/v4/, 'dedicated lane named');
        return true;
      }
    );
    assert.equal(urls.length, 1, 'billing condition — exactly one request');
  });
});

describe('Provider default Base URLs (official Zhipu coding-plan lanes)', () => {
  // Zhipu's official coding-plan doc pins three endpoints; the plan quota is
  // honored only on them and "错误配置端点将导致无法使用套餐额度". The preset
  // table must keep mapping every provider to its documented lane.
  const expectedLanes = {
    openai: 'https://api.openai.com/v1',
    moonshot: 'https://api.moonshot.cn/v1',
    kimi: 'https://api.moonshot.cn/v1',
    anthropic: 'https://api.anthropic.com/v1',
    glm: 'https://open.bigmodel.cn/api/paas/v4',
    'glm-coding': 'https://open.bigmodel.cn/api/coding/paas/v4'
  };

  for (const [provider, lane] of Object.entries(expectedLanes)) {
    it(`${provider}: default Base URL is the documented lane`, () => {
      const client = new LLMClient({ provider, model: 'm', apiKey: 'k' });
      assert.equal(client.apiBaseUrl, lane);
    });
  }

  it('unknown provider still throws (preset table is closed)', () => {
    assert.throws(() => new LLMClient({ provider: 'nope', model: 'm', apiKey: 'k' }), /Unknown provider/);
  });

  it('balance remedy names the coding-plan lane AND the provider preset', () => {
    const client = new LLMClient({ provider: 'glm', model: 'glm-5.2', apiKey: 'k' });
    const tail = client._balanceRemedyTail();
    assert.match(tail, /coding\/paas\/v4/);
    assert.match(tail, /GLM Coding Plan provider/, 'names the Settings preset, not just the plan name');
  });
});
