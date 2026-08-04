// Regression for bugx.log 2026-07-25: the selector-diagnostics pipeline
// looked complete in source but produced selectorDiagnosticCount: 0 on every
// STEP_ITERATION in production logs. Root cause: two message-relay hops
// silently dropped the _diagnostics field from DOM_RESPONSE messages.
//
// The pipeline has four links:
//   1. content-script.js dom* helpers return {result, _diagnostics}
//   2. content-script.js DOM_REQUEST handler includes _diagnostics in DOM_RESPONSE
//   3. background.js relays DOM_RESPONSE → offscreen          ← was dropping _diagnostics
//   4. offscreen.js forwards DOM_RESPONSE → its sandbox iframe ← was dropping _diagnostics
//   5. sandbox.js reads e.data._diagnostics from DOM_RESPONSE, accumulates
//
// Links 1, 2, and 5 were verified by existing unit tests. Links 3 and 4 had
// NO test coverage and were silently broken from the original instrumentation
// commit (df44bfb / b93abbc) — the spec assumed content-script → sandbox was
// a direct hop, but the real architecture routes through background → offscreen.
//
// These tests exercise links 3 and 4 with stubbed chrome APIs and a JSDOM iframe.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function makeChromeStub() {
  const sentMessages = [];
  const messageListeners = [];
  const noop = function() {};
  // Minimal stubs for the classes background.js references at load time.
  // We only care about the DOM_RESPONSE relay path — anything else just
  // needs to not throw.
  class ServiceRegistry {
    constructor() { this._byName = new Map(); }
    async getByName() { return null; }
    async list() { return []; }
  }
  class LLMClient { constructor() {} chat() { return Promise.resolve(''); } }
  class OffscreenExecutor {
    constructor() { this.tabId = 0; this.timeoutMs = 1; }
    ensureOffscreenDocument() { return Promise.resolve(); }
    hasDocument() { return Promise.resolve(false); }
    closeDocument() { return Promise.resolve(); }
    wrapScript(code) { return code; }
    execute() { return Promise.resolve({ result: null, selectorDiagnostics: [] }); }
  }
  class UrlTemplate {
    static resolveTargetUrl(url) { return url; }
  }
  class StepOrchestrator {
    static async execute() { return { finalResult: null, steps: [] }; }
  }
  return {
    chrome: {
      runtime: {
        sendMessage: (msg) => {
          sentMessages.push(msg);
          return Promise.resolve();
        },
        onMessage: {
          addListener: (fn) => messageListeners.push(fn),
          removeListener: (fn) => {
            const i = messageListeners.indexOf(fn);
            if (i >= 0) messageListeners.splice(i, 1);
          }
        },
        onInstalled: { addListener: noop },
        onStartup: { addListener: noop },
        openOptionsPage: noop,
        getLastError: () => null,
        getURL: (p) => 'chrome-extension://x/' + p
      },
      storage: {
        local: {
          get: () => Promise.resolve({}),
          set: () => Promise.resolve()
        }
      },
      alarms: {
        create: noop,
        onAlarm: { addListener: noop }
      },
      action: { onClicked: { addListener: noop } },
      tabs: { remove: () => Promise.resolve() },
      offscreen: { createDocument: () => Promise.resolve() }
    },
    classes: { ServiceRegistry, LLMClient, OffscreenExecutor, UrlTemplate, StepOrchestrator },
    _sentMessages: sentMessages,
    _messageListeners: messageListeners,
    _emit(message, sender = { tab: { id: 1 } }) {
      for (const fn of messageListeners) {
        fn(message, sender, noop);
      }
    }
  };
}

describe('background.js DOM_RESPONSE relay preserves _diagnostics (RC2)', () => {
  it('forwards _diagnostics from content-script to offscreen', () => {
    const stub = makeChromeStub();
    const noop = function() {};
    const sandbox = {
      chrome: stub.chrome,
      ServiceRegistry: stub.classes.ServiceRegistry,
      LLMClient: stub.classes.LLMClient,
      OffscreenExecutor: stub.classes.OffscreenExecutor,
      UrlTemplate: stub.classes.UrlTemplate,
      StepOrchestrator: stub.classes.StepOrchestrator,
      debugLogger: { log: noop },
      importScripts: noop,
      console: { log: noop, error: noop, warn: noop },
      Date, JSON, URL, Promise, Error, Object, Array, Math,
      String, Number, Boolean, Map, Set, Symbol, parseInt, parseFloat,
      setTimeout, clearTimeout,
      AbortSignal: { timeout: () => ({}) },
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ type: 'HEARTBEAT' }) })
    };

    // Load background.js into the sandbox to register message listeners.
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);

    // Simulate a DOM_RESPONSE arriving from content-script with _diagnostics.
    const sampleDiagnostics = {
      api: 'extractList',
      containerSelector: 'div[role="article"]',
      containerMatches: 5,
      perField: [{ field: 'author', subSelector: 'h3 a', matchCount: 5, sampleTexts: ['Alice'], sampleHrefs: [] }]
    };
    stub._emit({
      type: 'DOM_RESPONSE',
      id: 'req-42',
      result: { posts: [] },
      error: null,
      _diagnostics: sampleDiagnostics,
      _fromOffscreen: true
    });

    const forwarded = stub._sentMessages.find(m => m.type === 'DOM_RESPONSE');
    assert.ok(forwarded, 'background should relay DOM_RESPONSE');
    assert.deepEqual(forwarded._diagnostics, sampleDiagnostics,
      'background must preserve _diagnostics — silent drop breaks selector-diagnostics pipeline');
    assert.equal(forwarded.id, 'req-42');
  });
});

// RC25 (console.log 2026-08-04): background should broadcast
// TRUSTED_WHEEL_SKIPPED to extension pages when a content-script emits a
// trustedWheel_skipped diagnostic. Without this surfacing, the user has no
// visible signal that scroll stalls + Enhanced Mode is off — only console
// logs (which they rarely check). The wizard listens for this broadcast and
// surfaces a post-run tip.
describe('background.js CONTENT_SCRIPT_DIAGNOSTIC broadcasts TRUSTED_WHEEL_SKIPPED (RC25)', () => {
  it('emits TRUSTED_WHEEL_SKIPPED broadcast when cat is trustedWheel_skipped', () => {
    const stub = makeChromeStub();
    const noop = function() {};
    const sandbox = {
      chrome: stub.chrome,
      ServiceRegistry: stub.classes.ServiceRegistry,
      LLMClient: stub.classes.LLMClient,
      OffscreenExecutor: stub.classes.OffscreenExecutor,
      UrlTemplate: stub.classes.UrlTemplate,
      StepOrchestrator: stub.classes.StepOrchestrator,
      debugLogger: { log: noop },
      importScripts: noop,
      console: { log: noop, error: noop, warn: noop },
      Date, JSON, URL, Promise, Error, Object, Array, Math,
      String, Number, Boolean, Map, Set, Symbol, parseInt, parseFloat,
      setTimeout, clearTimeout,
      AbortSignal: { timeout: () => ({}) },
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ type: 'HEARTBEAT' }) })
    };

    const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);

    // Emit a trustedWheel_skipped diagnostic from a content-script.
    stub._emit({
      type: 'CONTENT_SCRIPT_DIAGNOSTIC',
      category: 'trustedWheel_skipped',
      payload: { selector: 'div[role="main"]', reason: 'enhanced mode disabled' }
    });

    const broadcast = stub._sentMessages.find(m => m.type === 'TRUSTED_WHEEL_SKIPPED');
    assert.ok(broadcast, 'background must broadcast TRUSTED_WHEEL_SKIPPED');
    assert.equal(broadcast.payload.reason, 'enhanced mode disabled');
  });

  it('does NOT broadcast TRUSTED_WHEEL_SKIPPED for unrelated diagnostics', () => {
    const stub = makeChromeStub();
    const noop = function() {};
    const sandbox = {
      chrome: stub.chrome,
      ServiceRegistry: stub.classes.ServiceRegistry,
      LLMClient: stub.classes.LLMClient,
      OffscreenExecutor: stub.classes.OffscreenExecutor,
      UrlTemplate: stub.classes.UrlTemplate,
      StepOrchestrator: stub.classes.StepOrchestrator,
      debugLogger: { log: noop },
      importScripts: noop,
      console: { log: noop, error: noop, warn: noop },
      Date, JSON, URL, Promise, Error, Object, Array, Math,
      String, Number, Boolean, Map, Set, Symbol, parseInt, parseFloat,
      setTimeout, clearTimeout,
      AbortSignal: { timeout: () => ({}) },
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ type: 'HEARTBEAT' }) })
    };

    const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);

    // Emit a normal diagnostic (not trustedWheel_skipped).
    stub._emit({
      type: 'CONTENT_SCRIPT_DIAGNOSTIC',
      category: 'scrollToBottom_iter',
      payload: { attempt: 1, newY: 100 }
    });

    const broadcast = stub._sentMessages.find(m => m.type === 'TRUSTED_WHEEL_SKIPPED');
    assert.equal(broadcast, undefined,
      'unrelated diagnostics must not trigger TRUSTED_WHEEL_SKIPPED broadcast');
  });
});

describe('offscreen.js DOM_RESPONSE forward preserves _diagnostics (RC3)', () => {
  it('buildSandboxForwardPayload carries _diagnostics from background to sandbox', () => {
    // Set up JSDOM and chrome stubs so offscreen.js can be loaded into a
    // sandbox and expose buildSandboxForwardPayload on `self`.
    const dom = new JSDOM('<!DOCTYPE html><body></body>', {
      url: 'chrome-extension://x/offscreen.html'
    });
    const noop = function() {};
    const messageListeners = [];

    const sandbox = {
      chrome: {
        runtime: {
          sendMessage: () => Promise.resolve(),
          onMessage: { addListener: (fn) => messageListeners.push(fn), removeListener: noop },
          onInstalled: { addListener: noop },
          onStartup: { addListener: noop },
          getURL: (p) => 'chrome-extension://x/' + p
        },
        offscreen: { createDocument: () => Promise.resolve() }
      },
      console: { log: noop, error: noop, warn: noop },
      Date, JSON, URL, Promise, Error, Object, Array, Math,
      String, Number, Boolean, Map, Set, Symbol,
      parseInt, parseFloat,
      setTimeout: noop, clearTimeout: noop,
      document: dom.window.document,
      window: dom.window,
      self: dom.window,
      Node: dom.window.Node,
      MessageEvent: dom.window.MessageEvent,
      HTMLElement: dom.window.HTMLElement,
      Event: dom.window.Event
    };
    sandbox.window.postMessage = noop;  // offscreen.js doesn't call this at load time

    vm.createContext(sandbox);
    const src = fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8');
    vm.runInContext(src, sandbox);

    const build = sandbox.self.buildSandboxForwardPayload;
    assert.equal(typeof build, 'function',
      'offscreen.js should expose buildSandboxForwardPayload on self for testing');

    const sampleDiag = {
      api: 'extractList',
      containerSelector: 'div[role="article"]',
      containerMatches: 3,
      perField: [{ field: 'author', subSelector: 'h3 a', matchCount: 3, sampleTexts: ['A', 'B', 'C'], sampleHrefs: [] }]
    };

    const payload = build({
      type: 'DOM_RESPONSE',
      id: 'req-99',
      result: { posts: [] },
      error: null,
      _diagnostics: sampleDiag,
      _fromOffscreen: true
    });

    assert.equal(payload.type, 'DOM_RESPONSE');
    assert.equal(payload.id, 'req-99');
    assert.deepEqual(payload._diagnostics, sampleDiag,
      'offscreen must preserve _diagnostics in sandbox forward — silent drop breaks selector-diagnostics pipeline');
  });
});
