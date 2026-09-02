// B2: sandbox DOM_RESPONSE error branch must attach e.data._diagnostics to
// the rejected Error, and executeInSandbox's catch must include the failing
// call's diagnostics in the EXECUTE_RESULT error payload.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadSandbox() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'sandbox.js'), 'utf8');
  const posted = [];
  const messageListeners = [];
  const fakeParent = { postMessage(msg) { posted.push(msg); } };
  const fakeWindow = {
    addEventListener(_type, fn) { messageListeners.push(fn); },
    location: { href: 'about:blank' }
  };
  // The script bodies created by executeInSandbox's `new Function` run in the
  // Node global scope (not inside this factory's param scope), so `window`
  // must exist as a real global for them to reach window.$extract. Kept
  // installed for the whole test — EXECUTE delivery resolves globals lazily.
  globalThis.window = fakeWindow;
  globalThis.self = fakeWindow;
  globalThis.parent = fakeParent;
  const fn = new Function('parent', 'window', 'self', source);
  fn(fakeParent, fakeWindow, fakeWindow);
  return { posted, messageListeners };
}

function deliver(listeners, data) {
  for (const l of listeners) l({ source: 'frame', data });
}

describe('B2: sandbox error diagnostics', () => {
  it('a DOM_RESPONSE error carrying _diagnostics rides the rejected promise AND the EXECUTE_RESULT error payload', async () => {
    const { posted, messageListeners } = loadSandbox();
    // A script that starts a $extract call and swallows the rejection, so
    // EXECUTE_RESULT settles and we can observe whether the rejected Error
    // carried the diagnostics.
    const script = 'window.$extract("div.x").catch(function(e){ return "swallowed:" + (e && e._diagnostics ? "has-diag" : "no-diag"); })';
    deliver(messageListeners, { type: 'EXECUTE', script, input: {} });
    const req = posted.find((m) => m.type === 'DOM_REQUEST');
    assert.ok(req, 'DOM_REQUEST posted');
    deliver(messageListeners, {
      type: 'DOM_RESPONSE',
      id: req.id,
      error: 'ELEMENT_NOT_FOUND: div.x',
      _diagnostics: { api: 'extract', matchCount: 0 }
    });
    // Give the microtask chain a tick to settle the catch + post EXECUTE_RESULT.
    await new Promise(r => setTimeout(r, 20));
    const res = posted.find((m) => m.type === 'EXECUTE_RESULT');
    assert.ok(res, 'EXECUTE_RESULT posted');
    assert.match(String(res.error || res.result), /swallowed:has-diag/, 'the rejected Error carries _diagnostics');

    // Now the uncaught case: diagnostics must ALSO ride the error payload.
    deliver(messageListeners, { type: 'EXECUTE', script: 'window.$extract("div.y")', input: {} });
    const req2 = posted.find((m) => m.type === 'DOM_REQUEST' && m.selector === 'div.y');
    assert.ok(req2, 'second DOM_REQUEST posted');
    deliver(messageListeners, {
      type: 'DOM_RESPONSE',
      id: req2.id,
      error: 'ELEMENT_NOT_FOUND: div.y',
      _diagnostics: { api: 'extract', matchCount: 0, note: 'y' }
    });
    await new Promise(r => setTimeout(r, 20));
    const res2 = posted.filter((m) => m.type === 'EXECUTE_RESULT').pop();
    assert.ok(res2, 'second EXECUTE_RESULT posted');
    assert.equal(res2.error, 'ELEMENT_NOT_FOUND: div.y');
    assert.deepEqual(res2.selectorDiagnostics, [{ api: 'extract', matchCount: 0, note: 'y' }],
      "the failing call's diagnostics ride the error payload");
  });
});
