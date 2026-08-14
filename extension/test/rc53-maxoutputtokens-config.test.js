// RC53: maxOutputTokens as a per-provider config parameter threaded through
// the whole LLM call flow.
//
// FOLLOWUP to RC52 (post-RC51). RC52 fixed the deterministic
// finish_reason:length + empty-content failure (136,953-token prompt capped at
// the llm-client 4096 default) by hardcoding maxTokens: 8192 at the two
// under-budgeted wizard call sites. The user then asked whether maxTokens
// should be confirmed with the LLM provider and threaded as ONE parameter
// throughout (maxTokens是不是要跟LLM服务方用接口去确认？然后作为一个参数贯穿全程？)
// and chose the config-parameter approach (配置参数).
//
// Design: the completion budget belongs to the PROVIDER+MODEL pair, not to
// individual call sites. glm-5.1 via an Anthropic-compatible proxy can spend
// the entire completion budget on non-visible reasoning (RC52: output_tokens
// 4096, text_tokens 0), so the safe value is provider-specific knowledge the
// user has, not something the wizard call sites should each guess.
//
// Priority chain at the single budgeting site (llm-client _chatOnce):
//   options.maxTokens ?? config.maxOutputTokens ?? 8192
// - options.maxTokens keeps per-call override capability (tested here).
// - config.maxOutputTokens comes from the Settings page, stored in
//   chrome.storage.local llmConfig (GET/SAVE_LLM_CONFIG pass the object
//   verbatim — no whitelist to update), reaching every new LLMClient(config).
// - The built-in default rises 4096 → 8192: the proven-working sibling value
//   on the wizard flow. A bare chat() call can no longer silently cap at 4096.
//
// Call-site change: every hardcoded maxTokens: 8192 in wizard.js (7 sites)
// and background.js (autoFix) is REMOVED — the config is authoritative, and a
// call-site hardcode would silently cap a user who configures 16384. The RC52
// guard test (every wizard client.chat carries explicit maxTokens) is updated
// to the new invariant: no call site may hardcode a value BELOW 8192.
//
// timeoutMs is the precedent pattern mirrored here: UI seconds ↔ stored ms,
// validated range, coerced via Number(), fallback at the use site.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { LLMClient } = require('../lib/llm-client');

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

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

describe('RC53: llm-client maxOutputTokens priority chain', () => {
  let capturedBodies;

  beforeEach(() => {
    capturedBodies = [];
    global.fetch = async (url, init) => {
      capturedBodies.push(JSON.parse(init.body));
      return mockResponse({ body: successBody('ok') });
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

  it('uses config.maxOutputTokens when the call omits maxTokens', async () => {
    const client = makeClient({ maxOutputTokens: 16384 });
    await client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 0 });
    assert.equal(capturedBodies[0].max_tokens, 16384,
      'config.maxOutputTokens must reach the request body when no per-call override exists');
  });

  it('per-call maxTokens overrides config.maxOutputTokens', async () => {
    const client = makeClient({ maxOutputTokens: 16384 });
    await client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 0, maxTokens: 2048 });
    assert.equal(capturedBodies[0].max_tokens, 2048,
      'options.maxTokens must win over config.maxOutputTokens (per-call escape hatch)');
  });

  it('defaults to 8192 (not the RC52-trap 4096) when both are absent', async () => {
    const client = makeClient();
    await client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 0 });
    assert.equal(capturedBodies[0].max_tokens, 8192,
      'the built-in fallback must be >= 8192 — the 4096 default caused the RC52 incident ' +
      '(136K-token prompt, finish_reason:length, empty content, 4 wasted retries)');
  });

  it('ignores invalid config.maxOutputTokens (falls back at use site)', async () => {
    const zero = makeClient({ maxOutputTokens: 0 });
    const negative = makeClient({ maxOutputTokens: -100 });
    const nan = makeClient({ maxOutputTokens: NaN });
    const notFinite = makeClient({ maxOutputTokens: Infinity });
    for (const c of [zero, negative, nan, notFinite]) {
      assert.equal(c.maxOutputTokens, undefined,
        'invalid maxOutputTokens must normalize to undefined (timeoutMs pattern)');
    }
    await zero.chat([{ role: 'user', content: 'hi' }], { maxRetries: 0 });
    assert.equal(capturedBodies[0].max_tokens, 8192);
  });

  it('accepts numeric-string config.maxOutputTokens (Number coercion, timeoutMs parity)', async () => {
    const client = makeClient({ maxOutputTokens: '16384' });
    assert.equal(client.maxOutputTokens, 16384);
    await client.chat([{ role: 'user', content: 'hi' }], { maxRetries: 0 });
    assert.equal(capturedBodies[0].max_tokens, 16384);
  });
});

describe('RC53: Settings UI exposes maxOutputTokens', () => {
  it('options.html has an llmMaxTokens number input', () => {
    const src = readSrc('options.html');
    assert.match(src, /id="llmMaxTokens"/,
      'Settings modal must expose the completion-budget field');
    const m = src.match(/<input[^>]*id="llmMaxTokens"[^>]*>/);
    assert.ok(m, 'llmMaxTokens input tag must be parseable');
    const min = m[0].match(/min="(\d+)"/);
    assert.ok(min, 'llmMaxTokens must carry a min');
    assert.ok(parseInt(min[1], 10) >= 1024,
      'min must be >= 1024 (a lower budget reintroduces the RC52 truncation class)');
  });

  it('options.js saveLlmConfig includes maxOutputTokens when the field is valid', () => {
    const src = readSrc('options.js');
    const start = src.indexOf('async function saveLlmConfig()');
    assert.ok(start > -1, 'saveLlmConfig must exist');
    const end = src.indexOf('async function ', start + 10);
    const body = src.slice(start, end);
    assert.match(body, /llmMaxTokens/, 'saveLlmConfig must read the llmMaxTokens field');
    assert.match(body, /maxOutputTokens/,
      'saveLlmConfig must put maxOutputTokens into the persisted config');
  });

  it('options.js loadLlmConfig populates llmMaxTokens from stored config', () => {
    const src = readSrc('options.js');
    const start = src.indexOf('async function loadLlmConfig()');
    assert.ok(start > -1, 'loadLlmConfig must exist');
    const end = src.indexOf('async function ', start + 10);
    const body = src.slice(start, end);
    assert.match(body, /maxOutputTokens/, 'loadLlmConfig must map stored maxOutputTokens to the field');
  });
});

describe('RC53: call sites are config-driven (no hardcoded budgets)', () => {
  // A hardcoded maxTokens at a call site silently caps a user who configures
  // a larger budget — the config parameter must be authoritative. The only
  // remaining protection needed: no call site may hardcode a value BELOW
  // 8192 (that reintroduces the RC52 failure mode even with no config set).
  function assertNoSub8192Hardcode(src, file) {
    const hardcoded = [];
    const re = /maxTokens:\s*(\d+)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (parseInt(m[1], 10) < 8192) hardcoded.push(m[0]);
    }
    assert.deepEqual(hardcoded, [],
      file + ' must not hardcode maxTokens below 8192 (RC52 failure mode). Found: ' +
      JSON.stringify(hardcoded));
  }

  it('wizard.js call sites do not hardcode sub-8192 budgets', () => {
    assertNoSub8192Hardcode(readSrc('wizard.js'), 'wizard.js');
  });

  it('background.js call sites do not hardcode sub-8192 budgets', () => {
    assertNoSub8192Hardcode(readSrc('background.js'), 'background.js');
  });

  it('the RC52 maxTokens:8192 hardcodes were removed (config now drives)', () => {
    // If this fails with 8192s present, the removal step was skipped: a
    // call-site 8192 caps users who configure 16384 via Settings.
    const wizardSrc = readSrc('wizard.js');
    const count = (wizardSrc.match(/maxTokens:\s*8192/g) || []).length;
    assert.equal(count, 0,
      'wizard.js must not hardcode maxTokens: 8192 — maxOutputTokens config is authoritative. Found ' + count);
    const bgSrc = readSrc('background.js');
    const bgCount = (bgSrc.match(/maxTokens:\s*8192/g) || []).length;
    assert.equal(bgCount, 0,
      'background.js must not hardcode maxTokens: 8192 — maxOutputTokens config is authoritative. Found ' + bgCount);
  });
});
