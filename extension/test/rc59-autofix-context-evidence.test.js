// RC59: autoFix context architecture — evidence preservation + history diet.
//
// INCIDENT (console.log 2026-08-18 10:29-11:31, 10 user-feedback/failure
// autoFix rounds): comments/shares stayed empty through NINE rounds of fixes;
// per-round LLM input reached 212K→803K prompt tokens (~5.5M total) while the
// model iterated blind. Three compounding root causes in the context chain:
//
// 1. EVIDENCE AMPUTATION (the "couldn't extract" root cause): record HTML is
//    30-100K chars; engagement counts live in aria-label attributes on
//    action-bar elements at the END of that HTML. stripSnapshotsFromTestResult
//    capped every string field at a 5K HEAD-ONLY prefix — the tail (where the
//    counts are) was cut in every copy the LLM ever saw. The LLM could only
//    guess regex phrasings round after round (its round-7 reply literally
//    notes "counts live in aria-label — step 4 never captured them").
//
// 2. HISTORY BLOAT (the "why so many rounds" cost driver): summarizeFixIteration
//    embedded the FULL capped testResult JSON (~300K chars: 10 posts × html +
//    hovercards) into every llmHistory entry. trimLlmHistory's 150K cap is
//    defeated by its `length > 4` floor — 4 messages × ~250K stuck at
//    700-950K history chars, and the SAME post data appeared 3-4× per round
//    (history summary + steps[].result + finalResult).
//
// 3. CURRENT-PROMPT SELF-DUPLICATION: finalResult and the final step's
//    steps[].result are the same object serialized twice in currentOutput
//    (addressed by elideDuplicateFinalResults, tested in this file).
//
// Fixes here are ALL generic (no site terms): head+tail truncation keeps both
// ends of long DOM strings; history entries get a per-field 200-char digest
// (structure preserved, the CURRENT prompt still carries the full output).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  stripSnapshotsFromTestResult,
  summarizeFixIteration
} = require('../lib/wizard-utils');

describe('RC59: stripSnapshotsFromTestResult head+tail truncation', () => {
  it('keeps the TAIL of oversized fields — count evidence lives at the END of record HTML', () => {
    // Real incident shape: 40K-char article HTML whose ONLY comment-count
    // evidence is an aria-label near the end of the markup.
    const html = '<div class="article">' + 'a'.repeat(40000) +
      '<a aria-label="93 则评论" role="button"></a></div>';
    const stripped = stripSnapshotsFromTestResult({ finalResult: { html } });
    const out = stripped.finalResult.html;
    assert.ok(out.length < 6000, 'capped, got ' + out.length);
    assert.ok(out.includes('<div class="article">' + 'a'.repeat(100)),
      'head prefix preserved (marker-first, then head, per existing format)');
    assert.ok(out.includes('aria-label="93 则评论"'),
      'TAIL evidence (aria-label count) must survive truncation');
  });

  it('marks the middle cut so the LLM knows the field was truncated', () => {
    const stripped = stripSnapshotsFromTestResult({
      finalResult: { html: 'x'.repeat(50000) }
    });
    const out = stripped.finalResult.html;
    assert.match(out, /TRUNCATED[^\n]*50000/,
      'marker must disclose the original length');
    assert.match(out, /\[cut\]|\[middle|…/, 'marker must signal omitted middle');
  });

  it('leaves short fields untouched (no marker, full value)', () => {
    const stripped = stripSnapshotsFromTestResult({
      finalResult: { content: 'short text', likes: '8' }
    });
    assert.equal(stripped.finalResult.content, 'short text');
    assert.equal(stripped.finalResult.likes, '8');
  });

  it('honors a custom fieldCharCap (head+tail split scales down with it)', () => {
    const html = 'H'.repeat(500) + 'M'.repeat(1000) + 'T'.repeat(500);
    const stripped = stripSnapshotsFromTestResult(
      { finalResult: { html } }, { fieldCharCap: 200 }
    );
    const out = stripped.finalResult.html;
    assert.ok(out.length < 400, 'small cap honored, got ' + out.length);
    assert.ok(out.includes('H'), 'head region kept');
    assert.ok(out.includes('T'), 'tail region kept at small caps too');
    assert.ok(!out.includes('MMM'), 'middle cut');
  });
});

describe('RC59: summarizeFixIteration history digest', () => {
  it('caps result field values at a digest budget — history stops carrying output dumps', () => {
    // Incident: each history entry embedded ~300K chars of capped-but-still-
    // huge output JSON. The current prompt re-sends the fresh output anyway;
    // history only needs structure + scalar values.
    const result = {
      finalResult: {
        posts: Array.from({ length: 10 }, (_, i) => ({
          index: i + 1,
          content: '正文' + i,
          likes: '8',
          comments: '',
          html: '<div>' + 'x'.repeat(50000) + '</div>',
          hoverInfos: [{ htmlSnippet: '<span>' + 'y'.repeat(30000) + '</span>' }]
        }))
      }
    };
    const summary = summarizeFixIteration({
      stepId: '4', stepName: 'extract', script: 'return {}',
      annotations: [], userFeedback: 'comments 抽不出来', error: null, result
    });
    assert.ok(summary.length < 30000,
      'history entry must be a digest, got ' + summary.length + ' chars');
    assert.ok(!/x{300,}/.test(summary), 'no huge html runs in history');
    assert.ok(!/y{300,}/.test(summary), 'no huge hovercard runs in history');
    assert.ok(summary.includes('posts'), 'result structure visible');
    assert.ok(summary.includes('likes'), 'scalar field names visible');
  });

  it('still records user feedback, error, and the tried script verbatim', () => {
    const summary = summarizeFixIteration({
      stepId: '5', stepName: 'classify', script: 'return 1;',
      annotations: [], userFeedback: '第二篇帖子分类错了',
      error: 'ELEMENT_NOT_FOUND', result: { finalResult: { a: 1 } }
    });
    assert.ok(summary.includes('第二篇帖子分类错了'));
    assert.ok(summary.includes('ELEMENT_NOT_FOUND'));
    assert.ok(summary.includes('return 1;'));
  });
});

// Source-text wiring checks live in rc59-wiring tests below.
describe('RC59: wizard.js wiring (source-text)', () => {
  const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('currentOutput and testResultSection serialize through the same chain', () => {
    const src = readSrc('wizard.js');
    const count = (src.match(/stripPagesFromLLMContext\(stripSnapshotsFromTestResult\(/g) || []).length;
    assert.ok(count >= 2,
      'both serialization sites (testResultSection + currentOutput) must strip; found ' + count);
  });
});
