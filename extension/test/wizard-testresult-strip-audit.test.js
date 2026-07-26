// Regression test for the RC9 audit. The stripSnapshotsFromTestResult helper
// exists because wizard.js's autoFix prompt overflows the LLM context window
// when testResult carries per-step snapshot.html fields (~150K each, ~750K
// total for a 5-step FB-shaped run). RC9 wrapped the helper around two of
// three JSON.stringify(wizardState.testResult) sites but missed the
// user-feedback branch's `currentOutput` dump (wizard.js:2546). That branch
// fires on the "Empty result detected, showing fix controls" path — exactly
// when the LLM most needs to see the small diagnostic signal (e.g.
// "container matched 0 element(s)") instead of 800K of feed HTML.
//
// console.log 2026-07-26 13:33:09 showed the autoFix-on-empty prompt at
// promptChars:845059 — the line 2546 regression was the cause.
//
// This test scans wizard.js source and asserts that EVERY occurrence of
// JSON.stringify on wizardState.testResult (or a `.testResult` reference)
// is wrapped in stripSnapshotsFromTestResult. If a future change adds a
// fourth raw dump site, this test will fail.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WIZARD_PATH = path.join(__dirname, '..', 'wizard.js');

describe('wizard.js testResult JSON.stringify sites all use stripSnapshotsFromTestResult', () => {
  const src = fs.readFileSync(WIZARD_PATH, 'utf8');

  it('every JSON.stringify of wizardState.testResult is wrapped in stripSnapshotsFromTestResult', () => {
    // Find every `JSON.stringify(...testResult...)` site. The call may span
    // multiple lines (the helper form is two lines: the helper call wraps
    // the inner testResult reference). Match on the JSON.stringify token
    // followed by (optional whitespace + stripSnapshotsFromTestResult( ··· )
    // OR an immediate testResult reference (the unsafe form).
    //
    // Strategy: find every JSON.stringify( occurrence and capture up to the
    // matching close paren, then assert that capture either (a) contains
    // stripSnapshotsFromTestResult OR (b) does NOT reference testResult.
    let i = 0;
    const bad = [];
    while (true) {
      const idx = src.indexOf('JSON.stringify(', i);
      if (idx < 0) break;
      // Walk forward to find the matching close paren at depth 0.
      let depth = 0;
      let end = -1;
      for (let j = idx + 'JSON.stringify('.length - 1; j < src.length; j++) {
        const ch = src[j];
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) { end = j + 1; break; }
        }
      }
      assert.ok(end > idx, 'unterminated JSON.stringify( in wizard.js');
      const callText = src.slice(idx, end);
      // Only audit sites that reference testResult. Other JSON.stringify
      // calls (e.g. JSON.stringify(steps, null, 2)) are out of scope.
      if (/testResult/.test(callText)) {
        if (!/stripSnapshotsFromTestResult/.test(callText)) {
          bad.push({ line: src.slice(0, idx).split('\n').length, call: callText });
        }
      }
      i = end;
    }
    assert.deepEqual(bad, [], 'Unwrapped JSON.stringify(...testResult...) sites found:\n' +
      bad.map(b => '  line ' + b.line + ': ' + b.call.split('\n').map(l => l.trim()).join(' ').slice(0, 200)).join('\n'));
  });

  it('stripSnapshotsFromTestResult is imported/available in wizard.js', () => {
    // Sanity: the helper must actually be in scope at the call sites.
    assert.match(src, /stripSnapshotsFromTestResult/);
  });
});
