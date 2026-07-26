// Regression test for the RC11 user-feedback prompt regression guard.
//
// console.log 2026-07-26 14:49:08 RC11 showed glm-5.1 take a working
// `h3 a[role="link"]` (matched FB author correctly) and replace it with
// `a[role="link"][aria-label]` (matched a different element, dropped author
// coverage to 0). The user-feedback path runs MAX_ATTEMPTS=1 — there was no
// way to roll back the regression OR to tell the next iteration's LLM that
// its predecessor had regressed.
//
// buildRegressionGuard is the prompt-side half of the fix. It runs AFTER
// restoreBestAttempt has rolled the scripts back, when the user submits new
// feedback. It surfaces the best-known score + breakdown so the LLM treats
// the current scripts as a baseline to preserve, not a blank slate.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// buildRegressionGuard is defined inline in wizard.js (not exported as a
// standalone). We load it from source so the test runs against the actual
// prompt-construction code path. Loading via vm in a fake DOM is overkill —
// the function is self-contained (no DOM access), so we just eval its body.
const fs = require('node:fs');
const path = require('node:path');

function loadBuildRegressionGuard() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');
  // The function declaration spans from `function buildRegressionGuard(` to
  // the next `}` at column 0 that closes it. Walk brace depth from the
  // function body open.
  const startIdx = src.indexOf('function buildRegressionGuard(');
  assert.ok(startIdx > -1, 'wizard.js: buildRegressionGuard not found');
  const openIdx = src.indexOf('{', startIdx);
  let depth = 1;
  let i = openIdx + 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  const body = src.slice(startIdx, i);
  // Wrap in a module that exports the function — no external deps.
  const moduleSrc = body + '\nmodule.exports = { buildRegressionGuard };\n';
  // eslint-disable-next-line no-new-func
  const factory = new Function('module', 'exports', moduleSrc);
  const mod = { exports: {} };
  factory(mod, mod.exports);
  return mod.exports.buildRegressionGuard;
}

describe('buildRegressionGuard (RC11 user-feedback prompt regression guard)', () => {
  const buildRegressionGuard = loadBuildRegressionGuard();

  it('returns empty string when no bestAttempt is provided', () => {
    assert.equal(buildRegressionGuard(null, { score: 0 }), '');
    assert.equal(buildRegressionGuard(undefined, { score: 10 }), '');
    assert.equal(buildRegressionGuard({}, { score: 10 }), '');
  });

  it('returns empty string when bestAttempt.score is 0 or missing', () => {
    // Score 0 means nothing was extracted — there's no working baseline to
    // preserve, so the guard has nothing to say.
    assert.equal(buildRegressionGuard({ score: 0 }, { score: 0 }), '');
    assert.equal(buildRegressionGuard({ score: 0, breakdown: {} }, { score: 5 }), '');
  });

  it('returns empty string when current score already meets or beats best', () => {
    // No regression — guard would only confuse the LLM.
    const best = { score: 100, breakdown: { listItemCount: 5, avgFieldsPerItem: 3, requiredCoverage: 0.8 } };
    assert.equal(buildRegressionGuard(best, { score: 100 }), '');
    assert.equal(buildRegressionGuard(best, { score: 150 }), '');
  });

  it('emits REGRESSION GUARD header when current score is below best', () => {
    const best = {
      score: 200,
      attemptNum: 1,
      breakdown: { listItemCount: 8, avgFieldsPerItem: 4, requiredCoverage: 1 }
    };
    const out = buildRegressionGuard(best, { score: 50 });
    assert.match(out, /REGRESSION GUARD/);
    assert.match(out, /BEST-KNOWN-WORKING/);
  });

  it('includes the best-known breakdown metrics (generic, no site-specific terms)', () => {
    const best = {
      score: 200,
      breakdown: { listItemCount: 8, avgFieldsPerItem: 4.5, requiredCoverage: 1 }
    };
    const out = buildRegressionGuard(best, { score: 10 });
    assert.match(out, /items extracted: 8/);
    assert.match(out, /avg fields per item: 4\.50/);
    assert.match(out, /required-field coverage: 100%/);
  });

  it('includes both best and current numeric scores', () => {
    const best = { score: 333, breakdown: {} };
    const out = buildRegressionGuard(best, { score: 17 });
    assert.match(out, /best-known: 333/);
    assert.match(out, /current run: 17/);
  });

  it('warns the LLM NOT to rewrite working selectors', () => {
    // This is the FB RC11 regression in its generic form: glm-5.1 took a
    // working selector and replaced it with a "more general" one that
    // happened to match the wrong element. The guard must call this out as
    // forbidden behavior without naming specific selectors or sites.
    const best = { score: 300, breakdown: {} };
    const out = buildRegressionGuard(best, { score: 10 });
    assert.match(out, /DO NOT rewrite a selector that is already producing/);
    assert.match(out, /Identify the SPECIFIC field or step/);
    // Must NOT mention Facebook, FB, or specific CSS — that would violate
    // the "no site-specific features in prompt" project rule.
    assert.doesNotMatch(out, /facebook/i);
    assert.doesNotMatch(out, /FB[^a-z]/i);
    assert.doesNotMatch(out, /\bh3\b/);
    assert.doesNotMatch(out, /aria-label/);
  });

  it('offers a safe no-op escape when the LLM cannot pinpoint the bug', () => {
    // A no-op (return the same scripts) is strictly better than guessing
    // because the bestAttempt has already been restored — guessing risks
    // regressing again.
    const best = { score: 300, breakdown: {} };
    const out = buildRegressionGuard(best, { score: 50 });
    assert.match(out, /return the current scripts UNCHANGED/);
    assert.match(out, /no-op/);
  });

  it('handles missing currentScoreResult gracefully', () => {
    // Defensive: if scoreAttemptResult returned something malformed, the
    // guard should not crash — it should fall back to assuming a regression
    // (bestAttempt exists and has a score, current state unknown).
    const best = { score: 200, breakdown: {} };
    const out1 = buildRegressionGuard(best, null);
    assert.match(out1, /REGRESSION GUARD/);
    const out2 = buildRegressionGuard(best, undefined);
    assert.match(out2, /REGRESSION GUARD/);
    const out3 = buildRegressionGuard(best, {});
    assert.match(out3, /REGRESSION GUARD/);
  });

  it('handles missing breakdown gracefully', () => {
    // Older bestAttempt objects (pre-RC11) don't have breakdown. The guard
    // should still work — just skip the metrics line.
    const best = { score: 200 };
    const out = buildRegressionGuard(best, { score: 10 });
    assert.match(out, /REGRESSION GUARD/);
    assert.match(out, /Score \(higher/);
    // No metrics line because breakdown is missing
    assert.doesNotMatch(out, /items extracted/);
  });
});
