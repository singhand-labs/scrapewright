// Regression test for RC13 (console.log 2026-07-27 01:44 + 01:55):
//
// TWO compounding bugs were silently disabling the popup-window fix:
//
//   1. scrape-tab.js's top-level `var api = {...}` collided with
//      list-pattern.js's top-level `const api = {...}` in wizard.html's
//      shared global lexical environment. V8 throws "Identifier 'api' has
//      already been declared" at parse time, preventing the entire file
//      from executing — `createScrapeTab` was undefined, and the popup
//      window was never created. The wizard's tests continued to run via
//      stale chrome.tabs.create paths or Chrome's lenient handling, but
//      the throttling fix (RC12's whole point) was effectively disabled.
//
//   2. visibility-keepalive.js (new in RC13) had the same top-level
//      `const api = ...` collision. Wrapped in IIFE in the same fix.
//
// This test loads every wizard.html <script> tag in document order through
// a Node vm context (which uses V8 and faithfully reproduces the browser's
// shared-global-lexical-environment semantics), and asserts no SyntaxError
// is thrown. It also asserts `createScrapeTab` and `injectVisibilityKeepalive`
// are exposed as global free variables, since wizard.js calls them
// unqualified (`await createScrapeTab(url)`).
//
// The test ALSO simulates createScrapeTab end-to-end and asserts that
// chrome.scripting.executeScript is invoked with world:'MAIN' — that's the
// RC13 visibility-keepalive injection. Without this, the popup window is
// throttled the moment the user switches focus, defeating RC12.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXT_DIR = path.join(__dirname, '..');

const WIZARD_HTML_SCRIPT_ORDER = [
  'lib/service-registry.js',
  'lib/llm-client.js',
  'lib/offscreen-executor.js',
  'lib/script-executor.js',
  'lib/list-pattern.js',
  'lib/wizard-utils.js',
  'lib/dom-cleaner.js',
  'lib/url-template.js',
  'lib/step-orchestrator.js',
  'lib/visibility-keepalive.js',
  'lib/scrape-tab.js',
  'lib/debug-logger.js'
];

// Mirror the manifest's importScripts order. RC12 added scrape-tab.js;
// RC13 added visibility-keepalive.js BEFORE scrape-tab.js so the
// VisibilityKeepalive global is defined when createScrapeTab runs.
const BACKGROUND_IMPORT_ORDER = [
  'lib/service-registry.js',
  'lib/llm-client.js',
  'lib/offscreen-executor.js',
  'lib/url-template.js',
  'lib/step-orchestrator.js',
  'lib/wizard-utils.js',
  'lib/visibility-keepalive.js',
  'lib/scrape-tab.js',
  'lib/debug-logger.js'
];

function makeSandbox() {
  // Declare sandbox first so the executeScript closure can capture it by
  // reference. (Returning object literal directly makes `sandbox` a free
  // variable, which resolves to undefined at call time.)
  const sandbox = {
    window: {},
    document: {},
    chrome: {
      windows: {
        create: async (opts) => ({ id: 1, tabs: [{ id: 99, url: opts && opts.url }] })
      },
      // RC14: createScrapeTab's default path uses chrome.tabs.create({active:false})
      // (was: chrome.windows.create popup). Wire it to the same fake-tab
      // generator so the visibility-keepalive injection test stays meaningful.
      tabs: {
        create: async (opts) => ({ id: 99, url: opts && opts.url })
      },
      scripting: {
        executeScript: async (cfg) => {
          sandbox._lastExecuteScriptCfg = cfg;
          return [{ result: true }];
        }
      }
    },
    console: { log: () => {}, error: () => {}, warn: () => {} },
    setTimeout: () => 0,
    _lastExecuteScriptCfg: null
  };
  return sandbox;
}

function loadAllInSandbox(files) {
  const sandbox = makeSandbox();
  vm.createContext(sandbox);
  const failures = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(EXT_DIR, f), 'utf8');
    try {
      vm.runInContext(src, sandbox, { filename: f });
    } catch (e) {
      failures.push({ file: f, error: e.message });
    }
  }
  return { sandbox, failures };
}

describe('RC13 — scrape-tab.js + visibility-keepalive.js IIFE guards', () => {
  it('wizard.html script sequence loads every file without SyntaxError', () => {
    const { failures } = loadAllInSandbox(WIZARD_HTML_SCRIPT_ORDER);
    assert.deepEqual(failures, [],
      `Expected zero load failures, got: ${JSON.stringify(failures, null, 2)}. ` +
      `Most likely cause: a top-level \`var api\` or \`const api\` in one of these ` +
      `files collides with another file's same-named declaration in the shared ` +
      `global lexical environment. Wrap the offending file in an IIFE.`);
  });

  it('background.js importScripts sequence loads every file without SyntaxError', () => {
    const { failures } = loadAllInSandbox(BACKGROUND_IMPORT_ORDER);
    assert.deepEqual(failures, [],
      `Expected zero load failures, got: ${JSON.stringify(failures, null, 2)}`);
  });

  it('createScrapeTab is exposed as a global free variable (wizard.js calls it unqualified)', () => {
    const { sandbox, failures } = loadAllInSandbox(WIZARD_HTML_SCRIPT_ORDER);
    assert.deepEqual(failures, []);
    assert.equal(typeof sandbox.createScrapeTab, 'function',
      'createScrapeTab must be a global — wizard.js line 1748 calls it as a bare identifier');
  });

  it('injectVisibilityKeepalive is exposed as a global free variable', () => {
    const { sandbox, failures } = loadAllInSandbox(WIZARD_HTML_SCRIPT_ORDER);
    assert.deepEqual(failures, []);
    assert.equal(typeof sandbox.injectVisibilityKeepalive, 'function',
      'injectVisibilityKeepalive must be a global — scrape-tab.js references it as a bare identifier');
  });

  it('ScrapeTab module is exposed (window.ScrapeTab.createScrapeTab)', () => {
    const { sandbox, failures } = loadAllInSandbox(WIZARD_HTML_SCRIPT_ORDER);
    assert.deepEqual(failures, []);
    assert.equal(typeof sandbox.window.ScrapeTab, 'object');
    assert.equal(typeof sandbox.window.ScrapeTab.createScrapeTab, 'function');
  });

  it('VisibilityKeepalive module is exposed (window.VisibilityKeepalive.injectVisibilityKeepalive)', () => {
    const { sandbox, failures } = loadAllInSandbox(WIZARD_HTML_SCRIPT_ORDER);
    assert.deepEqual(failures, []);
    assert.equal(typeof sandbox.window.VisibilityKeepalive, 'object');
    assert.equal(typeof sandbox.window.VisibilityKeepalive.injectVisibilityKeepalive, 'function');
  });

  it('createScrapeTab triggers chrome.scripting.executeScript with world:"MAIN" (the visibility-keepalive injection)', async () => {
    const { sandbox, failures } = loadAllInSandbox(WIZARD_HTML_SCRIPT_ORDER);
    assert.deepEqual(failures, []);
    const tab = await sandbox.createScrapeTab('https://example.com');
    // The injection is fire-and-forget (Promise.resolve.catch). Wait one
    // macrotask so the Promise.resolve(injectVisibilityKeepalive(...)) chain
    // has a chance to invoke chrome.scripting.executeScript.
    await new Promise(r => setTimeout(r, 50));
    assert.ok(sandbox._lastExecuteScriptCfg,
      'createScrapeTab must trigger chrome.scripting.executeScript for visibility-keepalive');
    assert.equal(sandbox._lastExecuteScriptCfg.world, 'MAIN',
      `injection must use world:'MAIN' to override page-visible globals; got: ${sandbox._lastExecuteScriptCfg.world}`);
    assert.equal(sandbox._lastExecuteScriptCfg.injectImmediately, true,
      'injection must use injectImmediately:true to run before page scripts');
    assert.equal(typeof sandbox._lastExecuteScriptCfg.func, 'function',
      'injection must pass a function (pageWorldKeepalive) — not a file, to avoid web_accessible_resources overhead');
  });
});

// Verify the pageWorldKeepalive function actually overrides visibility APIs.
// Uses JSDOM to simulate a browser MAIN-world environment. The function
// source is extracted from visibility-keepalive.js via regex (so changes to
// the function body don't require updating a string copy here).
describe('RC13 — pageWorldKeepalive overrides visibility APIs', () => {
  const { JSDOM } = require('jsdom');

  function loadPageWorldKeepalive() {
    const src = fs.readFileSync(path.join(EXT_DIR, 'lib/visibility-keepalive.js'), 'utf8');
    const m = src.match(/function pageWorldKeepalive\(\) \{[\s\S]*?\n  \}/);
    assert.ok(m, 'pageWorldKeepalive function not found in lib/visibility-keepalive.js — has it been renamed?');
    return m[0];
  }

  function makeHiddenJsdom() {
    const dom = new JSDOM('<!DOCTYPE html><body></body></html>', { pretendToBeVisual: false });
    const { window } = dom;
    // Force hidden state — pretendToBeVisual:false usually gives 'hidden' but
    // JSDOM behavior varies; redefine explicitly so the test is deterministic.
    Object.defineProperty(window.document, 'visibilityState', { configurable: true, writable: true, value: 'hidden' });
    Object.defineProperty(window.document, 'hidden', { configurable: true, writable: true, value: true });
    // JSDOM with pretendToBeVisual:false does not define requestAnimationFrame,
    // but pageWorldKeepalive starts a rAF keep-alive loop. Stub it so the
    // function runs to completion in the test environment.
    if (typeof window.requestAnimationFrame !== 'function') {
      window.requestAnimationFrame = () => 0;
    }
    // pageWorldKeepalive also schedules a 1s setInterval. Without stubbing
    // setInterval, the interval keeps the Node event loop alive after the
    // test completes, causing `node --test` to hang until its external
    // timeout kills it. We're verifying the override logic, not the timer —
    // return a sentinel id without actually scheduling.
    window.setInterval = () => 0;
    return window;
  }

  it('overrides document.visibilityState to "visible"', () => {
    const fnSrc = loadPageWorldKeepalive();
    const window = makeHiddenJsdom();
    assert.equal(window.document.visibilityState, 'hidden', 'precondition: simulate hidden tab');
    vm.createContext(window);
    vm.runInContext(fnSrc + '\npageWorldKeepalive();', window);
    assert.equal(window.document.visibilityState, 'visible');
    assert.equal(window.document.hidden, false);
  });

  it('overrides document.hasFocus() to return true', () => {
    const fnSrc = loadPageWorldKeepalive();
    const window = makeHiddenJsdom();
    vm.createContext(window);
    vm.runInContext(fnSrc + '\npageWorldKeepalive();', window);
    assert.equal(window.document.hasFocus(), true);
  });

  it('is idempotent — running twice does not stack intervals/rAF loops', () => {
    const fnSrc = loadPageWorldKeepalive();
    const window = makeHiddenJsdom();
    vm.createContext(window);
    vm.runInContext(fnSrc + '\npageWorldKeepalive();\npageWorldKeepalive();', window);
    assert.equal(window.__SCRAPEWRIGHT_VISIBILITY_KEEPALIVE__, true,
      '__SCRAPEWRIGHT_VISIBILITY_KEEPALIVE__ sentinel must be set to prevent re-entry');
  });

  it('overrides are read-only — page cannot reset visibilityState via assignment', () => {
    const fnSrc = loadPageWorldKeepalive();
    const window = makeHiddenJsdom();
    vm.createContext(window);
    vm.runInContext(fnSrc + '\npageWorldKeepalive();', window);
    vm.runInContext('document.visibilityState = "hidden"; document.hidden = true;', window);
    assert.equal(window.document.visibilityState, 'visible',
      'page assignment to visibilityState must be ignored — getter is read-only');
    assert.equal(window.document.hidden, false,
      'page assignment to hidden must be ignored — getter is read-only');
  });
});
