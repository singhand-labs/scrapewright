// Regression for bugx.log 2026-07-24 04:47:12 — user gave feedback about
// extraction quality (publishTime missing, images, only 3 posts), but autoFix
// only modified step 5 (extract_images_and_finalize) because the heuristic
// defaults to wizardState.steps[last]. The actual root cause was in step 4
// (extract_posts) which used a too-narrow :has() filter. The LLM understood
// the feedback (ACK text named all 3 symptoms) but had no way to redirect
// the fix to step 4 — RETURN_FORMAT only allowed modifying the marked step.
//
// resolveAutoFixTarget is the pure decision function extracted from
// runFixIteration: given the LLM response, the heuristic targetStepId, and
// the full step list, decide which step the patch should apply to.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveAutoFixTarget } = require('../lib/wizard-utils');

const STEPS = [
  { id: '1', name: 'wait',           script: 'return {done:true};',             onSuccess: '2',    onFailure: 'TERMINATE', maxIterations: 10 },
  { id: '2', name: 'scroll',         script: 'await $count("div[role=article]"); return {done:true};', onSuccess: '3', onFailure: 'TERMINATE', maxIterations: 15 },
  { id: '3', name: 'expand',         script: 'return {done:true};',             onSuccess: '4',    onFailure: '4',         maxIterations: 3  },
  { id: '4', name: 'extract_posts',  script: 'return {posts:[]};',              onSuccess: '5',    onFailure: 'TERMINATE', maxIterations: 1  },
  { id: '5', name: 'finalize',       script: 'return {posts:[]};',              onSuccess: 'TERMINATE', onFailure: 'TERMINATE', maxIterations: 1 }
];

describe('resolveAutoFixTarget', () => {
  it('uses targetStepId when obj has no stepId (backward compat)', () => {
    const obj = { script: 'return 1;' };
    const res = resolveAutoFixTarget(obj, '5', STEPS);
    assert.equal(res.step.id, '5');
    assert.equal(res.redirected, false);
  });

  it('uses targetStepId when obj.stepId === targetStepId (no redirect)', () => {
    const obj = { stepId: '5', script: 'return 1;' };
    const res = resolveAutoFixTarget(obj, '5', STEPS);
    assert.equal(res.step.id, '5');
    assert.equal(res.redirected, false);
  });

  it('redirects to LLM-chosen stepId when valid and different', () => {
    // bugx.log scenario: marked step is 5, but root cause is in 4. LLM
    // returns stepId:"4" after analyzing scripts.
    const obj = { stepId: '4', script: 'return {posts: await $extractList(...)};' };
    const res = resolveAutoFixTarget(obj, '5', STEPS);
    assert.equal(res.step.id, '4');
    assert.equal(res.step.name, 'extract_posts');
    assert.equal(res.redirected, true);
    assert.equal(res.redirectedFrom, '5');
  });

  it('falls back to targetStepId when LLM-chosen stepId does not exist', () => {
    const obj = { stepId: '99', script: 'return 1;' };
    const res = resolveAutoFixTarget(obj, '5', STEPS);
    assert.equal(res.step.id, '5');
    assert.equal(res.redirected, false);
    assert.match(res.fallbackReason, /99/);
    assert.match(res.fallbackReason, /falling back/i);
  });

  it('trims whitespace in stepId before lookup', () => {
    const obj = { stepId: '  4  ', script: 'return 1;' };
    const res = resolveAutoFixTarget(obj, '5', STEPS);
    assert.equal(res.step.id, '4');
    assert.equal(res.redirected, true);
  });

  it('returns error when targetStepId itself is invalid', () => {
    const obj = { script: 'return 1;' };
    const res = resolveAutoFixTarget(obj, '99', STEPS);
    assert.equal(res.step, undefined);
    assert.match(res.error, /not found/i);
  });

  it('returns error when obj is null or non-object', () => {
    assert.match(resolveAutoFixTarget(null, '5', STEPS).error, /invalid/i);
    assert.match(resolveAutoFixTarget('not an object', '5', STEPS).error, /invalid/i);
  });

  it('ignores non-string stepId (e.g. number) — falls back to targetStepId', () => {
    // Defensive: LLM occasionally returns numbers. Don't crash; fall back.
    const obj = { stepId: 4, script: 'return 1;' };
    const res = resolveAutoFixTarget(obj, '5', STEPS);
    assert.equal(res.step.id, '5');
    assert.equal(res.redirected, false);
  });
});
