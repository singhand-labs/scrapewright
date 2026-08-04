// Regression test for the RC23 fix.
//
// console.log 2026-08-03 12:54–13:00: FB search extraction returned
// {posts:[]} across 4 autoFix rounds. Every round, step 4 (extract_posts)
// returned `{done:false}` because `posts.filter(p => p.username || p.content)`
// rejected every record — every record had empty username AND empty content
// because the LLM-guessed selectors (`h3 a[href*="/user/"] span` for username,
// assuming FB uses `/user/` hrefs) didn't match the actual DOM.
//
// Root cause was framework-level: SCRIPT_DSL_GUIDE rule 4 actively taught
// the wrong pattern:
//
//   "EXTRACTION MUST NOT RETURN EMPTY AS SUCCESS: ... must treat EMPTY output
//    ('', null, [], or a required field missing) as NOT done — return
//    { done: false } (with maxIterations>1) and retry until the content is
//    present."
//
// This rule conflates two semantically distinct cases:
//   (a) CONTENT-NOT-YET-PRESENT (transient — page still rendering, list not
//       yet in DOM): retrying makes sense, {done:false} is correct.
//   (b) EXTRACTION-RAN-BUT-EMPTY (deterministic — the $extractList* call
//       completed but the records array is empty or every record's fields
//       are empty): retrying with the same selectors against the same DOM
//       produces the same empty result. {done:false} here is harmful.
//
// The harm: case (b) with {done:false} burns the retry budget → POLL_EXHAUSTED
// → autoFix sees a TIMING signal ("poll exhausted") instead of an
// EXTRACTION-QUALITY signal ("empty fields"). The wizard's EMPTY_EXTRACTION
// detector (wizard.js ~1914) never fires because the step never returns
// {done:true, <field>:[]}. The RC15 EMPTY_FIELDS signal never reaches the
// autoFix prompt. The LLM then hallucinates causes — in the log it claimed
// "Step 3/4 don't have maxIterations>1" when both steps had maxIterations:3.
//
// The fix: rewrite rule 4 so it teaches the LLM to distinguish (a) from (b).
// For (b), return {done:true, <field>:[]} so the EMPTY_EXTRACTION/EMPTY_FIELDS
// pipeline can fire and autoFix gets the data-driven signal.
//
// Universality: this is a prompt-level data-flow bug, NOT FB-specific. Any
// site where the LLM's first selector guess misses causes the same POLL-
// EXHAUSTED-masking-EMPTY_EXTRACTION cascade.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

describe('SCRIPT_DSL_GUIDE rule 4 distinguishes transient-empty from deterministic-empty', () => {
  const guide = loadScriptDslGuide();

  it('does NOT teach the harmful "empty → {done:false}, retry" pattern as a blanket rule', () => {
    // The OLD rule 4 (the bug) said: "must treat EMPTY output as NOT done —
    // return { done: false } (with maxIterations>1) and retry until the
    // content is present." That blanket rule is what caused the FB cascade.
    // If a future edit brings it back, this guard fires.
    const oldRulePattern = /must treat EMPTY output[^]*retry until the content is present/i;
    assert.doesNotMatch(guide, oldRulePattern,
      'guide must NOT contain the old blanket rule "treat EMPTY as NOT done + retry"');
  });

  it('teaches that extraction-completed-but-empty should return {done:true, <field>:[]} not {done:false}', () => {
    // The corrected rule must explicitly tell the LLM: when the extraction
    // LOGIC ran (the $extractList* call returned, possibly empty) but the
    // page is in steady state, return done:true with the empty array. This
    // lets the EMPTY_EXTRACTION detector fire instead of POLL_EXHAUSTED.
    // Look for the rule 4 section. NOTE: the guide has multiple "4." entries
    // (NEVER NAVIGATE is also numbered 4 in a different section); anchor on
    // the extraction rule by matching its title keyword.
    const ruleIdx = guide.search(/4\.\s+(?:DISTINGUISH|EXTRACTION MUST)/);
    assert.ok(ruleIdx > -1, 'guide must have rule 4 titled DISTINGUISH... or EXTRACTION MUST...');
    const window = guide.slice(ruleIdx, ruleIdx + 3000);

    // Must distinguish two cases.
    assert.match(window, /EXTRACTION[\s-]*COMPLETED[\s-]*BUT[\s-]*EMPTY|EXTRACTION[\s-]*RAN[\s-]*BUT[\s-]*EMPTY/i,
      'rule 4 must name the "extraction completed but empty" case explicitly');

    // Must say done:true (not done:false) for the deterministic-empty case.
    assert.match(window, /done:\s*true/i,
      'rule 4 must teach done:true for extraction-completed-but-empty');
  });

  it('explains WHY retrying deterministic-empty is harmful (masks EMPTY_EXTRACTION behind POLL_EXHAUSTED)', () => {
    // Without the WHY, a future editor might "simplify" the rule back to
    // the old blanket version. The WHY pins the reasoning.
    const ruleIdx = guide.search(/4\.\s+(?:DISTINGUISH|EXTRACTION MUST)/);
    assert.ok(ruleIdx > -1);
    const window = guide.slice(ruleIdx, ruleIdx + 3500);

    // Must reference the diagnostic consequence — either POLL_EXHAUSTED
    // hiding EMPTY_EXTRACTION, or the framework's empty-detection pipeline.
    assert.ok(
      /POLL_EXHAUSTED/i.test(window) || /EMPTY_EXTRACTION/i.test(window),
      'rule 4 must explain that {done:false} on deterministic-empty causes POLL_EXHAUSTED which masks EMPTY_EXTRACTION'
    );
  });

  it('shows the concrete anti-pattern: `if (!records.length) return { done: false }` after $extractList*', () => {
    // The exact code shape the LLM wrote in the FB log. Naming it by
    // pattern prevents the LLM from producing the same shape again.
    const ruleIdx = guide.search(/4\.\s+(?:DISTINGUISH|EXTRACTION MUST)/);
    assert.ok(ruleIdx > -1);
    const window = guide.slice(ruleIdx, ruleIdx + 3500);

    assert.match(window, /if\s*\(\s*!\s*records\.length\s*\)\s*return\s*\{\s*done:\s*false\s*\}/,
      'rule 4 must show the exact anti-pattern `if (!records.length) return { done: false }`');
  });
});
