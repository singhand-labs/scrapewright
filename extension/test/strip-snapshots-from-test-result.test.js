// Regression test for stripSnapshotsFromTestResult. Without this cap,
// wizard.js's autoFix prompt overflows the LLM context window when testResult
// carries 5 step entries each with a ~150K-char snapshot.html. The
// console.log 2026-07-26 trace showed the proxy rejecting prompts at
// prompt_tokens:0 with `finish_reason: model_context_window_exceeded` — both
// on the initial ~2.4M-char attempt AND on the compact-retry attempt at
// ~899K chars (because compactMode only shrinks the pageSnapshot budget,
// not the testResult dump).
//
// Two serialization paths must strip snapshots:
//   1. testResultSection (wizard.js:~2441) — JSON.stringify of testResult
//   2. summarizeFixIteration (lib/wizard-utils.js) — pushes to llmHistory
// Both now route through stripSnapshotsFromTestResult.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  stripSnapshotsFromTestResult,
  stripPagesFromLLMContext,
  dedupeStepIterations,
  summarizeFixIteration
} = require('../lib/wizard-utils');

function hugeHtml(n) {
  // Synthesize an FB-shaped HTML string of approximately n chars.
  return '<html><body>' + ('<div class="x">y</div>'.repeat(Math.ceil(n / 24))).slice(0, n) + '</body></html>';
}

function buildFbTestResult() {
  // Mirror what the real FB extraction produces: 5 steps, each carrying a
  // snapshot with ~150K-char HTML, plus normal result data per step.
  return {
    finalResult: { posts: [], keyword: '人工智能' },
    steps: [
      { stepId: '1', stepName: 'wait_for_posts', result: { done: true, postCount: 7 },
        snapshot: { url: 'https://www.facebook.com/search/top?q=人工智能', html: hugeHtml(150000), textContent: 'x'.repeat(20000), structure: 'y'.repeat(20000) } },
      { stepId: '2', stepName: 'scroll_and_load_posts', result: { done: true, iterations: 12 },
        snapshot: { url: 'https://www.facebook.com/search/top?q=人工智能', html: hugeHtml(150000) } },
      { stepId: '3', stepName: 'expand_posts', result: { clicked: 4 },
        snapshot: { url: 'https://www.facebook.com/search/top?q=人工智能', html: hugeHtml(150000) } },
      { stepId: '4', stepName: 'extract_posts', result: { posts: [] },
        error: 'EMPTY_EXTRACTION',
        snapshot: { url: 'https://www.facebook.com/search/top?q=人工智能', html: hugeHtml(150000) } },
      { stepId: '5', stepName: 'return_results', result: { posts: [], keyword: '人工智能' },
        snapshot: { url: 'https://www.facebook.com/search/top?q=人工智能', html: hugeHtml(150000) } }
    ]
  };
}

describe('stripSnapshotsFromTestResult', () => {
  it('removes every step.snapshot field', () => {
    const stripped = stripSnapshotsFromTestResult(buildFbTestResult());
    for (const step of stripped.steps) {
      assert.ok(!('snapshot' in step), `step ${step.stepId} still has snapshot field`);
    }
  });

  it('reduces a 750K+ testResult to under 50K chars when JSON-stringified', () => {
    const original = buildFbTestResult();
    const originalChars = JSON.stringify(original).length;
    const strippedChars = JSON.stringify(stripSnapshotsFromTestResult(original)).length;
    assert.ok(originalChars > 700000, `expected original > 700K, got ${originalChars}`);
    assert.ok(strippedChars < 50000, `expected stripped < 50K, got ${strippedChars}`);
  });

  it('preserves stepId, stepName, result, and error on each step', () => {
    const stripped = stripSnapshotsFromTestResult(buildFbTestResult());
    assert.equal(stripped.steps.length, 5);
    assert.equal(stripped.steps[0].stepId, '1');
    assert.equal(stripped.steps[0].stepName, 'wait_for_posts');
    assert.deepEqual(stripped.steps[0].result, { done: true, postCount: 7 });
    assert.equal(stripped.steps[3].error, 'EMPTY_EXTRACTION');
  });

  it('preserves finalResult', () => {
    const stripped = stripSnapshotsFromTestResult(buildFbTestResult());
    assert.deepEqual(stripped.finalResult, { posts: [], keyword: '人工智能' });
  });

  it('does NOT mutate the input', () => {
    const tr = buildFbTestResult();
    const snapshotBefore = tr.steps[0].snapshot;
    stripSnapshotsFromTestResult(tr);
    assert.equal(tr.steps[0].snapshot, snapshotBefore, 'input testResult was mutated');
    assert.ok(tr.steps[0].snapshot.html.length > 100000, 'snapshot HTML was modified in place');
  });

  it('caps oversized string fields to TEST_RESULT_FIELD_CHAR_CAP (5000)', () => {
    const tr = {
      finalResult: { hugeText: 'A'.repeat(50000) },
      steps: [{ stepId: '1', stepName: 's1', result: { giantString: 'B'.repeat(40000) } }]
    };
    const stripped = stripSnapshotsFromTestResult(tr);
    const serialized = JSON.stringify(stripped);
    assert.ok(!/A{5000,}/.test(serialized), 'huge finalResult text was not capped');
    assert.ok(!/B{5000,}/.test(serialized), 'huge result string was not capped');
    // Verify the marker is present so the LLM knows data was truncated.
    assert.match(serialized, /TRUNCATED/);
  });

  it('returns non-object inputs unchanged', () => {
    assert.equal(stripSnapshotsFromTestResult(null), null);
    assert.equal(stripSnapshotsFromTestResult(undefined), undefined);
    assert.equal(stripSnapshotsFromTestResult('string'), 'string');
    assert.equal(stripSnapshotsFromTestResult(42), 42);
  });

  it('handles arrays at any nesting depth', () => {
    const tr = {
      steps: [{
        result: {
          nested: [[{ deep: { snapshot: { html: 'huge' }, value: 'ok' } }]]
        }
      }]
    };
    const stripped = stripSnapshotsFromTestResult(tr);
    assert.ok(!('snapshot' in stripped.steps[0].result.nested[0][0].deep));
    assert.equal(stripped.steps[0].result.nested[0][0].deep.value, 'ok');
  });
});

describe('summarizeFixIteration uses stripSnapshotsFromTestResult', () => {
  it('produces a summary well under 50K chars even with huge testResult', () => {
    const summary = summarizeFixIteration({
      stepId: '4',
      stepName: 'extract_posts',
      script: 'return {posts: []}',
      annotations: [],
      userFeedback: null,
      error: 'EMPTY_EXTRACTION',
      result: buildFbTestResult()
    });
    assert.ok(summary.length < 50000, `summary too big: ${summary.length} chars`);
    // Sanity: summary still mentions the step and result.
    assert.match(summary, /extract_posts/);
    assert.match(summary, /Result:/);
  });

  it('no `snapshot.html` substring leaks into the summary', () => {
    const summary = summarizeFixIteration({
      stepId: '4',
      stepName: 'extract_posts',
      script: 'return {}',
      annotations: [],
      userFeedback: null,
      error: null,
      result: buildFbTestResult()
    });
    // The snapshot keys are stripped; the values never make it in.
    assert.ok(!/snapshot/.test(summary), 'summary contained a snapshot reference');
    // The hugeHtml marker `<div class="x">` should not appear at all.
    assert.ok(!/<div class="x">/.test(summary), 'summary leaked snapshot HTML content');
  });
});

// Regression tests for dedupeStepIterations. Without this helper, a polling
// step that runs N iterations produces N entries in testResult.steps — and
// each intermediate entry can carry a growing accumulator (updatedPosts,
// seenSignatures, etc.) that bloats the autoFix prompt by 1MB+ even after
// stripSnapshotsFromTestResult's 5K-per-field string cap.
//
// console.log 2026-08-05 04:32: step 5 ran 9 iterations on a 10-post page;
// each iteration's result.updatedPosts grew by one post (rawHTML ~100K each,
// capped to 5K). Stripped+capped testResult was 885K — autoFix prompt hit
// 1.83MB, LLM timed out 4× then returned finish_reason:model_context_window_exceeded.
//
// The fix keeps only the LAST entry per stepId. Intermediate polling results
// are diagnostic noise; the LLM only needs the final per-step state. The
// per-iteration traces still survive via summarizeAllStepDiagnostics (which
// reads lastExecutionEvents, not testResult.steps).
describe('dedupeStepIterations', () => {
  it('keeps only the last entry per stepId when a step has multiple iterations', () => {
    const tr = {
      finalResult: { posts: [] },
      steps: [
        { stepId: '1', stepName: 'wait', result: { done: true }, timestamp: 1 },
        { stepId: '2', stepName: 'scroll', result: { done: false, n: 1 }, timestamp: 2 },
        { stepId: '2', stepName: 'scroll', result: { done: false, n: 2 }, timestamp: 3 },
        { stepId: '2', stepName: 'scroll', result: { done: true, n: 3 }, timestamp: 4 },
        { stepId: '3', stepName: 'finalize', result: { posts: [] }, timestamp: 5 }
      ]
    };
    const deduped = dedupeStepIterations(tr);
    assert.equal(deduped.steps.length, 3, 'should collapse 5 entries (step 2 had 3 iters) to 3');
    assert.deepEqual(deduped.steps.map(s => s.stepId), ['1', '2', '3']);
    // The KEPT entry for step 2 must be the last one (done:true, n:3), not the first.
    assert.equal(deduped.steps[1].result.n, 3);
    assert.equal(deduped.steps[1].result.done, true);
  });

  it('returns non-object inputs unchanged', () => {
    assert.equal(dedupeStepIterations(null), null);
    assert.equal(dedupeStepIterations(undefined), undefined);
    assert.equal(dedupeStepIterations('str'), 'str');
    assert.equal(dedupeStepIterations(42), 42);
  });

  it('handles testResult without steps array (returns clone as-is)', () => {
    const tr = { finalResult: { x: 1 } };
    const out = dedupeStepIterations(tr);
    assert.deepEqual(out, tr);
    assert.notEqual(out, tr, 'should return a clone, not the same object');
  });

  it('does NOT mutate the input', () => {
    const tr = {
      finalResult: {},
      steps: [
        { stepId: '1', result: { v: 1 } },
        { stepId: '1', result: { v: 2 } }
      ]
    };
    const before = tr.steps.length;
    dedupeStepIterations(tr);
    assert.equal(tr.steps.length, before, 'input testResult.steps was mutated');
  });

  it('reduces a 9-iteration polling step from 885K to under 250K when chained with stripSnapshotsFromTestResult', () => {
    // Realistic FB shape: step 5 iterates 9 times, each result carries a growing
    // updatedPosts array. Each post has rawHTML ~100K (capped to ~5K by stripSnapshotsFromTestResult).
    const rawHTML = '<div>' + 'x'.repeat(100000) + '</div>';
    const makePost = (i) => ({
      groupInfo: { groupName: 'g' + i }, accountInfo: { username: 'u' + i },
      postTime: '2天', content: '', mediaUrls: [], rawHTML
    });
    const finalPosts = Array.from({ length: 10 }, (_, i) => makePost(i));
    const steps = [
      { stepId: '1', stepName: 'wait', result: { done: true }, timestamp: 1 },
      { stepId: '2', stepName: 'scroll', result: { done: true, uniqueCount: 12 }, timestamp: 2 },
      { stepId: '3', stepName: 'expand', result: { done: true }, timestamp: 3 },
      { stepId: '4', stepName: 'extract', result: { posts: finalPosts }, timestamp: 4 }
    ];
    for (let i = 1; i <= 9; i++) {
      steps.push({
        stepId: '5',
        stepName: 'scrape_hover_details',
        result: i === 9 ? { done: true, posts: finalPosts } : { done: false, posts: finalPosts, index: i, updatedPosts: finalPosts.slice(0, i) },
        timestamp: 100 + i
      });
    }
    steps.push({ stepId: '6', stepName: 'finalize', result: { posts: finalPosts }, timestamp: 200 });
    const tr = { finalResult: { posts: finalPosts }, steps };

    const strippedOnly = JSON.stringify(stripPagesFromLLMContext(stripSnapshotsFromTestResult(tr)), null, 2);
    const strippedAndDeduped = JSON.stringify(stripPagesFromLLMContext(stripSnapshotsFromTestResult(dedupeStepIterations(tr))), null, 2);
    assert.ok(strippedOnly.length > 700000,
      `pre-dedup size should exceed 700K (was ${strippedOnly.length}); if not, the bloat shape changed and this test needs updating`);
    assert.ok(strippedAndDeduped.length < 250000,
      `post-dedup size should be under 250K (was ${strippedAndDeduped}); dedupeStepIterations isn't shrinking enough`);
    // The reduction ratio should be substantial (more than 3x).
    assert.ok(strippedOnly.length > strippedAndDeduped.length * 3,
      `dedupe should reduce size by >3x; only got ${strippedOnly.length} → ${strippedAndDeduped.length}`);
  });
});
