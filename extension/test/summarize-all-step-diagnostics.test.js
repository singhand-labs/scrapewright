// Regression for bugx.log 2026-07-24: autoFix on the user-feedback path could
// not tell that scroll_and_load had run 5 iterations all reporting postCount=6
// with stalled incrementing 0..4. The LLM only saw the final testResult JSON
// (postCount=6, exhausted=true) and misdiagnosed as "container selector too
// narrow". summarizeAllStepDiagnostics re-uses the per-step renderer from
// summarizeExecutionDiagnostics but iterates over ALL steps, not just one
// failing step — so the feedback prompt now includes the stalled trace.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeAllStepDiagnostics } = require('../lib/wizard-utils');

function itEvent(stepId, iteration, resultPreview) {
  return { type: 'STEP_ITERATION', stepId, iteration, resultPreview, domActivity: [], ts: Date.now() };
}

describe('summarizeAllStepDiagnostics', () => {
  it('returns empty string when no events', () => {
    const steps = [{ id: '1', name: 's1' }];
    assert.equal(summarizeAllStepDiagnostics([], steps), '');
    assert.equal(summarizeAllStepDiagnostics(undefined, steps), '');
  });

  it('returns empty string when no step has iterations', () => {
    const steps = [{ id: '1', name: 's1' }];
    const events = [{ type: 'EXECUTION_START', ts: 0 }];
    assert.equal(summarizeAllStepDiagnostics(events, steps), '');
  });

  it('includes a header per step that has iterations', () => {
    const steps = [
      { id: '1', name: 'wait_for_posts' },
      { id: '2', name: 'scroll_and_load' }
    ];
    const events = [
      itEvent('1', 1, '{"done":true,"postCount":3}'),
      itEvent('2', 1, '{"done":false,"postCount":3,"stalled":0}'),
      itEvent('2', 2, '{"done":false,"postCount":3,"stalled":1}')
    ];
    const out = summarizeAllStepDiagnostics(events, steps);
    assert.match(out, /Step 1.*wait_for_posts/);
    assert.match(out, /Step 2.*scroll_and_load/);
  });

  it('surfaces the stalled sequence for the scroll step (the bugx.log scenario)', () => {
    const steps = [{ id: '2', name: 'scroll_and_load' }];
    const events = [
      itEvent('2', 1, '{"done":false,"postCount":6,"stalled":0}'),
      itEvent('2', 2, '{"done":false,"postCount":6,"stalled":1}'),
      itEvent('2', 3, '{"done":false,"postCount":6,"stalled":2}'),
      itEvent('2', 4, '{"done":false,"postCount":6,"stalled":3}'),
      itEvent('2', 5, '{"done":true,"postCount":6,"stalled":4,"exhausted":true}')
    ];
    const out = summarizeAllStepDiagnostics(events, steps);
    // The exact phrase shape matters because the autoFix prompt will grep for
    // these words when reasoning about "scroll didn't progress".
    assert.match(out, /postCount.:6/);
    assert.match(out, /stalled.:0/);
    assert.match(out, /stalled.:4/);
    assert.match(out, /exhausted.:true/);
  });

  it('skips steps with no STEP_ITERATION events', () => {
    const steps = [
      { id: '1', name: 'no_events_step' },
      { id: '2', name: 'has_events_step' }
    ];
    const events = [itEvent('2', 1, '{"done":true}')];
    const out = summarizeAllStepDiagnostics(events, steps);
    assert.doesNotMatch(out, /no_events_step/);
    assert.match(out, /has_events_step/);
  });

  it('collapses identical consecutive iteration previews (prompt-size budget)', () => {
    const steps = [{ id: '1', name: 'poll' }];
    const events = [
      itEvent('1', 1, '{"done":false,"postCount":6,"stalled":0}'),
      itEvent('1', 2, '{"done":false,"postCount":6,"stalled":0}'),
      itEvent('1', 3, '{"done":false,"postCount":6,"stalled":0}')
    ];
    const out = summarizeAllStepDiagnostics(events, steps);
    // Three identical previews should NOT each take a full iteration block.
    // Look for a collapse marker like "(N identical" or "× N" or similar —
    // the exact format is up to the implementation, but the total length
    // should be smaller than 3x the single-iteration block.
    assert.ok(out.length < 600, 'expected collapsed output, got: ' + out.length);
  });
});
