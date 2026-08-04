// Regression test for the RC22 fix.
//
// console.log 2026-08-03 11:43–11:57: FB extraction returned username:"" across
// four consecutive autoFix rounds, even though the user had annotated the
// username field at author time ("我之前还标注过"). Round 2 even extracted group
// correctly ("💓美女图分享💓") — proving the profile_name container existed —
// yet every attempt to derive the username selector failed.
//
// Root cause: wizard.js's user-feedback autoFix prompt builder (the path that
// fires when isFailureFix === false) constructs `allStepsContext` from each
// step's script but NEVER includes step.annotations. So when the user reports
// "field X missing", the LLM has access to:
//   - the broken script
//   - the cleaned full-page HTML
//   - the selector diagnostics (container match counts + RECORD HTML)
// ...but NOT the user-annotated selectors that were captured empirically at
// author time. The LLM is forced to guess selectors based on its training-data
// assumption of the site's DOM, and when that assumption is wrong (as it is
// for FB's specific profile_name layout), every round fails the same way.
//
// The failure-fix path (isFailureFix === true) does NOT have this bug — it
// dumps `Annotations: ${JSON.stringify(wizardState.annotations)}` at line ~2694.
// The user-feedback path missed this entirely.
//
// This test asserts:
//   1. wizard.js's allStepsContext builder references step.annotations
//   2. The reference flows through buildAnnotationsText (the existing
//      formatter that emits "selector: X ← USE THIS EXACT SELECTOR VERBATIM")
//   3. The fix lives in the user-feedback prompt range (not just failure-fix)
//
// Universality: this is a data-flow bug, not FB-specific. Any site where the
// user annotated a field would lose that annotation on the user-feedback path.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WIZARD_PATH = path.join(__dirname, '..', 'wizard.js');

describe('wizard.js user-feedback autoFix surfaces step.annotations', () => {
  const src = fs.readFileSync(WIZARD_PATH, 'utf8');

  it('allStepsContext builder references step.annotations', () => {
    // Locate the allStepsContext builder specifically (not any other
    // wizardState.steps.map — there are several in wizard.js).
    const mapIdx = src.indexOf('const allStepsContext = wizardState.steps.map(s => {');
    assert.ok(mapIdx > 0, 'allStepsContext builder not found');

    // Pull the builder body — up to the next `.join(\'\\n\\n\')`.
    const joinIdx = src.indexOf(".join('\\n\\n')", mapIdx);
    assert.ok(joinIdx > mapIdx, 'allStepsContext .join not found after .map');
    const builderBody = src.slice(mapIdx, joinIdx);

    assert.match(builderBody, /s\.annotations/, 'allStepsContext builder does NOT reference s.annotations — user-feedback autoFix loses annotation data');
  });

  it('annotations are formatted via buildAnnotationsText (not raw JSON.stringify)', () => {
    // Raw JSON.stringify(wizardState.annotations) is the failure-fix pattern
    // (line ~2694). The user-feedback path should use the structured
    // buildAnnotationsText formatter, which emits per-annotation lines with
    // the explicit "USE THIS EXACT SELECTOR VERBATIM" instruction.
    const mapIdx = src.indexOf('const allStepsContext = wizardState.steps.map(s => {');
    const joinIdx = src.indexOf(".join('\\n\\n')", mapIdx);
    const builderBody = src.slice(mapIdx, joinIdx);

    assert.match(builderBody, /buildAnnotationsText/, 'allStepsContext should format annotations via buildAnnotationsText');
  });

  it('buildAnnotationsText is in wizard.js scope (loaded via wizard.html)', () => {
    // Sanity: confirm the function name appears somewhere in wizard.js
    // (used or not). If a future refactor renames it, this guard fires.
    assert.match(src, /buildAnnotationsText/);
  });
});
