// Regression for bugx.log 2026-07-24: LLM-generated script did
// `window.location.href = searchUrl` inside the sandbox, which navigated the
// sandbox iframe itself and destroyed it. Every subsequent EXECUTE was silently
// dropped. sandbox.js now scans for navigation patterns BEFORE invoking
// `new Function(...)` and returns a FORBIDDEN_NAVIGATION error instead.
//
// We load sandbox.js inside a fake DOM shim (parent + window) and exercise it
// through the same message events production uses.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadSandbox() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'sandbox.js'), 'utf8');

  const posted = [];
  const messageListeners = [];
  const fakeParent = {
    postMessage(msg) { posted.push(msg); }
  };
  const fakeWindow = {
    addEventListener(_type, fn) { messageListeners.push(fn); },
    location: { href: 'about:blank' }
  };

  // Evaluate the IIFE with our shims in scope. The IIFE attaches window.$exists
  // etc. and registers a window.message listener we can invoke directly.
  const fn = new Function('parent', 'window', 'self', source);
  fn(fakeParent, fakeWindow, fakeWindow);

  if (messageListeners.length === 0) {
    throw new Error('sandbox.js did not register any message listener');
  }

  return {
    parent: fakeParent,
    posted,
    async send(msg) {
      const listener = messageListeners[messageListeners.length - 1];
      listener({ data: msg, source: fakeWindow });
      // Drain microtasks so async `executeInSandbox` bodies can post their
      // EXECUTE_RESULT before we assert.
      await new Promise(r => setImmediate(r));
    },
    window: fakeWindow
  };
}

describe('sandbox.js forbidden-navigation guard', () => {
  it('rejects `window.location.href = url` with FORBIDDEN_NAVIGATION', async () => {
    const sb = loadSandbox();
    await sb.send({
      type: 'EXECUTE',
      script: "window.location.href = 'https://facebook.com/search';",
      input: {}
    });
    const result = sb.posted.find(m => m.type === 'EXECUTE_RESULT');
    assert.ok(result, 'posted EXECUTE_RESULT');
    assert.ok(result.error, 'has error');
    assert.match(result.error, /FORBIDDEN_NAVIGATION/);
    assert.match(result.error, /sandbox/i);
    assert.equal(result.result, undefined);
  });

  it('rejects `location.replace(url)`', async () => {
    const sb = loadSandbox();
    await sb.send({
      type: 'EXECUTE',
      script: "location.replace('https://example.com');",
      input: {}
    });
    const result = sb.posted.find(m => m.type === 'EXECUTE_RESULT');
    assert.ok(result.error);
    assert.match(result.error, /FORBIDDEN_NAVIGATION/);
  });

  it('rejects `location.assign(url)`', async () => {
    const sb = loadSandbox();
    await sb.send({
      type: 'EXECUTE',
      script: "location.assign('https://example.com');",
      input: {}
    });
    const result = sb.posted.find(m => m.type === 'EXECUTE_RESULT');
    assert.match(result.error, /FORBIDDEN_NAVIGATION/);
  });

  it('rejects `window.location = url` (whole-location assignment)', async () => {
    const sb = loadSandbox();
    await sb.send({
      type: 'EXECUTE',
      script: "window.location = 'https://example.com';",
      input: {}
    });
    const result = sb.posted.find(m => m.type === 'EXECUTE_RESULT');
    assert.match(result.error, /FORBIDDEN_NAVIGATION/);
  });

  it('does NOT flag reads of location.href', async () => {
    const sb = loadSandbox();
    await sb.send({
      type: 'EXECUTE',
      // sandbox.js wraps as `return ${scriptCode};`, so the body must be an
      // expression. Reading window.location.href is legitimate.
      script: "(window.location && window.location.href) || 'unknown'",
      input: {}
    });
    const result = sb.posted.find(m => m.type === 'EXECUTE_RESULT');
    if (result.error) {
      assert.doesNotMatch(result.error, /FORBIDDEN_NAVIGATION/);
    }
  });

  it('does NOT flag a variable named `location`', async () => {
    const sb = loadSandbox();
    await sb.send({
      type: 'EXECUTE',
      // IIFE so a `const location` declaration is a legitimate local variable.
      script: "(() => { const location = 'cafe'; return location; })()",
      input: {}
    });
    const result = sb.posted.find(m => m.type === 'EXECUTE_RESULT');
    if (result.error) {
      assert.doesNotMatch(result.error, /FORBIDDEN_NAVIGATION/);
    }
  });

  it('lets a normal expression script proceed (sanity check)', async () => {
    const sb = loadSandbox();
    await sb.send({
      type: 'EXECUTE',
      // Expression form — sandbox.js wraps as `return { ok: true };`.
      script: "{ ok: true }",
      input: {}
    });
    const result = sb.posted.find(m => m.type === 'EXECUTE_RESULT');
    assert.deepEqual(result.result, { ok: true });
    assert.equal(result.error, undefined);
  });
});
