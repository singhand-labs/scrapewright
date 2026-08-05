// Source-text audit for the 2026-08-05 no-op escalation wiring.
//
// console.log 2026-08-05 07:13–07:22: autoFix stuck in a no-op loop. The
// LLM returned byte-identical 3785-char responses across 3 iterations for
// similar user feedback. The framework detected the no-op correctly but
// could not break the loop because [NO-OP DETECTED] in llmHistory was the
// only signal — the LLM ignored it (likely proxy cache or attention anchor).
//
// The fix adds 3 wiring points in wizard.js + a new helper in wizard-utils.js.
// These audits prevent regression by checking the source-level invariants.
//
// Pattern follows test/wizard-testresult-strip-audit.test.js.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WIZARD_PATH = path.join(__dirname, '..', 'wizard.js');
const WIZARD_UTILS_PATH = path.join(__dirname, '..', 'lib', 'wizard-utils.js');

describe('wizard.js no-op escalation wiring (2026-08-05 regression guard)', () => {
  const src = fs.readFileSync(WIZARD_PATH, 'utf8');

  it('wizardState has consecutiveNoOpCount and lastNoOpFeedback fields', () => {
    // Without these state fields the escalation cannot track repeats.
    // Both must be initialized so the first read returns 0/null, not undefined.
    assert.match(src, /consecutiveNoOpCount:\s*0/,
      'wizardState.consecutiveNoOpCount must be initialized to 0');
    assert.match(src, /lastNoOpFeedback:\s*null/,
      'wizardState.lastNoOpFeedback must be initialized to null');
  });

  it('isNoOpAutoFixPatch branch calls registerNoOpForFeedback', () => {
    // The no-op detection branch must register the no-op with the feedback
    // text so the NEXT iteration knows to inject the escalation warning.
    // Find the isNoOpAutoFixPatch call and verify registerNoOpForFeedback
    // is invoked within its block.
    const noopIdx = src.indexOf('isNoOpAutoFixPatch(target.resolved, patchedById)');
    assert.ok(noopIdx > 0, 'isNoOpAutoFixPatch call not found');

    // Walk forward to find the end of the if-block (closing brace at depth 0).
    const ifStart = src.lastIndexOf('if', noopIdx);
    let depth = 0;
    let blockEnd = -1;
    let inBlock = false;
    for (let i = ifStart; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') { depth++; inBlock = true; }
      else if (ch === '}') {
        depth--;
        if (inBlock && depth === 0) { blockEnd = i; break; }
      }
    }
    assert.ok(blockEnd > noopIdx, 'could not find end of isNoOpAutoFixPatch if-block');
    const blockBody = src.slice(ifStart, blockEnd);
    assert.match(blockBody, /registerNoOpForFeedback\(/,
      'registerNoOpForFeedback must be called inside the no-op detection block');
    assert.match(blockBody, /userFeedback/,
      'registerNoOpForFeedback must receive userFeedback (or fallback) as the second argument');
  });

  it('isNoOpAutoFixPatch branch surfaces a toast after consecutiveNoOpCount >= 2', () => {
    // The user must be told when 2+ consecutive no-ops happen — silent
    // failure is the worst UX. The toast call must be gated on count >= 2.
    const noopIdx = src.indexOf('isNoOpAutoFixPatch(target.resolved, patchedById)');
    const ifStart = src.lastIndexOf('if', noopIdx);
    let depth = 0;
    let blockEnd = -1;
    let inBlock = false;
    for (let i = ifStart; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') { depth++; inBlock = true; }
      else if (ch === '}') { depth--; if (inBlock && depth === 0) { blockEnd = i; break; } }
    }
    const blockBody = src.slice(ifStart, blockEnd);
    assert.match(blockBody, /consecutiveNoOpCount\s*>=\s*2/,
      'toast must be gated on consecutiveNoOpCount >= 2');
    assert.match(blockBody, /showToast\(/,
      'showToast must be called when count >= 2');
  });

  it('successful patch path calls resetNoOpEscalation', () => {
    // When a real patch lands, the counter must be cleared so the next
    // feedback starts fresh. Locate the commit block ("for (const [stepId, entry] of patchedById)")
    // and verify resetNoOpEscalation is called in or before it.
    const commitIdx = src.indexOf("for (const [stepId, entry] of patchedById)");
    assert.ok(commitIdx > 0, 'patchedById commit loop not found');
    // The reset should be BEFORE or INSIDE the commit loop. Verify it exists
    // within 800 chars before the loop.
    const window = src.slice(Math.max(0, commitIdx - 800), commitIdx);
    assert.match(window, /resetNoOpEscalation\(/,
      'resetNoOpEscalation must be called before/at the patchedById commit loop');
  });

  it('user-feedback prompt branch includes noOpEscalation interpolation', () => {
    // The user-feedback prompt must interpolate the escalation section so the
    // LLM sees it in the CURRENT prompt. Find the prompt template literal
    // containing "User's observation feedback" and verify noOpEscalation is
    // interpolated near it.
    const idx = src.indexOf("User's observation feedback:");
    assert.ok(idx > 0, 'user-feedback prompt template not found');
    const window = src.slice(idx, idx + 800);
    assert.match(window, /\$\{noOpEscalation\}/,
      '${noOpEscalation} must be interpolated near User\'s observation feedback in the user-feedback prompt');
  });

  it('noOpEscalation is built from consecutiveNoOpCount', () => {
    // The escalation variable must be derived from wizardState.consecutiveNoOpCount
    // (not a stale snapshot or hardcoded value).
    assert.match(src, /buildNoOpEscalationSection\(wizardState\.consecutiveNoOpCount/,
      'noOpEscalation must be built from wizardState.consecutiveNoOpCount');
  });
});

describe('lib/wizard-utils.js no-op escalation helpers (2026-08-05 regression guard)', () => {
  const src = fs.readFileSync(WIZARD_UTILS_PATH, 'utf8');

  it('buildNoOpEscalationSection is defined and exported (all 3 sites)', () => {
    assert.match(src, /function buildNoOpEscalationSection\(/,
      'buildNoOpEscalationSection function not defined');
    assert.match(src, /module\.exports\s*=\s*\{[^}]*\bbuildNoOpEscalationSection\b/,
      'buildNoOpEscalationSection not in module.exports');
    assert.match(src, /window\.buildNoOpEscalationSection\s*=/,
      'buildNoOpEscalationSection not exported to window');
    assert.match(src, /self\.buildNoOpEscalationSection\s*=/,
      'buildNoOpEscalationSection not exported to self');
  });

  it('registerNoOpForFeedback is defined and exported (all 3 sites)', () => {
    assert.match(src, /function registerNoOpForFeedback\(/);
    assert.match(src, /module\.exports\s*=\s*\{[^}]*\bregisterNoOpForFeedback\b/);
    assert.match(src, /window\.registerNoOpForFeedback\s*=/);
    assert.match(src, /self\.registerNoOpForFeedback\s*=/);
  });

  it('resetNoOpEscalation is defined and exported (all 3 sites)', () => {
    assert.match(src, /function resetNoOpEscalation\(/);
    assert.match(src, /module\.exports\s*=\s*\{[^}]*\bresetNoOpEscalation\b/);
    assert.match(src, /window\.resetNoOpEscalation\s*=/);
    assert.match(src, /self\.resetNoOpEscalation\s*=/);
  });

  it('escalation section contains no FB-specific terms (universality)', () => {
    // Per CLAUDE.md: no site-specific terms in framework prompts. Locate the
    // function body and assert it does NOT mention FB/post/group/author.
    const fnStart = src.indexOf('function buildNoOpEscalationSection');
    assert.ok(fnStart > 0);
    const nextFn = src.slice(fnStart + 1).match(/\nfunction /);
    const fnEnd = nextFn ? fnStart + 1 + nextFn.index : src.length;
    const fnBody = src.slice(fnStart, fnEnd);
    assert.ok(!/facebook/i.test(fnBody), 'buildNoOpEscalationSection mentions facebook');
    assert.ok(!/\bpost(s)?\b/i.test(fnBody), 'buildNoOpEscalationSection mentions post(s)');
    assert.ok(!/\bgroup(s)?\b/i.test(fnBody), 'buildNoOpEscalationSection mentions group(s)');
    assert.ok(!/\bauthor(s)?\b/i.test(fnBody), 'buildNoOpEscalationSection mentions author(s)');
  });
});
