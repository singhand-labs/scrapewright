// Regression for console.log 2026-08-23 (second session, 14:19-14:54). Three
// prompt-layer gaps let one broken selector destroy the whole session:
//
// 1. autoFix fixed step 2's list selector but steps 3/4 kept the identical
//    broken string — the failure-path prompt explicitly said "only edit this
//    step's own fields". SELECTOR COHERENCE rule + multi-step patch option
//    must now exist in the prompt.
// 2. POLL_EXHAUSTED arrived with a fully-blind selector history (20
//    iterations, every selector 0-match); testScript must augment it with
//    COUNT_SELECTOR_BLIND evidence.
// 3. The LLM invented Playwright pseudo-classes (:has-text(...)) — invalid
//    CSS that killed the step instantly. testScript must append a
//    standard-CSS hint when the error says "is not a valid selector", and the
//    DSL guide must teach STANDARD CSS ONLY.
// 4. clickInList with a 0-match container selector silently returned
//    done:true — CLICK_CONTAINERS_EMPTY must be checked in testScript's
//    success path.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const wizardSrc = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');
const utilsSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wizard-utils.js'), 'utf8');

describe('SELECTOR COHERENCE prompt rule (console.log 2026-08-23 second session)', () => {
  it('failure-path autoFix prompt teaches SELECTOR COHERENCE with multi-step propagation', () => {
    assert.ok(/SELECTOR COHERITY|SELECTOR COHERENCE/.test(wizardSrc), 'SELECTOR COHERENCE rule missing');
    // The rule must instruct propagating the same fixed selector to every
    // step that references the broken one — not just name the concept.
    assert.ok(/every OTHER step|every other step/.test(wizardSrc), 'propagation instruction missing');
  });

  it('RETURN_FORMAT offers a multi-step patches option on the failure path', () => {
    // Option (C): {"patches":[{stepId, script}...]} for selector propagation.
    const m = wizardSrc.match(/RETURN FORMAT — choose ONE:[\s\S]{0,2500}/);
    assert.ok(m, 'RETURN FORMAT block not found');
    assert.ok(/"patches"/.test(m[0]), 'patches array option missing from RETURN FORMAT');
  });

  it('the old "only edit this step" constraint carves out the selector exception', () => {
    const m = wizardSrc.match(/Do NOT add or remove steps[^]*?\n\n/);
    assert.ok(m, 'step-edit constraint not found');
    const constraint = wizardSrc.match(/only edit this step's own fields[^.]*\./);
    assert.ok(constraint, 'constraint sentence not found');
    // Near the constraint there must be an EXCEPTION/SELECTOR COHERENCE mention.
    const idx = wizardSrc.indexOf("only edit this step's own fields");
    const window = wizardSrc.slice(idx, idx + 1200);
    assert.ok(/SELECTOR COHERENCE/.test(window), 'constraint lacks the selector-propagation exception nearby');
  });
});

describe('COUNT_SELECTOR_BLIND + invalid-selector augmentation in testScript catch', () => {
  it('catch path runs detectCountSelectorBlind on POLL_EXHAUSTED', () => {
    assert.ok(/detectCountSelectorBlind\(/.test(wizardSrc), 'detectCountSelectorBlind not called in wizard.js');
    assert.ok(/COUNT_SELECTOR_BLIND/.test(wizardSrc), 'COUNT_SELECTOR_BLIND marker missing');
  });

  it('catch path appends a standard-CSS hint on "is not a valid selector" errors', () => {
    assert.ok(/is not a valid selector/i.test(wizardSrc), 'invalid-selector branch missing');
    // The hint must name the Playwright pseudo-classes so the LLM recognizes
    // its own mistake.
    assert.ok(/:has-text/.test(wizardSrc), 'hint does not name :has-text(');
    assert.ok(/textContent/.test(wizardSrc), 'hint does not offer the textContent filter pattern');
  });

  it('success path checks detectClickInListEmptyContainers and throws CLICK_CONTAINERS_EMPTY', () => {
    assert.ok(/detectClickInListEmptyContainers\(/.test(wizardSrc), 'detectClickInListEmptyContainers not called');
    assert.ok(/CLICK_CONTAINERS_EMPTY/.test(wizardSrc), 'CLICK_CONTAINERS_EMPTY marker missing');
  });
});

describe('wizard-utils exports for the new detectors', () => {
  it('module.exports includes both detectors', () => {
    const mod = require('../lib/wizard-utils');
    assert.equal(typeof mod.detectCountSelectorBlind, 'function');
    assert.equal(typeof mod.detectClickInListEmptyContainers, 'function');
  });

  it('clickInList diagnostic summary flags 0-container calls', () => {
    assert.ok(/CONTAINER selector itself matched nothing|container selector itself matched nothing/.test(utilsSrc),
      'summarizeAllStepDiagnostics does not flag 0-container clickInList');
  });
});

describe('universality — no site-specific names in new texts', () => {
  it('wizard-utils.js contains no forbidden site tokens', () => {
    const forbidden = ['facebook', 'twitter', 'linkedin', 'tiktok', 'reddit', 'fb'];
    for (const term of forbidden) {
      assert.ok(!new RegExp(term, 'i').test(utilsSrc), `site-specific term "${term}" present`);
    }
  });
});
