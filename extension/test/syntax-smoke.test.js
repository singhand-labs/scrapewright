// Smoke check: run `node --check` on every top-level extension JS file.
//
// These files are browser-side (they use document, chrome, window, etc.) so
// they can't be imported into node directly. A syntax error — like an
// unescaped backtick inside a template literal — would slip past the unit
// tests, which only require() from lib/. The first sign of the problem would
// be the extension failing to load at chrome://extensions/.
//
// bugx.log 2026-07-24 regression: an edit to wizard.js added backticks inside
// an existing template literal without escaping them. The browser reported
// "Uncaught SyntaxError: Unexpected identifier 'script'" at wizard.js:1111.
// This test makes `node --test` catch that class of bug before it ships.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const EXTENSION_DIR = path.resolve(__dirname, '..');

// Top-level browser JS files. lib/ files are covered by import in other tests
// (a syntax error there surfaces as a test failure when the test requires them).
const BROWSER_JS_FILES = fs.readdirSync(EXTENSION_DIR)
  .filter(f => f.endsWith('.js'))
  .map(f => path.join(EXTENSION_DIR, f));

describe('extension JS files parse cleanly under node --check', () => {
  for (const file of BROWSER_JS_FILES) {
    it(`node --check ${path.basename(file)}`, () => {
      // execFileSync throws on non-zero exit (i.e. syntax error). The thrown
      // error includes the parser's stderr, which names the file + line.
      try {
        execFileSync(process.execPath, ['--check', file], {
          stdio: 'pipe',
          encoding: 'utf8'
        });
      } catch (e) {
        const stderr = (e.stderr || e.message || '').trim();
        assert.fail(`${path.basename(file)} failed node --check:\n${stderr}`);
      }
    });
  }
});
