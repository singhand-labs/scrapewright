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
