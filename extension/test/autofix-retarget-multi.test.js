// Regression for bugx.log 2026-07-24 07:04:16 — autoFix kept patching step 5
// ("extract_images_per_post") instead of step 4 (where publishTime's broken
// selector lived). The single-target resolveAutoFixTarget wasn't enough: the
// LLM needed to be able to fix MULTIPLE steps in one iteration when the
// user's feedback described issues spanning several steps (missing
// publishTime in step 4, multi-value images in step 5, scroll behavior in
// step 2, etc.).
//
// resolveAutoFixTargets is the plural decision function: given a list of
// {stepId, script} patches, the heuristic targetStepId, and the full step
// list, decide which step each patch applies to.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveAutoFixTargets } = require('../lib/wizard-utils');

const STEPS = [
  { id: '1', name: 'wait',           script: 'return {done:true};',             onSuccess: '2',    onFailure: 'TERMINATE', maxIterations: 10 },
  { id: '2', name: 'scroll',         script: 'await $scrollToBottom(); ...',     onSuccess: '3',    onFailure: '4',         maxIterations: 15 },
  { id: '3', name: 'expand',         script: 'return {done:true};',             onSuccess: '4',    onFailure: '4',         maxIterations: 3  },
  { id: '4', name: 'extract_posts',  script: 'return {posts:[]};',              onSuccess: '5',    onFailure: 'TERMINATE', maxIterations: 1  },
  { id: '5', name: 'finalize',       script: 'return {posts:[]};',              onSuccess: 'TERMINATE', onFailure: 'TERMINATE', maxIterations: 1 }
];

describe('resolveAutoFixTargets (multi-patch)', () => {
  it('happy path: multiple patches each resolve to their stepId', () => {
    // bugx.log scenario: user reports publishTime missing (step 4) and
    // images incomplete (step 5). LLM returns patches for both.
    const patches = [
      { stepId: '4', script: 'return {posts: await $extractList(..., {publishTime:\\\'...\\\'})};' },
      { stepId: '5', script: 'const imgs = await $list(\\\'img\\\'); ...' }
    ];
    const res = resolveAutoFixTargets(patches, '5', STEPS);
    assert.equal(res.errors.length, 0);
    assert.equal(res.resolved.length, 2);
    assert.equal(res.resolved[0].step.id, '4');
    assert.equal(res.resolved[0].redirected, true);
    assert.equal(res.resolved[1].step.id, '5');
    assert.equal(res.resolved[1].redirected, false);
  });

  it('single patch redirects from heuristic to LLM-chosen step', () => {
    // Single-element patches array — the LLM explicitly picks step 4 even
    // though heuristic was 5.
    const patches = [{ stepId: '4', script: 'return 1;' }];
    const res = resolveAutoFixTargets(patches, '5', STEPS);
    assert.equal(res.errors.length, 0);
    assert.equal(res.resolved.length, 1);
    assert.equal(res.resolved[0].step.id, '4');
    assert.equal(res.resolved[0].redirected, true);
    assert.equal(res.resolved[0].redirectedFrom, '5');
  });

  it('falls back to targetStepId when a patch omits stepId (legacy shape)', () => {
    // Legacy single-target response wrapped as [parsed.value] — no stepId.
    const patches = [{ script: 'return 1;' }];
    const res = resolveAutoFixTargets(patches, '5', STEPS);
    assert.equal(res.errors.length, 0);
    assert.equal(res.resolved[0].step.id, '5');
    assert.equal(res.resolved[0].redirected, false);
  });

  it('falls back to targetStepId when a patch stepId is unknown (soft)', () => {
    // The OTHER patches may still be valid; we don't abort the whole iteration.
    const patches = [
      { stepId: '99', script: 'return 1;' },   // unknown — falls back
      { stepId: '4',  script: 'return 2;' }    // valid redirect
    ];
    const res = resolveAutoFixTargets(patches, '5', STEPS);
    assert.equal(res.errors.length, 0);
    assert.equal(res.resolved.length, 2);
    assert.equal(res.resolved[0].step.id, '5');           // fell back
    assert.match(res.resolved[0].fallbackReason, /99/);
    assert.equal(res.resolved[1].step.id, '4');           // redirected
  });

  it('rejects duplicate patches for the same step', () => {
    // LLM shouldn't emit two patches for one step — that's ambiguous.
    const patches = [
      { stepId: '4', script: 'return 1;' },
      { stepId: '4', script: 'return 2;' }
    ];
    const res = resolveAutoFixTargets(patches, '5', STEPS);
    assert.ok(res.errors.length >= 1);
    assert.match(res.errors[0], /duplicate/i);
    assert.equal(res.resolved.length, 1);  // first one kept, second errored
  });

  it('rejects duplicate when both patches fall back to targetStepId', () => {
    // Both patches omit stepId — both would apply to step 5. Ambiguous.
    const patches = [
      { script: 'return 1;' },
      { script: 'return 2;' }
    ];
    const res = resolveAutoFixTargets(patches, '5', STEPS);
    assert.ok(res.errors.length >= 1);
    assert.match(res.errors[0], /duplicate/i);
  });

  it('rejects patch with missing or empty script', () => {
    const patches = [
      { stepId: '4', script: '' },
      { stepId: '5' }                            // no script at all
    ];
    const res = resolveAutoFixTargets(patches, '5', STEPS);
    assert.ok(res.errors.length >= 2);
    assert.match(res.errors.join('; '), /script/i);
    assert.equal(res.resolved.length, 0);
  });

  it('rejects non-array patches argument', () => {
    const res = resolveAutoFixTargets({ stepId: '4', script: 'x' }, '5', STEPS);
    assert.ok(res.errors.length >= 1);
    assert.match(res.errors[0], /array/i);
  });

  it('errors out when targetStepId itself is invalid', () => {
    const patches = [{ stepId: '4', script: 'return 1;' }];
    const res = resolveAutoFixTargets(patches, '99', STEPS);
    assert.ok(res.errors.length >= 1);
    assert.match(res.errors[0], /target step not found/i);
  });

  it('handles three patches spanning three different steps', () => {
    // Stress case: user reported 3 issues, each in a different step.
    const patches = [
      { stepId: '2', script: 'const r = await $scrollToBottom(); return {done:false};' },
      { stepId: '4', script: 'return {posts: await $extractList(...)};' },
      { stepId: '5', script: 'return {posts: __stepResults__[\\\'4\\\'].posts};' }
    ];
    const res = resolveAutoFixTargets(patches, '5', STEPS);
    assert.equal(res.errors.length, 0);
    assert.equal(res.resolved.length, 3);
    assert.deepEqual(res.resolved.map(r => r.step.id), ['2', '4', '5']);
  });

  it('trims whitespace in stepId', () => {
    const patches = [{ stepId: '  4  ', script: 'return 1;' }];
    const res = resolveAutoFixTargets(patches, '5', STEPS);
    assert.equal(res.errors.length, 0);
    assert.equal(res.resolved[0].step.id, '4');
  });

  it('ignores non-string stepId (e.g. number) — falls back', () => {
    // Defensive: LLM occasionally returns numbers.
    const patches = [{ stepId: 4, script: 'return 1;' }];
    const res = resolveAutoFixTargets(patches, '5', STEPS);
    assert.equal(res.errors.length, 0);
    assert.equal(res.resolved[0].step.id, '5');
    assert.equal(res.resolved[0].redirected, false);
  });

  it('empty patches array yields no resolved, no errors', () => {
    const res = resolveAutoFixTargets([], '5', STEPS);
    assert.equal(res.errors.length, 0);
    assert.equal(res.resolved.length, 0);
  });

  // bugx.log 2026-07-24 follow-up: the user-feedback path used to default
  // targetStepId to the LAST step (the finalizer). That was structurally
  // wrong because user-observed extraction bugs usually live upstream
  // (e.g. step 4 extract_posts, not step 5 finalize). The wizard now passes
  // targetStepId=null on the feedback path — these tests pin the contract.

  describe('null targetStepId (user-feedback path)', () => {
    it('rejects a patch without stepId — no implicit target', () => {
      const res = resolveAutoFixTargets([{ script: 'return 1;' }], null, STEPS);
      assert.ok(res.errors.length >= 1);
      assert.match(res.errors[0], /stepId/i);
      assert.equal(res.resolved.length, 0);
    });

    it('accepts a patch with a valid stepId', () => {
      const res = resolveAutoFixTargets([{ stepId: '4', script: 'return 1;' }], null, STEPS);
      assert.equal(res.errors.length, 0);
      assert.equal(res.resolved.length, 1);
      assert.equal(res.resolved[0].step.id, '4');
    });

    it('sets redirected=false and redirectedFrom=null (no heuristic to redirect from)', () => {
      const res = resolveAutoFixTargets([{ stepId: '4', script: 'return 1;' }], null, STEPS);
      assert.equal(res.resolved[0].redirected, false);
      assert.equal(res.resolved[0].redirectedFrom, null);
    });

    it('accepts multi-step patches across unrelated steps', () => {
      const res = resolveAutoFixTargets([
        { stepId: '2', script: 'await $scrollToBottom();' },
        { stepId: '4', script: 'return {posts: await $extractList(...)};' }
      ], null, STEPS);
      assert.equal(res.errors.length, 0);
      assert.deepEqual(res.resolved.map(r => r.step.id), ['2', '4']);
    });

    it('hard-errors on unknown stepId (no soft fallback when target is null)', () => {
      const res = resolveAutoFixTargets([{ stepId: '99', script: 'return 1;' }], null, STEPS);
      assert.ok(res.errors.length >= 1);
      assert.match(res.errors[0], /99/);
      assert.equal(res.resolved.length, 0);
    });

    it('rejects duplicate stepIds', () => {
      const res = resolveAutoFixTargets([
        { stepId: '4', script: 'return 1;' },
        { stepId: '4', script: 'return 2;' }
      ], null, STEPS);
      assert.ok(res.errors.length >= 1);
      assert.match(res.errors[0], /duplicate/i);
      assert.equal(res.resolved.length, 1);
    });

    it('mixes valid and missing-stepId patches: only the valid one resolves, missing one errors', () => {
      const res = resolveAutoFixTargets([
        { stepId: '4', script: 'return 1;' },
        { script: 'return 2;' }           // missing stepId — hard error
      ], null, STEPS);
      assert.ok(res.errors.length >= 1);
      assert.match(res.errors[0], /stepId/i);
      assert.equal(res.resolved.length, 1);
      assert.equal(res.resolved[0].step.id, '4');
    });
  });
});
