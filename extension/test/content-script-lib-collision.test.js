// Regression test for content-script lib `const api` collision.
//
// manifest.json content_scripts entry loads these libs in a shared isolated
// world. Top-level lexical declarations (const/let) in one file collide with
// those in another file when V8 parses them in the same script context.
//
// User-reported symptom (2026-08-12):
//   "Uncaught SyntaxError: Identifier 'api' has already been declared
//    at lib/scroll-ops.js:1 (匿名函数)"
//   "[content-script] Using inline $extractList fallback — lib/list-extract-ops.js
//    did not attach window.ListExtractOps at call time."
//
// Root cause: three libs declared top-level `api` without IIFE-wrapping:
//   - selector-generator.js: `const api = {...}`
//   - list-extract-ops.js: `const api = {...}`
//   - scroll-ops.js: `var api = {...}`
//
// The collision silently takes down list-extract-ops.js and scroll-ops.js,
// forcing content-script.js to fall back to its inline copies. The inline
// copies have historically drifted from the libs (RC8/RC19/RC35), causing
// subtle extraction bugs.
//
// Fix: IIFE-wrap each lib (same pattern as list-pattern.js / scrape-tab.js /
// annotation-cluster.js / record-shape-distribution.js per RC30 part-2).
//
// This test loads all content-script libs in a single JSDOM/vm context to
// catch future regressions. If anyone adds a new lib with top-level `api`
// (or any other colliding name) without IIFE-wrapping, this test fails.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT_DIR = path.join(__dirname, '..');

// Libs loaded by manifest.json content_scripts[0].js (excluding content-script.js
// itself, which has its own top-level scope concerns we don't audit here).
const CONTENT_SCRIPT_LIBS = [
  'lib/iframe-selector.js',
  'lib/dom-cleaner.js',
  'lib/selector-generator.js',
  'lib/list-extract-ops.js',
  'lib/scroll-ops.js',
];

test('content-script libs load together without Identifier-already-declared SyntaxError', () => {
  const combined = CONTENT_SCRIPT_LIBS.map(rel =>
    fs.readFileSync(path.join(EXT_DIR, rel), 'utf8')
  ).join('\n');

  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.module = { exports: {} };

  try {
    vm.createContext(sandbox);
    vm.runInContext(combined, sandbox);
  } catch (e) {
    assert.fail(
      'Content-script lib collision: ' + (e && e.message) + '\n' +
      'One of ' + CONTENT_SCRIPT_LIBS.join(', ') + ' declares a top-level\n' +
      'lexical name that another lib also declares. Wrap the offending file\n' +
      'in an IIFE: (function (global) { ... })(typeof globalThis !== "undefined" ? globalThis : this);'
    );
  }

  // All three IIFE-wrapped libs must expose their globals.
  assert.ok(sandbox.SelectorGenerator, 'selector-generator.js must expose SelectorGenerator');
  assert.ok(sandbox.ListExtractOps, 'list-extract-ops.js must expose ListExtractOps');
  assert.ok(sandbox.ScrollOps, 'scroll-ops.js must expose ScrollOps');

  // Spot-check: each global has its expected API surface. This guards against
  // the IIFE wrap accidentally hiding a function that the content-script
  // relies on via window.X.
  assert.equal(typeof sandbox.SelectorGenerator.generateSelector, 'function');
  assert.equal(typeof sandbox.ListExtractOps.extractListRecords, 'function');
  assert.equal(typeof sandbox.ScrollOps.scrollToBottomIncremental, 'function');
});

test('each content-script lib with top-level api is IIFE-wrapped', () => {
  // Source-text audit: if anyone adds a top-level `const api` / `var api` /
  // `let api` to a content-script lib WITHOUT wrapping it in an IIFE, this
  // test fails. The audit is per-file (each file must independently wrap its
  // top-level api declaration in an IIFE).
  const files = [
    'lib/selector-generator.js',
    'lib/list-extract-ops.js',
    'lib/scroll-ops.js',
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(EXT_DIR, rel), 'utf8');
    const hasTopLevelApi = /^[ \t]*(const|var|let)\s+api\s*=/m.test(src);
    if (!hasTopLevelApi) continue;
    // If the file has a top-level api declaration, it MUST be wrapped in an
    // IIFE. Look for the IIFE open marker before the api declaration and the
    // IIFE close marker after it.
    const apiLine = src.match(/^[ \t]*(const|var|let)\s+api\s*=/m);
    assert.ok(apiLine, `${rel}: expected top-level api declaration`);
    const apiIdx = src.indexOf(apiLine[0]);
    const beforeApi = src.slice(0, apiIdx);
    const afterApi = src.slice(apiIdx);
    const hasIifeOpen = /\(\s*function\s*\(\s*global\s*\)\s*\{/.test(beforeApi);
    const hasIifeClose = /\}\s*\)\s*\(\s*(?:typeof\s+globalThis|globalThis|this)/.test(afterApi);
    assert.ok(hasIifeOpen && hasIifeClose,
      `${rel} has a top-level api declaration but is not IIFE-wrapped. ` +
      'This causes "Identifier \'api\' has already been declared" SyntaxError when loaded ' +
      'with other content-script libs. Wrap the file body in: ' +
      '(function (global) { ... })(typeof globalThis !== "undefined" ? globalThis : this);');
  }
});
