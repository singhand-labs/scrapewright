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
  summarizeFixIteration,
  elideDuplicateFinalResults
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
describe('RC59: elideDuplicateFinalResults', () => {
  const ELISION = /elided|identical to finalResult/;

  it('replaces step results that deep-equal finalResult with an elision marker', () => {
    // Incident: currentOutput serialized the SAME posts array twice — once as
    // the terminal step's steps[].result, once as finalResult (~250K chars
    // each after capping). Identical bytes, zero added signal.
    const posts = [{ content: 'p1', likes: '8' }, { content: 'p2', likes: '3' }];
    const testResult = {
      finalResult: { posts },
      steps: [
        { stepId: '1', result: { url: 'https://example.test/' } },
        { stepId: '2', result: { posts } }
      ]
    };
    const out = elideDuplicateFinalResults(testResult);
    assert.equal(out.steps[0].result.url, 'https://example.test/',
      'differing results kept verbatim');
    assert.ok(ELISION.test(String(out.steps[1].result)),
      'duplicating result replaced by marker, got: ' + JSON.stringify(out.steps[1].result));
    assert.deepEqual(out.finalResult, { posts },
      'finalResult itself stays full — serialized exactly once');
  });

  it('does not mutate the input testResult', () => {
    const posts = [{ content: 'p' }];
    const testResult = { finalResult: { posts }, steps: [{ stepId: '2', result: { posts } }] };
    elideDuplicateFinalResults(testResult);
    assert.deepEqual(testResult.steps[0].result, { posts },
      'stored wizardState.testResult must be untouched (elision is serialization-only)');
  });

  it('is a no-op when finalResult is absent, null, or steps is missing', () => {
    const noFinal = { steps: [{ stepId: '1', result: { a: 1 } }] };
    assert.deepEqual(elideDuplicateFinalResults(noFinal), noFinal);
    const nullFinal = { finalResult: null, steps: [{ stepId: '1', result: null }] };
    assert.deepEqual(elideDuplicateFinalResults(nullFinal), nullFinal);
    const noSteps = { finalResult: { a: 1 } };
    assert.deepEqual(elideDuplicateFinalResults(noSteps), noSteps);
    assert.equal(elideDuplicateFinalResults(null), null);
  });
});

// RC59-4: firstContainerHtml head+tail capture. The 2000-char cap was
// HEAD-ONLY in both copies (lib + inline fallback); the record action-bar
// (where aria-label metric counts live) sits at the END of the markup, so
// the FIELD_CANDIDATES evidence snippet amputated exactly the region the
// LLM needed to see (incident: fieldCandidates gate showed recordHtmlChars
// 2012 with zero metric evidence through 10 rounds).
describe('RC59: firstContainerHtml head+tail capture', () => {
  const { JSDOM } = require('jsdom');
  const listExtractOps = require('../lib/list-extract-ops');

  it('lib capture keeps head AND tail of oversized container HTML', () => {
    const html = '<div class="record">' + 'm'.repeat(4000) +
      '<a aria-label="93 则评论" role="button"></a></div>';
    const dom = new JSDOM('<!DOCTYPE html>' + html);
    const c = dom.window.document.querySelector('.record');
    const out = listExtractOps.computeExtractListDiagnostics([c], {}, '.record')
      .firstContainerHtml;
    assert.ok(out.length < 2300, 'still capped near 2000, got ' + out.length);
    assert.ok(out.startsWith('<div class="record">'), 'head prefix survives');
    assert.ok(out.includes('aria-label="93 则评论"'),
      'TAIL evidence (metric count attribute) must survive the cap');
    const lenMatch = out.match(/truncated (\d+) chars/);
    assert.ok(lenMatch && Number(lenMatch[1]) >= 4000,
      'marker must disclose the original length, got: ' + (lenMatch && lenMatch[1]));
  });

  it('short container HTML is kept whole (no marker)', () => {
    const dom = new JSDOM('<!DOCTYPE html><div class="r"><span>x</span></div>');
    const c = dom.window.document.querySelector('.r');
    const out = listExtractOps.computeExtractListDiagnostics([c], {}, '.r')
      .firstContainerHtml;
    assert.ok(out.includes('<span>x</span>'));
    assert.ok(!/truncated/i.test(out));
  });

  it('inline fallback copy mirrors the head+tail split (source-text)', () => {
    // content-script.js is a strict-mode IIFE — source-text audit only.
    // (The inline copy lives inside createInlineListExtractOps; RC8/RC19/RC35
    // drift incidents all had lib gain a fix the fallback missed.)
    const cs = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
    assert.ok(!/collapsed\.slice\(0,\s*2000\)/.test(cs),
      'head-only 2000-char cap must be gone from the inline fallback copy');
    assert.ok(/collapsed\.slice\(collapsed\.length\s*-\s*[A-Za-z0-9_$]+\)/.test(cs),
      'inline fallback must keep a tail slice so end-of-record evidence survives');
    assert.ok(cs.includes('chars, middle cut]'),
      'inline fallback marker must disclose the truncation like the lib copy');
  });
});

describe('RC59: wizard.js wiring (source-text)', () => {
  const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('currentOutput and testResultSection serialize through the same chain', () => {
    const src = readSrc('wizard.js');
    const count = (src.match(/stripPagesFromLLMContext\(stripSnapshotsFromTestResult\(/g) || []).length;
    assert.ok(count >= 2,
      'both serialization sites (testResultSection + currentOutput) must strip; found ' + count);
  });

  it('both serialization sites elide steps[].result duplicating finalResult', () => {
    const src = readSrc('wizard.js');
    const count = (src.match(/elideDuplicateFinalResults\(stripPagesFromLLMContext\(/g) || []).length;
    assert.ok(count >= 2,
      'both sites must wrap the chain with elideDuplicateFinalResults; found ' + count);
  });

  it('elideDuplicateFinalResults is exported from wizard-utils', () => {
    const src = readSrc('lib/wizard-utils.js');
    assert.match(src, /function elideDuplicateFinalResults\(/);
    assert.match(src, /module\.exports[^\n]*elideDuplicateFinalResults/);
  });
});
