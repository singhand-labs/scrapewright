// Source-text audit for the "Edit Steps → re-annotate as refinement" change.
//
// Before this change: generateStepScript (wizard.js) did not receive the
// current step.script. Re-annotating a step always regenerated from scratch,
// silently discarding any refinements the user had accumulated via autoFix.
//
// After this change: generateStepScript accepts an optional currentScript
// parameter. When non-empty, the prompt includes a [CURRENT SCRIPT] block +
// refinement framing; when empty, behavior is unchanged (first-time
// annotation).
//
// These tests assert the source-level invariants:
//   1. The prompt template includes the literal `[CURRENT SCRIPT]` and the
//      word `refine` somewhere nearby.
//   2. The [CURRENT SCRIPT] block is gated on currentScript being truthy
//      (so first-time annotation does NOT see the block).
//   3. _completeStepAnnotationInner passes step.script as the 6th argument.
//
// Pattern follows test/wizard-user-feedback-annotations-audit.test.js.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WIZARD_PATH = path.join(__dirname, '..', 'wizard.js');

describe('wizard.js generateStepScript treats re-annotation as refinement', () => {
  const src = fs.readFileSync(WIZARD_PATH, 'utf8');

  it('generateStepScript accepts a 6th currentScript parameter', () => {
    // The signature must accept currentScript as the 6th positional parameter
    // with a default of '' (so existing 5-arg calls still work).
    const sigMatch = src.match(/async function generateStepScript\(([^)]*)\)/);
    assert.ok(sigMatch, 'generateStepScript function signature not found');
    const params = sigMatch[1].split(',').map(s => s.trim());
    assert.ok(params.length >= 6,
      `generateStepScript must accept at least 6 parameters, got ${params.length}: ${sigMatch[1]}`);
    assert.equal(params[5], "currentScript = ''",
      `6th parameter must be ` + `"currentScript = ''"` + ` (got: ${params[5]})`);
  });

  it('prompt template includes [CURRENT SCRIPT] literal and refinement framing, gated on currentScript', () => {
    // The literal `[CURRENT SCRIPT]` must appear in source, AND it must be
    // inside a currentScript-conditional block. Otherwise either the
    // refinement block is missing entirely, or it's always included (which
    // would regress the first-time-annotation path).
    const literalIdx = src.indexOf('[CURRENT SCRIPT]');
    assert.ok(literalIdx > 0, '[CURRENT SCRIPT] literal missing from source');

    // Walk backwards up to 300 chars looking for `currentScript ?` — the
    // ternary that gates the block. Must be present so the block is conditional.
    const windowStart = Math.max(0, literalIdx - 300);
    const window = src.slice(windowStart, literalIdx);
    assert.match(window, /currentScript\s*\?/,
      '[CURRENT SCRIPT] block must be gated on a `currentScript ?` ternary within 300 chars before the literal');

    // The word `refine` must appear somewhere after the literal (in the
    // framing text that tells the LLM how to treat the block).
    const afterWindow = src.slice(literalIdx, literalIdx + 800);
    assert.match(afterWindow, /refine/i,
      '"refine" framing missing after [CURRENT SCRIPT] literal — LLM has no instruction to treat the block as a refinement baseline');

    // The "annotation wins" rule must be present so the LLM knows user
    // annotations override stale selectors in the current script.
    assert.match(afterWindow, /annotation wins/i,
      '"annotation wins" rule missing — LLM may blindly copy stale selectors from current script');
  });

  it('_completeStepAnnotationInner passes step.script as 6th arg to generateStepScript', () => {
    // Locate _completeStepAnnotationInner (the only call site that should
    // pass a non-test currentScript). Within its body, find the call to
    // generateStepScript(...) and verify the 6th argument is step.script.
    const fnIdx = src.indexOf('async function _completeStepAnnotationInner');
    assert.ok(fnIdx > 0, '_completeStepAnnotationInner function not found');

    // Function body ends at the next top-level `async function` or
    // `function ` declaration. Find a reasonable window.
    const nextFnMatch = src.slice(fnIdx + 1).match(/\nasync function |\nfunction /);
    const fnEnd = nextFnMatch ? fnIdx + 1 + nextFnMatch.index : src.length;
    const fnBody = src.slice(fnIdx, fnEnd);

    const callIdx = fnBody.indexOf('generateStepScript(');
    assert.ok(callIdx > 0, 'generateStepScript call not found inside _completeStepAnnotationInner');

    // Walk forward from the call to find the matching close paren at depth 0.
    let depth = 0;
    let callEnd = -1;
    for (let i = callIdx + 'generateStepScript('.length - 1; i < fnBody.length; i++) {
      const ch = fnBody[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) { callEnd = i; break; }
      }
    }
    assert.ok(callEnd > 0, 'could not find end of generateStepScript call');
    const callInner = fnBody.slice(callIdx + 'generateStepScript('.length, callEnd);
    const args = callInner.split(',').map(s => s.trim());
    assert.ok(args.length >= 6,
      `generateStepScript call must pass at least 6 args, got ${args.length}: ${callInner}`);
    assert.equal(args[5], 'step.script',
      `6th argument must be step.script (got: ${args[5]}) — without this, re-annotation loses the current script baseline`);
  });
});
