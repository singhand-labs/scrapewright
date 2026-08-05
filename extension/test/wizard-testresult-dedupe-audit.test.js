// Regression test for the 2026-08-05 dedupeStepIterations fix. The helper
// itself lives in lib/wizard-utils.js, but the autoFix prompt still overflowed
// the LLM context window at 1.2MB because polling-step iterations were
// duplicated in testResult.steps. Each iteration carried a growing accumulator
// (e.g. updatedPosts) — even after stripSnapshotsFromTestResult's 5K-per-field
// cap, 9 iterations × 10 posts × 5K = ~450K per polling step. Combined with
// other fields the stripped testResult was 885K, which autoFix prompt-inflated
// to 1.83MB on iteration 2 (console.log 2026-08-05 04:32). The LLM timed out 4
// consecutive times then returned finish_reason:model_context_window_exceeded.
//
// The fix keeps only the LAST entry per stepId. Intermediate polling results
// are diagnostic noise; the LLM only needs the final per-step state.
//
// This audit scans wizard.js + lib/wizard-utils.js source and asserts that
// EVERY JSON.stringify site that references testResult (the shape that carries
// the duplicated steps[]) is wrapped in dedupeStepIterations. If a future
// change adds a fourth raw dump site, this test will fail.
//
// Pattern follows test/wizard-testresult-strip-audit.test.js.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WIZARD_PATH = path.join(__dirname, '..', 'wizard.js');
const WIZARD_UTILS_PATH = path.join(__dirname, '..', 'lib', 'wizard-utils.js');

// Walk every JSON.stringify( call in `src`, capture the call text up to the
// matching close paren, and return the index/end pairs so callers can also
// read surrounding context.
function findJsonStringifyCalls(src) {
  const calls = [];
  let i = 0;
  while (true) {
    const idx = src.indexOf('JSON.stringify(', i);
    if (idx < 0) break;
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
    if (end < idx) break;
    calls.push({ idx, end, callText: src.slice(idx, end) });
    i = end;
  }
  return calls;
}

describe('dedupeStepIterations wraps every testResult JSON.stringify site (2026-08-05 regression guard)', () => {
  it('wizard.js: every JSON.stringify of testResult is wrapped in dedupeStepIterations', () => {
    const src = fs.readFileSync(WIZARD_PATH, 'utf8');
    const bad = [];
    for (const { idx, end, callText } of findJsonStringifyCalls(src)) {
      // Only audit sites that reference the wizardState.testResult shape.
      // Ignore individual step.result UI renderings (already slice(0,60)-capped).
      if (/testResult/.test(callText)) {
        if (!/dedupeStepIterations/.test(callText)) {
          bad.push({
            line: src.slice(0, idx).split('\n').length,
            call: callText.split('\n').map(l => l.trim()).join(' ').slice(0, 200)
          });
        }
      }
    }
    assert.deepEqual(bad, [],
      'Unwrapped JSON.stringify(...testResult...) sites in wizard.js:\n' +
      bad.map(b => '  line ' + b.line + ': ' + b.call).join('\n'));
  });

  it('lib/wizard-utils.js: summarizeFixIteration Result dump uses dedupeStepIterations', () => {
    // The summarizeFixIteration helper takes a result-shaped object (same
    // shape as wizardState.testResult). It is the only wizard-utils site that
    // serializes the full testResult shape into LLM-bound context. Scope the
    // audit to its function body to avoid false positives from other result
    // references (e.g. per-step diagnostic logs).
    const src = fs.readFileSync(WIZARD_UTILS_PATH, 'utf8');
    const fnIdx = src.indexOf('function summarizeFixIteration');
    assert.ok(fnIdx > 0, 'summarizeFixIteration function not found in lib/wizard-utils.js');
    // Function body ends at the next top-level function declaration.
    const nextFn = src.slice(fnIdx + 1).match(/\nfunction /);
    const fnEnd = nextFn ? fnIdx + 1 + nextFn.index : src.length;
    const fnBody = src.slice(fnIdx, fnEnd);

    const bad = [];
    for (const { idx, callText } of findJsonStringifyCalls(fnBody)) {
      // summarizeFixIteration has only one JSON.stringify — the Result dump.
      // It must wrap dedupeStepIterations around the result parameter.
      if (!/dedupeStepIterations/.test(callText)) {
        bad.push({
          line: fnBody.slice(0, idx).split('\n').length,
          call: callText.split('\n').map(l => l.trim()).join(' ').slice(0, 200)
        });
      }
    }
    assert.deepEqual(bad, [],
      'summarizeFixIteration Result dump missing dedupeStepIterations wrapper:\n' +
      bad.map(b => '  line ' + b.line + ': ' + b.call).join('\n'));
  });

  it('dedupeStepIterations is exported from lib/wizard-utils.js (all 3 export sites)', () => {
    const src = fs.readFileSync(WIZARD_UTILS_PATH, 'utf8');
    // CommonJS export
    assert.match(src, /module\.exports\s*=\s*\{[^}]*\bdedupeStepIterations\b/,
      'dedupeStepIterations missing from module.exports in lib/wizard-utils.js');
    // Browser window global
    assert.match(src, /window\.dedupeStepIterations\s*=\s*dedupeStepIterations/,
      'dedupeStepIterations missing from window.* export in lib/wizard-utils.js');
    // Web worker / service worker global
    assert.match(src, /self\.dedupeStepIterations\s*=\s*dedupeStepIterations/,
      'dedupeStepIterations missing from self.* export in lib/wizard-utils.js');
  });

  it('dedupeStepIterations appears at >=2 wizard.js call sites (testResultSection + currentOutput)', () => {
    // Sanity: the helper must actually be wired into the prompt-assembly path.
    // If both call sites were removed, the audit above would still pass
    // vacuously. This test fails if the wiring is unwired.
    const src = fs.readFileSync(WIZARD_PATH, 'utf8');
    const matches = src.match(/dedupeStepIterations\(/g) || [];
    assert.ok(matches.length >= 2,
      `expected >=2 dedupeStepIterations( call sites in wizard.js, got ${matches.length}`);
  });

  it('dedupeStepIterations appears at >=1 call site in lib/wizard-utils.js (summarizeFixIteration)', () => {
    const src = fs.readFileSync(WIZARD_UTILS_PATH, 'utf8');
    // Count call sites excluding the function definition and export assignments.
    const callSitePattern = /dedupeStepIterations\(/g;
    const allMatches = src.match(callSitePattern) || [];
    // Subtract the function definition `function dedupeStepIterations(`
    // (counted once) — leaves only true call sites.
    const defMatches = src.match(/function\s+dedupeStepIterations\s*\(/g) || [];
    const trueCallSites = allMatches.length - defMatches.length;
    // 1 real call site (summarizeFixIteration) + export sites use `=` not `(`.
    assert.ok(trueCallSites >= 1,
      `expected >=1 dedupeStepIterations( call site in lib/wizard-utils.js (besides the definition), got ${trueCallSites}`);
  });
});
