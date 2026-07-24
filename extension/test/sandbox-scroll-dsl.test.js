// Regression for bugx.log 2026-07-24: step 2 (scroll_and_load_posts) had
// dead `if (scrollable) { /* empty body */ }` code because the DSL had no
// scroll function at all. The LLM knew scrolling was needed but had no API
// to call, so it left the if-body empty and the script declared the feed
// exhausted after the first batch (count stayed at 7 across all iterations).
//
// These tests verify the three new scroll DSL functions ($scrollBy,
// $scrollToBottom, $scrollIntoView) exist on the sandbox window and post
// DOM_REQUEST messages with the expected action/selector/args. The actual
// DOM scroll is exercised end-to-end in the browser; here we only verify
// the sandbox wires the calls correctly.

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
  const fn = new Function('parent', 'window', 'self', source);
  fn(fakeParent, fakeWindow, fakeWindow);
  return {
    posted,
    window: fakeWindow,
    // The DOM_REQUEST is posted to parent BEFORE the caller awaits the
    // promise. We capture it by inspecting `posted` after each call.
    lastDomRequest() {
      for (let i = posted.length - 1; i >= 0; i--) {
        if (posted[i].type === 'DOM_REQUEST') return posted[i];
      }
      return null;
    }
  };
}

describe('sandbox scroll DSL', () => {
  it('exposes $scrollBy, $scrollToBottom, $scrollIntoView on window', () => {
    const { window } = loadSandbox();
    assert.equal(typeof window.$scrollBy, 'function');
    assert.equal(typeof window.$scrollToBottom, 'function');
    assert.equal(typeof window.$scrollIntoView, 'function');
  });

  it('$scrollBy posts DOM_REQUEST with action=scrollBy and deltaY in args', () => {
    const { window, lastDomRequest } = loadSandbox();
    // Don't await — the promise won't resolve without a DOM_RESPONSE, but the
    // DOM_REQUEST is posted synchronously inside sendDomRequest.
    window.$scrollBy(500);
    const req = lastDomRequest();
    assert.equal(req.type, 'DOM_REQUEST');
    assert.equal(req.action, 'scrollBy');
    assert.equal(req.selector, null);
    assert.deepEqual(req.args, [500]);
  });

  it('$scrollBy with a selector passes the selector', () => {
    const { window, lastDomRequest } = loadSandbox();
    window.$scrollBy(800, 'div[role="feed"]');
    const req = lastDomRequest();
    assert.equal(req.action, 'scrollBy');
    assert.equal(req.selector, 'div[role="feed"]');
    assert.deepEqual(req.args, [800]);
  });

  it('$scrollToBottom posts DOM_REQUEST with action=scrollToBottom', () => {
    const { window, lastDomRequest } = loadSandbox();
    window.$scrollToBottom();
    const req = lastDomRequest();
    assert.equal(req.action, 'scrollToBottom');
    assert.equal(req.selector, null);
    assert.deepEqual(req.args, []);
  });

  it('$scrollToBottom with a selector passes the selector', () => {
    const { window, lastDomRequest } = loadSandbox();
    window.$scrollToBottom('main[role="main"]');
    const req = lastDomRequest();
    assert.equal(req.action, 'scrollToBottom');
    assert.equal(req.selector, 'main[role="main"]');
  });

  it('$scrollIntoView posts DOM_REQUEST with action=scrollIntoView', () => {
    const { window, lastDomRequest } = loadSandbox();
    window.$scrollIntoView('button.see-more');
    const req = lastDomRequest();
    assert.equal(req.action, 'scrollIntoView');
    assert.equal(req.selector, 'button.see-more');
  });
});
