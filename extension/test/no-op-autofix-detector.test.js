// Regression for console.log 2026-08-04 04:50-04:52 FB username bug.
//
// SYMPTOM: user-feedback autoFix looped without progress:
//   round 1 output: posts[1].username === "AI人工智能 & 機器人" (the group name)
//   user feedback: "第二条帖子的用户名是Mamur Obaid"
//   LLM ACK (round 2): "// ACK: The script incorrectly assigned the group
//       name ... to the username field ... I will fix the extraction logic
//       to correctly distinguish between group and user links"
//   LLM response body: IDENTICAL script to round 1 (char-for-char,
//       scriptLength 2640 → 2640)
//   round 2 output: same wrong username
//   (next iteration would have consumed a 2nd autoFix attempt with zero progress)
//
// ROOT CAUSE: runFixIteration parsed the response into patches and committed
// them without checking "is this patch identical to the current step?" The
// LLM ACK'd a fix, returned the same code, and the framework silently re-ran
// it. The outer autoFix loop just saw "testScript failed" → retried, burning
// the attempt budget without any signal that the LLM was going in circles.
//
// FIX: isNoOpAutoFixPatch — returns true when EVERY resolved patch leaves its
// step unchanged (script + flow fields). runFixIteration uses this to:
//   (1) skip the wasteful testScript re-run
//   (2) inject an explicit [NO-OP DETECTED] user-role message into llmHistory
//       so the next iteration's prompt tells the LLM "you returned the same
//       script — you MUST change it"
//   (3) return false so the outer loop either retries with the new signal or
//       gives up cleanly
//
// UNIVERSALITY: this is NOT FB-specific. Any site, any step, any LLM can
// ACK-without-fixing. The detector catches the universal antipattern.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isNoOpAutoFixPatch } = require('../lib/wizard-utils');

// Build a resolved-patch entry like the ones resolveAutoFixTargets returns,
// and the corresponding patchedById Map that runFixIteration builds.
function makeFixture(currentStep, patchOverrides) {
  const patch = { script: currentStep.script, ...(patchOverrides || {}) };
  const proposed = { ...currentStep };
  if (typeof patch.script === 'string') proposed.script = patch.script;
  if (typeof patch.onSuccess === 'string' && patch.onSuccess.trim()) proposed.onSuccess = patch.onSuccess.trim();
  if (typeof patch.onFailure === 'string' && patch.onFailure.trim()) proposed.onFailure = patch.onFailure.trim();
  if (Number.isInteger(patch.maxIterations) && patch.maxIterations >= 1) proposed.maxIterations = patch.maxIterations;
  const resolved = { step: currentStep, patch };
  const patchedById = new Map([[currentStep.id, { proposed, resolved }]]);
  return { resolved: [resolved], patchedById };
}

const STEP = {
  id: '4',
  name: 'extract_posts',
  script: 'const x = await $list("div"); return { posts: x };',
  onSuccess: 'TERMINATE',
  onFailure: 'TERMINATE',
  maxIterations: 1
};

describe('isNoOpAutoFixPatch — detects ACK-without-fixing antipattern', () => {
  it('returns true when patch script === current script and no flow change', () => {
    const { resolved, patchedById } = makeFixture(STEP, { script: STEP.script });
    assert.equal(isNoOpAutoFixPatch(resolved, patchedById), true);
  });

  it('returns false when patch script is different', () => {
    const { resolved, patchedById } = makeFixture(STEP, {
      script: 'const y = await $list("article"); return { posts: y };'
    });
    assert.equal(isNoOpAutoFixPatch(resolved, patchedById), false);
  });

  it('returns false when script is the same but onSuccess changed', () => {
    const { resolved, patchedById } = makeFixture(STEP, {
      script: STEP.script,
      onSuccess: '5'
    });
    assert.equal(isNoOpAutoFixPatch(resolved, patchedById), false);
  });

  it('returns false when script is the same but onFailure changed', () => {
    const { resolved, patchedById } = makeFixture(STEP, {
      script: STEP.script,
      onFailure: 'TERMINATE_RECOVER'
    });
    assert.equal(isNoOpAutoFixPatch(resolved, patchedById), false);
  });

  it('returns false when script is the same but maxIterations changed', () => {
    const { resolved, patchedById } = makeFixture(STEP, {
      script: STEP.script,
      maxIterations: 10
    });
    assert.equal(isNoOpAutoFixPatch(resolved, patchedById), false);
  });

  it('returns true for multi-patch only when EVERY patch is a no-op', () => {
    const stepA = { ...STEP, id: '4' };
    const stepB = { ...STEP, id: '5', script: 'return { done: true };' };
    const resolved = [
      { step: stepA, patch: { script: stepA.script } },
      { step: stepB, patch: { script: stepB.script } }
    ];
    const patchedById = new Map([
      [stepA.id, { proposed: { ...stepA }, resolved: resolved[0] }],
      [stepB.id, { proposed: { ...stepB }, resolved: resolved[1] }]
    ]);
    assert.equal(isNoOpAutoFixPatch(resolved, patchedById), true,
      'both patches no-op → true');
    // Now make stepB's patch actually different
    resolved[1].patch.script = 'return { done: false };';
    patchedById.get(stepB.id).proposed.script = 'return { done: false };';
    assert.equal(isNoOpAutoFixPatch(resolved, patchedById), false,
      'one of two patches changes something → false');
  });

  it('is robust to empty / malformed inputs (returns false)', () => {
    assert.equal(isNoOpAutoFixPatch([], new Map()), false);
    assert.equal(isNoOpAutoFixPatch(null, new Map()), false);
    assert.equal(isNoOpAutoFixPatch([{ step: STEP, patch: {} }], new Map()), false,
      'patchedById missing the entry → false (conservative, not a no-op)');
  });

  it('treats whitespace-only script differences as no-op (LLM trailing newline)', () => {
    // LLM often appends a trailing newline. "abc" === "abc\n" semantically
    // but not ===. A real fix changes more than trailing whitespace, so we
    // should still trim-compare to avoid false negatives (which would cause
    // the detector to miss real no-ops).
    const { resolved, patchedById } = makeFixture(STEP, {
      script: STEP.script + '\n\n'
    });
    assert.equal(isNoOpAutoFixPatch(resolved, patchedById), true,
      'trailing whitespace differences should still count as no-op');
  });
});

// Source-text audit: SCRIPT_DSL_GUIDE must teach the LLM that returning the
// same script char-for-char is forbidden, and must mention the NACK escape
// hatch (so the LLM can decline to fix rather than fake-fix).
describe('SCRIPT_DSL_GUIDE — no-op fix prevention rule', () => {
  const UTILS_PATH = path.join(__dirname, '..', 'lib', 'wizard-utils.js');

  function loadScriptDslGuide() {
    const src = fs.readFileSync(UTILS_PATH, 'utf8');
    const startIdx = src.indexOf('SCRIPT_DSL_GUIDE');
    assert.ok(startIdx > -1, 'wizard-utils.js: SCRIPT_DSL_GUIDE not found');
    const eqIdx = src.indexOf('=', startIdx);
    const btIdx = src.indexOf('`', eqIdx);
    assert.ok(btIdx > -1, 'wizard-utils.js: SCRIPT_DSL_GUIDE opening backtick not found');
    const endMarker = '`;';
    const endIdx = src.indexOf(endMarker, btIdx + 1);
    assert.ok(endIdx > btIdx, 'wizard-utils.js: SCRIPT_DSL_GUIDE closing backtick-semicolon not found');
    return src.slice(btIdx + 1, endIdx);
  }

  it('warns the LLM not to return the same script char-for-char', () => {
    const guide = loadScriptDslGuide();
    // Look for any phrasing that conveys "don't return identical code".
    // Accept several wordings so a future copy edit doesn't silently break
    // the audit.
    assert.match(
      guide,
      /same\s+script|identical\s+(script|code)|do\s+not\s+return\s+the\s+same|never\s+return\s+the\s+same/i,
      'SCRIPT_DSL_GUIDE must warn the LLM against returning the same script char-for-char'
    );
  });

  it('references NACK as the escape hatch when the LLM cannot see a fix', () => {
    const guide = loadScriptDslGuide();
    // The ACK/NACK protocol is the LLM's way of signaling "I see the problem"
    // (ACK) vs "I cannot fix this" (NACK). NACK prevents the no-op loop by
    // telling the framework to stop retrying instead of faking a fix.
    assert.match(
      guide,
      /NACK/,
      'SCRIPT_DSL_GUIDE must mention NACK as the escape hatch for "I cannot fix this"'
    );
  });
});
