// RC42 audit: scalar-empty fallback in background.js.
//
// Console.log 2026-08-12 incident: step graph
//   1 wait → 2 scroll → 3 expand → 4 extract_posts ($extractListMulti)
//   → 5 hover_enrich ($hover writing accountInfoHtml + groupInfoHtml)
//   → 6 parse_and_output (pass-through)
//
// Step 5's $hover calls were wrapped in try/catch with empty catch blocks.
// The hovers silently failed (popover never matched), the script returned
// {done:true, accountInfoHtml:"", groupInfoHtml:""}, and the orchestrator
// saw a clean success. validateOutputAgainstSchema fired
// REQUIRED_OUTPUT_MISSING but the prior code returned failure directly —
// autoFix never got a chance to repair the producing step.
//
// This file audits that:
// 1. background.js's REQUIRED_OUTPUT_MISSING path throws a synthetic error
//    (so it enters the catch block) when a target step can be found.
// 2. The catch path's shouldAutoFix gate accepts REQUIRED_OUTPUT_MISSING.
//
// Source-text audit pattern: service-worker code cannot be unit-tested
// directly (chrome.* dependency), so we verify the wiring by grepping the
// source for the diagnostic markers of the fix.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('RC42: background.js routes REQUIRED_OUTPUT_MISSING through autoFix', () => {
  it('throws a synthetic error with stepId when target step is found', () => {
    // The fix constructs a synthetic Error, sets .stepId and .code, then
    // throws — entering the catch block where shouldAutoFix can act on it.
    // Look for the three diagnostic markers together: the code assignment,
    // the stepId assignment, and the throw.
    const src = readSrc('background.js');

    // Find the validateOutputAgainstSchema block.
    const validateIdx = src.indexOf('validateOutputAgainstSchema(result.finalResult');
    assert.ok(validateIdx > -1, 'validateOutputAgainstSchema call must exist');
    // Slice up to the next 4000 chars (block boundary).
    const block = src.slice(validateIdx, validateIdx + 4000);

    assert.ok(/syntheticErr.*stepId\s*=/.test(block) || /\.stepId\s*=\s*targetStepId/.test(block),
      'REQUIRED_OUTPUT_MISSING path must set stepId on the synthetic error so the catch block can route it to autoFix. ' +
      'Look for: syntheticErr.stepId = targetStepId');

    assert.ok(/syntheticErr.*code\s*=\s*['"]REQUIRED_OUTPUT_MISSING['"]/.test(block) ||
      /\.code\s*=\s*['"]REQUIRED_OUTPUT_MISSING['"]/.test(block),
      'synthetic error must carry code "REQUIRED_OUTPUT_MISSING" so the catch path identifies it.');

    assert.ok(/\bthrow\s+syntheticErr\b/.test(block),
      'synthetic error must be thrown to enter the catch path. Look for: throw syntheticErr');
  });

  it('extends shouldAutoFix gate to accept REQUIRED_OUTPUT_MISSING', () => {
    // Without this gate extension, even if the synthetic error reaches the
    // catch block, shouldAutoFix returns false and autoFix is skipped.
    const src = readSrc('background.js');
    const gateIdx = src.indexOf('shouldAutoFix');
    assert.ok(gateIdx > -1, 'shouldAutoFix must exist');
    // Slice the gate expression (a few hundred chars covers the boolean).
    const gate = src.slice(gateIdx, gateIdx + 600);

    assert.ok(/REQUIRED_OUTPUT_MISSING/.test(gate),
      'shouldAutoFix must include REQUIRED_OUTPUT_MISSING in its autoFix-eligible conditions. ' +
      'Without this, scalar-empty failures return without attempting autoFix even when a producer step is identified.');
  });

  it('uses findUpstreamProducingStepId to locate the target step', () => {
    // The producing-step walker matches $hover/$extract/$extractList/
    // $extractListMulti/$list. Without it, the synthetic error would fall
    // back to the last step (the pass-through finalizer), and autoFix would
    // rewrite the wrong step.
    const src = readSrc('background.js');
    assert.ok(/findUpstreamProducingStepId\s*\(/.test(src),
      'background.js must call findUpstreamProducingStepId to locate the step that produces the missing fields. ' +
      'findUpstreamExtractionStepId only matches $extractList/$extractListMulti/$list (ARRAY primitives) — ' +
      '$hover / $extract steps would be invisible and autoFix would mis-target.');
  });
});
