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

describe('SELECTOR COHERENCE rule (console.log 2026-08-23 second session)', () => {
  it('knowledge-units carry the selector-coherence rule with multi-step propagation', () => {
    const kuSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'knowledge-units.js'), 'utf8');
    const i = kuSrc.indexOf("id: 'selector-coherence'");
    assert.ok(i !== -1, 'selector-coherence unit missing');
    const body = kuSrc.slice(i, kuSrc.indexOf('id:', i + 10));
    assert.ok(/SAME selector string/.test(body), 'propagation instruction missing');
    assert.ok(/FULL step workflow/.test(body), 'full-workflow scan missing');
  });
});

describe('COUNT_SELECTOR_BLIND + invalid-selector augmentation in verify-runner (was testScript catch)', () => {
  const runnerSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'verify-runner.js'), 'utf8');
  it('failure path runs detectCountSelectorBlind on POLL_EXHAUSTED', () => {
    assert.ok(/detectCountSelectorBlind\(/.test(runnerSrc), 'detectCountSelectorBlind not called in verify-runner');
    assert.ok(/COUNT_SELECTOR_BLIND/.test(runnerSrc), 'COUNT_SELECTOR_BLIND marker missing');
  });

  it('failure path appends a standard-CSS hint on "is not a valid selector" errors', () => {
    assert.ok(/is not a valid selector/i.test(runnerSrc), 'invalid-selector branch missing');
    // The hint must name the Playwright pseudo-classes so the LLM recognizes
    // its own mistake.
    assert.ok(/:has-text/.test(runnerSrc), 'hint does not name :has-text(');
    assert.ok(/textContent/.test(runnerSrc), 'hint does not offer the textContent filter pattern');
  });

  it('success path checks detectClickInListEmptyContainers and throws CLICK_CONTAINERS_EMPTY', () => {
    assert.ok(/detectClickInListEmptyContainers\(/.test(runnerSrc), 'detectClickInListEmptyContainers not called');
    assert.ok(/CLICK_CONTAINERS_EMPTY/.test(runnerSrc), 'CLICK_CONTAINERS_EMPTY marker missing');
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
