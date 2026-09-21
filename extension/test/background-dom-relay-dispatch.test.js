// 104th log: my own 103c tail-typo — the DOM_REQUEST relay wrap kept the old
// IIFE closer `})();` instead of the call closer `});`, so every dispatch
// executed `enqueueDomRequestRelay(...)()` — invoking the returned PROMISE as
// a function. The queue had already enqueued (the relay itself worked, zero
// functional damage), but every single DOM_REQUEST dispatch threw
// synchronously: 167 "Error in event handler: enqueueDomRequestRelay(...) is
// not a function" in the offscreen/wizard consoles over one session.
//
// The 103c source-audit test matched the CALL text and missed the malformed
// invocation. This regression dispatches a REAL message through the REAL
// background.js onMessage handler in a vm — a sync throw fails the test
// regardless of how the call site is spelled.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BG_PATH = path.join(__dirname, '..', 'background.js');

function loadBackground() {
  const listeners = [];
  const noopL = { addListener: () => {}, removeListener: () => {} };
  const sent = [];
  const chrome = {
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn), removeListener: () => {} },
      onInstalled: noopL, onStartup: noopL,
      sendMessage: async (m) => { sent.push(m); },
      getContexts: async () => [],
      getURL: (p) => 'x/' + p,
      lastError: undefined
    },
    tabs: {
      onRemoved: noopL, onActivated: noopL, onUpdated: noopL, onCreated: noopL,
      sendMessage: async () => ({ ok: true }),
      create: async () => ({ id: 1 }), query: async () => [], update: async () => ({}), get: async () => ({})
    },
    storage: {
      local: { get: async () => ({}), set: async () => {}, onChanged: noopL },
      session: { get: async () => ({}), set: async () => {}, onChanged: noopL },
      onChanged: noopL
    },
    offscreen: { createDocument: async () => {}, hasDocument: async () => false },
    scripting: { executeScript: async () => [] },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, onClicked: noopL },
    alarms: { create: () => {}, onAlarm: noopL, clear: () => {} },
    windows: { onFocusChanged: noopL, getAll: async () => [], update: async () => ({}), onCreated: noopL, onRemoved: noopL },
    debugger: { attach: () => {}, sendCommand: () => {}, detach: () => {}, onDetach: noopL },
    webNavigation: { onCompleted: noopL, onHistoryStateUpdated: noopL },
    notifications: { create: () => {} }
  };
  const sandbox = {
    chrome,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    crypto, URL, URLSearchParams, TextEncoder, TextDecoder,
    navigator: {}, performance, Date, Promise, structuredClone,
    location: { href: 'chrome-extension://x/background.js' }
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.importScripts = (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(BG_PATH, 'utf8'), sandbox, { filename: 'background.js' });
  return { listeners, chrome };
}

describe('104th log: DOM_REQUEST dispatch through the real background handler', () => {
  it('a DOM_REQUEST message dispatches WITHOUT a synchronous throw (the 103c `})();` tail-typo)', () => {
    const { listeners } = loadBackground();
    assert.ok(listeners.length >= 1, 'main onMessage listener registered');
    let threw = null;
    try {
      listeners[listeners.length - 1](
        { type: 'DOM_REQUEST', _fromOffscreen: true, id: 't1', action: 'extractList', tabId: 123 },
        { tab: { id: 123 } },
        () => {}
      );
    } catch (e) { threw = e; }
    assert.ok(!threw, 'the handler must not throw synchronously — got: ' + (threw && threw.message));
  });
  it('two same-tab DOM_REQUESTs serialize without either dispatch throwing', async () => {
    const { listeners } = loadBackground();
    const send = (id) => {
      let err = null;
      try {
        listeners[listeners.length - 1](
          { type: 'DOM_REQUEST', _fromOffscreen: true, id, action: 'extractList', tabId: 123 },
          { tab: { id: 123 } },
          () => {}
        );
      } catch (e) { err = e; }
      assert.ok(!err, 'dispatch ' + id + ' threw: ' + (err && err.message));
    };
    send('a'); send('b');
    await new Promise((r) => setTimeout(r, 30));
  });
});
